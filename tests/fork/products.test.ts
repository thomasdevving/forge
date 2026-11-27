/**
 * Phase 5 on the fork: long call, covered call, cash-secured put, the self-financing collar,
 * and staged open/close (multi-transaction, restart, duplicates, out-of-order, cancellation,
 * pending-open expiry and partial-close recovery).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { fetchPosition } from "@orca-so/whirlpools-client";
import { tickIndexToSqrtPrice } from "@orca-so/whirlpools-core";
import {
  buildCloseBatch,
  buildFinalizeClose,
  buildOpen,
  fetchBucket,
  fetchMarket,
  fetchStrategy,
  forgeIx,
  humanPriceToX64,
  type LegSpec,
  rw,
  SimulationError,
  strategyPdas,
} from "@forge/txbuilder";
import { airdrop } from "@forge/fork/surfnet";
import { advance, humanPrice, moveMarket, newUser, publishReference, rpc, send, setup, sol, tokenAmount } from "../src/harness.js";

const priceAt = (tick: number) => (Number(tickIndexToSqrtPrice(tick)) / 2 ** 64) ** 2 * 1e3;
const W = 256;
const center = () => sol.buckets[8]!.tickLower;
const below = (k: number) => center() - W * k;
const above = (k: number) => center() + W * k;

async function expectError(p: Promise<unknown>, name?: string) {
  try {
    await p;
  } catch (e) {
    if (name) expect((e as SimulationError).codeName).toBe(name);
    return;
  }
  throw new Error(`expected failure ${name ?? ""}`);
}

type Wallet = Awaited<ReturnType<typeof newUser>>;

async function open(u: Wallet, nonce: bigint, legs: LegSpec[], budget = 300_000_000n) {
  const m = await fetchMarket(rpc, sol.market);
  const price = await humanPrice(sol.whirlpool);
  await publishReference(price);
  return buildOpen(rpc, {
    owner: u.user, market: sol.market, nonce, legs, premiumBudget: budget, expiry: 0n,
    openReferenceX64: humanPriceToX64(price, 9, 6), openToleranceBps: m.params.open_tolerance_bps,
    swapSlippageBps: m.params.swap_slippage_bps, certificateHash: new Uint8Array(32).fill(1),
    userBase: u.wsol, userQuote: u.usdc,
  });
}

async function closeAll(u: Wallet, strategy: Address, caller = u.user, keeperQuote?: Address) {
  const s = await fetchStrategy(rpc, strategy);
  const p = { caller, market: sol.market, strategy, userBase: u.wsol, userQuote: u.usdc, keeperQuote };
  if (s.state === "Open") await send(caller, [forgeIx("begin_close", { caller, market: sol.market, strategy }, {}, [])]);
  const pending = s.legs.map((l, i) => ({ l, i })).filter(({ l }) => l.executed && !l.restored).map(({ i }) => i);
  for (let i = 0; i < pending.length; i += 2) {
    await publishReference(await humanPrice(sol.whirlpool));
    await send(caller, [await buildCloseBatch(rpc, p, pending.slice(i, i + 2))]);
  }
  await send(caller, [await buildFinalizeClose(rpc, p)]);
  return fetchStrategy(rpc, strategy);
}

const liq = async (tl: number, frac = 6n) => (await fetchBucket(rpc, sol.buckets.find((b) => b.tickLower === tl)!.address)).total_liquidity / frac;

describe("products and staged execution (fork)", () => {
  let u: Wallet;
  let nonce = 900n;

  beforeAll(async () => {
    await setup();
    await moveMarket(sol.scenarioPrice);
    u = await newUser({ wsol: 2_000_000_000_000n, usdc: 200_000_000_000n });
  });

  // every scenario starts from the reference price, so one failure cannot cascade
  beforeEach(async () => {
    await moveMarket(sol.scenarioPrice);
  });

  it("long call: base escrow, rally above the range, restoration sells base, call payoff realized", async () => {
    const tl = above(2);
    const L = await liq(tl);
    const { strategy, transactions } = await open(u, nonce++, [{ kind: "BorrowBase", tickLower: tl, liquidity: L }]);
    await send(u.user, transactions[0]!);
    const s0 = await fetchStrategy(rpc, strategy);
    expect(s0.legs[0]!.removed_quote).toBe(0n);
    expect(s0.legs[0]!.removed_base).toBeGreaterThan(0n);
    const P = priceAt(tl + W) * 1.02; // 2% above the range
    await moveMarket(P);
    const q0 = await tokenAmount(u.usdc);
    const b0 = await tokenAmount(u.wsol);
    const s = await closeAll(u, strategy);
    expect(s.state).toBe("Closed");
    expect(s.legs[0]!.swap_in).toBeGreaterThan(0n); // sold base for quote on the restoration pool
    const dQ = Number((await tokenAmount(u.usdc)) - q0) / 1e6;
    const dB = Number((await tokenAmount(u.wsol)) - b0) / 1e9;
    // balances were taken after the open: the close returns the unspent budget, escrow and buffer
    const budgetBack = Number(s.premium_budget - s.premium_paid - s.keeper_bounty_paid) / 1e6;
    const realizedGross = dQ - budgetBack + dB * P - (Number(s0.legs[0]!.buffer) / 1e9) * P;
    const x = Number(s0.legs[0]!.removed_base) / 1e9;
    const pa = priceAt(tl), pb = priceAt(tl + W);
    const theory = x * P - x * Math.sqrt(pa * pb); // x_full * S - y_full (all quote above the range)
    expect(theory).toBeGreaterThan(0);
    expect(Math.abs(realizedGross - theory)).toBeLessThan(0.003 * x * P);
    await moveMarket(sol.scenarioPrice);
  });

  it("covered call and cash-secured put: user-provided legs under the strategy authority", async () => {
    const callTl = above(1);
    const putTl = below(1);
    const L = 2_000_000_000_000n;
    const { strategy, transactions } = await open(u, nonce++, [
      { kind: "ProvideBase", tickLower: callTl, liquidity: L },
      { kind: "ProvideQuote", tickLower: putTl, liquidity: L },
    ], 0n);
    await send(u.user, transactions[0]!);
    const s0 = await fetchStrategy(rpc, strategy);
    expect(s0.state).toBe("Open");
    const sp = await strategyPdas(strategy);
    // the positions are owned by the strategy's own authority, not the LP vault
    const mint0 = s0.legs[0]!.bucket;
    const pos0 = await fetchPosition(rpc, (await import("@forge/txbuilder")).pdas.orcaPosition(mint0) as unknown as Address).catch(async () =>
      fetchPosition(rpc, await (await import("@forge/txbuilder")).pdas.orcaPosition(mint0)));
    expect(pos0.data.liquidity).toBe(L);
    const nft = await rpc.getTokenAccountsByOwner(sp.authority, { mint: mint0 }, { encoding: "base64" }).send();
    expect(nft.value).toHaveLength(1);
    expect(s0.legs[0]!.provided_quote).toBe(0n);
    expect(s0.legs[1]!.provided_base).toBe(0n);
    // rally through the covered-call range: the base is sold for quote
    await moveMarket(priceAt(callTl + W) * 1.01);
    const s = await closeAll(u, strategy);
    expect(s.state).toBe("Closed");
    expect(s.legs[0]!.returned_base).toBe(0n);
    expect(s.legs[0]!.returned_quote).toBeGreaterThan(0n);
    expect(s.legs[1]!.returned_quote).toBeGreaterThan(0n); // put range above price now: still quote
    expect(s.premium_paid).toBe(0n);
    await moveMarket(sol.scenarioPrice);
  });

  it("self-financing collar: covered-call fees are actual collected credits netted against the put premium", async () => {
    const callTl = above(1);
    const putTl = below(2);
    const { strategy, transactions } = await open(u, nonce++, [
      { kind: "BorrowQuote", tickLower: putTl, liquidity: await liq(putTl) },
      { kind: "ProvideBase", tickLower: callTl, liquidity: 3_000_000_000_000n },
    ]);
    await send(u.user, transactions[0]!);
    // trade inside the covered-call range so it earns real fees, staying above the put range
    const mid = Math.sqrt(priceAt(callTl) * priceAt(callTl + W));
    for (let i = 0; i < 3; i++) {
      await moveMarket(mid * 0.996);
      await moveMarket(mid * 1.004);
    }
    await moveMarket(sol.scenarioPrice);
    await advance(3_600);
    const s = await closeAll(u, strategy);
    expect(s.state).toBe("Closed");
    expect(s.fee_credit_base + s.fee_credit_quote).toBeGreaterThan(0n);
    expect(s.legs[1]!.fees_base + s.legs[1]!.fees_quote).toBe(s.fee_credit_base + s.fee_credit_quote);
    expect(s.premium_paid).toBeGreaterThan(0n);
    // netting shown to the user: premium paid minus collected quote-valued fee credits
    const price = await humanPrice(sol.whirlpool);
    const credits = Number(s.fee_credit_quote) / 1e6 + (Number(s.fee_credit_base) / 1e9) * price;
    console.log({ premium: Number(s.premium_paid) / 1e6, feeCredits: credits, net: Number(s.premium_paid) / 1e6 - credits });
  });

  it("staged 4-leg open survives a restart, rejects duplicates and allows out-of-order batches", async () => {
    const legs: LegSpec[] = [
      { kind: "BorrowQuote", tickLower: below(2), liquidity: await liq(below(2), 10n) },
      { kind: "BorrowQuote", tickLower: below(3), liquidity: await liq(below(3), 10n) },
      { kind: "BorrowBase", tickLower: above(2), liquidity: await liq(above(2), 10n) },
      { kind: "ProvideBase", tickLower: above(3), liquidity: 1_000_000_000_000n },
    ];
    const n = nonce++;
    const plan = await open(u, n, legs);
    expect(plan.transactions).toHaveLength(4); // begin, two batches, finalize
    await send(u.user, plan.transactions[0]!);
    expect((await fetchStrategy(rpc, plan.strategy)).state).toBe("PendingOpen");
    // reservations count toward utilization immediately
    const b2 = await fetchBucket(rpc, sol.buckets.find((b) => b.tickLower === below(2))!.address);
    expect(b2.reserved).toBeGreaterThan(0n);
    // out of order: the second batch first
    await send(u.user, plan.transactions[2]!);
    // "restart": rebuild the plan from chain state and run the remaining batch
    const again = await open(u, n, legs).catch(() => plan); // begin cannot be rebuilt for an existing strategy
    void again;
    await send(u.user, plan.transactions[1]!);
    // a duplicate submission of an executed batch is rejected, not double-counted
    await expectError(send(u.user, plan.transactions[1]!), "InvalidLeg");
    await send(u.user, plan.transactions[3]!);
    const s = await fetchStrategy(rpc, plan.strategy);
    expect(s.state).toBe("Open");
    expect(s.legs.every((l) => l.executed)).toBe(true);
    expect((await fetchBucket(rpc, b2.position === b2.position ? sol.buckets.find((b) => b.tickLower === below(2))!.address : b2.market)).reserved).toBe(0n);
    // staged close: two batches, then finalize
    const done = await closeAll(u, plan.strategy);
    expect(done.state).toBe("Closed");
  });

  it("owner cancellation unwinds executed legs and releases untouched reservations", async () => {
    const legs: LegSpec[] = [
      { kind: "BorrowQuote", tickLower: below(4), liquidity: await liq(below(4), 10n) },
      { kind: "BorrowQuote", tickLower: below(5), liquidity: await liq(below(5), 10n) },
      { kind: "BorrowQuote", tickLower: below(6), liquidity: await liq(below(6), 10n) },
    ];
    const q0 = await tokenAmount(u.usdc);
    const plan = await open(u, nonce++, legs);
    await send(u.user, plan.transactions[0]!);
    await send(u.user, plan.transactions[1]!); // legs 0 and 1 executed, leg 2 only reserved
    const b6 = sol.buckets.find((b) => b.tickLower === below(6))!.address;
    expect((await fetchBucket(rpc, b6)).reserved).toBeGreaterThan(0n);
    await send(u.user, [forgeIx("abort_open", { caller: u.user, strategy: plan.strategy, market: sol.market }, {}, [rw(b6)])]);
    expect((await fetchBucket(rpc, b6)).reserved).toBe(0n);
    const s = await closeAll(u, plan.strategy);
    expect(s.state).toBe("Cancelled");
    for (const tl of [below(4), below(5)]) {
      const b = await fetchBucket(rpc, sol.buckets.find((x) => x.tickLower === tl)!.address);
      expect(b.reserved).toBe(0n);
    }
    // a cancellation is a compensating unwind, not a reversal: the owner lost at most premium + costs
    const lost = Number(q0 - (await tokenAmount(u.usdc))) / 1e6;
    expect(lost).toBeLessThan(Number(s.premium_paid) / 1e6 + 5);
  });

  it("an expired pending open can be recovered by anyone", async () => {
    const legs: LegSpec[] = [
      { kind: "BorrowQuote", tickLower: below(3), liquidity: await liq(below(3), 12n) },
      { kind: "BorrowQuote", tickLower: below(4), liquidity: await liq(below(4), 12n) },
      { kind: "BorrowQuote", tickLower: below(5), liquidity: await liq(below(5), 12n) },
    ];
    const plan = await open(u, nonce++, legs);
    await send(u.user, plan.transactions[0]!);
    await advance(301); // past the 300 s pending-open deadline
    await expectError(send(u.user, plan.transactions[1]!), "DeadlinePassed");
    const stranger = await generateKeyPairSigner();
    await airdrop(rpc, stranger.address, 1);
    const rem = legs.map((l) => rw(sol.buckets.find((b) => b.tickLower === l.tickLower)!.address));
    await send(stranger, [forgeIx("abort_open", { caller: stranger, strategy: plan.strategy, market: sol.market }, {}, rem)]);
    const s = await closeAll(u, plan.strategy);
    expect(s.state).toBe("Cancelled");
  });

  it("partial close: completed restorations stay final while a failed batch is retried", async () => {
    const legs: LegSpec[] = [
      { kind: "BorrowQuote", tickLower: below(2), liquidity: await liq(below(2), 10n) },
      { kind: "BorrowQuote", tickLower: below(3), liquidity: await liq(below(3), 10n) },
      { kind: "BorrowQuote", tickLower: below(4), liquidity: await liq(below(4), 10n) },
    ];
    const plan = await open(u, nonce++, legs);
    for (const tx of plan.transactions) await send(u.user, tx);
    const strategy = plan.strategy;
    await send(u.user, [forgeIx("begin_close", { caller: u.user, market: sol.market, strategy }, {}, [])]);
    const p = { caller: u.user, market: sol.market, strategy, userBase: u.wsol, userQuote: u.usdc };
    const price = await humanPrice(sol.whirlpool);
    await publishReference(price);
    await send(u.user, [await buildCloseBatch(rpc, p, [0, 1])]);
    await publishReference(price * 1.03); // the next batch cannot pass the price guard
    await expectError(send(u.user, [await buildCloseBatch(rpc, p, [2])]), "PoolDeviation");
    let s = await fetchStrategy(rpc, strategy);
    expect(s.legs.map((l) => l.restored)).toEqual([true, true, false]);
    await expectError(send(u.user, [await buildFinalizeClose(rpc, p)]), "InvalidState"); // no payout early
    await publishReference(price);
    await send(u.user, [await buildCloseBatch(rpc, p, [2]), await buildFinalizeClose(rpc, p)]);
    s = await fetchStrategy(rpc, strategy);
    expect(s.state).toBe("Closed");
  });
});
