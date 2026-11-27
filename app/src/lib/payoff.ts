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
export const PRESETS: Record<string, { label: string; hint: string; make: (units: number, spot: number) => Point[] }> = {
  protective_put: {
    label: "Protective put",
    hint: "Hold the token, floor its value",
    make: (u, s) => {
      const f = 0.9 * s;
      return [[0.55 * s, u * f], [f, u * f], [1.6 * s, u * 1.6 * s]];
    },
  },
  collar: {
    label: "Collar",
    hint: "Floor below, cap above: the cap pays for the floor",
    make: (u, s) => {
      const f = 0.9 * s, c = 1.12 * s;
      return [[0.55 * s, u * f], [f, u * f], [c, u * c], [1.6 * s, u * c]];
    },
  },
  put_spread: {
    label: "Put spread",
    hint: "Protection between two levels",
    make: (u, s) => {
      const hi = 0.93 * s, lo = 0.8 * s;
      const f = (x: number) => u * x + u * Math.max(hi - x, 0) + u * Math.min(x, lo);
      return [0.55 * s, lo, hi, 1.6 * s].map((x) => [x, f(x)] as Point);
    },
  },
  call_spread: {
    label: "Call spread",
    hint: "Upside between two levels, base covers the short call",
    make: (u, s) => {
      const lo = 1.06 * s, hi = 1.2 * s;
      const f = (x: number) => (u / 2) * Math.max(x - lo, 0) + (u / 2) * Math.min(x, hi);
      return [0.55 * s, lo, hi, 1.6 * s].map((x) => [x, f(x)] as Point);
    },
  },
  strangle: {
    label: "Long strangle",
    hint: "Pays on a big move either way",
    make: (u, s) => {
      const p = 0.92 * s, c = 1.08 * s;
      return [[0.55 * s, u * (p - 0.55 * s)], [p, 0], [c, 0], [1.6 * s, u * (1.6 * s - c)]];
    },
  },
};
