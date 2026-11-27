use anchor_lang::prelude::*;

pub const WHIRLPOOL_PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PREMIUM_VAULT_SEED: &[u8] = b"premium_vault";
pub const BUCKET_SEED: &[u8] = b"bucket";
pub const BUCKET_MINT_SEED: &[u8] = b"bucket_mint";
pub const LP_SEED: &[u8] = b"lp";
pub const STRATEGY_SEED: &[u8] = b"strategy";
pub const ESCROW_BASE_SEED: &[u8] = b"escrow_base";
pub const ESCROW_QUOTE_SEED: &[u8] = b"escrow_quote";
pub const BUDGET_SEED: &[u8] = b"budget";
pub const SCENARIO_SEED: &[u8] = b"scenario_reference";

/// Hard ceilings that no market parameter may exceed.
pub const MAX_LEGS: usize = 8;
pub const MAX_OPS_PER_TX_CEILING: u8 = 2;
pub const MIN_EXPIRY_SECONDS: i64 = 60;
