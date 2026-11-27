use crate::constants::MAX_LEGS;
use crate::error::ForgeError;
use crate::math::premium::UtilizationCurve;
use anchor_lang::prelude::*;

/// Per-market economic and safety parameters (section 8.6). Snapshotted into each strategy
/// where they affect its terms; admin changes apply to new positions only.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct MarketParams {
    pub floor_rate_bps: u16,
    pub curve: UtilizationCurve,
    pub notice_period_s: u32,
    pub restoration_buffer_bps: u16,
    pub swap_slippage_bps: u16,
    pub pool_deviation_bps: u16,
    pub ref_max_age_s: u32,
    pub ref_max_conf_bps: u16,
    pub open_tolerance_bps: u16,
    pub pending_open_deadline_s: u32,
    pub keeper_trigger_bps: u16,
    pub bounty_bps: u16,
    pub max_ops_per_tx: u8,
    pub max_buckets_per_strategy: u8,
}

impl Default for MarketParams {
    fn default() -> Self {
        Self {
            floor_rate_bps: 500,
            curve: UtilizationCurve::default(),
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
        }
    }
}

impl MarketParams {
    pub fn validate(&self) -> Result<()> {
        self.curve.validate()?;
        let p = self;
        require!(p.floor_rate_bps <= 10_000, ForgeError::InvalidParameters);
        require!(
            p.restoration_buffer_bps > 0 && p.restoration_buffer_bps <= 10_000,
            ForgeError::InvalidParameters
        );
        require!(
            p.swap_slippage_bps > 0 && p.swap_slippage_bps <= 1_000,
            ForgeError::InvalidParameters
        );
        require!(
            p.pool_deviation_bps > 0 && p.pool_deviation_bps <= 1_000,
            ForgeError::InvalidParameters
        );
        require!(p.ref_max_age_s > 0, ForgeError::InvalidParameters);
        require!(
            p.ref_max_conf_bps > 0 && p.ref_max_conf_bps <= p.pool_deviation_bps,
            ForgeError::InvalidParameters
        );
        require!(
            p.open_tolerance_bps > 0 && p.open_tolerance_bps <= p.pool_deviation_bps,
            ForgeError::InvalidParameters
        );
        require!(p.pending_open_deadline_s > 0, ForgeError::InvalidParameters);
        require!(
            p.keeper_trigger_bps > 0 && p.keeper_trigger_bps <= 10_000,
            ForgeError::InvalidParameters
        );
        require!(p.bounty_bps < 10_000, ForgeError::InvalidParameters);
        require!(
            (1..=crate::constants::MAX_OPS_PER_TX_CEILING).contains(&p.max_ops_per_tx),
            ForgeError::InvalidParameters
        );
        require!(
            (1..=MAX_LEGS as u8).contains(&p.max_buckets_per_strategy),
            ForgeError::InvalidParameters
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ReferenceKind {
    /// Validated Pyth base/USD and quote/USD price updates, divided.
    PythPair,
    /// Fork-only scenario reference updated by a dedicated team signer. Trusted demo
    /// assumption; never admissible for a production market.
    ForkScenario,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct ReferenceConfig {
    pub kind: ReferenceKind,
    /// PythPair: base/USD PriceUpdateV2 account. ForkScenario: ScenarioReference account.
    pub base_account: Pubkey,
    /// PythPair: quote/USD PriceUpdateV2 account. ForkScenario: unused.
    pub quote_account: Pubkey,
    pub base_feed_id: [u8; 32],
    pub quote_feed_id: [u8; 32],
}

/// Global configuration. Set once by the program upgrade authority, which names a separate
/// market-registry admin key (section 5).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub admin: Pubkey,
    pub whirlpool: Pubkey,
    pub swap_pool: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_is_a: bool,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub tick_spacing: u16,
    /// Bucket width in ticks (a multiple of the tick spacing), grid anchored at tick 0.
    pub bucket_width: i32,
    pub reference: ReferenceConfig,
    pub params: MarketParams,
    pub premium_vault: Pubkey,
    /// Idle-liquidity Orca fees collected for LPs, by token.
    pub fee_vault_base: Pubkey,
    pub fee_vault_quote: Pubkey,
    pub opens_paused: bool,
    pub borrow_paused: bool,
    pub strategy_count: u64,
    pub unresolved_strategies: u32,
    pub outstanding_lp_shortfall: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Market {
    pub fn vault_seeds<'a>(&'a self, market: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [crate::constants::VAULT_SEED, market.as_ref(), bump]
    }
}

#[account]
#[derive(InitSpace)]
pub struct ScenarioReference {
    pub market_whirlpool: Pubkey,
    pub signer: Pubkey,
    /// Quote atoms per base atom, Q64.64.
    pub price_x64: u128,
    pub conf_bps: u16,
    pub publish_time: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bucket {
    pub market: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub position_mint: Pubkey,
    pub position: Pubkey,
    pub position_token_account: Pubkey,
    /// LP-owned liquidity units. One share is one liquidity unit, so shares == total_liquidity.
    pub total_liquidity: u128,
    /// Liquidity currently removed from Orca by borrowers.
    pub borrowed: u128,
    /// Liquidity reserved by pending opens (counts toward utilization immediately).
    pub reserved: u128,
    /// Liquidity with a pending LP withdrawal request (cannot be newly borrowed).
    pub withdrawal_requested: u128,
    /// Earliest unfulfilled withdrawal request time (0 if none); starts the notice period.
    pub withdrawal_notice_start: i64,
    pub premium_index_x64: u128,
    pub premium_remainder_x64: u128,
    pub premium_distributed: u64,
    /// Idle Orca fees per share (Q64.64), by token, with exact carried remainders.
    pub fee_index_base_x64: u128,
    pub fee_index_quote_x64: u128,
    pub fee_remainder_base_x64: u128,
    pub fee_remainder_quote_x64: u128,
    pub fees_collected_base: u64,
    pub fees_collected_quote: u64,
    pub lp_shortfall_quote: u64,
    /// Number of executed, unrestored borrowed legs on this bucket.
    pub open_legs: u32,
    /// Timestamp and count of leg checkpoints in the current second. A share change is only
    /// allowed when every open leg checkpointed in the same transaction (section 4.3).
    pub checkpoint_ts: i64,
    pub checkpoint_count: u32,
    pub bump: u8,
    pub mint_bump: u8,
}

impl Bucket {
    pub fn active_liquidity(&self) -> u128 {
        self.total_liquidity.saturating_sub(self.borrowed)
    }

    /// Record a checkpoint by one open leg at `now` (call once per leg per transaction).
    pub fn record_leg_checkpoint(&mut self, now: i64) {
        if self.checkpoint_ts != now {
            self.checkpoint_ts = now;
            self.checkpoint_count = 0;
        }
        self.checkpoint_count += 1;
    }

    /// Share changes require every open leg to have checkpointed in this transaction.
    pub fn require_fully_checkpointed(&self, now: i64) -> Result<()> {
        require!(
            self.open_legs == 0 || (self.checkpoint_ts == now && self.checkpoint_count >= self.open_legs),
            ForgeError::LiquidityLocked
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub owner: Pubkey,
    pub bucket: Pubkey,
    pub liquidity: u128,
    pub premium_index_x64: u128,
    pub premium_owed: u64,
    pub premium_claimed: u64,
    pub fee_index_base_x64: u128,
    pub fee_index_quote_x64: u128,
    pub fee_owed_base: u64,
    pub fee_owed_quote: u64,
    pub fees_claimed_base: u64,
    pub fees_claimed_quote: u64,
    pub withdrawal_liquidity: u128,
    pub withdrawal_requested_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum DepositState {
    Pending,
    Done,
    Cancelled,
}

/// A staged ladder deposit of an existing Orca position (section 4.2). The original position's
/// liquidity is withdrawn into this ticket's escrow and redeployed bucket by bucket; it is not
/// advertised as active until every bucket is funded.
#[account]
#[derive(InitSpace)]
pub struct LpDeposit {
    pub lp: Pubkey,
    pub market: Pubkey,
    pub nonce: u64,
    pub state: DepositState,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub withdrawn_base: u64,
    pub withdrawn_quote: u64,
    /// Next bucket (by index from tick_lower) to redeploy.
    pub cursor: u16,
    pub bucket_count: u16,
    pub created_at: i64,
    pub bump: u8,
    pub escrow_base_bump: u8,
    pub escrow_quote_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum LegKind {
    /// Borrow a range below spot (quote-only): put-like payoff.
    BorrowQuote,
    /// Borrow a range above spot (base-only): call-like payoff.
    BorrowBase,
    /// User provides quote in a range below spot: cash-secured put.
    ProvideQuote,
    /// User provides base in a range above spot: covered call.
    ProvideBase,
}

impl LegKind {
    pub fn is_borrow(self) -> bool {
        matches!(self, LegKind::BorrowQuote | LegKind::BorrowBase)
    }
    /// The single token the range holds at open (true = quote).
    pub fn holds_quote(self) -> bool {
        matches!(self, LegKind::BorrowQuote | LegKind::ProvideQuote)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum StrategyState {
    PendingOpen,
    Open,
    PendingClose,
    Recovery,
    Closed,
    Cancelled,
}

pub fn kind_from_tag(tag: u8) -> Result<LegKind> {
    match tag {
        0 => Ok(LegKind::BorrowQuote),
        1 => Ok(LegKind::BorrowBase),
        2 => Ok(LegKind::ProvideQuote),
        3 => Ok(LegKind::ProvideBase),
        _ => err!(ForgeError::InvalidLeg),
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Leg {
    pub kind_tag: u8,
    pub bucket: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    /// Exact token amounts removed from Orca at open (the leg's principal escrow).
    pub removed_base: u64,
    pub removed_quote: u64,
    /// Remaining leg ledgers in escrow (principal + buffer), by mint.
    pub escrow_base: u64,
    pub escrow_quote: u64,
    /// Restoration buffer funded by the user, in the removed mint.
    pub buffer: u64,
    pub multiplier_ppm: u32,
    pub notional_quote: u64,
    pub opened_at: i64,
    pub growth_a_x64: u128,
    pub growth_b_x64: u128,
    pub cum_forgone_quote: u64,
    pub premium: u64,
    /// Premium already transferred to the bucket's LP index.
    pub premium_distributed: u64,
    pub last_checkpoint_ts: i64,
    pub executed: bool,
    pub restored: bool,
    pub restored_at: i64,
    pub swap_in: u64,
    pub swap_out: u64,
    /// Provided legs: tokens the user funded, tokens returned at close, and actual Orca fees
    /// the position collected (fee credits, never projected fees).
    pub provided_base: u64,
    pub provided_quote: u64,
    pub returned_base: u64,
    pub returned_quote: u64,
    pub fees_base: u64,
    pub fees_quote: u64,
}

impl Leg {
    pub fn kind(&self) -> Result<LegKind> {
        kind_from_tag(self.kind_tag)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Strategy {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub nonce: u64,
    pub state: StrategyState,
    pub created_at: i64,
    pub opened_at: i64,
    pub expiry: i64,
    pub pending_deadline: i64,
    pub certificate_hash: [u8; 32],
    pub open_reference_x64: u128,
    pub open_tolerance_bps: u16,
    pub swap_slippage_bps: u16,
    pub floor_rate_bps: u16,
    pub keeper_trigger_bps: u16,
    pub premium_budget: u64,
    pub bounty_reserve: u64,
    pub premium_accrued: u64,
    pub premium_paid: u64,
    pub keeper_bounty_paid: u64,
    pub lp_shortfall: u64,
    pub close_by_keeper: bool,
    pub keeper: Pubkey,
    /// Set when accrued premium reaches the LP cap; the remaining cap is then allocated pro
    /// rata over unpaid leg premiums at final settlement.
    pub cap_binding: bool,
    pub aborting: bool,
    /// Counted in market.unresolved_strategies while true.
    pub recovery_recorded: bool,
    /// Fee credits from provided legs (actual collected fees), netted against premium in the UI
    /// and returned to the owner at settlement; never used to raise authorized spending.
    pub fee_credit_base: u64,
    pub fee_credit_quote: u64,
    pub authority_bump: u8,
    pub provide_base_bump: u8,
    pub provide_quote_bump: u8,
    /// When the close (or abort) was authorized; a close stalled longer than the market's
    /// pending deadline may be flagged as Recovery by anyone.
    pub close_started_at: i64,
    pub leg_count: u8,
    /// Heap-allocated on deserialization (a fixed array would overflow the 4 KB SBF frame).
    #[max_len(8)]
    pub legs: Vec<Leg>,
    pub bump: u8,
    pub escrow_base_bump: u8,
    pub escrow_quote_bump: u8,
    pub budget_bump: u8,
}

impl Strategy {
    pub fn legs(&self) -> &[Leg] {
        &self.legs[..self.leg_count as usize]
    }

    pub fn all_executed(&self) -> bool {
        self.legs().iter().all(|l| l.executed)
    }

    pub fn all_restored(&self) -> bool {
        self.legs().iter().all(|l| !l.executed || l.restored)
    }

    pub fn lp_cap(&self) -> u64 {
        self.premium_budget - self.bounty_reserve
    }
}
