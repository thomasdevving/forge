/**
 * Generate golden vectors from Orca's own math library (@orca-so/whirlpools-core, pinned)
 * so the Python port (math/forge_math/orca.py) and the on-chain Rust port can be checked
 * against it bit for bit. Deterministic: a fixed seed drives every random input.
 *
 * Usage: pnpm --filter @forge/fork vectors
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectFeesQuote,
  decreaseLiquidityQuote,
  increaseLiquidityQuote,
  sqrtPriceToTickIndex,
  tickIndexToSqrtPrice,
  tryGetAmountDeltaA,
  tryGetAmountDeltaB,
} from "@orca-so/whirlpools-core";

const SEED = 0x5eed_f0e6n;
const MIN_TICK = -443636;
const MAX_TICK = 443636;
const U128 = 1n << 128n;

// splitmix64: small, deterministic, and easy to reproduce in any language
let state = SEED;
function next64(): bigint {
  state = (state + 0x9e3779b97f4a7c15n) & 0xffff_ffff_ffff_ffffn;
  let z = state;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffff_ffff_ffff_ffffn;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffff_ffff_ffff_ffffn;
  return z ^ (z >> 31n);
}
const randBits = (bits: number): bigint => {
  let v = 0n;
  for (let i = 0; i < bits; i += 64) v = (v << 64n) | next64();
  return v & ((1n << BigInt(bits)) - 1n);
};
const randInt = (lo: number, hi: number): number =>
  lo + Number(next64() % BigInt(hi - lo + 1));
const randTick = (spacing = 1): number => {
  const t = randInt(MIN_TICK, MAX_TICK);
  return Math.trunc(t / spacing) * spacing;
};
const randU128 = (): bigint => randBits(128);
const randLiquidity = (): bigint => randBits(randInt(1, 100));

type Vec = Record<string, string | number | boolean | null>;
const s = (v: bigint) => v.toString();
function attempt<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

const out: Record<string, Vec[]> = {
  tick_to_sqrt: [],
  sqrt_to_tick: [],
  amount_delta_a: [],
  amount_delta_b: [],
  increase_quote: [],
  decrease_quote: [],
  collect_fees: [],
};

// Tick <-> sqrt price, including every power-of-two boundary and the extremes.
const edgeTicks = [MIN_TICK, MAX_TICK, 0, 1, -1];
for (let b = 1; b <= 262144; b *= 2) edgeTicks.push(b, -b, b - 1, -(b - 1));
for (let i = 0; i < 1000; i++) edgeTicks.push(randTick());
for (const t of edgeTicks) {
  if (t < MIN_TICK || t > MAX_TICK) continue;
  out.tick_to_sqrt!.push({ tick: t, sqrt_price: s(tickIndexToSqrtPrice(t)) });
}
for (let i = 0; i < 1000; i++) {
  const t = randTick();
  const lo = tickIndexToSqrtPrice(t);
  const hi = t < MAX_TICK ? tickIndexToSqrtPrice(t + 1) : lo + 1n;
  const span = hi - lo;
  const sp = span > 1n ? lo + (randBits(64) % span) : lo;
  out.sqrt_to_tick!.push({ sqrt_price: s(sp), tick: sqrtPriceToTickIndex(sp) });
}

// Token deltas, with both rounding modes and overflow cases.
for (let i = 0; i < 1500; i++) {
  const p0 = tickIndexToSqrtPrice(randTick());
  const p1 = tickIndexToSqrtPrice(randTick());
  const L = randLiquidity();
  const up = (next64() & 1n) === 1n;
  const a = attempt(() => tryGetAmountDeltaA(p0, p1, L, up));
  const b = attempt(() => tryGetAmountDeltaB(p0, p1, L, up));
  out.amount_delta_a!.push({ p0: s(p0), p1: s(p1), liquidity: s(L), round_up: up, amount: a === null ? null : s(a) });
  out.amount_delta_b!.push({ p0: s(p0), p1: s(p1), liquidity: s(L), round_up: up, amount: b === null ? null : s(b) });
}

// Liquidity quotes with zero slippage: token estimates equal Orca's on-chain deltas.
for (let i = 0; i < 1500; i++) {
  const spacing = [1, 4, 8, 64, 128][randInt(0, 4)]!;
  let lo = randTick(spacing);
  let hi = randTick(spacing);
  if (lo === hi) continue;
  if (lo > hi) [lo, hi] = [hi, lo];
  // bias the current price toward the range so all three regimes are exercised
  const cur = randInt(0, 2) === 0 ? randTick() : randInt(lo - spacing * 5, hi + spacing * 5);
  if (cur < MIN_TICK || cur > MAX_TICK) continue;
  const sp = tickIndexToSqrtPrice(cur) + (randInt(0, 1) ? 0n : randBits(20));
  const tickCur = sqrtPriceToTickIndex(sp);
  const L = randBits(randInt(1, 80)) + 1n;
  const inc = attempt(() => increaseLiquidityQuote(L, 0, sp, lo, hi));
  const dec = attempt(() => decreaseLiquidityQuote(L, 0, sp, lo, hi));
  const base = { sqrt_price: s(sp), tick_current: tickCur, tick_lower: lo, tick_upper: hi, liquidity: s(L) };
  out.increase_quote!.push({ ...base, a: inc ? s(inc.tokenEstA) : null, b: inc ? s(inc.tokenEstB) : null });
  out.decrease_quote!.push({ ...base, a: dec ? s(dec.tokenEstA) : null, b: dec ? s(dec.tokenEstB) : null });
}

// Fee growth inside and fees owed, with wrapping growth values.
for (let i = 0; i < 1200; i++) {
  let lo = randTick(4);
  let hi = randTick(4);
  if (lo === hi) continue;
  if (lo > hi) [lo, hi] = [hi, lo];
  const cur = randInt(0, 2) === 0 ? randTick() : randInt(lo - 40, hi + 40);
  if (cur < MIN_TICK || cur > MAX_TICK) continue;
  const tick = (init: boolean) => ({
    initialized: init,
    liquidityNet: 0n,
    liquidityGross: init ? 1n : 0n,
    feeGrowthOutsideA: init ? randU128() : 0n,
    feeGrowthOutsideB: init ? randU128() : 0n,
    rewardGrowthsOutside: [0n, 0n, 0n],
  });
  // Positions holding liquidity always have initialized boundary ticks. The SDK quote ignores
  // the initialized flag, so only that realistic case is compared here; the program's
  // uninitialized-tick branch is tested directly in math/tests/test_orca.py.
  const tl = tick(true);
  const tu = tick(true);
  const L = randBits(randInt(1, 64));
  const whirlpool = {
    feeTierIndexSeed: new Uint8Array([4, 0]),
    tickSpacing: 4,
    feeRate: 400,
    protocolFeeRate: 1300,
    liquidity: 1n,
    sqrtPrice: tickIndexToSqrtPrice(cur),
    tickCurrentIndex: cur,
    feeGrowthGlobalA: randU128(),
    feeGrowthGlobalB: randU128(),
    rewardLastUpdatedTimestamp: 0n,
    rewardInfos: [0, 1, 2].map(() => ({ emissionsPerSecondX64: 0n, growthGlobalX64: 0n })),
  };
  // Independent wrapping computation of growth inside, used only to place each checkpoint a
  // realistic distance (delta * L < 2^128) below it. The comparison target is Orca's quote.
  const wrap = (v: bigint) => ((v % U128) + U128) % U128;
  const inside = (g: bigint, lo_o: bigint, hi_o: bigint) => {
    const below = cur < lo ? wrap(g - lo_o) : lo_o;
    const above = cur >= hi ? wrap(g - hi_o) : hi_o;
    return wrap(g - below - above);
  };
  const lBits = L === 0n ? 0 : L.toString(2).length;
  const deltaBits = Math.max(1, Math.min(127, 127 - lBits));
  const position = {
    liquidity: L,
    tickLowerIndex: lo,
    tickUpperIndex: hi,
    feeGrowthCheckpointA: wrap(
      inside(whirlpool.feeGrowthGlobalA, tl.feeGrowthOutsideA, tu.feeGrowthOutsideA) - randBits(deltaBits),
    ),
    feeOwedA: 0n,
    feeGrowthCheckpointB: wrap(
      inside(whirlpool.feeGrowthGlobalB, tl.feeGrowthOutsideB, tu.feeGrowthOutsideB) - randBits(deltaBits),
    ),
    feeOwedB: 0n,
    rewardInfos: [0, 1, 2].map(() => ({ growthInsideCheckpoint: 0n, amountOwed: 0n })),
  };
  const q = attempt(() => collectFeesQuote(whirlpool, position, tl, tu));
  out.collect_fees!.push({
    tick_current: cur, tick_lower: lo, tick_upper: hi, liquidity: s(L),
    lower_init: tl.initialized, lower_out_a: s(tl.feeGrowthOutsideA), lower_out_b: s(tl.feeGrowthOutsideB),
    upper_init: tu.initialized, upper_out_a: s(tu.feeGrowthOutsideA), upper_out_b: s(tu.feeGrowthOutsideB),
    global_a: s(whirlpool.feeGrowthGlobalA), global_b: s(whirlpool.feeGrowthGlobalB),
    checkpoint_a: s(position.feeGrowthCheckpointA), checkpoint_b: s(position.feeGrowthCheckpointB),
    owed_a: q ? s(q.feeOwedA) : null, owed_b: q ? s(q.feeOwedB) : null,
  });
}


const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../math/tests/fixtures/orca_core_vectors.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  JSON.stringify({ source: "@orca-so/whirlpools-core@3.1.0", seed: s(SEED), vectors: out }) + "\n",
);
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
console.log(`wrote ${target}`, counts);
