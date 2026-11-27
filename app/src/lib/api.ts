/** Same-origin service calls (rewritten to the hosted services). */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path}: ${res.status} ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const d = data as { error?: string; detail?: unknown; code?: string };
    const msg = d?.code ? `${d.code}: ${d.error}` : d?.error ?? JSON.stringify(d?.detail ?? d);
    throw new Error(msg);
  }
  return data as T;
}

export type MarketParams = {
  floor_rate_bps: number;
  curve: { base_ppm: number; slope1_ppm: number; kink_ppm: number; slope2_ppm: number; cap_ppm: number };
  notice_period_s: number;
  restoration_buffer_bps: number;
  swap_slippage_bps: number;
  pool_deviation_bps: number;
  ref_max_age_s: number;
  open_tolerance_bps: number;
  keeper_trigger_bps: number;
  bounty_bps: number;
  max_ops_per_tx: number;
  max_buckets_per_strategy: number;
};

export type MarketInfo = {
  address: string;
  name: string;
  whirlpool: string;
  swapPool: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  tickSpacing: number;
  bucketWidth: number;
  poolPrice: number;
  tickCurrentIndex: number;
  reference: { kind: string; label: string; price: number; confBps: number; ageSeconds: number } | null;
  params: MarketParams;
  opensPaused: boolean;
  borrowPaused: boolean;
  unresolvedStrategies: number;
  outstandingLpShortfall: string;
  now: number;
};

export type BucketInfo = {
  address: string;
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  side: "below" | "above" | "spot";
  totalLiquidity: string;
  borrowed: string;
  reserved: string;
  withdrawalRequested: string;
  withdrawalNoticeStart: string;
  utilization: number;
  borrowable: string;
  premiumDistributed: string;
  feesCollectedBase: string;
  feesCollectedQuote: string;
  lpShortfall: string;
  forgoneMeasured: string;
  openLegs: number;
};

export type LegView = {
  kind_tag: number;
  bucket: string;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  removed_base: string;
  removed_quote: string;
  escrow_base: string;
  escrow_quote: string;
  buffer: string;
  multiplier_ppm: number;
  notional_quote: string;
  opened_at: string;
  cum_forgone_quote: string;
  premium: string;
  premium_distributed: string;
  executed: boolean;
  restored: boolean;
  swap_in: string;
  swap_out: string;
  provided_base: string;
  provided_quote: string;
  returned_base: string;
  returned_quote: string;
  fees_base: string;
  fees_quote: string;
  estimate: { forgone: string; premium: string };
};

export type StrategyView = {
  address: string;
  owner: string;
  market: string;
  nonce: string;
  state: "PendingOpen" | "Open" | "PendingClose" | "Recovery" | "Closed" | "Cancelled";
  created_at: string;
  opened_at: string;
  expiry: string;
  certificate_hash: string;
  premium_budget: string;
  bounty_reserve: string;
  premium_accrued: string;
  premium_paid: string;
  keeper_bounty_paid: string;
  lp_shortfall: string;
  close_by_keeper: boolean;
  cap_binding: boolean;
  aborting: boolean;
  fee_credit_base: string;
  fee_credit_quote: string;
  payout_base: string;
  payout_quote: string;
  budget_refund: string;
  settlement_reference_x64: string;
  closed_at: string;
  keeper_trigger_bps: number;
  legs: LegView[];
  accruedEstimate: string;
  lpCap: string;
  now: number;
};

export type LpView = {
  address: string;
  bucket: string;
  market: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  shareOfBucket: number;
  premiumOwedNow: string;
  premium_claimed: string;
  feesOwedBaseNow: string;
  feesOwedQuoteNow: string;
  fees_claimed_base: string;
  fees_claimed_quote: string;
  withdrawal_liquidity: string;
  withdrawal_requested_at: string;
};

export type Certificate = {
  hash: string;
  market: { whirlpool: string; base_decimals: number; quote_decimals: number; spot: number };
  target: { breakpoints: [number, number][]; domain: [number, number] };
  construction: { cash: number; base: number; legs: { kind: string; side: string; tick_lower: number; tick_upper: number; price_lower: number; price_upper: number; liquidity_onchain: number }[] };
  error: { max_gross_error: number; at_price: number; target_at: number; construction_at: number; rounding_bound: number; certified_bound: number };
  collateral: Record<string, number>;
  premium_budget: number;
  liquidity_check: { tick_lower: number; requested: number; borrowable: number; ok: boolean }[];
  simulation: Record<string, unknown> | null;
  disclaimer: string;
};

export type CompileResponse = {
  result: {
    status: "ok" | "infeasible";
    construction: null | {
      cash: number; base: number; spot: number; escrow_quote: number; escrow_base: number; buffer_quote: number;
      buffer_base: number; provided_quote: number; provided_base: number; capital_locked: number;
      legs: { kind: string; tick_lower: number; tick_upper: number; price_lower: number; price_upper: number; liquidity: number; liquidity_onchain: number }[];
    };
    sampled_max_error: number;
    reasons: string[];
    closest_feasible: [number, number][] | null;
    solve_seconds: number;
  };
  certificate: Certificate | null;
  tolerance: number;
};

export type Feasibility = { status: string; reasons: string[]; sampled_max_error: number; tolerance: number; legs: number; closest_feasible: [number, number][] | null };

export type BuiltTx = { transaction: string; computeUnits: number; computeUnitLimit: number; bytes: number; accounts: number };
