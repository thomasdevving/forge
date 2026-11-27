//! Opening a strategy (sections 8.2, 8.5). One-transaction opens pack begin_open,
//! execute_open_batch and finalize_open into a single atomic transaction; larger strategies
//! run the same instructions across transactions with reservations held in between.

use super::common::*;
use crate::constants::*;
use crate::error::ForgeError;
use crate::math::orca::liquidity_token_deltas;
use crate::math::premium::{base_to_quote, bounty_reserve, utilization_ppm};
use crate::math::{ceil_div_u128, deviation_bps, to_u64, BPS};
use crate::orca::{self, read_whirlpool, LiquidityAccounts};
use crate::reference::{check_pool_deviation, load_reference};
use crate::state::*;
use crate::token_util;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct LegSpec {
    pub kind_tag: u8,
    pub tick_lower: i32,
    pub liquidity: u128,
    /// Restoration buffer above the market minimum, in the removed mint.
    pub extra_buffer: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BeginOpenArgs {
    pub nonce: u64,
    pub legs: Vec<LegSpec>,
    pub premium_budget: u64,
    pub expiry: i64,
    pub open_reference_x64: u128,
    pub open_tolerance_bps: u16,
    pub swap_slippage_bps: u16,
    pub certificate_hash: [u8; 32],
}

#[derive(Accounts)]
#[instruction(args: BeginOpenArgs)]
pub struct BeginOpen<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA, authority of the escrow accounts.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = owner, space = 8 + Strategy::INIT_SPACE,
        seeds = [STRATEGY_SEED, market.key().as_ref(), owner.key().as_ref(), &args.nonce.to_le_bytes()], bump)]
    pub strategy: Box<Account<'info, Strategy>>,
    #[account(init, payer = owner, seeds = [ESCROW_BASE_SEED, strategy.key().as_ref()], bump,
        token::mint = base_mint, token::authority = vault)]
    pub escrow_base: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = owner, seeds = [ESCROW_QUOTE_SEED, strategy.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault)]
    pub escrow_quote: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = owner, seeds = [BUDGET_SEED, strategy.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault)]
    pub budget: Box<Account<'info, TokenAccount>>,
    #[account(address = market.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = market.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = base_mint, token::authority = owner)]
    pub user_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = owner)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    /// CHECK: market Whirlpool, read only here.
    #[account(address = market.whirlpool)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_base: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration (unused for scenario).
    pub reference_quote: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn begin_open<'info>(ctx: Context<'info, BeginOpen<'info>>, args: BeginOpenArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market_key = ctx.accounts.market.key();
    let market = &ctx.accounts.market;
    let p = market.params;
    require!(!market.opens_paused, ForgeError::OpensPaused);
    require!(!market.borrow_paused, ForgeError::BorrowPaused);
    let n = args.legs.len();
    require!(
        n >= 1 && n <= p.max_buckets_per_strategy as usize && n <= MAX_LEGS,
        ForgeError::TooManyLegs
    );
    require!(ctx.remaining_accounts.len() == n, ForgeError::LegAccountMismatch);
    require!(args.premium_budget > 0, ForgeError::InsufficientBudget);
    require!(
        args.open_tolerance_bps > 0 && args.open_tolerance_bps <= p.open_tolerance_bps,
        ForgeError::InvalidParameters
    );
    require!(
        args.swap_slippage_bps > 0 && args.swap_slippage_bps <= p.swap_slippage_bps,
        ForgeError::InvalidParameters
    );
    require!(
        args.expiry == 0 || args.expiry >= now + MIN_EXPIRY_SECONDS,
        ForgeError::InvalidExpiry
    );

    let reference = load_reference(
        market,
        &ctx.accounts.reference_base.to_account_info(),
        Some(&ctx.accounts.reference_quote.to_account_info()),
        now,
    )?;
    require!(
        deviation_bps(reference.price_x64, args.open_reference_x64)? <= args.open_tolerance_bps as u128,
        ForgeError::OpenTolerance
    );
    let w = read_whirlpool(&ctx.accounts.whirlpool.to_account_info())?;
    check_pool_deviation(w.sqrt_price, market.base_is_a, &reference, p.pool_deviation_bps)?;

    let mut legs = [Leg::default(); MAX_LEGS];
    let mut buffer_base: u64 = 0;
    let mut buffer_quote: u64 = 0;
    for (i, spec) in args.legs.iter().enumerate() {
        require!(spec.liquidity > 0, ForgeError::ZeroAmount);
        let kind = match spec.kind_tag {
            0 => LegKind::BorrowQuote,
            1 => LegKind::BorrowBase,
            _ => return err!(ForgeError::InvalidLeg),
        };
        let info = &ctx.remaining_accounts[i];
        for prev in &legs[..i] {
            require_keys_neq!(prev.bucket, *info.key, ForgeError::LegAccountMismatch);
        }
        let mut bucket: Account<'info, Bucket> = Account::try_from(info)?;
        require_keys_eq!(bucket.market, market_key, ForgeError::LegAccountMismatch);
        require!(bucket.tick_lower == spec.tick_lower, ForgeError::LegAccountMismatch);
        check_borrow_side(kind, market.base_is_a, &w, bucket.tick_lower, bucket.tick_upper)?;

        // Reserve: counts toward utilization immediately; withdrawal-requested liquidity
        // cannot be newly borrowed.
        let committed = bucket
            .borrowed
            .checked_add(bucket.reserved)
            .and_then(|v| v.checked_add(spec.liquidity))
            .ok_or(error!(ForgeError::MathOverflow))?;
        require!(
            committed
                .checked_add(bucket.withdrawal_requested)
                .ok_or(error!(ForgeError::MathOverflow))?
                <= bucket.total_liquidity,
            ForgeError::UtilizationCap
        );
        let u = utilization_ppm(committed, bucket.total_liquidity)?;
        let multiplier_ppm = p.curve.multiplier_ppm(u)?;

        // Removed amounts are price-independent while strictly out of range.
        let (ra, rb) = liquidity_token_deltas(
            w.tick_current_index,
            w.sqrt_price,
            bucket.tick_lower,
            bucket.tick_upper,
            spec.liquidity,
            false,
        )?;
        let (removed_base, removed_quote) = to_base_quote(market.base_is_a, ra, rb);
        let removed = match kind {
            LegKind::BorrowQuote => {
                require!(removed_base == 0 && removed_quote > 0, ForgeError::BorrowNotOutOfRange);
                removed_quote
            }
            LegKind::BorrowBase => {
                require!(removed_quote == 0 && removed_base > 0, ForgeError::BorrowNotOutOfRange);
                removed_base
            }
        };
        let min_buffer = to_u64(ceil_div_u128(
            removed as u128 * p.restoration_buffer_bps as u128,
            BPS,
        )?)?;
        let buffer = min_buffer
            .checked_add(spec.extra_buffer)
            .ok_or(error!(ForgeError::MathOverflow))?;
        let notional_quote = match kind {
            LegKind::BorrowQuote => removed_quote,
            LegKind::BorrowBase => base_to_quote(removed_base, reference.price_x64)?,
        };
        match kind {
            LegKind::BorrowQuote => buffer_quote = buffer_quote.checked_add(buffer).ok_or(error!(ForgeError::MathOverflow))?,
            LegKind::BorrowBase => buffer_base = buffer_base.checked_add(buffer).ok_or(error!(ForgeError::MathOverflow))?,
        }
        legs[i] = Leg {
            kind_tag: spec.kind_tag,
            bucket: bucket.key(),
            tick_lower: bucket.tick_lower,
            tick_upper: bucket.tick_upper,
            liquidity: spec.liquidity,
            removed_base,
            removed_quote,
            escrow_base: if kind == LegKind::BorrowBase { buffer } else { 0 },
            escrow_quote: if kind == LegKind::BorrowQuote { buffer } else { 0 },
            buffer,
            multiplier_ppm,
            notional_quote,
            ..Leg::default()
        };
        bucket.reserved = bucket.reserved.checked_add(spec.liquidity).ok_or(error!(ForgeError::MathOverflow))?;
        bucket.exit(&crate::ID)?;
    }

    // Lock all user funding (budget and buffers) before any liquidity is removed.
    let tp = ctx.accounts.token_program.to_account_info();
    let owner = ctx.accounts.owner.to_account_info();
    token_util::transfer_from_user(&tp, &ctx.accounts.user_quote.to_account_info(), &ctx.accounts.budget.to_account_info(), &owner, args.premium_budget)?;
    token_util::transfer_from_user(&tp, &ctx.accounts.user_quote.to_account_info(), &ctx.accounts.escrow_quote.to_account_info(), &owner, buffer_quote)?;
    token_util::transfer_from_user(&tp, &ctx.accounts.user_base.to_account_info(), &ctx.accounts.escrow_base.to_account_info(), &owner, buffer_base)?;

    let s = &mut ctx.accounts.strategy;
    s.owner = ctx.accounts.owner.key();
    s.market = market_key;
    s.nonce = args.nonce;
    s.state = StrategyState::PendingOpen;
    s.created_at = now;
    s.expiry = args.expiry;
    s.pending_deadline = now + p.pending_open_deadline_s as i64;
    s.certificate_hash = args.certificate_hash;
    s.open_reference_x64 = args.open_reference_x64;
    s.open_tolerance_bps = args.open_tolerance_bps;
    s.swap_slippage_bps = args.swap_slippage_bps;
    s.floor_rate_bps = p.floor_rate_bps;
    s.keeper_trigger_bps = p.keeper_trigger_bps;
    s.premium_budget = args.premium_budget;
    s.bounty_reserve = bounty_reserve(args.premium_budget, p.bounty_bps);
    s.leg_count = n as u8;
    s.legs = legs;
    s.bump = ctx.bumps.strategy;
    s.escrow_base_bump = ctx.bumps.escrow_base;
    s.escrow_quote_bump = ctx.bumps.escrow_quote;
    s.budget_bump = ctx.bumps.budget;
    ctx.accounts.market.strategy_count += 1;
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteOpenBatch<'info> {
    pub owner: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA (position authority).
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one = owner @ ForgeError::Unauthorized, has_one = market)]
    pub strategy: Box<Account<'info, Strategy>>,
    /// CHECK: market Whirlpool.
    #[account(mut, address = market.whirlpool)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: checked against the Whirlpool.
    #[account(mut)]
    pub whirlpool_vault_a: UncheckedAccount<'info>,
    /// CHECK: checked against the Whirlpool.
    #[account(mut)]
    pub whirlpool_vault_b: UncheckedAccount<'info>,
    /// CHECK: strategy escrow (base).
    #[account(mut, seeds = [ESCROW_BASE_SEED, strategy.key().as_ref()], bump = strategy.escrow_base_bump)]
    pub escrow_base: UncheckedAccount<'info>,
    /// CHECK: strategy escrow (quote).
    #[account(mut, seeds = [ESCROW_QUOTE_SEED, strategy.key().as_ref()], bump = strategy.escrow_quote_bump)]
    pub escrow_quote: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_base: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_quote: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

pub fn execute_open_batch<'info>(
    ctx: Context<'info, ExecuteOpenBatch<'info>>,
    leg_indices: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let market = &a.market;
    let market_key = market.key();
    require!(a.strategy.state == StrategyState::PendingOpen, ForgeError::InvalidState);
    require!(now <= a.strategy.pending_deadline, ForgeError::DeadlinePassed);
    require!(
        !leg_indices.is_empty() && leg_indices.len() <= market.params.max_ops_per_tx as usize,
        ForgeError::TooManyOps
    );

    let reference = load_reference(market, &a.reference_base.to_account_info(), Some(&a.reference_quote.to_account_info()), now)?;
    require!(
        deviation_bps(reference.price_x64, a.strategy.open_reference_x64)? <= a.strategy.open_tolerance_bps as u128,
        ForgeError::OpenTolerance
    );

    let vb = [market.vault_bump];
    let seeds = vault_signer_seeds(&market_key, &vb);
    let (owner_a, owner_b) = if market.base_is_a {
        (a.escrow_base.to_account_info(), a.escrow_quote.to_account_info())
    } else {
        (a.escrow_quote.to_account_info(), a.escrow_base.to_account_info())
    };

    let mut strategy: Box<Strategy> = Box::new((**a.strategy).clone());
    for (slot, &idx) in leg_indices.iter().enumerate() {
        let idx = idx as usize;
        require!(idx < strategy.leg_count as usize, ForgeError::InvalidLeg);
        require!(!strategy.legs[idx].executed, ForgeError::InvalidLeg);
        require!(!leg_indices[..slot].contains(&(idx as u8)), ForgeError::InvalidLeg);
        let leg = strategy.legs[idx];
        let infos = leg_infos(ctx.remaining_accounts, slot)?;
        let mut bucket = load_leg_bucket(&infos, &leg, &market_key)?;

        // Re-read the pool before every CPI: an earlier one may have changed it.
        let w = read_whirlpool(&a.whirlpool.to_account_info())?;
        require_keys_eq!(a.whirlpool_vault_a.key(), w.vault_a, ForgeError::InvalidOrcaAccount);
        require_keys_eq!(a.whirlpool_vault_b.key(), w.vault_b, ForgeError::InvalidOrcaAccount);
        check_pool_deviation(w.sqrt_price, market.base_is_a, &reference, market.params.pool_deviation_bps)?;
        check_borrow_side(leg.kind()?, market.base_is_a, &w, leg.tick_lower, leg.tick_upper)?;
        let growth = growth_inside(&w, &market.whirlpool, infos.tick_array_lower, infos.tick_array_upper, leg.tick_lower, leg.tick_upper)?;

        let before_base = token_util::amount(&a.escrow_base.to_account_info())?;
        let before_quote = token_util::amount(&a.escrow_quote.to_account_info())?;
        let (min_a, min_b) = to_a_b(market.base_is_a, leg.removed_base, leg.removed_quote);
        orca::decrease_liquidity(
            &LiquidityAccounts {
                whirlpool: &a.whirlpool.to_account_info(),
                token_program: &a.token_program.to_account_info(),
                position_authority: &a.vault.to_account_info(),
                position: infos.position,
                position_token_account: infos.position_token_account,
                owner_a: &owner_a,
                owner_b: &owner_b,
                vault_a: &a.whirlpool_vault_a.to_account_info(),
                vault_b: &a.whirlpool_vault_b.to_account_info(),
                tick_array_lower: infos.tick_array_lower,
                tick_array_upper: infos.tick_array_upper,
                whirlpool_program: &a.whirlpool_program.to_account_info(),
            },
            leg.liquidity,
            min_a,
            min_b,
            &[&seeds],
        )?;
        let got_base = token_util::amount(&a.escrow_base.to_account_info())? - before_base;
        let got_quote = token_util::amount(&a.escrow_quote.to_account_info())? - before_quote;
        require!(
            got_base == leg.removed_base && got_quote == leg.removed_quote,
            ForgeError::UnexpectedCpiAmounts
        );

        bucket.reserved = bucket.reserved.checked_sub(leg.liquidity).ok_or(error!(ForgeError::MathOverflow))?;
        bucket.borrowed = bucket.borrowed.checked_add(leg.liquidity).ok_or(error!(ForgeError::MathOverflow))?;
        bucket.open_legs += 1;
        let l = &mut strategy.legs[idx];
        l.executed = true;
        l.opened_at = now;
        l.growth_a_x64 = growth.0;
        l.growth_b_x64 = growth.1;
        l.escrow_base += got_base;
        l.escrow_quote += got_quote;
        l.last_checkpoint_ts = now;
        bucket.record_leg_checkpoint(now);
        bucket.exit(&crate::ID)?;
    }
    write_back(&mut ctx.accounts.strategy, &mut strategy);
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeOpen<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ ForgeError::Unauthorized)]
    pub strategy: Box<Account<'info, Strategy>>,
}

pub fn finalize_open(ctx: Context<FinalizeOpen>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let s = &mut ctx.accounts.strategy;
    require!(s.state == StrategyState::PendingOpen, ForgeError::InvalidState);
    require!(s.all_executed(), ForgeError::InvalidState);
    require!(s.expiry == 0 || s.expiry >= now + MIN_EXPIRY_SECONDS, ForgeError::InvalidExpiry);
    s.state = StrategyState::Open;
    s.opened_at = now;
    Ok(())
}
