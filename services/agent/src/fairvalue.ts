/**
 * Fair value of borrowed concentrated-liquidity ranges and a suggested premium budget.
 *
 * Kept identical in services/agent/src/fairvalue.ts and app/src/lib/fairvalue.ts (pure, no imports).
 *
 * Premium per borrowed leg on-chain is max(time floor, m(u) × forgone Orca fees of that range). Expected
 * forgone fees track the value of the leg's own payoff (about 0.70–0.85× its Black–Scholes value from
 * arbitrage alone, more with other volume; benchmarks/research/2026-11-recent), so a budget of about
 * m(u) × fair value over the holding period keeps the keeper from closing the hedge as it starts paying off.
 * These are estimates from past price moves, not quotes: the actual premium depends on future trading.
 */

export type FvLeg = { kind: string; price_lower: number; price_upper: number; liquidity_onchain: number };
export type FvCurve = { base_ppm: number; slope1_ppm: number; kink_ppm: number; slope2_ppm: number; cap_ppm: number };
export type FvParams = { floor_rate_bps: number; bounty_bps: number; keeper_trigger_bps: number; curve: FvCurve };
export type FvBucket = { tickLower: number; totalLiquidity: string; borrowed: string; reserved: string };

/** Human units of base/quote per unit of on-chain liquidity × √price: 10^(−(baseDecimals + quoteDecimals)/2). */
export const liquidityScale = (baseDecimals: number, quoteDecimals: number) => 10 ** (-(baseDecimals + quoteDecimals) / 2);

/** Quote value at price P of a concentrated-liquidity position over [pa, pb] with (human-scaled) liquidity l. */
export function rangeValue(l: number, pa: number, pb: number, P: number): number {
  const ra = Math.sqrt(pa), rb = Math.sqrt(pb);
  if (P <= pa) return l * (1 / ra - 1 / rb) * P; // all base
  if (P >= pb) return l * (rb - ra); // all quote
  const rp = Math.sqrt(P);
  return l * (1 / rp - 1 / rb) * P + l * (rp - ra);
}

/**
 * What the borrower of a range holds at price P, in quote (≥ 0). Borrowing a quote-side range below spot
 * (borrow_put) removes Q = l(√pb − √pa) of quote and the borrower owes back the position: payoff Q − V(P).
 * Borrowing a base-side range above spot (borrow_call) removes B = l(1/√pa − 1/√pb) of base: payoff B·P − V(P).
 * Provided legs pay nothing to the borrower.
 */
export function legPayoff(leg: FvLeg, P: number, scale: number): number {
  const l = leg.liquidity_onchain * scale;
  const pa = leg.price_lower, pb = leg.price_upper;
  if (leg.kind === "borrow_put") return Math.max(0, l * (Math.sqrt(pb) - Math.sqrt(pa)) - rangeValue(l, pa, pb, P));
  if (leg.kind === "borrow_call") return Math.max(0, l * (1 / Math.sqrt(pa) - 1 / Math.sqrt(pb)) * P - rangeValue(l, pa, pb, P));
  return 0;
}

/**
 * Expected payoff at the horizon (r = 0, lognormal with annualized σ), by Simpson's rule over ±6σ with
 * 400 intervals. `scale` converts on-chain liquidity to human units (see liquidityScale).
 */
export function legFairValue(leg: FvLeg, spot: number, sigma: number, days: number, scale = 1): number {
  if (!leg.kind.startsWith("borrow")) return 0;
  const sd = sigma * Math.sqrt(Math.max(days, 0) / 365);
  if (!(sd > 0)) return legPayoff(leg, spot, scale);
  const n = 400, lo = -6, h = 12 / n;
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    const z = lo + i * h;
    const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    const P = spot * Math.exp(-0.5 * sd * sd + sd * z);
    acc += w * legPayoff(leg, P, scale) * Math.exp(-0.5 * z * z);
  }
  return (acc * h) / 3 / Math.sqrt(2 * Math.PI);
}

const Z95 = 1.6449;
const HORIZON_DAYS: Record<string, number> = { "1d": 1, "7d": 7, "30d": 30 };

/**
 * Annualized σ from historical move quantiles (end/start price ratios), using the horizon closest to the
 * holding period: σ = (ln p95 − ln p5) / (2 × 1.6449) / √(horizonDays / 365).
 */
export function sigmaFromMoves(quantiles: Record<string, { p5?: number; p95?: number }>, days: number): { sigma: number; horizon: string } | null {
  const hs = Object.keys(quantiles).filter((h) => HORIZON_DAYS[h] && quantiles[h]!.p5! > 0 && quantiles[h]!.p95! > 0);
  if (!hs.length) return null;
  const h = hs.reduce((a, b) => (Math.abs(HORIZON_DAYS[b]! - days) < Math.abs(HORIZON_DAYS[a]! - days) ? b : a));
  const q = quantiles[h]!;
  const sigma = (Math.log(q.p95!) - Math.log(q.p5!)) / (2 * Z95) / Math.sqrt(HORIZON_DAYS[h]! / 365);
  return sigma > 0 ? { sigma, horizon: h } : null;
}

/** The program's m(u): base + slope1·u up to the kink, then + slope2·(u − kink). */
export function multiplier(curve: FvCurve, u: number): number {
  const k = curve.kink_ppm / 1e6;
  const m = curve.base_ppm / 1e6;
  return u <= k ? m + (curve.slope1_ppm / 1e6) * u : m + (curve.slope1_ppm / 1e6) * k + (curve.slope2_ppm / 1e6) * (u - k);
}

/** Utilization of a leg's bucket once this leg is borrowed, capped at the program's cap. Null if the bucket is unknown or empty. */
export function legUtilization(leg: FvLeg & { tick_lower: number }, buckets: FvBucket[], curve: FvCurve): number | null {
  const b = buckets.find((x) => x.tickLower === leg.tick_lower);
  if (!b || !(BigInt(b.totalLiquidity) > 0n)) return null;
  const used = Number(BigInt(b.borrowed) + BigInt(b.reserved)) + leg.liquidity_onchain;
  return Math.min(curve.cap_ppm / 1e6, used / Number(BigInt(b.totalLiquidity)));
}

/**
 * Suggested premium budget for holding `days`. Per borrowed leg: max(floor rate × notional × days/365,
 * m(u) × leg fair value). The keeper closes at keeper_trigger_bps of the LP share of the budget and the
 * bounty share is reserved for the keeper, so the sum is grossed up by both.
 */
export function suggestedBudget(a: {
  legs: (FvLeg & { utilization: number | null })[];
  spot: number; sigma: number; days: number; scale: number; params: FvParams;
}) {
  let floor = 0, fees = 0, expected = 0, fair = 0, mMax = 0;
  for (const l of a.legs.filter((x) => x.kind.startsWith("borrow"))) {
    const s = a.scale * l.liquidity_onchain;
    const ra = Math.sqrt(l.price_lower), rb = Math.sqrt(l.price_upper);
    const notional = l.kind === "borrow_put" ? s * (rb - ra) : s * (1 / ra - 1 / rb) * a.spot;
    const legFloor = notional * (a.params.floor_rate_bps / 1e4) * (a.days / 365);
    const fv = legFairValue(l, a.spot, a.sigma, a.days, a.scale);
    const m = multiplier(a.params.curve, l.utilization ?? 0);
    floor += legFloor;
    fair += fv;
    fees += m * fv;
    expected += Math.max(legFloor, m * fv);
    mMax = Math.max(mMax, m);
  }
  const lpShare = 1 - a.params.bounty_bps / 1e4;
  const trigger = a.params.keeper_trigger_bps / 1e4;
  const budget = expected > 0 ? expected / lpShare / trigger : 0;
  return { budget, expected_premium: expected, floor_premium: floor, fair_value: fair, multiplier_times_fair_value: fees, multiplier_max: mMax };
}
