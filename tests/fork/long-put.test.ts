/**
 * Phase 2 acceptance: a long put opens through FORGE and Orca CPIs, the market crashes on the
 * fork with real swaps, and the position settles with exact restoration and correct balances.
 * Invariants checked: 1 (exact restoration), 2 (no partial restoration / escrow cover),
 * 4 (user receives only funded assets minus costs), 5 (premium <= budget).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { address, type Address } from "@solana/kit";
import { fetchPosition } from "@orca-so/whirlpools-client";
import { tickIndexToSqrtPrice } from "@orca-so/whirlpools-core";
import {
  buildClose,
  buildOpen,
  fetchBucket,
  fetchMarket,
  fetchStrategy,
  humanPriceToX64,
  pdas,
} from "@forge/txbuilder";
import { humanPrice, moveMarket, newUser, publishReference, rpc, send, setup, sol, tokenAmount } from "../src/harness.js";

const priceAt = (tick: number) => (Number(tickIndexToSqrtPrice(tick)) / 2 ** 64) ** 2 * 1e3;
const sqrt = Math.sqrt;

/** Frictionless put payoff for one borrowed range, in USDC (section 3.2). */
function putPayoff(L: bigint, tickLower: number, tickUpper: number, P: number): number {
  const l = Number(L) / 1e6 * 1e-3 ** 0; // liquidity in sqrt(atoms) units
  const pa = priceAt(tickLower) * 1e-3; // atoms price (USDC atoms per lamport)
  const pb = priceAt(tickUpper) * 1e-3;
  const p = P * 1e-3;
  const yFull = l * (sqrt(pb) - sqrt(pa));
  const s = Math.min(Math.max(sqrt(p), sqrt(pa)), sqrt(pb));
  const x = l * (1 / s - 1 / sqrt(pb));
  const y = l * (s - sqrt(pa));
  return yFull - (x * p + y); // already in USDC because l was scaled by 1e-6
}

describe("long put on SOL/USDC (fork)", () => {
  let user: Awaited<ReturnType<typeof newUser>>;
  let strategy: Address;
  const market = sol.market;
  const legBuckets = sol.buckets.filter((b) => b.tickLower === sol.buckets[8]!.tickLower - 512 || b.tickLower === sol.buckets[8]!.tickLower - 256);
  const posLiquidityBefore = new Map<Address, bigint>();
  const borrowedBefore = new Map<Address, bigint>();
  const openLegsBefore = new Map<Address, number>();
  let quoteBefore = 0n;
  let baseBefore = 0n;

  beforeAll(async () => {
    await setup();
    // start from the bootstrap price on both pools and a fresh reference
    await moveMarket(sol.scenarioPrice);
    user = await newUser();
  });

  it("opens through Orca CPIs and escrows exactly the removed quote", async () => {
    const m = await fetchMarket(rpc, market);
    const price = await humanPrice(sol.whirlpool);
    await publishReference(price);
    expect(legBuckets).toHaveLength(2);
    for (const b of legBuckets) {
      const bk = await fetchBucket(rpc, b.address);
      posLiquidityBefore.set(b.address, (await fetchPosition(rpc, bk.position)).data.liquidity);
      borrowedBefore.set(b.address, bk.borrowed);
      openLegsBefore.set(b.address, bk.open_legs);
    }
    const L = (await fetchBucket(rpc, legBuckets[0]!.address)).total_liquidity / 3n;
    quoteBefore = await tokenAmount(user.usdc);
    baseBefore = await tokenAmount(user.wsol);
    const { strategy: s, transactions } = await buildOpen(rpc, {
      owner: user.user,
      market,
      nonce: 1n,
      legs: legBuckets.map((b) => ({ kind: "BorrowQuote" as const, tickLower: b.tickLower, liquidity: L })),
      premiumBudget: 500_000_000n, // 500 USDC maximum premium spend
      expiry: 0n,
      openReferenceX64: humanPriceToX64(price, 9, 6),
      openToleranceBps: m.params.open_tolerance_bps,
      swapSlippageBps: m.params.swap_slippage_bps,
      certificateHash: new Uint8Array(32).fill(7),
      userBase: user.wsol,
      userQuote: user.usdc,
    });
    strategy = s;
    expect(transactions).toHaveLength(1); // two buckets fit one atomic transaction
    const { prepared } = await send(user.user, transactions[0]!);
    expect(prepared.bytes).toBeLessThanOrEqual(1232);
    expect(prepared.unitsConsumed).toBeLessThanOrEqual(1_100_000);

    const st = await fetchStrategy(rpc, strategy);
    expect(st.state).toBe("Open");
    const escrowQuote = await tokenAmount(await pdas.escrowQuote(strategy));
    const expected = st.legs.reduce((a, l) => a + l.removed_quote + l.buffer, 0n);
    expect(escrowQuote).toBe(expected);
    expect(await tokenAmount(await pdas.escrowBase(strategy))).toBe(0n);
    for (const [i, b] of legBuckets.entries()) {
      const bk = await fetchBucket(rpc, b.address);
      expect(bk.borrowed).toBe(borrowedBefore.get(b.address)! + L);
      const pos = await fetchPosition(rpc, bk.position);
      expect(pos.data.liquidity).toBe(posLiquidityBefore.get(b.address)! - L);
      // post-reservation utilization including other borrowers on this bucket
      const u = Number(((borrowedBefore.get(b.address)! + L) * 1_000_000n + bk.total_liquidity - 1n) / bk.total_liquidity);
      expect(st.legs[i]!.multiplier_ppm).toBe(u <= 600_000 ? 1_000_000 + u : 1_600_000 + 6 * (u - 600_000));
    }
    // the user paid exactly budget + buffers
    const paid = quoteBefore - (await tokenAmount(user.usdc));
    expect(paid).toBe(500_000_000n + st.legs.reduce((a, l) => a + l.buffer, 0n));
  });

  it("settles after a real crash with exact restoration and reconciled balances", async () => {
    const crash = 69.0;
    const moved = await moveMarket(crash);
    expect(Math.abs(moved.target - crash) / crash).toBeLessThan(1e-4);
    const st0 = await fetchStrategy(rpc, strategy);
    const plan = await buildClose(rpc, { caller: user.user, market, strategy, userBase: user.wsol, userQuote: user.usdc });
    expect(plan).toHaveLength(1);
    const { prepared } = await send(user.user, plan[0]!);
    expect(prepared.unitsConsumed).toBeLessThanOrEqual(1_100_000);

    const st = await fetchStrategy(rpc, strategy);
    expect(st.state).toBe("Closed");
    // Invariant 1: every bucket position holds exactly its pre-open liquidity again.
    for (const b of legBuckets) {
      const bk = await fetchBucket(rpc, b.address);
      expect(bk.borrowed).toBe(borrowedBefore.get(b.address)!);
      expect(bk.open_legs).toBe(openLegsBefore.get(b.address)!);
      expect((await fetchPosition(rpc, bk.position)).data.liquidity).toBe(posLiquidityBefore.get(b.address)!);
    }
    // Invariant 5: premium + bounty within the budget, no shortfall in this scenario.
    expect(st.premium_paid + st.keeper_bounty_paid).toBeLessThanOrEqual(st.premium_budget);
    expect(st.lp_shortfall).toBe(0n);
    expect(st.premium_paid).toBe(st.premium_accrued);
    expect(st.premium_paid).toBeGreaterThan(0n);
    // escrow accounts are closed and the owner got everything else back
    expect(await tokenAmount(await pdas.escrowQuote(strategy))).toBe(0n);

    const dQuote = Number((await tokenAmount(user.usdc)) - quoteBefore) / 1e6;
    const dBase = Number((await tokenAmount(user.wsol)) - baseBefore) / 1e9;
    const realizedNet = dQuote + dBase * crash; // net of premium, buffers and execution costs
    const theory = st0.legs.reduce((a, l) => a + putPayoff(l.liquidity, l.tick_lower, l.tick_upper, crash), 0);
    const premium = Number(st.premium_paid) / 1e6;
    const notional = st0.legs.reduce((a, l) => a + Number(l.removed_quote), 0) / 1e6;
    // realized gross payoff = net + premium; must match the CLMM payoff up to swap fees,
    // integer rounding and the 1e-4 price placement (bounded at 0.2% of notional)
    const gross = realizedNet + premium;
    console.log({ theory, gross, realizedNet, premium, swapIn: st.legs.map((l) => l.swap_in), notional });
    expect(theory).toBeGreaterThan(0);
    expect(Math.abs(gross - theory)).toBeLessThan(notional * 0.002);
    expect(gross).toBeLessThanOrEqual(theory + notional * 0.0005);
    void address;
  });
});
