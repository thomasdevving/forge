/** Client-side payoff math for display (same formulas as the verifier; settlement uses chain data). */

export type Point = [number, number];

export const tickPrice = (tick: number, bd = 9, qd = 6) => 1.0001 ** tick * 10 ** (bd - qd);

const KIND_TAG: Record<string, number> = { borrow_put: 0, borrow_call: 1, provide_put: 2, provide_call: 3 };
export const kindTag = (k: string | number) => (typeof k === "number" ? k : KIND_TAG[k] ?? -1);
export const KIND_LABEL: Record<number, string> = { 0: "Long put", 1: "Long call", 2: "Cash-secured put", 3: "Covered call" };
export const KIND_SIDE: Record<number, "borrowed" | "provided"> = { 0: "borrowed", 1: "borrowed", 2: "provided", 3: "provided" };

/** Frictionless payoff (quote, human) of one leg at closing price S. */
export function legPayoff(kind: string | number, tickLower: number, tickUpper: number, liquidityOnchain: number, S: number, bd = 9, qd = 6) {
  const L = liquidityOnchain * 10 ** (-(bd + qd) / 2);
  const ra = Math.sqrt(tickPrice(tickLower, bd, qd));
  const rb = Math.sqrt(tickPrice(tickUpper, bd, qd));
  const s = Math.min(Math.max(Math.sqrt(S), ra), rb);
  const V = L * (1 / s - 1 / rb) * S + L * (s - ra);
  switch (kindTag(kind)) {
    case 0: return L * (rb - ra) - V;
    case 1: return L * (1 / ra - 1 / rb) * S - V;
    default: return V;
  }
}

export function greeks(legs: { kind: string | number; tickLower: number; tickUpper: number; liquidity: number }[], S: number, bd = 9, qd = 6) {
  const val = (x: number) => legs.reduce((a, l) => a + legPayoff(l.kind, l.tickLower, l.tickUpper, l.liquidity, x, bd, qd), 0);
  const h = S * 1e-4;
  const up = val(S + h), mid = val(S), dn = val(S - h);
  return { value: mid, delta: (up - dn) / (2 * h), gamma: (up - 2 * mid + dn) / (h * h) };
}

export function interp(points: Point[], x: number): number {
  if (!points.length) return NaN;
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1]![1];
}

/** Presets: gross value of the position (collateral for short legs included), as in the compiler. */
/** One level of a preset, as a multiple of today's price (0.9 = 10% below). */
export type Level = { label: string; def: number; min: number; max: number };

/**
 * Starting payoffs. Each one is defined by one or two price levels (the floor, the cap, ...), so the
 * Studio's form and the chart describe the same thing: levels in, breakpoints out.
 */
export const PRESETS: Record<string, { label: string; hint: string; levels: Level[]; make: (units: number, spot: number, lv?: number[]) => Point[] }> = {
  protective_put: {
    label: "Protective put",
    hint: "Hold the token, floor its value",
    levels: [{ label: "Floor", def: 0.9, min: 0.6, max: 0.99 }],
    make: (u, s, lv = [0.9]) => {
      const f = lv[0]! * s;
      return [[0.55 * s, u * f], [f, u * f], [1.6 * s, u * 1.6 * s]];
    },
  },
  collar: {
    label: "Collar",
    hint: "Floor below, cap above: the cap pays for the floor",
    levels: [{ label: "Floor", def: 0.9, min: 0.6, max: 0.99 }, { label: "Cap", def: 1.12, min: 1.01, max: 1.55 }],
    make: (u, s, lv = [0.9, 1.12]) => {
      const f = lv[0]! * s, c = lv[1]! * s;
      return [[0.55 * s, u * f], [f, u * f], [c, u * c], [1.6 * s, u * c]];
    },
  },
  put_spread: {
    label: "Put spread",
    hint: "Protection between two levels",
    levels: [{ label: "Protect from", def: 0.93, min: 0.62, max: 0.99 }, { label: "Down to", def: 0.8, min: 0.6, max: 0.97 }],
    make: (u, s, lv = [0.93, 0.8]) => {
      const hi = lv[0]! * s, lo = lv[1]! * s;
      const f = (x: number) => u * x + u * Math.max(hi - x, 0) + u * Math.min(x, lo);
      return [0.55 * s, lo, hi, 1.6 * s].map((x) => [x, f(x)] as Point);
    },
  },
  call_spread: {
    label: "Call spread",
    hint: "Upside between two levels, base covers the short call",
    levels: [{ label: "Upside from", def: 1.06, min: 1.01, max: 1.5 }, { label: "Up to", def: 1.2, min: 1.03, max: 1.55 }],
    make: (u, s, lv = [1.06, 1.2]) => {
      const lo = lv[0]! * s, hi = lv[1]! * s;
      const f = (x: number) => (u / 2) * Math.max(x - lo, 0) + (u / 2) * Math.min(x, hi);
      return [0.55 * s, lo, hi, 1.6 * s].map((x) => [x, f(x)] as Point);
    },
  },
  strangle: {
    label: "Long strangle",
    hint: "Pays on a big move either way",
    levels: [{ label: "Pays below", def: 0.92, min: 0.6, max: 0.99 }, { label: "Pays above", def: 1.08, min: 1.01, max: 1.55 }],
    make: (u, s, lv = [0.92, 1.08]) => {
      const p = lv[0]! * s, c = lv[1]! * s;
      return [[0.55 * s, u * (p - 0.55 * s)], [p, 0], [c, 0], [1.6 * s, u * (1.6 * s - c)]];
    },
  },
};

/** The x of each interior breakpoint, in the order the preset's levels are listed. */
export const LEVEL_POINTS: Record<string, number[]> = { protective_put: [1], collar: [1, 2], put_spread: [2, 1], call_spread: [1, 2], strangle: [1, 2] };

/**
 * If `points` is still the preset's shape (any levels), its level prices; otherwise null. Lets a point
 * dragged sideways on the chart update the form, while a reshaped curve reads as custom. The spot the
 * shape was drawn at is read from its end points (they sit at 0.55× and 1.6×), since the live price moves.
 */
export function levelsOf(preset: string, points: Point[], units: number): number[] | null {
  const p = PRESETS[preset], idx = LEVEL_POINTS[preset];
  if (!p || !idx || points.length < 2) return null;
  const anchor = points[0]![0] / 0.55;
  if (!(anchor > 0) || Math.abs(points[points.length - 1]![0] - 1.6 * anchor) > anchor * 1e-6) return null;
  const lv = idx.map((i) => (points[i] ? points[i]![0] / anchor : NaN));
  if (lv.some((x) => !Number.isFinite(x))) return null;
  const want = p.make(units, anchor, lv);
  if (want.length !== points.length) return null;
  const scale = Math.max(1e-12, ...want.map((q) => Math.abs(q[1])));
  const same = want.every((q, i) => Math.abs(q[0] - points[i]![0]) <= anchor * 1e-6 && Math.abs(q[1] - points[i]![1]) <= scale * 0.004);
  return same ? lv.map((x) => x * anchor) : null;
}

/** Keeps level prices inside the preset's limits, and two-level spreads ordered at least 2% apart. */
export function clampLevels(preset: string, prices: number[], spot: number): number[] {
  const p = PRESETS[preset];
  if (!p) return prices;
  const out = prices.map((x, i) => Math.min(p.levels[i]!.max * spot, Math.max(p.levels[i]!.min * spot, x)));
  // the second level follows the first, whichever was moved
  if (preset === "put_spread") out[1] = Math.min(out[1]!, out[0]! * 0.98);
  if (preset === "call_spread") out[1] = Math.max(out[1]!, out[0]! * 1.02);
  return out;
}
