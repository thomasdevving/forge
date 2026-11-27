/**
 * Deterministic FORGE functions behind the Architect's tools: market data, liquidity, holdings, payoff
 * construction, compilation, verification and cost facts. Every number the Architect shows comes from
 * here (the indexer, the compiler, the verifier, the chain), never from the model.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as fv from "./fairvalue.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const cfg = {
  indexer: process.env.INDEXER_URL ?? "http://127.0.0.1:8787",
  compiler: process.env.COMPILER_URL ?? "http://127.0.0.1:8000",
  rpc: process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8899",
  movesDir: process.env.FORGE_MOVES_DIR ?? path.resolve(here, "../../../app/public/moves"),
};

export type Point = [number, number];

export type Market = {
  address: string; name: string; whirlpool: string; baseMint: string; quoteMint: string;
  baseDecimals: number; quoteDecimals: number; tickSpacing: number; bucketWidth: number; poolPrice: number;
  reference: { kind: string; price: number; confBps: number; ageSeconds: number } | null;
  params: {
    floor_rate_bps: number; keeper_trigger_bps: number; bounty_bps: number; max_buckets_per_strategy: number;
    open_tolerance_bps: number; swap_slippage_bps: number;
    curve: { base_ppm: number; slope1_ppm: number; kink_ppm: number; slope2_ppm: number; cap_ppm: number };
  };
  opensPaused: boolean; borrowPaused: boolean;
};

export type Bucket = {
  address: string; tickLower: number; tickUpper: number; priceLower: number; priceUpper: number;
  side: "below" | "above" | "spot"; totalLiquidity: string; borrowed: string; reserved: string;
  utilization: number; borrowable: string;
};

export type Leg = { kind: string; tick_lower: number; tick_upper: number; price_lower: number; price_upper: number; liquidity: number; liquidity_onchain: number };

export type CompileResponse = {
  result: {
    status: "ok" | "infeasible";
    construction: null | {
      cash: number; base: number; spot: number; escrow_quote: number; escrow_base: number; buffer_quote: number;
      buffer_base: number; provided_quote: number; provided_base: number; capital_locked: number; legs: Leg[];
    };
    sampled_max_error: number; reasons: string[]; closest_feasible: Point[] | null; solve_seconds: number;
  };
  certificate: null | {
    hash: string;
    error: { max_gross_error: number; at_price: number; certified_bound: number };
    liquidity_check: { tick_lower: number; requested: number; borrowable: number; ok: boolean }[];
    [k: string]: unknown;
  };
  tolerance: number;
};

async function http<T>(base: string, p: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(base + p, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

let marketCache: { at: number; list: Market[] } | null = null;
export async function markets(): Promise<Market[]> {
  if (marketCache && Date.now() - marketCache.at < 10_000) return marketCache.list;
  const list = await http<Market[]>(cfg.indexer, "/markets");
  marketCache = { at: Date.now(), list };
  return list;
}

export const baseSymbol = (m: Market) => m.name.split("/")[0]!;

/** Match "JUP", "jup/usdc", a market address or a base mint. */
export async function findMarket(query: string): Promise<Market> {
  const q = query.trim().toLowerCase().replace(/^\$/, "");
  const ms = await markets();
  const hit = ms.find((m) => m.name.toLowerCase() === q || baseSymbol(m).toLowerCase() === q || m.address.toLowerCase() === q || m.baseMint.toLowerCase() === q);
  if (!hit) throw new Error(`No FORGE market for "${query}". Supported: ${ms.map((m) => m.name).join(", ")}.`);
  return hit;
}

export const buckets = (m: Market) => http<Bucket[]>(cfg.indexer, `/markets/${m.address}/buckets`);

/** Historical price-move quantiles (end price / start price) for 1, 7 and 30 days, from Binance data. */
export function moveQuantiles(m: Market) {
  const f = path.join(cfg.movesDir, `${baseSymbol(m).toLowerCase()}.json`);
  if (!existsSync(f)) return null;
  const d = JSON.parse(readFileSync(f, "utf8")) as { source: string; from_ms: number; to_ms: number; horizons: Record<string, { samples: number; quantiles: Record<string, number> }> };
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    source: d.source,
    period: `${day(d.from_ms)} to ${day(d.to_ms)}`,
    horizons: Object.fromEntries(Object.entries(d.horizons).map(([h, v]) => [h, { samples: v.samples, ...v.quantiles }])),
  };
}

/** Token balances of an owner on the fork, for supported markets only (data minimization). */
export async function holdings(owner: string) {
  const ms = await markets();
  const byMint = new Map<string, { symbol: string; price: number }>();
  for (const m of ms) {
    byMint.set(m.baseMint, { symbol: baseSymbol(m), price: m.poolPrice });
    byMint.set(m.quoteMint, { symbol: m.name.split("/")[1]!, price: 1 });
  }
  const out: { symbol: string; mint: string; amount: number; usd_value: number }[] = [];
  for (const program of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    const r = await http<{ result?: { value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } }[] } }>(cfg.rpc, "", {
      jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { programId: program }, { encoding: "jsonParsed" }],
    });
    for (const a of r.result?.value ?? []) {
      const info = a.account.data.parsed.info;
      const known = byMint.get(info.mint);
      const amount = info.tokenAmount.uiAmount ?? 0;
      if (!known || amount <= 0) continue;
      const prev = out.find((o) => o.mint === info.mint);
      if (prev) { prev.amount += amount; prev.usd_value = prev.amount * known.price; }
      else out.push({ symbol: known.symbol, mint: info.mint, amount, usd_value: amount * known.price });
    }
  }
  return out.sort((a, b) => b.usd_value - a.usd_value);
}

export type Structure = "protective_put" | "collar" | "put_spread" | "custom";
export type PayoffSpec = {
  structure: Structure; units: number;
  floor_price?: number | null; cap_price?: number | null; lower_price?: number | null;
  points?: Point[] | null;
};

/**
 * Value (in quote) of the position as a function of price, as breakpoints. The holder keeps `units`
 * of the base token; the structure shapes what that holding is worth at each price.
 */
export function buildPayoff(spec: PayoffSpec, spot: number): Point[] {
  const u = spec.units;
  if (!(u > 0)) throw new Error("units must be positive");
  const need = (x: number | null | undefined, name: string) => {
    if (x == null || !(x > 0)) throw new Error(`${name} is required for ${spec.structure}`);
    return x;
  };
  const lowEdge = (x: number) => Math.min(0.55 * spot, 0.8 * x);
  const highEdge = (x: number) => Math.max(1.6 * spot, 1.25 * x);
  switch (spec.structure) {
    case "protective_put": {
      const f = need(spec.floor_price, "floor_price");
      if (f >= spot * 1.2) throw new Error("floor_price is far above spot; that is not protection");
      const lo = lowEdge(f), hi = highEdge(f);
      return [[lo, u * f], [f, u * f], [hi, u * hi]];
    }
    case "collar": {
      const f = need(spec.floor_price, "floor_price"), c = need(spec.cap_price, "cap_price");
      if (!(c > f)) throw new Error("cap_price must be above floor_price");
      const lo = lowEdge(f), hi = highEdge(c);
      return [[lo, u * f], [f, u * f], [c, u * c], [hi, u * c]];
    }
    case "put_spread": {
      const up = need(spec.floor_price, "floor_price"), low = need(spec.lower_price, "lower_price");
      if (!(low < up)) throw new Error("lower_price must be below floor_price");
      const lo = lowEdge(low), hi = highEdge(up);
      return [[lo, u * (lo + up - low)], [low, u * up], [up, u * up], [hi, u * hi]];
    }
    case "custom": {
      const pts = (spec.points ?? []).slice().sort((a, b) => a[0] - b[0]);
      if (pts.length < 2) throw new Error("custom needs at least two [price, value] points");
      if (pts.some(([p, v]) => !(p > 0) || !Number.isFinite(v))) throw new Error("points must have positive prices and finite values");
      return pts;
    }
  }
}

export function compileRequest(m: Market, bs: Bucket[], payoff: Point[], limits: { base: number; quote: number; budget: number }, extra: Record<string, unknown> = {}) {
  const borrowable: Record<string, string> = {};
  for (const b of bs) borrowable[String(b.tickLower)] = b.borrowable;
  return {
    payoff,
    spot: m.poolPrice,
    tick_spacing: m.tickSpacing,
    bucket_multiplier: m.bucketWidth / m.tickSpacing,
    n_each_side: Math.min(12, Math.ceil(bs.length / 2) + 2),
    borrowable,
    limits: { base_holdings: limits.base, quote_holdings: limits.quote, premium_budget: limits.budget, max_legs: m.params.max_buckets_per_strategy },
    market: { whirlpool: m.whirlpool, base_decimals: m.baseDecimals, quote_decimals: m.quoteDecimals },
    ...extra,
  };
}

export const compile = (req: unknown) => http<CompileResponse>(cfg.compiler, "/compile", req, 120_000);
export const verify = (cert: unknown) => http<{ valid: boolean; hash: string }>(cfg.compiler, "/verify", cert);
export const storeCertificate = (cert: unknown) => http<{ hash: string }>(cfg.compiler, "/certificates", cert);

/** The program's m(u) (premium multiplier on forgone fees) at a utilization. */
export function multiplier(m: Market, u: number) {
  const c = m.params.curve;
  const k = c.kink_ppm / 1e6;
  return u <= k ? c.base_ppm / 1e6 + (c.slope1_ppm / 1e6) * u : c.base_ppm / 1e6 + (c.slope1_ppm / 1e6) * k + (c.slope2_ppm / 1e6) * (u - k);
}

/**
 * Premium facts from the program's rules. Premium per borrowed leg is max(time floor, m(u) × forgone
 * fees): the floor is known ahead, forgone fees depend on future trading, and the total is capped by the
 * budget (the keeper closes the position at keeper_trigger_bps of the LP share of the budget).
 */
export function costFacts(m: Market, bs: Bucket[], legs: Leg[], budget: number) {
  const scale = 10 ** (-(m.baseDecimals + m.quoteDecimals) / 2);
  let notional = 0;
  const mults: number[] = [];
  for (const l of legs.filter((x) => x.kind.startsWith("borrow"))) {
    const ra = Math.sqrt(l.price_lower), rb = Math.sqrt(l.price_upper);
    const L = l.liquidity_onchain;
    notional += l.kind.endsWith("put") ? L * scale * (rb - ra) : L * scale * (1 / ra - 1 / rb) * m.poolPrice;
    const b = bs.find((x) => x.tickLower === l.tick_lower);
    if (b && BigInt(b.totalLiquidity) > 0n) {
      const u = Math.min(m.params.curve.cap_ppm / 1e6, (Number(BigInt(b.borrowed) + BigInt(b.reserved)) + L) / Number(BigInt(b.totalLiquidity)));
      mults.push(multiplier(m, u));
    }
  }
  const floorPerDay = (notional * m.params.floor_rate_bps) / 1e4 / 365;
  const lpCap = budget * (1 - m.params.bounty_bps / 1e4);
  const trigger = lpCap * (m.params.keeper_trigger_bps / 1e4);
  return {
    borrowed_notional_usd: notional,
    premium_floor_per_day_usd: floorPerDay,
    premium_multiplier_on_forgone_fees: mults.length ? Math.max(...mults) : null,
    premium_budget_usd: budget,
    keeper_closes_at_premium_usd: trigger,
    max_days_of_cover_at_floor_rate: floorPerDay > 0 ? trigger / floorPerDay : null,
    note: "Premium per borrowed range is the larger of the time floor and the multiplier times the trading fees the range would have earned. Fees depend on future trading, so only the floor is known now. The keeper closes the position when accrued premium reaches the trigger, so cover can end sooner than the floor-rate figure.",
  };
}

/**
 * Suggested premium budget for a holding period: per borrowed leg, the larger of the time floor and m(u) ×
 * the leg's fair value (expected payoff, lognormal with σ from the token's past moves), grossed up for the
 * keeper bounty and the keeper trigger. An estimate: the actual premium depends on future trading.
 */
export function budgetSuggestion(m: Market, bs: Bucket[], legs: Leg[], budget: number, days: number) {
  const q = moveQuantiles(m);
  const s = q ? fv.sigmaFromMoves(q.horizons as Record<string, { p5?: number; p95?: number }>, days) : null;
  if (!q || !s) return { holding_days: days, suggested_premium_budget_usd: null, sigma_annual: null, sigma_from: null, budget_below_suggestion: null };
  const r = fv.suggestedBudget({
    legs: legs.map((l) => ({ ...l, utilization: fv.legUtilization(l, bs, m.params.curve) })),
    spot: m.poolPrice, sigma: s.sigma, days, scale: fv.liquidityScale(m.baseDecimals, m.quoteDecimals), params: m.params,
  });
  return {
    holding_days: days,
    suggested_premium_budget_usd: Number(r.budget.toFixed(2)),
    expected_premium_usd: Number(r.expected_premium.toFixed(2)),
    borrowed_legs_fair_value_usd: Number(r.fair_value.toFixed(2)),
    sigma_annual: Number(s.sigma.toFixed(3)),
    sigma_from: `${s.horizon} move quantiles (p5/p95), ${q.source}, ${q.period}`,
    budget_below_suggestion: budget < r.budget,
    suggestion_note: "Estimate from the token's past moves, not a quote: per borrowed range the larger of the time floor and m(u) × the range's fair value over the holding period, grossed up for the keeper bounty and the keeper's close trigger. Actual premium depends on trading; the keeper closes the position when the budget is used.",
  };
}
