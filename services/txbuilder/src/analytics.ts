/**
 * Read-side analytics shared by the indexer and the app. Every number comes from chain state
 * (pool, ticks, strategy accounts) or the program's own formulas; nothing is invented.
 */
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { tickIndexToSqrtPrice } from "@orca-so/whirlpools-core";
import type { Leg, Market, Strategy } from "./accounts.js";
import { fetchRaw } from "./accounts.js";
import { pdas } from "./program.js";
import { type PoolState, TICK_ARRAY_SIZE, tickArrayStart } from "./orca.js";

const U128 = 1n << 128n;
const Q64 = 1n << 64n;
const FIXED_DISC = [69, 97, 189, 190, 110, 7, 66, 187];
const DYNAMIC_DISC = [17, 216, 246, 142, 225, 199, 218, 56];

export type TickInfo = { initialized: boolean; liquidityNet: bigint; outsideA: bigint; outsideB: bigint };

const le = (b: Uint8Array, o: number, n: number, signed = false) => {
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]!);
  if (signed && v >= 1n << BigInt(n * 8 - 1)) v -= 1n << BigInt(n * 8);
  return v;
};

/** Decode every tick of a fixed or dynamic tick array. */
export function decodeTickArray(d: Uint8Array): { start: number; ticks: TickInfo[] } {
  const start = Number(le(d, 8, 4, true));
  const isFixed = FIXED_DISC.every((x, i) => d[i] === x);
  const isDyn = DYNAMIC_DISC.every((x, i) => d[i] === x);
  if (!isFixed && !isDyn) throw new Error("not a tick array");
  const ticks: TickInfo[] = [];
  if (isFixed) {
    for (let k = 0; k < TICK_ARRAY_SIZE; k++) {
      const o = 12 + 113 * k;
      ticks.push({ initialized: d[o] !== 0, liquidityNet: le(d, o + 1, 16, true), outsideA: le(d, o + 33, 16), outsideB: le(d, o + 49, 16) });
    }
  } else {
    let o = 60;
    for (let k = 0; k < TICK_ARRAY_SIZE; k++) {
      if (d[o] === 0) {
        ticks.push({ initialized: false, liquidityNet: 0n, outsideA: 0n, outsideB: 0n });
        o += 1;
      } else {
        ticks.push({ initialized: true, liquidityNet: le(d, o + 1, 16, true), outsideA: le(d, o + 33, 16), outsideB: le(d, o + 49, 16) });
        o += 113;
      }
    }
  }
  return { start, ticks };
}

async function tickAt(rpc: Rpc<SolanaRpcApi>, pool: PoolState, tick: number): Promise<TickInfo> {
  const start = tickArrayStart(tick, pool.tickSpacing);
  const raw = await fetchRaw(rpc, await pdas.tickArray(pool.address, start));
  if (!raw) return { initialized: false, liquidityNet: 0n, outsideA: 0n, outsideB: 0n };
  return decodeTickArray(raw).ticks[(tick - start) / pool.tickSpacing]!;
}

/** Orca fee growth inside [lower, upper), wrapping Q64.64 (same as the program). */
export async function feeGrowthInside(rpc: Rpc<SolanaRpcApi>, pool: PoolState, lower: number, upper: number): Promise<[bigint, bigint]> {
  const lo = await tickAt(rpc, pool, lower);
  const hi = await tickAt(rpc, pool, upper);
  const wrap = (v: bigint) => ((v % U128) + U128) % U128;
  const inside = (g: bigint, lo_o: bigint, hi_o: bigint) => {
    const below = !lo.initialized ? g : pool.tickCurrentIndex < lower ? wrap(g - lo_o) : lo_o;
    const above = !hi.initialized ? 0n : pool.tickCurrentIndex < upper ? hi_o : wrap(g - hi_o);
    return wrap(g - below - above);
  };
  return [inside(pool.feeGrowthGlobalA, lo.outsideA, hi.outsideA), inside(pool.feeGrowthGlobalB, lo.outsideB, hi.outsideB)];
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Live premium estimate for one borrowed leg: the program's formula at current growth. */
export async function estimateLegPremium(rpc: Rpc<SolanaRpcApi>, m: Market, pool: PoolState, s: Strategy, leg: Leg, refPriceX64: bigint, now: number) {
  if (!leg.executed || leg.restored || leg.kind_tag > 1) return { forgone: leg.cum_forgone_quote, premium: leg.premium };
  const [ga, gb] = await feeGrowthInside(rpc, pool, leg.tick_lower, leg.tick_upper);
  const fa = ceilDiv(((ga - leg.growth_a_x64 + U128) % U128) * leg.liquidity, Q64);
  const fb = ceilDiv(((gb - leg.growth_b_x64 + U128) % U128) * leg.liquidity, Q64);
  const [baseFees, quoteFees] = m.base_is_a ? [fa, fb] : [fb, fa];
  const forgone = leg.cum_forgone_quote + quoteFees + ceilDiv(baseFees * refPriceX64, Q64);
  const elapsed = BigInt(Math.max(0, now - Number(leg.opened_at)));
  const floor = ceilDiv(leg.notional_quote * BigInt(s.floor_rate_bps) * elapsed, 10_000n * 31_536_000n);
  const scaled = ceilDiv(BigInt(leg.multiplier_ppm) * forgone, 1_000_000n);
  return { forgone, premium: floor > scaled ? floor : scaled };
}

// ---------------------------------------------------------------- payoff and Greeks (human units)

export type LegShape = { kind_tag: number; tick_lower: number; tick_upper: number; liquidity: bigint };
const humanPrice = (tick: number, bd: number, qd: number) => 1.0001 ** tick * 10 ** (bd - qd);

/** Payoff of one leg at closing price S (quote, human units), frictionless (section 3). */
export function legPayoff(l: LegShape, S: number, bd = 9, qd = 6): number {
  const L = Number(l.liquidity) * 10 ** (-(bd + qd) / 2);
  const pa = humanPrice(l.tick_lower, bd, qd);
  const pb = humanPrice(l.tick_upper, bd, qd);
  const ra = Math.sqrt(pa), rb = Math.sqrt(pb);
  const s = Math.min(Math.max(Math.sqrt(S), ra), rb);
  const V = L * (1 / s - 1 / rb) * S + L * (s - ra);
  if (l.kind_tag === 0) return L * (rb - ra) - V; // long put
  if (l.kind_tag === 1) return L * (1 / ra - 1 / rb) * S - V; // long call
  return V; // provided
}

/** Delta (base units) and gamma (base per quote) of a leg at S by central differences. */
export function legGreeks(l: LegShape, S: number, bd = 9, qd = 6) {
  const h = S * 1e-4;
  const up = legPayoff(l, S + h, bd, qd), mid = legPayoff(l, S, bd, qd), dn = legPayoff(l, S - h, bd, qd);
  return { value: mid, delta: (up - dn) / (2 * h), gamma: (up - 2 * mid + dn) / (h * h) };
}

// ---------------------------------------------------------------- out-of-range liquidity

/**
 * Value of Orca liquidity sitting out of range (earning no fees), from the pool's live tick
 * arrays within `arraysEachSide` arrays of the current price. Returns quote-valued totals and
 * the scanned price window so the UI states exactly what was measured.
 */
export async function outOfRangeLiquidity(rpc: Rpc<SolanaRpcApi>, pool: PoolState, priceQuotePerBase: number, arraysEachSide = 6, bd = 9, qd = 6) {
  const span = pool.tickSpacing * TICK_ARRAY_SIZE;
  const center = tickArrayStart(pool.tickCurrentIndex, pool.tickSpacing);
  const lowStart = center - arraysEachSide * span;
  const ticks: { tick: number; net: bigint }[] = [];
  for (let k = -arraysEachSide; k <= arraysEachSide; k++) {
    const start = center + k * span;
    const raw = await fetchRaw(rpc, await pdas.tickArray(pool.address, start));
    if (!raw) continue;
    const ta = decodeTickArray(raw);
    ta.ticks.forEach((t, i) => {
      if (t.initialized) ticks.push({ tick: start + i * pool.tickSpacing, net: t.liquidityNet });
    });
  }
  ticks.sort((a, b) => a.tick - b.tick);
  // Liquidity is piecewise constant between initialized ticks: walking up, add liquidity_net.
  // Liquidity that starts below the scanned window is unknown, so the walk begins at the
  // pool's active liquidity and works outward from the current tick in both directions.
  const scale = 10 ** (-(bd + qd) / 2);
  const above = ticks.filter((t) => t.tick > pool.tickCurrentIndex);
  const below = ticks.filter((t) => t.tick <= pool.tickCurrentIndex).reverse();
  let outQuote = 0;
  let outBase = 0;
  // upward: segments [t_i, t_{i+1}) above the current segment hold base
  let L = pool.liquidity;
  for (let i = 0; i < above.length - 1; i++) {
    L += above[i]!.net;
    if (L <= 0n) continue;
    const pa = humanPrice(above[i]!.tick, bd, qd), pb = humanPrice(above[i + 1]!.tick, bd, qd);
    outBase += Number(L) * scale * (1 / Math.sqrt(pa) - 1 / Math.sqrt(pb)) * priceQuotePerBase;
  }
  // downward: crossing a tick downward subtracts its liquidity_net; segments below hold quote
  L = pool.liquidity;
  for (let i = 0; i < below.length - 1; i++) {
    L -= below[i]!.net;
    if (L <= 0n) continue;
    const pa = humanPrice(below[i + 1]!.tick, bd, qd), pb = humanPrice(below[i]!.tick, bd, qd);
    outQuote += Number(L) * scale * (Math.sqrt(pb) - Math.sqrt(pa));
  }
  return {
    window: { low: humanPrice(lowStart, bd, qd), high: humanPrice(center + (arraysEachSide + 1) * span, bd, qd) },
    outOfRangeQuoteValue: outQuote + outBase,
    belowPriceQuote: outQuote,
    abovePriceBaseValued: outBase,
    activeLiquidity: pool.liquidity.toString(),
  };
}
