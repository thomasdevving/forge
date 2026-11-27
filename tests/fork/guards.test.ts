/**
 * Phase 2 acceptance: guarded restoration, insufficient-buffer recovery, and invariants
 * 2 (no partial restoration), 6 (authorization) and 7 (failed CPIs abort the transaction).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { type AccountMeta, type Address, generateKeyPairSigner } from "@solana/kit";
import { tickIndexToSqrtPrice } from "@orca-so/whirlpools-core";
import {
  buildClose,
  buildCloseBatch,
  buildFinalizeClose,
  buildOpen,
  defaultParams,
  fetchBucket,
  fetchMarket,
  fetchStrategy,
  forgeIx,
  humanPriceToX64,
  pdas,
  recordRecoveryIx,
  SimulationError,
  topUpBufferIx,
} from "@forge/txbuilder";
import { loadKey } from "@forge/fork/env";
import { bucketBelow, humanPrice, moveMarket, newUser, openPut, publishReference, rpc, send, setup, sol } from "../src/harness.js";

const priceAt = (tick: number) => (Number(tickIndexToSqrtPrice(tick)) / 2 ** 64) ** 2 * 1e3;

async function expectFailure(p: Promise<unknown>, name?: string) {
  try {
    await p;
  } catch (e) {
    if (name) {
      expect(e).toBeInstanceOf(SimulationError);
      expect((e as SimulationError).codeName ?? (e as Error).message).toContain(name);
    }
    return e;
  }
  throw new Error(`expected failure${name ? ` (${name})` : ""}`);
}

async function setMarket(params: Partial<ReturnType<typeof defaultParams>>, flags: { borrowPaused?: boolean } = {}) {
  const admin = await loadKey("admin");
  const m = await fetchMarket(rpc, sol.market);
  await send(admin, [
    forgeIx("update_market", { admin, market: sol.market }, {
      params: { ...m.params, ...params },
      opens_paused: null,
      borrow_paused: flags.borrowPaused ?? null,
    }),
  ]);
}

describe("guards, recovery and authorization (fork)", () => {
  let user: Awaited<ReturnType<typeof newUser>>;
  let nonce = 100n;

  beforeAll(async () => {
    await setup();
    await moveMarket(sol.scenarioPrice);
    await setMarket(defaultParams(), { borrowPaused: false });
    user = await newUser();
  });

  it("rejects an open when the reference is stale", async () => {
    const price = await humanPrice(sol.whirlpool);
    await publishReference(price, { ageSeconds: 120 });
    const m = await fetchMarket(rpc, sol.market);
    const b = await fetchBucket(rpc, sol.buckets.find((x) => x.tickLower === bucketBelow(1))!.address);
    const { transactions } = await buildOpen(rpc, {
      owner: user.user, market: sol.market, nonce: nonce++, premiumBudget: 100_000_000n, expiry: 0n,
      legs: [{ kind: "BorrowQuote", tickLower: bucketBelow(1), liquidity: b.total_liquidity / 10n }],
      openReferenceX64: humanPriceToX64(price, 9, 6), openToleranceBps: 50, swapSlippageBps: m.params.swap_slippage_bps,
      certificateHash: new Uint8Array(32), userBase: user.wsol, userQuote: user.usdc,
    });
    await expectFailure(send(user.user, transactions[0]!), "StaleReference");
  });

  it("aborts the whole transaction when an Orca CPI fails (invariant 7)", async () => {
    const price = await humanPrice(sol.whirlpool);
    await publishReference(price);
    const m = await fetchMarket(rpc, sol.market);
    const bAddr = sol.buckets.find((x) => x.tickLower === bucketBelow(1))!.address;
    const before = await fetchBucket(rpc, bAddr);
    const n = nonce++;
    const { strategy, transactions } = await buildOpen(rpc, {
      owner: user.user, market: sol.market, nonce: n, premiumBudget: 100_000_000n, expiry: 0n,
      legs: [{ kind: "BorrowQuote", tickLower: bucketBelow(1), liquidity: before.total_liquidity / 10n }],
      openReferenceX64: humanPriceToX64(price, 9, 6), openToleranceBps: 50, swapSlippageBps: m.params.swap_slippage_bps,
      certificateHash: new Uint8Array(32), userBase: user.wsol, userQuote: user.usdc,
    });
    // corrupt the leg's upper tick array: Orca rejects it inside the decrease_liquidity CPI
    const exec = transactions[0]![1]!;
    const wrong = await pdas.tickArray(sol.whirlpool, -5632 * 10);
    const accounts = [...exec.accounts!] as AccountMeta[];
    accounts[accounts.length - 1] = { ...accounts[accounts.length - 1]!, address: wrong };
    const broken = [transactions[0]![0]!, { ...exec, accounts }, transactions[0]![2]!];
    await expectFailure(send(user.user, broken));
    // nothing persisted: no strategy account, no reservation
    expect((await rpc.getAccountInfo(strategy, { encoding: "base64" }).send()).value).toBeNull();
    const after = await fetchBucket(rpc, bAddr);
    expect(after.reserved).toBe(before.reserved);
    expect(after.borrowed).toBe(before.borrowed);
  });

  it("enforces close authorization (invariant 6)", async () => {
    const strategy = await openPut(user, [bucketBelow(2)], nonce++, { fraction: 10n });
    const stranger = await generateKeyPairSigner();
    await (await import("@forge/fork/surfnet")).airdrop(rpc, stranger.address, 1);
    await expectFailure(
      send(stranger, [forgeIx("begin_close", { caller: stranger, market: sol.market, strategy }, {}, [])]),
      "CloseNotAllowed",
    );
    await expectFailure(send(stranger, [forgeIx("finalize_open", { owner: stranger, strategy })]));
    // the owner can always close; clean up
    const plan = await buildClose(rpc, { caller: user.user, market: sol.market, strategy, userBase: user.wsol, userQuote: user.usdc });
    await send(user.user, plan[0]!);
    expect((await fetchStrategy(rpc, strategy)).state).toBe("Closed");
  });

  it("blocks restoration on reference deviation, records recovery, then settles", async () => {
    const strategy = await openPut(user, [bucketBelow(1)], nonce++, { fraction: 10n });
    await send(user.user, [forgeIx("begin_close", { caller: user.user, market: sol.market, strategy }, {}, [])]);
    const price = await humanPrice(sol.whirlpool);
    await publishReference(price * 1.02); // reference 2% away from both pools
    const p = { caller: user.user, market: sol.market, strategy, userBase: user.wsol, userQuote: user.usdc };
    await expectFailure(send(user.user, [await buildCloseBatch(rpc, p, [0])]), "PoolDeviation");
    const s0 = await fetchStrategy(rpc, strategy);
    expect(s0.legs[0]!.restored).toBe(false); // invariant 2: no partial restoration
    await send(user.user, [await recordRecoveryIx(rpc, sol.market, strategy, 0)]);
    let m = await fetchMarket(rpc, sol.market);
    expect((await fetchStrategy(rpc, strategy)).state).toBe("Recovery");
    expect(m.borrow_paused).toBe(true);
    expect(m.unresolved_strategies).toBe(1);
    // new borrowing is paused while the shortfall is unresolved
    await expectFailure(openPut(user, [bucketBelow(3)], nonce++), "BorrowPaused");
    // the reference recovers: permissionless retry under the same checks
    await publishReference(price);
    await send(user.user, [await buildCloseBatch(rpc, p, [0]), await buildFinalizeClose(rpc, p)]);
    expect((await fetchStrategy(rpc, strategy)).state).toBe("Closed");
    m = await fetchMarket(rpc, sol.market);
    expect(m.unresolved_strategies).toBe(0);
    await setMarket({}, { borrowPaused: false }); // explicit admin review step
  });

  it("insufficient buffer: restoration fails, recovery is recorded, owner top-up settles", async () => {
    await setMarket({ restoration_buffer_bps: 1 });
    const tl = bucketBelow(1);
    const strategy = await openPut(user, [tl], nonce++, { fraction: 10n });
    await setMarket({ restoration_buffer_bps: 200 }); // params apply to new positions only
    const st = await fetchStrategy(rpc, strategy);
    expect(st.legs[0]!.buffer).toBe((st.legs[0]!.removed_quote + 9_999n) / 10_000n);

    // price just inside the top of the range: the frictionless margin is smallest here
    const pb = priceAt(tl + 256);
    const P = pb * (1 - 0.00226);
    await moveMarket(P, { swapPool: P * 1.004, reference: P }); // restoration pool 40 bps rich
    await send(user.user, [forgeIx("begin_close", { caller: user.user, market: sol.market, strategy }, {}, [])]);
    const p = { caller: user.user, market: sol.market, strategy, userBase: user.wsol, userQuote: user.usdc };
    await expectFailure(send(user.user, [await buildCloseBatch(rpc, p, [0])]));
    expect((await fetchStrategy(rpc, strategy)).legs[0]!.restored).toBe(false);

    await send(user.user, [await recordRecoveryIx(rpc, sol.market, strategy, 0)]);
    expect((await fetchStrategy(rpc, strategy)).state).toBe("Recovery");
    expect((await fetchMarket(rpc, sol.market)).borrow_paused).toBe(true);

    // the owner tops up the buffer (1% of the removed quote) and the retry settles
    const topUp = st.legs[0]!.removed_quote / 100n;
    await send(user.user, [await topUpBufferIx(user.user, strategy, user.usdc, await pdas.escrowQuote(strategy), 0, topUp)]);
    expect((await fetchStrategy(rpc, strategy)).state).toBe("PendingClose");
    await publishReference(P);
    await send(user.user, [await buildCloseBatch(rpc, p, [0]), await buildFinalizeClose(rpc, p)]);
    const done = await fetchStrategy(rpc, strategy);
    expect(done.state).toBe("Closed");
    expect(done.legs[0]!.swap_in).toBeGreaterThan(0n);
    const m = await fetchMarket(rpc, sol.market);
    expect(m.unresolved_strategies).toBe(0);
    await setMarket({}, { borrowPaused: false });
    await moveMarket(sol.scenarioPrice);
  });
});

export type { Address };
