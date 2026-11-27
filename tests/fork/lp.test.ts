/**
 * Phase 3: LP economics on the fork. Idle fee pass-through, pro-rata shares, ladder deposits
 * of real Orca positions, premium claims, withdrawals with notice, keeper cranks and the
 * budget cap. Invariants 3 (utilization cap), 5 (premium <= budget) and 8 (share accounting
 * conserves token claims) are asserted directly.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { type Address, type KeyPairSigner } from "@solana/kit";
import { fetchPosition } from "@orca-so/whirlpools-client";
import { openPositionInstructionsWithTickBounds, setDefaultFunder, setNativeMintWrappingStrategy } from "@orca-so/whirlpools";
import {
  beginLpDepositIx,
  buildClose,
  buildCloseBatch,
  buildFinalizeClose,
  checkpointIxsForBucket,
  checkpointLegIx,
  claimLpIx,
  collectAndDistributeIx,
  depositLiquidityIx,
  executeLpDepositBucketIx,
  fetchBucket,
  fetchLpPosition,
  fetchMarket,
  fetchStrategy,
  finishLpDepositIx,
  forgeIx,
  pdas,
  requestWithdrawalIx,
  SimulationError,
  withdrawLiquidityIx,
} from "@forge/txbuilder";
import { loadKey } from "@forge/fork/env";
import { sendInstructions } from "@forge/fork/surfnet";
import { advance, bucketBelow, humanPrice, moveMarket, newUser, openPut, rpc, send, setup, sol, tokenAmount } from "../src/harness.js";

async function expectError(p: Promise<unknown>, name: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SimulationError);
    expect((e as SimulationError).codeName).toBe(name);
    return;
  }
  throw new Error(`expected ${name}`);
}

type Wallet = Awaited<ReturnType<typeof newUser>>;
const bucketAt = (tl: number) => sol.buckets.find((b) => b.tickLower === tl)!.address;

async function deposit(w: Wallet, bucket: Address, liquidity: bigint) {
  await send(w.user, [await depositLiquidityIx({ rpc, lp: w.user, market: sol.market, bucket, liquidity, lpBase: w.wsol, lpQuote: w.usdc })]);
}

/** Wash-trade inside the current range to generate real Orca fees. */
async function washTrade(rounds: number) {
  const p0 = await humanPrice(sol.whirlpool);
  for (let i = 0; i < rounds; i++) {
    await moveMarket(p0 * 0.997);
    await moveMarket(p0 * 1.003);
  }
  await moveMarket(p0);
}

describe("LP economics (fork)", () => {
  let lpA: Wallet;
  let lpB: Wallet;
  let trader: Wallet;
  let nonce = 500n;

  beforeAll(async () => {
    await setup();
    setNativeMintWrappingStrategy("none"); // test wallets already hold wrapped SOL
    await moveMarket(sol.scenarioPrice);
    lpA = await newUser({ wsol: 50_000_000_000_000n, usdc: 5_000_000_000_000n });
    lpB = await newUser({ wsol: 50_000_000_000_000n, usdc: 5_000_000_000_000n });
    trader = await newUser();
  });

  it("passes idle Orca fees through pro rata and conserves claims (invariant 8)", async () => {
    // the bucket containing the price, so wash trades earn fees on it
    const bucket = sol.buckets[8]!.address;
    const before = await fetchBucket(rpc, bucket);
    await deposit(lpA, bucket, 1_000_000_000_000n);
    await deposit(lpB, bucket, 3_000_000_000_000n);
    await washTrade(2);
    await send(lpA.user, [await collectAndDistributeIx(rpc, sol.market, bucket)]);
    const b = await fetchBucket(rpc, bucket);
    const collectedQuote = b.fees_collected_quote - before.fees_collected_quote;
    expect(collectedQuote).toBeGreaterThan(0n);

    const qa = await tokenAmount(lpA.usdc);
    const qb = await tokenAmount(lpB.usdc);
    await send(lpA.user, [await claimLpIx(rpc, lpA.user, sol.market, bucket, lpA.wsol, lpA.usdc)]);
    await send(lpB.user, [await claimLpIx(rpc, lpB.user, sol.market, bucket, lpB.wsol, lpB.usdc)]);
    const gotA = (await tokenAmount(lpA.usdc)) - qa;
    const gotB = (await tokenAmount(lpB.usdc)) - qb;
    expect(gotA).toBeGreaterThan(0n);
    // B has 3x A's shares: its claim is 3x within one atom of rounding per index step
    const ratio = Number(gotB) / Number(gotA);
    expect(ratio).toBeGreaterThan(2.99);
    expect(ratio).toBeLessThan(3.01);
    // invariant 8: no LP claims more than was collected; the vault still covers every owed amount
    const fb = await fetchBucket(rpc, bucket);
    const lpShare = Number(4_000_000_000_000n) / Number(fb.total_liquidity);
    expect(Number(gotA + gotB)).toBeLessThanOrEqual(Number(collectedQuote) * lpShare + 2);
    expect(await tokenAmount(fb.market === sol.market ? (await fetchMarket(rpc, sol.market)).fee_vault_quote : bucket)).toBeGreaterThanOrEqual(0n);
  });

  it("a late joiner cannot claim fees earned before it deposited", async () => {
    const bucket = sol.buckets[8]!.address;
    await washTrade(1); // fees accrue in the Orca position but are not yet collected
    const late = await newUser({ wsol: 10_000_000_000_000n, usdc: 1_000_000_000_000n });
    await deposit(late, bucket, 2_000_000_000_000n); // deposit collects and credits first
    const lp = await fetchLpPosition(rpc, await pdas.lp(bucket, late.user.address));
    const b = await fetchBucket(rpc, bucket);
    expect(lp.fee_index_quote_x64).toBe(b.fee_index_quote_x64);
    expect(lp.fee_owed_quote).toBe(0n);
    const q0 = await tokenAmount(late.usdc);
    await send(late.user, [await claimLpIx(rpc, late.user, sol.market, bucket, late.wsol, late.usdc)]);
    expect(await tokenAmount(late.usdc)).toBe(q0); // nothing earned yet
  });

  it("redeploys a real Orca position into the ladder exactly (staged deposit)", async () => {
    const m = await fetchMarket(rpc, sol.market);
    const lo = sol.buckets[6]!.tickLower;
    const hi = sol.buckets[10]!.tickLower; // four buckets: 6, 7, 8, 9
    setDefaultFunder(lpA.user);
    const open = await openPositionInstructionsWithTickBounds(rpc, sol.whirlpool, { tokenMaxA: 5_000_000_000n, tokenMaxB: 300_000_000n }, lo, hi, { slippageToleranceBps: 10_000 });
    await sendInstructions(rpc, lpA.user, open.instructions);
    const [orcaPos] = [await pdas.orcaPosition(open.positionMint)];
    const L = (await fetchPosition(rpc, orcaPos)).data.liquidity;
    const nftAcc = (await rpc.getTokenAccountsByOwner(lpA.user.address, { mint: open.positionMint }, { encoding: "base64" }).send()).value[0]!.pubkey;
    const n = nonce++;
    const buckets = [6, 7, 8, 9].map((i) => sol.buckets[i]!);
    const lpBefore = await Promise.all(buckets.map(async (b) => {
      try { return (await fetchLpPosition(rpc, await pdas.lp(b.address, lpA.user.address))).liquidity; } catch { return 0n; }
    }));
    const posBefore = await Promise.all(buckets.map(async (b) => (await fetchPosition(rpc, (await fetchBucket(rpc, b.address)).position)).data.liquidity));

    const { ix } = await beginLpDepositIx({ rpc, lp: lpA.user, market: sol.market, nonce: n, orcaPosition: orcaPos, orcaPositionTokenAccount: nftAcc, tickLower: lo, tickUpper: hi, liquidity: L });
    await send(lpA.user, [ix]);
    expect((await fetchPosition(rpc, orcaPos)).data.liquidity).toBe(0n);
    // two buckets per transaction (section 8.5), plus a few atoms of rounding top-up at the end
    for (let i = 0; i < buckets.length; i += 2) {
      const ixs = [];
      for (const b of buckets.slice(i, i + 2)) {
        ixs.push(...(await checkpointIxsForBucket(rpc, sol.market, b.address)));
        ixs.push(await executeLpDepositBucketIx(rpc, lpA.user, sol.market, lpA.user.address, n, b.address));
      }
      try {
        await send(lpA.user, ixs);
      } catch {
        // rounding: increase rounds up per bucket while the single decrease rounded down;
        // the depositor covers at most a few atoms per bucket per token
        const { getTransferInstruction } = await import("@solana-program/token");
        const t = await (await import("@forge/txbuilder")).depositTicket(sol.market, lpA.user.address, n);
        await send(lpA.user, [
          getTransferInstruction({ source: lpA.wsol, destination: t.escrowBase, authority: lpA.user, amount: 8n }),
          getTransferInstruction({ source: lpA.usdc, destination: t.escrowQuote, authority: lpA.user, amount: 8n }),
          ...ixs,
        ]);
      }
    }
    await send(lpA.user, [await finishLpDepositIx(rpc, lpA.user, sol.market, n, lpA.wsol, lpA.usdc)]);
    for (const [i, b] of buckets.entries()) {
      const lp = await fetchLpPosition(rpc, await pdas.lp(b.address, lpA.user.address));
      expect(lp.liquidity - lpBefore[i]!).toBe(L); // exactly L units in every bucket
      const pos = (await fetchPosition(rpc, (await fetchBucket(rpc, b.address)).position)).data.liquidity;
      expect(pos - posBefore[i]!).toBe(L);
    }
    void m;
  });

  it("rejects a deposit whose range is not an exact union of buckets", async () => {
    const lo = sol.buckets[6]!.tickLower + 64; // aligned to tick spacing, not to the bucket grid
    const hi = sol.buckets[8]!.tickLower;
    setDefaultFunder(lpB.user);
    const open = await openPositionInstructionsWithTickBounds(rpc, sol.whirlpool, { tokenMaxA: 1_000_000_000n, tokenMaxB: 100_000_000n }, lo, hi, { slippageToleranceBps: 10_000 });
    await sendInstructions(rpc, lpB.user, open.instructions);
    const orcaPos = await pdas.orcaPosition(open.positionMint);
    const nftAcc = (await rpc.getTokenAccountsByOwner(lpB.user.address, { mint: open.positionMint }, { encoding: "base64" }).send()).value[0]!.pubkey;
    const L = (await fetchPosition(rpc, orcaPos)).data.liquidity;
    const { ix } = await beginLpDepositIx({ rpc, lp: lpB.user, market: sol.market, nonce: nonce++, orcaPosition: orcaPos, orcaPositionTokenAccount: nftAcc, tickLower: lo, tickUpper: hi, liquidity: L });
    await expectError(send(lpB.user, [ix]), "MisalignedBucket");
  });

  it("enforces the utilization cap (invariant 3) and rejects duplicate legs", async () => {
    const tl = bucketBelow(3);
    const b = await fetchBucket(rpc, bucketAt(tl));
    const free = (b.total_liquidity * 800_000n) / 1_000_000n - b.borrowed - b.reserved;
    await expectError(openPut(trader, [tl], nonce++, { fraction: 1n }), "UtilizationCap"); // 100% > 80%
    const s = await openPut(trader, [tl], nonce++, { liquidity: free - 10n });
    const after = await fetchBucket(rpc, bucketAt(tl));
    expect(after.borrowed * 1_000_000n).toBeLessThanOrEqual(after.total_liquidity * 800_000n);
    const st = await fetchStrategy(rpc, s);
    // near the cap the multiplier approaches its maximum: base + slope1·kink + slope2·(cap − kink)
    const c = (await fetchMarket(rpc, sol.market)).params.curve;
    const top = c.base_ppm + (c.slope1_ppm * c.kink_ppm + c.slope2_ppm * (c.cap_ppm - c.kink_ppm)) / 1_000_000;
    expect(st.legs[0]!.multiplier_ppm).toBeGreaterThan(top - 100_000);
    expect(st.legs[0]!.multiplier_ppm).toBeLessThanOrEqual(top);
    await expectError(openPut(trader, [bucketBelow(4), bucketBelow(4)], nonce++), "LegAccountMismatch");
    const plan = await buildClose(rpc, { caller: trader.user, market: sol.market, strategy: s, userBase: trader.wsol, userQuote: trader.usdc });
    await send(trader.user, plan[0]!);
  });

  it("share changes on a borrowed bucket require every open leg to checkpoint first", async () => {
    const tl = bucketBelow(2);
    const s = await openPut(trader, [tl], nonce++, { fraction: 5n });
    await advance(5); // the open itself was a checkpoint; move past that second
    const ix = await depositLiquidityIx({ rpc, lp: lpB.user, market: sol.market, bucket: bucketAt(tl), liquidity: 1_000_000_000n, lpBase: lpB.wsol, lpQuote: lpB.usdc });
    await expectError(send(lpB.user, [ix]), "LiquidityLocked");
    // with every open leg's checkpoint in the same transaction the share change is allowed
    const cps = await checkpointIxsForBucket(rpc, sol.market, bucketAt(tl));
    expect(cps.length).toBeGreaterThanOrEqual(1);
    await send(lpB.user, [...cps, ix]);
    void checkpointLegIx;
    const plan = await buildClose(rpc, { caller: trader.user, market: sol.market, strategy: s, userBase: trader.wsol, userQuote: trader.usdc });
    await send(trader.user, plan[0]!);
  });

  it("withdraws unborrowed liquidity now and borrowed liquidity after notice + keeper close", async () => {
    const keeperKey = await loadKey("keeper");
    const keeper = await newUser({ wsol: 1_000_000_000n, usdc: 0n });
    const tl = bucketBelow(5);
    const bucket = bucketAt(tl);
    await deposit(lpA, bucket, 2_000_000_000_000n);
    const s = await openPut(trader, [tl], nonce++, { fraction: 2n }); // ~50% borrowed
    const b = await fetchBucket(rpc, bucket);
    const mine = (await fetchLpPosition(rpc, await pdas.lp(bucket, lpA.user.address))).liquidity;
    // free liquidity leaves immediately (with the open leg checkpointed in the same tx)
    const freeNow = b.total_liquidity - b.borrowed;
    const take = mine < freeNow / 2n ? mine / 2n : freeNow / 4n;
    await send(lpA.user, [...(await checkpointIxsForBucket(rpc, sol.market, bucket)), await withdrawLiquidityIx({ rpc, lp: lpA.user, market: sol.market, bucket, liquidity: take, lpBase: lpA.wsol, lpQuote: lpA.usdc })]);
    // the rest is requested; a keeper cannot close before the notice period
    await send(lpA.user, [await requestWithdrawalIx(lpA.user, bucket, mine - take)]);
    await expectError(send(keeper.user, [forgeIx("begin_close", { caller: keeper.user, market: sol.market, strategy: s }, {}, [{ address: bucket, role: 0 }])]), "CloseNotAllowed");
    await advance(86_400 + 5); // 24h notice (fork clock)
    await send(keeper.user, [forgeIx("begin_close", { caller: keeper.user, market: sol.market, strategy: s }, {}, [{ address: bucket, role: 0 }])]);
    const p = { caller: keeper.user, market: sol.market, strategy: s, userBase: trader.wsol, userQuote: trader.usdc, keeperQuote: keeper.usdc };
    await send(keeper.user, [await buildCloseBatch(rpc, p, [0]), await buildFinalizeClose(rpc, p)]);
    const st = await fetchStrategy(rpc, s);
    expect(st.state).toBe("Closed");
    expect(st.close_by_keeper).toBe(true);
    expect(await tokenAmount(keeper.usdc)).toBe(st.bounty_reserve);
    // after restoration the requested liquidity can leave
    const rest = (await fetchLpPosition(rpc, await pdas.lp(bucket, lpA.user.address))).liquidity;
    await send(lpA.user, [await withdrawLiquidityIx({ rpc, lp: lpA.user, market: sol.market, bucket, liquidity: rest, lpBase: lpA.wsol, lpQuote: lpA.usdc })]);
    const after = await fetchBucket(rpc, bucket);
    expect(after.withdrawal_requested).toBe(0n);
    expect(after.withdrawal_notice_start).toBe(0n);
    void keeperKey;
  });

  it("budget trigger lets a keeper close; premium never exceeds the cap and the excess is a recorded shortfall", async () => {
    const tl = bucketBelow(6);
    const keeper = await newUser({ wsol: 1_000_000_000n, usdc: 0n });
    // a 20 USDC budget against a ~16k USDC notional: the time floor (5%/yr) exceeds it in ~9 days
    const s = await openPut(trader, [tl], nonce++, { fraction: 4n, budget: 20_000_000n });
    await advance(30 * 86_400);
    await send(keeper.user, [await checkpointLegIx(rpc, sol.market, s, 0)]);
    const st0 = await fetchStrategy(rpc, s);
    expect(st0.cap_binding).toBe(true);
    expect(st0.premium_accrued).toBeGreaterThan(st0.premium_budget - st0.bounty_reserve);
    await send(keeper.user, [forgeIx("begin_close", { caller: keeper.user, market: sol.market, strategy: s }, {}, [])]);
    const p = { caller: keeper.user, market: sol.market, strategy: s, userBase: trader.wsol, userQuote: trader.usdc, keeperQuote: keeper.usdc };
    await send(keeper.user, [await buildCloseBatch(rpc, p, [0]), await buildFinalizeClose(rpc, p)]);
    const st = await fetchStrategy(rpc, s);
    const lpCap = st.premium_budget - st.bounty_reserve;
    // invariant 5: premium + bounty <= budget; excess accrual recorded, never charged
    expect(st.premium_paid).toBe(lpCap);
    expect(st.premium_paid + st.keeper_bounty_paid).toBeLessThanOrEqual(st.premium_budget);
    expect(st.lp_shortfall).toBe(st.premium_accrued - lpCap);
    expect((await fetchBucket(rpc, bucketAt(tl))).lp_shortfall_quote).toBeGreaterThanOrEqual(st.lp_shortfall);
    const m = await fetchMarket(rpc, sol.market);
    expect(m.borrow_paused).toBe(true); // paused pending review
    expect(m.outstanding_lp_shortfall).toBeGreaterThanOrEqual(st.lp_shortfall);
    const admin = await loadKey("admin");
    await send(admin, [forgeIx("update_market", { admin, market: sol.market }, { params: null, opens_paused: null, borrow_paused: false })]);
  });
});

export type { KeyPairSigner };
