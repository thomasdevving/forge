import { describe, expect, it } from "vitest";
import { legFairValue, legPayoff, multiplier, sigmaFromMoves, suggestedBudget } from "../src/fairvalue.js";

// human-scaled liquidity (scale = 1) on a range [4, 9]: √pa = 2, √pb = 3
const L = 1000;
const put = { kind: "borrow_put", price_lower: 4, price_upper: 9, liquidity_onchain: L };
const call = { kind: "borrow_call", price_lower: 4, price_upper: 9, liquidity_onchain: L };
const Q = L * (3 - 2); // removed quote
const B = L * (1 / 2 - 1 / 3); // removed base

describe("legPayoff closed forms", () => {
  it("borrow_put: Q − V(P)", () => {
    expect(legPayoff(put, 1, 1)).toBeCloseTo(Q - B * 1, 9); // below: all base
    expect(legPayoff(put, 6.25, 1)).toBeCloseTo(Q - L * (2 * 2.5 - 6.25 / 3 - 2), 9); // inside: V = l(2√P − P/√pb − √pa)
    expect(legPayoff(put, 9, 1)).toBeCloseTo(0, 9);
    expect(legPayoff(put, 20, 1)).toBe(0);
  });
  it("borrow_call: B·P − V(P)", () => {
    expect(legPayoff(call, 3, 1)).toBeCloseTo(0, 9);
    expect(legPayoff(call, 6.25, 1)).toBeCloseTo(B * 6.25 - L * (2 * 2.5 - 6.25 / 3 - 2), 9);
    expect(legPayoff(call, 16, 1)).toBeCloseTo(B * 16 - Q, 9); // above: all quote
  });
  it("provided legs pay nothing", () => {
    expect(legPayoff({ ...put, kind: "provide_put" }, 1, 1)).toBe(0);
    expect(legFairValue({ ...call, kind: "provide_call" }, 6, 0.8, 30, 1)).toBe(0);
  });
  it("applies the liquidity scale", () => {
    expect(legPayoff({ ...put, liquidity_onchain: L * 1e6 }, 1, 1e-6)).toBeCloseTo(legPayoff(put, 1, 1), 6);
  });
});

// Black–Scholes, r = 0
const ncdf = (x: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
};
const bs = (S: number, K: number, sd: number, isCall: boolean) => {
  const d1 = (Math.log(S / K) + sd * sd / 2) / sd, d2 = d1 - sd;
  return isCall ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
};
// a borrowed range is a strip of options with density l / (2 K^{3/2}) over [pa, pb]
const strip = (S: number, sd: number, isCall: boolean) => {
  const n = 2000, h = (9 - 4) / n;
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    const K = 4 + i * h;
    acc += (i === 0 || i === n ? 0.5 : 1) * (L / (2 * K ** 1.5)) * bs(S, K, sd, isCall);
  }
  return acc * h;
};

describe("legFairValue", () => {
  const sigma = 0.9, days = 30, sd = sigma * Math.sqrt(days / 365);
  it("matches a Black–Scholes strip of puts and calls", () => {
    for (const S of [5, 6.5, 8]) {
      expect(legFairValue(put, S, sigma, days, 1)).toBeCloseTo(strip(S, sd, false), 1);
      expect(legFairValue(call, S, sigma, days, 1)).toBeCloseTo(strip(S, sd, true), 1);
    }
  });
  it("is the intrinsic payoff at zero volatility", () => {
    expect(legFairValue(put, 3, 0, 30, 1)).toBeCloseTo(legPayoff(put, 3, 1), 9);
  });
});

describe("sigmaFromMoves and suggestedBudget", () => {
  const q = { "1d": { p5: 0.95, p95: 1.05 }, "7d": { p5: 0.82, p95: 1.2 }, "30d": { p5: 0.65, p95: 1.45 } };
  it("uses the closest horizon", () => {
    const s = sigmaFromMoves(q, 30)!;
    expect(s.horizon).toBe("30d");
    expect(s.sigma).toBeCloseTo((Math.log(1.45) - Math.log(0.65)) / (2 * 1.6449) / Math.sqrt(30 / 365), 9);
    expect(sigmaFromMoves(q, 5)!.horizon).toBe("7d");
    expect(sigmaFromMoves({}, 30)).toBeNull();
  });
  const curve = { base_ppm: 1_000_000, slope1_ppm: 1_000_000, kink_ppm: 600_000, slope2_ppm: 6_000_000, cap_ppm: 800_000 };
  it("multiplier follows the program's curve", () => {
    expect(multiplier(curve, 0.5)).toBeCloseTo(1.5, 9);
    expect(multiplier(curve, 0.7)).toBeCloseTo(1 + 0.6 + 0.6, 9);
  });
  it("grosses up m(u) × fair value for the bounty and the keeper trigger, never below the floor", () => {
    const params = { floor_rate_bps: 500, bounty_bps: 100, keeper_trigger_bps: 8000, curve };
    const r = suggestedBudget({ legs: [{ ...put, utilization: 0.5 }, { ...put, kind: "provide_call", utilization: null }], spot: 6.5, sigma: 0.9, days: 30, scale: 1, params });
    const fv = legFairValue(put, 6.5, 0.9, 30, 1);
    expect(r.fair_value).toBeCloseTo(fv, 9);
    expect(r.budget).toBeCloseTo(Math.max(r.floor_premium, 1.5 * fv) / 0.99 / 0.8, 6);
    const far = suggestedBudget({ legs: [{ ...put, utilization: 0 }], spot: 40, sigma: 0.3, days: 30, scale: 1, params });
    expect(far.budget).toBeCloseTo(far.floor_premium / 0.99 / 0.8, 9);
  });
});
