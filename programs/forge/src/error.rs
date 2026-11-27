use anchor_lang::prelude::*;

#[error_code]
pub enum ForgeError {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Token amount exceeds u64")]
    TokenMaxExceeded,
    #[msg("Amount must be positive")]
    ZeroAmount,
    #[msg("Invalid tick")]
    InvalidTick,
    #[msg("Invalid market parameters")]
    InvalidParameters,
    #[msg("Unsupported mint or token program (classic SPL Token only)")]
    UnsupportedMint,
    #[msg("Account is not the expected Orca account")]
    InvalidOrcaAccount,
    #[msg("Pool is not eligible for FORGE")]
    IneligiblePool,
    #[msg("Reference price account does not match the market configuration")]
    ReferenceMismatch,
    #[msg("Reference price is invalid")]
    InvalidReference,
    #[msg("Reference price is stale")]
    StaleReference,
    #[msg("Reference confidence interval too wide")]
    ReferenceConfidence,
    #[msg("Pool price deviates from the reference beyond the limit")]
    PoolDeviation,
    #[msg("Reference moved beyond the signed opening tolerance")]
    OpenTolerance,
    #[msg("Swap execution price outside the allowed slippage")]
    SwapSlippage,
    #[msg("Utilization cap exceeded")]
    UtilizationCap,
    #[msg("Bucket has no liquidity")]
    EmptyBucket,
    #[msg("Bucket is not aligned to the market grid")]
    MisalignedBucket,
    #[msg("Borrowed range must be strictly out of range on the required side")]
    BorrowNotOutOfRange,
    #[msg("Provided range must be single-sided on the required side")]
    ProvideNotSingleSided,
    #[msg("Too many legs")]
    TooManyLegs,
    #[msg("Too many bucket operations in one transaction")]
    TooManyOps,
    #[msg("Leg index invalid or already processed")]
    InvalidLeg,
    #[msg("Account does not match the committed leg")]
    LegAccountMismatch,
    #[msg("Strategy is in the wrong state for this action")]
    InvalidState,
    #[msg("Pending operation deadline has passed")]
    DeadlinePassed,
    #[msg("Close is not permitted for this caller yet")]
    CloseNotAllowed,
    #[msg("New opens are paused in this market")]
    OpensPaused,
    #[msg("Borrowing is paused in this market pending shortfall review")]
    BorrowPaused,
    #[msg("Escrow and buffer are insufficient to restore the bucket")]
    InsufficientRestorationFunds,
    #[msg("Restoration did not restore the exact borrowed liquidity")]
    RestorationMismatch,
    #[msg("Orca CPI produced unexpected token amounts")]
    UnexpectedCpiAmounts,
    #[msg("Clock went backwards")]
    ClockWentBackwards,
    #[msg("Expiry must be at least the minimum after activation")]
    InvalidExpiry,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Liquidity is borrowed or reserved and cannot be withdrawn")]
    LiquidityLocked,
    #[msg("Withdrawal notice period has not elapsed")]
    NoticeNotElapsed,
    #[msg("Restoration swap pool is not eligible")]
    InvalidSwapPool,
    #[msg("Premium budget is insufficient")]
    InsufficientBudget,
    #[msg("Restoration is possible; recovery cannot be recorded")]
    RecoveryNotNeeded,
    #[msg("Active reward emissions are not supported in v1")]
    RewardsActive,
}
