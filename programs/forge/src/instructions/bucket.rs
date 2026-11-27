//! Buckets and the LP lifecycle (sections 4.1, 4.2, 4.5): grid buckets owned by the vault,
//! direct and ladder deposits, idle fee pass-through, premium/fee claims, immediate withdrawal
//! of unborrowed liquidity and withdrawal requests with a notice period for borrowed liquidity.

use super::common::vault_signer_seeds;
use crate::constants::*;
use crate::error::ForgeError;
use crate::math::orca::{liquidity_token_deltas, MAX_TICK_INDEX, MIN_TICK_INDEX};
use crate::math::premium::{index_claimable, index_distribute};
use crate::orca::{self, read_position, read_whirlpool, CollectFeesAccounts, LiquidityAccounts, OpenPositionAccounts};
use crate::state::*;
use crate::token_util;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{Mint, Token, TokenAccount};

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
// Shared: bucket Orca accounts, idle-fee collection and LP checkpoints.
// ---------------------------------------------------------------------------------------------

/// Orca and vault accounts every bucket liquidity operation needs.
#[derive(Accounts)]
pub struct BucketPool<'info> {
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one = market, has_one = position, has_one = position_token_account)]
    pub bucket: Box<Account<'info, Bucket>>,
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
    /// CHECK: checked against the Whirlpool.
    #[account(mut)]
    pub whirlpool_vault_a: UncheckedAccount<'info>,
    /// CHECK: checked against the Whirlpool.
    #[account(mut)]
    pub whirlpool_vault_b: UncheckedAccount<'info>,
    /// CHECK: market fee vault (base).
    #[account(mut, address = market.fee_vault_base)]
    pub fee_vault_base: UncheckedAccount<'info>,
    /// CHECK: market fee vault (quote).
    #[account(mut, address = market.fee_vault_quote)]
    pub fee_vault_quote: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

impl<'info> BucketPool<'info> {
    fn ab_owners(&self, base: &AccountInfo<'info>, quote: &AccountInfo<'info>) -> (AccountInfo<'info>, AccountInfo<'info>) {
        if self.market.base_is_a {
            (base.clone(), quote.clone())
        } else {
            (quote.clone(), base.clone())
        }
    }

    fn liquidity_accounts<'a>(&'a self, owner_a: &'a AccountInfo<'info>, owner_b: &'a AccountInfo<'info>, tp: &'a AccountInfo<'info>) -> LiquidityAccounts<'a, 'info>
    where
        'info: 'a,
    {
        LiquidityAccounts {
            whirlpool: self.whirlpool.as_ref(),
            token_program: tp,
            position_authority: self.vault.as_ref(),
            position: self.position.as_ref(),
            position_token_account: self.position_token_account.as_ref(),
            owner_a,
            owner_b,
            vault_a: self.whirlpool_vault_a.as_ref(),
            vault_b: self.whirlpool_vault_b.as_ref(),
            tick_array_lower: self.tick_array_lower.as_ref(),
            tick_array_upper: self.tick_array_upper.as_ref(),
            whirlpool_program: self.whirlpool_program.as_ref(),
        }
    }

    /// Collect the bucket position's accrued Orca fees into the market fee vaults and credit
    /// the bucket's per-share fee indices. Must run before any share change.
    pub fn collect_and_credit(&mut self) -> Result<()> {
        let w = read_whirlpool(self.whirlpool.as_ref())?;
        require_keys_eq!(self.whirlpool_vault_a.key(), w.vault_a, ForgeError::InvalidOrcaAccount);
        require_keys_eq!(self.whirlpool_vault_b.key(), w.vault_b, ForgeError::InvalidOrcaAccount);
        let pos = read_position(self.position.as_ref())?;
        if pos.liquidity > 0 {
            orca::update_fees_and_rewards(
                self.whirlpool.as_ref(),
                self.position.as_ref(),
                self.tick_array_lower.as_ref(),
                self.tick_array_upper.as_ref(),
                self.whirlpool_program.as_ref(),
            )?;
        }
        let pos = read_position(self.position.as_ref())?;
        if pos.fee_owed_a == 0 && pos.fee_owed_b == 0 {
            return Ok(());
        }
        let base0 = token_util::amount(self.fee_vault_base.as_ref())?;
        let quote0 = token_util::amount(self.fee_vault_quote.as_ref())?;
        let market_key = self.market.key();
        let vb = [self.market.vault_bump];
        let seeds = vault_signer_seeds(&market_key, &vb);
        let (owner_a, owner_b) = self.ab_owners(self.fee_vault_base.as_ref(), self.fee_vault_quote.as_ref());
        let (vault_a, vault_b) = (self.whirlpool_vault_a.to_account_info(), self.whirlpool_vault_b.to_account_info());
        orca::collect_fees(
            &CollectFeesAccounts {
                whirlpool: self.whirlpool.as_ref(),
                position_authority: self.vault.as_ref(),
                position: self.position.as_ref(),
                position_token_account: self.position_token_account.as_ref(),
                owner_a: &owner_a,
                vault_a: &vault_a,
                owner_b: &owner_b,
                vault_b: &vault_b,
                token_program: self.token_program.as_ref(),
                whirlpool_program: self.whirlpool_program.as_ref(),
            },
            &[&seeds],
        )?;
        let got_base = token_util::amount(self.fee_vault_base.as_ref())? - base0;
        let got_quote = token_util::amount(self.fee_vault_quote.as_ref())? - quote0;
        let b = &mut self.bucket;
        let ib = index_distribute(got_base, b.total_liquidity, &mut b.fee_remainder_base_x64)?;
        let iq = index_distribute(got_quote, b.total_liquidity, &mut b.fee_remainder_quote_x64)?;
        b.fee_index_base_x64 = b.fee_index_base_x64.wrapping_add(ib);
        b.fee_index_quote_x64 = b.fee_index_quote_x64.wrapping_add(iq);
        b.fees_collected_base += got_base;
        b.fees_collected_quote += got_quote;
        Ok(())
    }
}

/// Move an LP's accrued premium and fees into its owed balances at the current indices.
pub fn checkpoint_lp(lp: &mut LpPosition, b: &Bucket) -> Result<()> {
    let add = |owed: u64, idx_now: u128, idx_then: u128| -> Result<u64> {
        owed.checked_add(index_claimable(lp.liquidity, idx_now, idx_then)?)
            .ok_or(error!(ForgeError::MathOverflow))
    };
    lp.premium_owed = add(lp.premium_owed, b.premium_index_x64, lp.premium_index_x64)?;
    lp.fee_owed_base = add(lp.fee_owed_base, b.fee_index_base_x64, lp.fee_index_base_x64)?;
    lp.fee_owed_quote = add(lp.fee_owed_quote, b.fee_index_quote_x64, lp.fee_index_quote_x64)?;
    lp.premium_index_x64 = b.premium_index_x64;
    lp.fee_index_base_x64 = b.fee_index_base_x64;
    lp.fee_index_quote_x64 = b.fee_index_quote_x64;
    Ok(())
}

fn init_lp_if_new(lp: &mut LpPosition, owner: Pubkey, bucket: &Account<Bucket>, bump: u8) {
    if lp.owner == Pubkey::default() {
        lp.owner = owner;
        lp.bucket = bucket.key();
        lp.bump = bump;
        lp.premium_index_x64 = bucket.premium_index_x64;
        lp.fee_index_base_x64 = bucket.fee_index_base_x64;
        lp.fee_index_quote_x64 = bucket.fee_index_quote_x64;
    }
}

// ---------------------------------------------------------------------------------------------
// collect_and_distribute: permissionless idle-fee collection for one bucket.
// ---------------------------------------------------------------------------------------------

pub fn collect_and_distribute(ctx: Context<BucketPool>) -> Result<()> {
    ctx.accounts.collect_and_credit()
}

// ---------------------------------------------------------------------------------------------
// deposit_liquidity: an LP adds liquidity units to one bucket from its own tokens.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
    pub pool: BucketPool<'info>,
    #[account(init_if_needed, payer = lp, space = 8 + LpPosition::INIT_SPACE,
        seeds = [LP_SEED, pool.bucket.key().as_ref(), lp.key().as_ref()], bump)]
    pub lp_position: Box<Account<'info, LpPosition>>,
    /// CHECK: LP's base token account (the token program enforces the LP's authority).
    #[account(mut)]
    pub lp_base: UncheckedAccount<'info>,
    /// CHECK: LP's quote token account.
    #[account(mut)]
    pub lp_quote: UncheckedAccount<'info>,
    /// CHECK: market staging account (base), vault-owned, pass-through only.
    #[account(mut, seeds = [b"staging_base", pool.market.key().as_ref()], bump)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: market staging account (quote), vault-owned, pass-through only.
    #[account(mut, seeds = [b"staging_quote", pool.market.key().as_ref()], bump)]
    pub staging_quote: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_liquidity(ctx: Context<DepositLiquidity>, liquidity: u128, max_base: u64, max_quote: u64) -> Result<()> {
    require!(liquidity > 0, ForgeError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.pool.bucket.require_fully_checkpointed(now)?;
    ctx.accounts.pool.collect_and_credit()?;

    let a = &ctx.accounts;
    let pool = &a.pool;
    let w = read_whirlpool(pool.whirlpool.as_ref())?;
    let (need_a, need_b) = liquidity_token_deltas(w.tick_current_index, w.sqrt_price, pool.bucket.tick_lower, pool.bucket.tick_upper, liquidity, true)?;
    let (need_base, need_quote) = if pool.market.base_is_a { (need_a, need_b) } else { (need_b, need_a) };
    require!(need_base <= max_base && need_quote <= max_quote, ForgeError::TokenMaxExceeded);

    let tp = pool.token_program.to_account_info();
    let lp_info = a.lp.to_account_info();
    token_util::transfer_from_user(&tp, a.lp_base.as_ref(), a.staging_base.as_ref(), &lp_info, need_base)?;
    token_util::transfer_from_user(&tp, a.lp_quote.as_ref(), a.staging_quote.as_ref(), &lp_info, need_quote)?;

    let pos_before = read_position(pool.position.as_ref())?;
    let market_key = pool.market.key();
    let vb = [pool.market.vault_bump];
    let seeds = vault_signer_seeds(&market_key, &vb);
    let (owner_a, owner_b) = pool.ab_owners(a.staging_base.as_ref(), a.staging_quote.as_ref());
    orca::increase_liquidity(&pool.liquidity_accounts(&owner_a, &owner_b, &tp), liquidity, need_a, need_b, &[&seeds])?;
    let pos_after = read_position(pool.position.as_ref())?;
    require!(pos_after.liquidity == pos_before.liquidity + liquidity, ForgeError::UnexpectedCpiAmounts);
    require!(
        token_util::amount(a.staging_base.as_ref())? == 0 && token_util::amount(a.staging_quote.as_ref())? == 0,
        ForgeError::UnexpectedCpiAmounts
    );

    let owner = ctx.accounts.lp.key();
    let bump = ctx.bumps.lp_position;
    let bucket = &mut ctx.accounts.pool.bucket;
    let lp = &mut ctx.accounts.lp_position;
    init_lp_if_new(lp, owner, bucket, bump);
    checkpoint_lp(lp, bucket)?;
    lp.liquidity += liquidity;
    bucket.total_liquidity += liquidity;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// withdraw_liquidity: unborrowed, unreserved liquidity leaves immediately.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct WithdrawLiquidity<'info> {
    pub lp: Signer<'info>,
    pub pool: BucketPool<'info>,
    #[account(mut, seeds = [LP_SEED, pool.bucket.key().as_ref(), lp.key().as_ref()], bump = lp_position.bump,
        constraint = lp_position.owner == lp.key() @ ForgeError::Unauthorized)]
    pub lp_position: Box<Account<'info, LpPosition>>,
    /// CHECK: LP's base token account (receives withdrawn tokens).
    #[account(mut)]
    pub lp_base: UncheckedAccount<'info>,
    /// CHECK: LP's quote token account.
    #[account(mut)]
    pub lp_quote: UncheckedAccount<'info>,
}

pub fn withdraw_liquidity(ctx: Context<WithdrawLiquidity>, liquidity: u128, min_base: u64, min_quote: u64) -> Result<()> {
    require!(liquidity > 0, ForgeError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.pool.bucket.require_fully_checkpointed(now)?;
    ctx.accounts.pool.collect_and_credit()?;
    let a = &ctx.accounts;
    let b = &a.pool.bucket;
    require!(liquidity <= a.lp_position.liquidity, ForgeError::LiquidityLocked);
    // borrowed and reserved liquidity cannot leave; other LPs' requested withdrawals stay
    // queued behind it but do not block unborrowed liquidity
    let free = b.total_liquidity.saturating_sub(b.borrowed).saturating_sub(b.reserved);
    require!(liquidity <= free, ForgeError::LiquidityLocked);
    let (mb, mq) = (min_base, min_quote);
    let (base_mint, base_owner, _) = token_util::read_token_account(a.lp_base.as_ref())?;
    let (quote_mint, quote_owner, _) = token_util::read_token_account(a.lp_quote.as_ref())?;
    require!(base_mint == a.pool.market.base_mint && quote_mint == a.pool.market.quote_mint, ForgeError::UnsupportedMint);
    require!(base_owner == a.lp.key() && quote_owner == a.lp.key(), ForgeError::Unauthorized);

    let tp = a.pool.token_program.to_account_info();
    let market_key = a.pool.market.key();
    let vb = [a.pool.market.vault_bump];
    let seeds = vault_signer_seeds(&market_key, &vb);
    let (owner_a, owner_b) = a.pool.ab_owners(a.lp_base.as_ref(), a.lp_quote.as_ref());
    let (min_a, min_b) = if a.pool.market.base_is_a { (mb, mq) } else { (mq, mb) };
    let pos_before = read_position(a.pool.position.as_ref())?;
    orca::decrease_liquidity(&a.pool.liquidity_accounts(&owner_a, &owner_b, &tp), liquidity, min_a, min_b, &[&seeds])?;
    require!(
        read_position(a.pool.position.as_ref())?.liquidity + liquidity == pos_before.liquidity,
        ForgeError::UnexpectedCpiAmounts
    );

    let bucket = &mut ctx.accounts.pool.bucket;
    let lp = &mut ctx.accounts.lp_position;
    checkpoint_lp(lp, bucket)?;
    lp.liquidity -= liquidity;
    bucket.total_liquidity -= liquidity;
    // a withdrawal fulfils this LP's pending request first
    let fulfilled = liquidity.min(lp.withdrawal_liquidity);
    lp.withdrawal_liquidity -= fulfilled;
    bucket.withdrawal_requested = bucket.withdrawal_requested.saturating_sub(fulfilled);
    if bucket.withdrawal_requested == 0 {
        bucket.withdrawal_notice_start = 0;
    }
    if lp.withdrawal_liquidity == 0 {
        lp.withdrawal_requested_at = 0;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// request_lp_withdrawal: start the notice period for liquidity that is (or may be) borrowed.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RequestLpWithdrawal<'info> {
    pub lp: Signer<'info>,
    #[account(mut)]
    pub bucket: Box<Account<'info, Bucket>>,
    #[account(mut, seeds = [LP_SEED, bucket.key().as_ref(), lp.key().as_ref()], bump = lp_position.bump,
        constraint = lp_position.owner == lp.key() @ ForgeError::Unauthorized)]
    pub lp_position: Box<Account<'info, LpPosition>>,
}

pub fn request_lp_withdrawal(ctx: Context<RequestLpWithdrawal>, liquidity: u128) -> Result<()> {
    require!(liquidity > 0, ForgeError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let lp = &mut ctx.accounts.lp_position;
    let b = &mut ctx.accounts.bucket;
    let new_total = lp.withdrawal_liquidity.checked_add(liquidity).ok_or(error!(ForgeError::MathOverflow))?;
    require!(new_total <= lp.liquidity, ForgeError::LiquidityLocked);
    lp.withdrawal_liquidity = new_total;
    if lp.withdrawal_requested_at == 0 {
        lp.withdrawal_requested_at = now;
    }
    b.withdrawal_requested += liquidity;
    if b.withdrawal_notice_start == 0 {
        b.withdrawal_notice_start = now;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// claim_lp: pay out an LP's accrued premium and idle fees for one bucket.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClaimLp<'info> {
    pub lp: Signer<'info>,
    pub pool: BucketPool<'info>,
    #[account(mut, seeds = [LP_SEED, pool.bucket.key().as_ref(), lp.key().as_ref()], bump = lp_position.bump,
        constraint = lp_position.owner == lp.key() @ ForgeError::Unauthorized)]
    pub lp_position: Box<Account<'info, LpPosition>>,
    /// CHECK: market premium vault.
    #[account(mut, address = pool.market.premium_vault)]
    pub premium_vault: UncheckedAccount<'info>,
    #[account(mut, token::mint = pool.market.base_mint, token::authority = lp)]
    pub lp_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.market.quote_mint, token::authority = lp)]
    pub lp_quote: Box<Account<'info, TokenAccount>>,
}

pub fn claim_lp(ctx: Context<ClaimLp>) -> Result<()> {
    ctx.accounts.pool.collect_and_credit()?;
    {
        let bucket = &ctx.accounts.pool.bucket;
        let lp = &mut ctx.accounts.lp_position;
        checkpoint_lp(lp, bucket)?;
    }
    let a = &ctx.accounts;
    let market_key = a.pool.market.key();
    let vb = [a.pool.market.vault_bump];
    let seeds = vault_signer_seeds(&market_key, &vb);
    let tp = a.pool.token_program.to_account_info();
    let vault = a.pool.vault.to_account_info();
    let (prem, fb, fq) = (a.lp_position.premium_owed, a.lp_position.fee_owed_base, a.lp_position.fee_owed_quote);
    token_util::transfer_signed(&tp, a.premium_vault.as_ref(), &a.lp_quote.to_account_info(), &vault, prem, &[&seeds])?;
    token_util::transfer_signed(&tp, a.pool.fee_vault_base.as_ref(), &a.lp_base.to_account_info(), &vault, fb, &[&seeds])?;
    token_util::transfer_signed(&tp, a.pool.fee_vault_quote.as_ref(), &a.lp_quote.to_account_info(), &vault, fq, &[&seeds])?;
    let lp = &mut ctx.accounts.lp_position;
    lp.premium_claimed += prem;
    lp.fees_claimed_base += fb;
    lp.fees_claimed_quote += fq;
    lp.premium_owed = 0;
    lp.fee_owed_base = 0;
    lp.fee_owed_quote = 0;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Ladder deposit of an existing Orca position (staged, section 4.2 / 8.5).
// ---------------------------------------------------------------------------------------------

pub const MAX_DEPOSIT_BUCKETS: i32 = 32;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct BeginLpDeposit<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA (escrow authority).
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = lp, space = 8 + LpDeposit::INIT_SPACE,
        seeds = [b"deposit", market.key().as_ref(), lp.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub ticket: Box<Account<'info, LpDeposit>>,
    #[account(init, payer = lp, seeds = [b"deposit_base", ticket.key().as_ref()], bump,
        token::mint = base_mint, token::authority = vault)]
    pub escrow_base: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = lp, seeds = [b"deposit_quote", ticket.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault)]
    pub escrow_quote: Box<Account<'info, TokenAccount>>,
    #[account(address = market.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = market.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    /// CHECK: market Whirlpool.
    #[account(mut, address = market.whirlpool)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: the LP's own Orca position in this Whirlpool (LP signs as its authority).
    #[account(mut)]
    pub lp_orca_position: UncheckedAccount<'info>,
    /// CHECK: the LP's position NFT token account; Orca verifies authority.
    pub lp_orca_position_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by Orca.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: validated by Orca.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: checked against the Whirlpool.
    #[account(mut)]
    pub whirlpool_vault_a: UncheckedAccount<'info>,
    /// CHECK: checked against the Whirlpool.
    #[account(mut)]
    pub whirlpool_vault_b: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

pub fn begin_lp_deposit(ctx: Context<BeginLpDeposit>, nonce: u64, liquidity: u128) -> Result<()> {
    require!(liquidity > 0, ForgeError::ZeroAmount);
    let a = &ctx.accounts;
    let m = &a.market;
    let w = read_whirlpool(a.whirlpool.as_ref())?;
    require_keys_eq!(a.whirlpool_vault_a.key(), w.vault_a, ForgeError::InvalidOrcaAccount);
    require_keys_eq!(a.whirlpool_vault_b.key(), w.vault_b, ForgeError::InvalidOrcaAccount);
    let pos = read_position(a.lp_orca_position.as_ref())?;
    require_keys_eq!(pos.whirlpool, m.whirlpool, ForgeError::InvalidOrcaAccount);
    require!(liquidity <= pos.liquidity, ForgeError::LiquidityLocked);
    // v1 accepts only ranges that are an exact union of grid buckets; a deposit is never
    // silently widened or narrowed.
    let width = m.bucket_width;
    require!(
        pos.tick_lower.rem_euclid(width) == 0 && pos.tick_upper.rem_euclid(width) == 0,
        ForgeError::MisalignedBucket
    );
    let count = (pos.tick_upper - pos.tick_lower) / width;
    require!(count >= 1 && count <= MAX_DEPOSIT_BUCKETS, ForgeError::TooManyLegs);

    let b0 = a.escrow_base.amount;
    let q0 = a.escrow_quote.amount;
    let tp = a.token_program.to_account_info();
    let (owner_a, owner_b) = if m.base_is_a {
        (a.escrow_base.to_account_info(), a.escrow_quote.to_account_info())
    } else {
        (a.escrow_quote.to_account_info(), a.escrow_base.to_account_info())
    };
    // the LP signs the outer transaction as its own position authority
    orca::decrease_liquidity(
        &LiquidityAccounts {
            whirlpool: a.whirlpool.as_ref(),
            token_program: &tp,
            position_authority: a.lp.as_ref(),
            position: a.lp_orca_position.as_ref(),
            position_token_account: a.lp_orca_position_token_account.as_ref(),
            owner_a: &owner_a,
            owner_b: &owner_b,
            vault_a: a.whirlpool_vault_a.as_ref(),
            vault_b: a.whirlpool_vault_b.as_ref(),
            tick_array_lower: a.tick_array_lower.as_ref(),
            tick_array_upper: a.tick_array_upper.as_ref(),
            whirlpool_program: a.whirlpool_program.as_ref(),
        },
        liquidity,
        0,
        0,
        &[],
    )?;
    let got_base = token_util::amount(&a.escrow_base.to_account_info())? - b0;
    let got_quote = token_util::amount(&a.escrow_quote.to_account_info())? - q0;

    let t = &mut ctx.accounts.ticket;
    t.lp = ctx.accounts.lp.key();
    t.market = ctx.accounts.market.key();
    t.nonce = nonce;
    t.state = DepositState::Pending;
    t.tick_lower = pos.tick_lower;
    t.tick_upper = pos.tick_upper;
    t.liquidity = liquidity;
    t.withdrawn_base = got_base;
    t.withdrawn_quote = got_quote;
    t.bucket_count = count as u16;
    t.created_at = Clock::get()?.unix_timestamp;
    t.bump = ctx.bumps.ticket;
    t.escrow_base_bump = ctx.bumps.escrow_base;
    t.escrow_quote_bump = ctx.bumps.escrow_quote;
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteLpDepositBucket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub pool: BucketPool<'info>,
    #[account(mut, constraint = ticket.market == pool.market.key() @ ForgeError::LegAccountMismatch)]
    pub ticket: Box<Account<'info, LpDeposit>>,
    /// CHECK: the depositing LP (owner of the new shares).
    #[account(address = ticket.lp)]
    pub lp: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, space = 8 + LpPosition::INIT_SPACE,
        seeds = [LP_SEED, pool.bucket.key().as_ref(), ticket.lp.as_ref()], bump)]
    pub lp_position: Box<Account<'info, LpPosition>>,
    /// CHECK: ticket escrow (base).
    #[account(mut, seeds = [b"deposit_base", ticket.key().as_ref()], bump = ticket.escrow_base_bump)]
    pub escrow_base: UncheckedAccount<'info>,
    /// CHECK: ticket escrow (quote).
    #[account(mut, seeds = [b"deposit_quote", ticket.key().as_ref()], bump = ticket.escrow_quote_bump)]
    pub escrow_quote: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Redeploy the ticket's liquidity into its next bucket (permissionless continuation).
pub fn execute_lp_deposit_bucket(ctx: Context<ExecuteLpDepositBucket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let t = &ctx.accounts.ticket;
    require!(t.state == DepositState::Pending, ForgeError::InvalidState);
    require!(t.cursor < t.bucket_count, ForgeError::InvalidState);
    let expected_lower = t.tick_lower + i32::from(t.cursor) * ctx.accounts.pool.market.bucket_width;
    require!(ctx.accounts.pool.bucket.tick_lower == expected_lower, ForgeError::LegAccountMismatch);
    let liquidity = t.liquidity;
    ctx.accounts.pool.bucket.require_fully_checkpointed(now)?;
    ctx.accounts.pool.collect_and_credit()?;

    let a = &ctx.accounts;
    let pool = &a.pool;
    let w = read_whirlpool(pool.whirlpool.as_ref())?;
    let (need_a, need_b) = liquidity_token_deltas(w.tick_current_index, w.sqrt_price, pool.bucket.tick_lower, pool.bucket.tick_upper, liquidity, true)?;
    let tp = pool.token_program.to_account_info();
    let market_key = pool.market.key();
    let vb = [pool.market.vault_bump];
    let seeds = vault_signer_seeds(&market_key, &vb);
    let (owner_a, owner_b) = pool.ab_owners(a.escrow_base.as_ref(), a.escrow_quote.as_ref());
    let pos_before = read_position(pool.position.as_ref())?;
    // Fails (and persists nothing) if the escrow cannot fund this bucket at the current price;
    // the LP may top up the escrow or cancel.
    orca::increase_liquidity(&pool.liquidity_accounts(&owner_a, &owner_b, &tp), liquidity, need_a, need_b, &[&seeds])?;
    require!(
        read_position(pool.position.as_ref())?.liquidity == pos_before.liquidity + liquidity,
        ForgeError::UnexpectedCpiAmounts
    );

    let lp_key = ctx.accounts.ticket.lp;
    let bump = ctx.bumps.lp_position;
    let bucket = &mut ctx.accounts.pool.bucket;
    let lp = &mut ctx.accounts.lp_position;
    init_lp_if_new(lp, lp_key, bucket, bump);
    checkpoint_lp(lp, bucket)?;
    lp.liquidity += liquidity;
    bucket.total_liquidity += liquidity;
    ctx.accounts.ticket.cursor += 1;
    Ok(())
}

#[derive(Accounts)]
pub struct FinishLpDeposit<'info> {
    pub lp: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one = lp @ ForgeError::Unauthorized, has_one = market)]
    pub ticket: Box<Account<'info, LpDeposit>>,
    /// CHECK: ticket escrow (base).
    #[account(mut, seeds = [b"deposit_base", ticket.key().as_ref()], bump = ticket.escrow_base_bump)]
    pub escrow_base: UncheckedAccount<'info>,
    /// CHECK: ticket escrow (quote).
    #[account(mut, seeds = [b"deposit_quote", ticket.key().as_ref()], bump = ticket.escrow_quote_bump)]
    pub escrow_quote: UncheckedAccount<'info>,
    #[account(mut, token::mint = market.base_mint, token::authority = lp)]
    pub lp_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.quote_mint, token::authority = lp)]
    pub lp_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Finalize a fully redeployed deposit, or cancel a pending one. Either way the ticket's
/// remaining escrow (rounding remainder, or undeployed liquidity) returns to the LP; shares
/// already minted for redeployed buckets stay valid.
pub fn finish_lp_deposit(ctx: Context<FinishLpDeposit>, cancel: bool) -> Result<()> {
    let t = &ctx.accounts.ticket;
    require!(t.state == DepositState::Pending, ForgeError::InvalidState);
    if !cancel {
        require!(t.cursor == t.bucket_count, ForgeError::InvalidState);
    }
    let a = &ctx.accounts;
    let market_key = a.market.key();
    let vb = [a.market.vault_bump];
    let seeds = vault_signer_seeds(&market_key, &vb);
    let tp = a.token_program.to_account_info();
    let vault = a.vault.to_account_info();
    let lp = a.lp.to_account_info();
    let rb = token_util::amount(a.escrow_base.as_ref())?;
    let rq = token_util::amount(a.escrow_quote.as_ref())?;
    token_util::transfer_signed(&tp, a.escrow_base.as_ref(), &a.lp_base.to_account_info(), &vault, rb, &[&seeds])?;
    token_util::transfer_signed(&tp, a.escrow_quote.as_ref(), &a.lp_quote.to_account_info(), &vault, rq, &[&seeds])?;
    token_util::close_signed(&tp, a.escrow_base.as_ref(), &lp, &vault, &[&seeds])?;
    token_util::close_signed(&tp, a.escrow_quote.as_ref(), &lp, &vault, &[&seeds])?;
    ctx.accounts.ticket.state = if cancel { DepositState::Cancelled } else { DepositState::Done };
    Ok(())
}
