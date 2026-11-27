use crate::constants::*;
use crate::error::ForgeError;
use crate::math::orca::{liquidity_token_deltas, MAX_TICK_INDEX, MIN_TICK_INDEX};
use crate::math::premium::index_claimable;
use crate::orca::{self, read_position, read_whirlpool, LiquidityAccounts, OpenPositionAccounts};
use crate::state::*;
use crate::token_util;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::Token;

// ---------------------------------------------------------------------------------------------
// create_bucket: the vault PDA opens a standardized Orca position on the grid via CPI.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(tick_lower: i32)]
pub struct CreateBucket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA (position owner).
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Bucket::INIT_SPACE,
        seeds = [BUCKET_SEED, market.key().as_ref(), &tick_lower.to_le_bytes()], bump)]
    pub bucket: Box<Account<'info, Bucket>>,
    /// CHECK: PDA that Orca initializes as the position NFT mint (signed by FORGE).
    #[account(mut, seeds = [BUCKET_MINT_SEED, bucket.key().as_ref()], bump)]
    pub position_mint: UncheckedAccount<'info>,
    /// CHECK: Orca position PDA for `position_mint`, verified in the handler.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: vault's associated token account for the position NFT, created by Orca.
    #[account(mut, address = get_associated_token_address(&vault.key(), &position_mint.key()))]
    pub position_token_account: UncheckedAccount<'info>,
    /// CHECK: must be the market's Whirlpool.
    #[account(address = market.whirlpool)]
    pub whirlpool: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

pub fn create_bucket(ctx: Context<CreateBucket>, tick_lower: i32) -> Result<()> {
    let market = &ctx.accounts.market;
    let width = market.bucket_width;
    require!(tick_lower.rem_euclid(width) == 0, ForgeError::MisalignedBucket);
    let tick_upper = tick_lower.checked_add(width).ok_or(error!(ForgeError::InvalidTick))?;
    require!(
        tick_lower >= MIN_TICK_INDEX && tick_upper <= MAX_TICK_INDEX,
        ForgeError::InvalidTick
    );
    let (expected_position, position_bump) = orca::position_address(&ctx.accounts.position_mint.key());
    require_keys_eq!(ctx.accounts.position.key(), expected_position, ForgeError::InvalidOrcaAccount);

    let bucket_key = ctx.accounts.bucket.key();
    let mint_bump = [ctx.bumps.position_mint];
    let mint_seeds: &[&[u8]] = &[BUCKET_MINT_SEED, bucket_key.as_ref(), &mint_bump];
    orca::open_position(
        &OpenPositionAccounts {
            funder: &ctx.accounts.payer.to_account_info(),
            owner: &ctx.accounts.vault.to_account_info(),
            position: &ctx.accounts.position.to_account_info(),
            position_mint: &ctx.accounts.position_mint.to_account_info(),
            position_token_account: &ctx.accounts.position_token_account.to_account_info(),
            whirlpool: &ctx.accounts.whirlpool.to_account_info(),
            token_program: &ctx.accounts.token_program.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
            rent: &ctx.accounts.rent.to_account_info(),
            associated_token_program: &ctx.accounts.associated_token_program.to_account_info(),
            whirlpool_program: &ctx.accounts.whirlpool_program.to_account_info(),
        },
        position_bump,
        tick_lower,
        tick_upper,
        &[mint_seeds],
    )?;

    let b = &mut ctx.accounts.bucket;
    b.market = ctx.accounts.market.key();
    b.tick_lower = tick_lower;
    b.tick_upper = tick_upper;
    b.position_mint = ctx.accounts.position_mint.key();
    b.position = expected_position;
    b.position_token_account = ctx.accounts.position_token_account.key();
    b.bump = ctx.bumps.bucket;
    b.mint_bump = ctx.bumps.position_mint;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// deposit_liquidity: an LP adds liquidity units to a bucket from its own tokens.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one = market, has_one = position, has_one = position_token_account)]
    pub bucket: Box<Account<'info, Bucket>>,
    #[account(init_if_needed, payer = lp, space = 8 + LpPosition::INIT_SPACE,
        seeds = [LP_SEED, bucket.key().as_ref(), lp.key().as_ref()], bump)]
    pub lp_position: Box<Account<'info, LpPosition>>,
    /// CHECK: market Whirlpool.
    #[account(mut, address = market.whirlpool)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: bucket's Orca position.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: bucket's position NFT account.
    pub position_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by Orca.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: validated by Orca.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: validated against the Whirlpool in the handler.
    #[account(mut)]
    pub whirlpool_vault_a: UncheckedAccount<'info>,
    /// CHECK: validated against the Whirlpool in the handler.
    #[account(mut)]
    pub whirlpool_vault_b: UncheckedAccount<'info>,
    /// CHECK: LP's base token account (transfer authority is the LP signer).
    #[account(mut)]
    pub lp_base: UncheckedAccount<'info>,
    /// CHECK: LP's quote token account.
    #[account(mut)]
    pub lp_quote: UncheckedAccount<'info>,
    /// CHECK: market staging account (base), vault-owned.
    #[account(mut, seeds = [b"staging_base", market.key().as_ref()], bump)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: market staging account (quote), vault-owned.
    #[account(mut, seeds = [b"staging_quote", market.key().as_ref()], bump)]
    pub staging_quote: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

pub fn deposit_liquidity(
    ctx: Context<DepositLiquidity>,
    liquidity: u128,
    max_base: u64,
    max_quote: u64,
) -> Result<()> {
    require!(liquidity > 0, ForgeError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let market = &a.market;
    a.bucket.require_fully_checkpointed(now)?;
    let w = read_whirlpool(&a.whirlpool.to_account_info())?;
    require_keys_eq!(a.whirlpool_vault_a.key(), w.vault_a, ForgeError::InvalidOrcaAccount);
    require_keys_eq!(a.whirlpool_vault_b.key(), w.vault_b, ForgeError::InvalidOrcaAccount);

    let (need_a, need_b) = liquidity_token_deltas(
        w.tick_current_index,
        w.sqrt_price,
        a.bucket.tick_lower,
        a.bucket.tick_upper,
        liquidity,
        true,
    )?;
    let (need_base, need_quote) = if market.base_is_a { (need_a, need_b) } else { (need_b, need_a) };
    require!(need_base <= max_base && need_quote <= max_quote, ForgeError::TokenMaxExceeded);

    let tp = a.token_program.to_account_info();
    let lp_info = a.lp.to_account_info();
    token_util::transfer_from_user(&tp, &a.lp_base.to_account_info(), &a.staging_base.to_account_info(), &lp_info, need_base)?;
    token_util::transfer_from_user(&tp, &a.lp_quote.to_account_info(), &a.staging_quote.to_account_info(), &lp_info, need_quote)?;

    let pos_before = read_position(&a.position.to_account_info())?;
    let market_key = market.key();
    let vb = [market.vault_bump];
    let seeds: &[&[u8]] = &[VAULT_SEED, market_key.as_ref(), &vb];
    let (owner_a, owner_b) = if market.base_is_a {
        (a.staging_base.to_account_info(), a.staging_quote.to_account_info())
    } else {
        (a.staging_quote.to_account_info(), a.staging_base.to_account_info())
    };
    orca::increase_liquidity(
        &LiquidityAccounts {
            whirlpool: &a.whirlpool.to_account_info(),
            token_program: &tp,
            position_authority: &a.vault.to_account_info(),
            position: &a.position.to_account_info(),
            position_token_account: &a.position_token_account.to_account_info(),
            owner_a: &owner_a,
            owner_b: &owner_b,
            vault_a: &a.whirlpool_vault_a.to_account_info(),
            vault_b: &a.whirlpool_vault_b.to_account_info(),
            tick_array_lower: &a.tick_array_lower.to_account_info(),
            tick_array_upper: &a.tick_array_upper.to_account_info(),
            whirlpool_program: &a.whirlpool_program.to_account_info(),
        },
        liquidity,
        need_a,
        need_b,
        &[seeds],
    )?;
    let pos_after = read_position(&a.position.to_account_info())?;
    require!(
        pos_after.liquidity == pos_before.liquidity + liquidity,
        ForgeError::UnexpectedCpiAmounts
    );
    // Staging accounts are pass-through only: they must be empty again.
    require!(
        token_util::amount(&a.staging_base.to_account_info())? == 0
            && token_util::amount(&a.staging_quote.to_account_info())? == 0,
        ForgeError::UnexpectedCpiAmounts
    );

    let bucket = &mut ctx.accounts.bucket;
    let lp = &mut ctx.accounts.lp_position;
    if lp.owner == Pubkey::default() {
        lp.owner = ctx.accounts.lp.key();
        lp.bucket = bucket.key();
        lp.bump = ctx.bumps.lp_position;
        lp.premium_index_x64 = bucket.premium_index_x64;
        lp.fee_index_a_x64 = bucket.fee_index_a_x64;
        lp.fee_index_b_x64 = bucket.fee_index_b_x64;
    }
    // Checkpoint the LP before its share count changes.
    lp.premium_owed = lp
        .premium_owed
        .checked_add(index_claimable(lp.liquidity, bucket.premium_index_x64, lp.premium_index_x64)?)
        .ok_or(error!(ForgeError::MathOverflow))?;
    lp.premium_index_x64 = bucket.premium_index_x64;
    lp.fee_owed_a += index_claimable(lp.liquidity, bucket.fee_index_a_x64, lp.fee_index_a_x64)?;
    lp.fee_owed_b += index_claimable(lp.liquidity, bucket.fee_index_b_x64, lp.fee_index_b_x64)?;
    lp.fee_index_a_x64 = bucket.fee_index_a_x64;
    lp.fee_index_b_x64 = bucket.fee_index_b_x64;
    lp.liquidity += liquidity;
    bucket.total_liquidity += liquidity;
    Ok(())
}
