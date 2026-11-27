import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { decodeAccount } from "./idl.js";

export type UtilizationCurve = { base_ppm: number; slope1_ppm: number; kink_ppm: number; slope2_ppm: number; cap_ppm: number };
export type MarketParams = {
  floor_rate_bps: number;
  curve: UtilizationCurve;
  notice_period_s: number;
  restoration_buffer_bps: number;
  swap_slippage_bps: number;
  pool_deviation_bps: number;
  ref_max_age_s: number;
  ref_max_conf_bps: number;
  open_tolerance_bps: number;
  pending_open_deadline_s: number;
  keeper_trigger_bps: number;
  bounty_bps: number;
  max_ops_per_tx: number;
  max_buckets_per_strategy: number;
};
export type ReferenceConfig = {
  kind: "PythPair" | "ForkScenario";
  base_account: Address;
  quote_account: Address;
  base_feed_id: Uint8Array;
  quote_feed_id: Uint8Array;
};
export type Market = {
  admin: Address;
  whirlpool: Address;
  swap_pool: Address;
  base_mint: Address;
  quote_mint: Address;
  base_is_a: boolean;
  base_decimals: number;
  quote_decimals: number;
  tick_spacing: number;
  bucket_width: number;
  reference: ReferenceConfig;
  params: MarketParams;
  premium_vault: Address;
  opens_paused: boolean;
  borrow_paused: boolean;
  strategy_count: bigint;
  unresolved_strategies: number;
  outstanding_lp_shortfall: bigint;
  bump: number;
  vault_bump: number;
};
export type Bucket = {
  market: Address;
  tick_lower: number;
  tick_upper: number;
  position_mint: Address;
  position: Address;
  position_token_account: Address;
  total_liquidity: bigint;
  borrowed: bigint;
  reserved: bigint;
  withdrawal_requested: bigint;
  withdrawal_notice_start: bigint;
  premium_index_x64: bigint;
  premium_remainder_x64: bigint;
  premium_distributed: bigint;
  fee_index_a_x64: bigint;
  fee_index_b_x64: bigint;
  lp_shortfall_quote: bigint;
  open_legs: number;
};
export type Leg = {
  kind_tag: number;
  bucket: Address;
  tick_lower: number;
  tick_upper: number;
  liquidity: bigint;
  removed_base: bigint;
  removed_quote: bigint;
  escrow_base: bigint;
  escrow_quote: bigint;
  buffer: bigint;
  multiplier_ppm: number;
  notional_quote: bigint;
  opened_at: bigint;
  growth_a_x64: bigint;
  growth_b_x64: bigint;
  cum_forgone_quote: bigint;
  premium: bigint;
  premium_distributed: bigint;
  last_checkpoint_ts: bigint;
  executed: boolean;
  restored: boolean;
  restored_at: bigint;
  swap_in: bigint;
  swap_out: bigint;
};
export type StrategyState = "PendingOpen" | "Open" | "PendingClose" | "Recovery" | "Closed" | "Cancelled";
export type Strategy = {
  owner: Address;
  market: Address;
  nonce: bigint;
  state: StrategyState;
  created_at: bigint;
  opened_at: bigint;
  expiry: bigint;
  pending_deadline: bigint;
  certificate_hash: Uint8Array;
  open_reference_x64: bigint;
  open_tolerance_bps: number;
  swap_slippage_bps: number;
  floor_rate_bps: number;
  keeper_trigger_bps: number;
  premium_budget: bigint;
  bounty_reserve: bigint;
  premium_accrued: bigint;
  premium_paid: bigint;
  keeper_bounty_paid: bigint;
  lp_shortfall: bigint;
  close_by_keeper: boolean;
  keeper: Address;
  cap_binding: boolean;
  aborting: boolean;
  recovery_recorded: boolean;
  leg_count: number;
  legs: Leg[];
};
export type LpPosition = {
  owner: Address;
  bucket: Address;
  liquidity: bigint;
  premium_index_x64: bigint;
  premium_owed: bigint;
  fee_owed_a: bigint;
  fee_owed_b: bigint;
  withdrawal_liquidity: bigint;
  withdrawal_requested_at: bigint;
};
export type ScenarioReference = { market_whirlpool: Address; signer: Address; price_x64: bigint; conf_bps: number; publish_time: bigint };

export async function fetchRaw(rpc: Rpc<SolanaRpcApi>, a: Address): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: "base64" }).send();
  return value ? new Uint8Array(Buffer.from(value.data[0], "base64")) : null;
}

async function fetchTyped<T>(rpc: Rpc<SolanaRpcApi>, name: string, a: Address): Promise<T> {
  const raw = await fetchRaw(rpc, a);
  if (!raw) throw new Error(`${name} ${a} not found`);
  return decodeAccount<T>(name, raw);
}

export const fetchMarket = (rpc: Rpc<SolanaRpcApi>, a: Address) => fetchTyped<Market>(rpc, "Market", a);
export const fetchBucket = (rpc: Rpc<SolanaRpcApi>, a: Address) => fetchTyped<Bucket>(rpc, "Bucket", a);
export const fetchStrategy = async (rpc: Rpc<SolanaRpcApi>, a: Address) => {
  const s = await fetchTyped<Strategy>(rpc, "Strategy", a);
  return { ...s, legs: s.legs.slice(0, s.leg_count) };
};
export const fetchLpPosition = (rpc: Rpc<SolanaRpcApi>, a: Address) => fetchTyped<LpPosition>(rpc, "LpPosition", a);
export const fetchScenario = (rpc: Rpc<SolanaRpcApi>, a: Address) => fetchTyped<ScenarioReference>(rpc, "ScenarioReference", a);

export function defaultParams(): MarketParams {
  return {
    floor_rate_bps: 500,
    curve: { base_ppm: 1_000_000, slope1_ppm: 1_000_000, kink_ppm: 600_000, slope2_ppm: 6_000_000, cap_ppm: 800_000 },
    notice_period_s: 86_400,
    restoration_buffer_bps: 200,
    swap_slippage_bps: 50,
    pool_deviation_bps: 100,
    ref_max_age_s: 60,
    ref_max_conf_bps: 100,
    open_tolerance_bps: 50,
    pending_open_deadline_s: 300,
    keeper_trigger_bps: 8_000,
    bounty_bps: 100,
    max_ops_per_tx: 2,
    max_buckets_per_strategy: 8,
  };
}
