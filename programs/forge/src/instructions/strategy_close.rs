//! Closing, guarded restoration (section 8.4), premium checkpoints, recovery and settlement.

use super::common::*;
use crate::constants::*;
use crate::error::ForgeError;
use crate::math::orca::liquidity_token_deltas;
use crate::math::premium::{base_to_quote, crank_allowed, quote_to_base};
use crate::math::{ceil_div_u128, mul_div, to_u64, U256, BPS, Q64};
use crate::orca::{self, read_position, read_whirlpool, LiquidityAccounts, SwapAccounts};
use crate::reference::{check_pool_deviation, load_reference, ReferencePrice};
use crate::state::*;
use crate::token_util;
use anchor_lang::prelude::*;
use anchor_spl::token::Token;

// ---------------------------------------------------------------------------------------------
// begin_close: owner at any time; a keeper once expiry, the budget trigger or an LP notice
// condition is met. Locks the strategy into PendingClose.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct BeginClose<'info> {
    pub caller: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market)]
    pub strategy: Box<Account<'info, Strategy>>,
}

pub fn begin_close<'info>(ctx: Context<'info, BeginClose<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let s = &ctx.accounts.strategy;
    require!(s.state == StrategyState::Open, ForgeError::InvalidState);
    let caller = ctx.accounts.caller.key();
    let by_keeper = caller != s.owner;
    if by_keeper {
        let expired = s.expiry != 0 && now >= s.expiry;
        let budget_trigger = crank_allowed(s.premium_accrued, s.lp_cap(), s.keeper_trigger_bps);
        // LP notice: any of the strategy's buckets (passed as remaining accounts) has a
        // withdrawal request whose notice period has elapsed.
        let mut notice = false;
        for info in ctx.remaining_accounts.iter() {
            if !s.legs().iter().any(|l| l.bucket == *info.key) {
                continue;
            }
            let b: Account<Bucket> = Account::try_from(info)?;
            if b.withdrawal_requested > 0
                && b.withdrawal_notice_start > 0
                && now >= b.withdrawal_notice_start + ctx.accounts.market.params.notice_period_s as i64
            {
                notice = true;
            }
        }
        require!(expired || budget_trigger || notice, ForgeError::CloseNotAllowed);
    }
    let s = &mut ctx.accounts.strategy;
    s.state = StrategyState::PendingClose;
    s.close_by_keeper = by_keeper;
    s.keeper = caller;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// abort_open: owner cancellation, or anyone after the pending-open deadline. Releases untouched
// reservations now; executed legs are unwound through the guarded restoration path.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct AbortOpen<'info> {
    pub caller: Signer<'info>,
    #[account(mut, has_one = market)]
    pub strategy: Box<Account<'info, Strategy>>,
    pub market: Box<Account<'info, Market>>,
}

pub fn abort_open<'info>(ctx: Context<'info, AbortOpen<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mut s: Box<Strategy> = Box::new((**ctx.accounts.strategy).clone());
    require!(s.state == StrategyState::PendingOpen, ForgeError::InvalidState);
    require!(
        ctx.accounts.caller.key() == s.owner || now > s.pending_deadline,
        ForgeError::Unauthorized
    );
    // remaining accounts: bucket accounts of every unexecuted leg, in leg order
    let mut k = 0;
    for i in 0..s.leg_count as usize {
        if s.legs[i].executed {
            continue;
        }
        let info = ctx.remaining_accounts.get(k).ok_or(error!(ForgeError::LegAccountMismatch))?;
        k += 1;
        require_keys_eq!(*info.key, s.legs[i].bucket, ForgeError::LegAccountMismatch);
        let mut b: Account<Bucket> = Account::try_from(info)?;
        b.reserved = b.reserved.checked_sub(s.legs[i].liquidity).ok_or(error!(ForgeError::MathOverflow))?;
        b.exit(&crate::ID)?;
        // the untouched leg keeps only its buffer, which is refunded at settlement
        s.legs[i].restored = true;
    }
    s.aborting = true;
    s.state = StrategyState::PendingClose;
    s.keeper = ctx.accounts.caller.key();
    write_back(&mut ctx.accounts.strategy, &mut s);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// checkpoint_leg: permissionless premium accrual + payment for one open leg.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct CheckpointLeg<'info> {
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one = market)]
    pub strategy: Box<Account<'info, Strategy>>,
    /// CHECK: market Whirlpool (read).
    #[account(address = market.whirlpool)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: strategy premium budget.
    #[account(mut, seeds = [BUDGET_SEED, strategy.key().as_ref()], bump = strategy.budget_bump)]
    pub budget: UncheckedAccount<'info>,
    /// CHECK: market premium vault.
    #[account(mut, address = market.premium_vault)]
    pub premium_vault: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_base: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_quote: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn checkpoint_leg<'info>(ctx: Context<'info, CheckpointLeg<'info>>, leg_index: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let market = &a.market;
    let market_key = market.key();
    let mut s: Box<Strategy> = Box::new((**a.strategy).clone());
    require!(
        matches!(s.state, StrategyState::Open | StrategyState::PendingClose | StrategyState::Recovery),
        ForgeError::InvalidState
    );
    let idx = leg_index as usize;
    require!(idx < s.leg_count as usize, ForgeError::InvalidLeg);
    let leg = s.legs[idx];
    require!(leg.executed && !leg.restored, ForgeError::InvalidLeg);
    // remaining: bucket, tick_array_lower, tick_array_upper
    let rem = ctx.remaining_accounts;
    require!(rem.len() == 3, ForgeError::LegAccountMismatch);
    require_keys_eq!(*rem[0].key, leg.bucket, ForgeError::LegAccountMismatch);
    let mut bucket: Account<Bucket> = Account::try_from(&rem[0])?;
    require_keys_eq!(bucket.market, market_key, ForgeError::LegAccountMismatch);

    let reference = load_reference(market, &a.reference_base.to_account_info(), Some(&a.reference_quote.to_account_info()), now)?;
    let w = read_whirlpool(&a.whirlpool.to_account_info())?;
    let growth = growth_inside(&w, &market.whirlpool, &rem[1], &rem[2], leg.tick_lower, leg.tick_upper)?;
    let lp_cap = s.lp_cap();
    let floor_rate = s.floor_rate_bps;
    let (mut paid, mut binding) = (s.premium_paid, s.cap_binding);
    {
        let l = &mut s.legs[idx];
        accrue_leg(l, growth, market.base_is_a, &reference, floor_rate, now)?;
        let vb = [market.vault_bump];
        let seeds = vault_signer_seeds(&market_key, &vb);
        pay_leg_increment(
            &mut paid,
            &mut binding,
            lp_cap,
            l,
            &mut bucket,
            &PayAccounts {
                token_program: &a.token_program.to_account_info(),
                budget: &a.budget.to_account_info(),
                premium_vault: &a.premium_vault.to_account_info(),
                vault: &a.vault.to_account_info(),
            },
            &[&seeds],
            now,
        )?;
    }
    s.premium_paid = paid;
    s.cap_binding = binding;
    s.premium_accrued = s.legs().iter().map(|l| l.premium).sum();
    bucket.exit(&crate::ID)?;
    write_back(&mut ctx.accounts.strategy, &mut s);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// execute_close_batch: guarded restoration of up to `max_ops_per_tx` legs. Permissionless once
// a close (or abort) has been authorized; retries are idempotent per leg.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ExecuteCloseBatch<'info> {
    pub caller: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one = market)]
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
    /// CHECK: strategy premium budget.
    #[account(mut, seeds = [BUDGET_SEED, strategy.key().as_ref()], bump = strategy.budget_bump)]
    pub budget: UncheckedAccount<'info>,
    /// CHECK: market premium vault.
    #[account(mut, address = market.premium_vault)]
    pub premium_vault: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_base: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_quote: UncheckedAccount<'info>,
    /// CHECK: registered restoration pool (never the pool being restored).
    #[account(mut, address = market.swap_pool)]
    pub swap_pool: UncheckedAccount<'info>,
    /// CHECK: checked against the swap pool.
    #[account(mut)]
    pub swap_vault_a: UncheckedAccount<'info>,
    /// CHECK: checked against the swap pool.
    #[account(mut)]
    pub swap_vault_b: UncheckedAccount<'info>,
    /// CHECK: validated by Orca.
    #[account(mut)]
    pub swap_tick_array_0: UncheckedAccount<'info>,
    /// CHECK: validated by Orca.
    #[account(mut)]
    pub swap_tick_array_1: UncheckedAccount<'info>,
    /// CHECK: validated by Orca.
    #[account(mut)]
    pub swap_tick_array_2: UncheckedAccount<'info>,
    /// CHECK: swap pool oracle PDA.
    #[account(mut, address = orca::oracle_address(&market.swap_pool))]
    pub swap_oracle: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Orca Whirlpool program.
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

pub fn execute_close_batch<'info>(
    ctx: Context<'info, ExecuteCloseBatch<'info>>,
    leg_indices: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let market = &a.market;
    let market_key = market.key();
    let mut s: Box<Strategy> = Box::new((**a.strategy).clone());
    require!(
        matches!(s.state, StrategyState::PendingClose | StrategyState::Recovery),
        ForgeError::InvalidState
    );
    require!(
        !leg_indices.is_empty() && leg_indices.len() <= market.params.max_ops_per_tx as usize,
        ForgeError::TooManyOps
    );
    let reference = load_reference(market, &a.reference_base.to_account_info(), Some(&a.reference_quote.to_account_info()), now)?;
    let vb = [market.vault_bump];
    let seeds = vault_signer_seeds(&market_key, &vb);
    let signer: &[&[&[u8]]] = &[&seeds];

    for (slot, &idx) in leg_indices.iter().enumerate() {
        let idx = idx as usize;
        require!(idx < s.leg_count as usize, ForgeError::InvalidLeg);
        require!(!leg_indices[..slot].contains(&(idx as u8)), ForgeError::InvalidLeg);
        let leg = s.legs[idx];
        // idempotent: already-restored or never-executed legs are skipped by the client
        require!(leg.executed && !leg.restored, ForgeError::InvalidLeg);
        let infos = leg_infos(ctx.remaining_accounts, slot)?;
        let mut bucket = load_leg_bucket(&infos, &leg, &market_key)?;

        // 1. Final premium checkpoint for this leg: accrual runs until restoration.
        let w = read_whirlpool(&a.whirlpool.to_account_info())?;
        require_keys_eq!(a.whirlpool_vault_a.key(), w.vault_a, ForgeError::InvalidOrcaAccount);
        require_keys_eq!(a.whirlpool_vault_b.key(), w.vault_b, ForgeError::InvalidOrcaAccount);
        check_pool_deviation(w.sqrt_price, market.base_is_a, &reference, market.params.pool_deviation_bps)?;
        let growth = growth_inside(&w, &market.whirlpool, infos.tick_array_lower, infos.tick_array_upper, leg.tick_lower, leg.tick_upper)?;
        let lp_cap = s.lp_cap();
        let floor_rate = s.floor_rate_bps;
        let (mut paid, mut binding) = (s.premium_paid, s.cap_binding);
        accrue_leg(&mut s.legs[idx], growth, market.base_is_a, &reference, floor_rate, now)?;
        pay_leg_increment(
            &mut paid,
            &mut binding,
            lp_cap,
            &mut s.legs[idx],
            &mut bucket,
            &PayAccounts {
                token_program: &a.token_program.to_account_info(),
                budget: &a.budget.to_account_info(),
                premium_vault: &a.premium_vault.to_account_info(),
                vault: &a.vault.to_account_info(),
            },
            signer,
            now,
        )?;
        s.premium_paid = paid;
        s.cap_binding = binding;

        // 2-3. Guarded restoration from this leg's escrow + buffer only.
        restore_leg(a, &mut s.legs[idx], &infos, &reference, s.swap_slippage_bps, signer)?;

        bucket.borrowed = bucket.borrowed.checked_sub(leg.liquidity).ok_or(error!(ForgeError::MathOverflow))?;
        bucket.open_legs = bucket.open_legs.saturating_sub(1);
        let l = &mut s.legs[idx];
        l.restored = true;
        l.restored_at = now;
        bucket.exit(&crate::ID)?;
    }
    s.premium_accrued = s.legs().iter().map(|l| l.premium).sum();
    write_back(&mut ctx.accounts.strategy, &mut s);
    Ok(())
}

/// Section 8.4 steps 1-4 for one bucket. Any failure reverts the whole transaction, including
/// the swap; there is no partial restoration of a bucket.
#[inline(never)]
fn restore_leg<'info>(
    a: &ExecuteCloseBatch<'info>,
    leg: &mut Leg,
    infos: &LegInfos<'info>,
    reference: &ReferencePrice,
    user_slippage_bps: u16,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let market = &a.market;
    let p = &market.params;
    let base_is_a = market.base_is_a;
    let slip = user_slippage_bps.min(p.swap_slippage_bps) as u128;

    let w = read_whirlpool(&a.whirlpool.to_account_info())?;
    let (ra, rb) = liquidity_token_deltas(w.tick_current_index, w.sqrt_price, leg.tick_lower, leg.tick_upper, leg.liquidity, true)?;
    let (need_base, need_quote) = to_base_quote(base_is_a, ra, rb);
    let def_base = need_base.saturating_sub(leg.escrow_base);
    let def_quote = need_quote.saturating_sub(leg.escrow_quote);
    require!(def_base == 0 || def_quote == 0, ForgeError::InsufficientRestorationFunds);

    if def_base > 0 || def_quote > 0 {
        // Approved, separate restoration pool; price-checked before and after the swap.
        let sw = read_whirlpool(&a.swap_pool.to_account_info())?;
        require_keys_eq!(a.swap_vault_a.key(), sw.vault_a, ForgeError::InvalidSwapPool);
        require_keys_eq!(a.swap_vault_b.key(), sw.vault_b, ForgeError::InvalidSwapPool);
        check_pool_deviation(sw.sqrt_price, base_is_a, reference, p.pool_deviation_bps)?;
        let buy_base = def_base > 0;
        // maximum input at the reference price plus the allowed all-in slippage
        let (out_amount, max_in, surplus) = if buy_base {
            let fair = base_to_quote(def_base, reference.price_x64)?;
            let max_in = to_u64(ceil_div_u128(fair as u128 * (BPS + slip), BPS)?)?;
            (def_base, max_in, leg.escrow_quote.saturating_sub(need_quote))
        } else {
            let fair = quote_to_base(def_quote, reference.price_x64, true)?;
            let max_in = to_u64(ceil_div_u128(fair as u128 * (BPS + slip), BPS)?)?;
            (def_quote, max_in, leg.escrow_base.saturating_sub(need_base))
        };
        let max_in = max_in.min(surplus);
        require!(max_in > 0, ForgeError::InsufficientRestorationFunds);
        // price limit: never trade beyond reference +/- slippage
        let limit_qpb = if buy_base {
            mul_div(reference.price_x64, BPS + slip, BPS, true)?
        } else {
            mul_div(reference.price_x64, BPS - slip, BPS, false)?
        };
        let sqrt_limit = sqrt_limit_for_price(limit_qpb, base_is_a)?;
        // a_to_b: paying token A. Buying base pays quote; selling base pays base.
        let pay_is_a = if buy_base { !base_is_a } else { base_is_a };
        let (owner_a, owner_b) = if base_is_a {
            (a.escrow_base.to_account_info(), a.escrow_quote.to_account_info())
        } else {
            (a.escrow_quote.to_account_info(), a.escrow_base.to_account_info())
        };
        let b0 = token_util::amount(&a.escrow_base.to_account_info())?;
        let q0 = token_util::amount(&a.escrow_quote.to_account_info())?;
        orca::swap(
            &SwapAccounts {
                token_program: &a.token_program.to_account_info(),
                token_authority: &a.vault.to_account_info(),
                whirlpool: &a.swap_pool.to_account_info(),
                owner_a: &owner_a,
                vault_a: &a.swap_vault_a.to_account_info(),
                owner_b: &owner_b,
                vault_b: &a.swap_vault_b.to_account_info(),
                tick_array_0: &a.swap_tick_array_0.to_account_info(),
                tick_array_1: &a.swap_tick_array_1.to_account_info(),
                tick_array_2: &a.swap_tick_array_2.to_account_info(),
                oracle: &a.swap_oracle.to_account_info(),
                whirlpool_program: &a.whirlpool_program.to_account_info(),
            },
            out_amount,
            max_in,
            sqrt_limit,
            false, // exact output
            pay_is_a,
            signer,
        )?;
        let b1 = token_util::amount(&a.escrow_base.to_account_info())?;
        let q1 = token_util::amount(&a.escrow_quote.to_account_info())?;
        let (paid, got) = if buy_base {
            (q0.checked_sub(q1).ok_or(error!(ForgeError::UnexpectedCpiAmounts))?, b1.checked_sub(b0).ok_or(error!(ForgeError::UnexpectedCpiAmounts))?)
        } else {
            (b0.checked_sub(b1).ok_or(error!(ForgeError::UnexpectedCpiAmounts))?, q1.checked_sub(q0).ok_or(error!(ForgeError::UnexpectedCpiAmounts))?)
        };
        require!(got >= out_amount && paid <= max_in, ForgeError::SwapSlippage);
        // all-in execution price vs reference (quote per base)
        if buy_base {
            // paid_quote / got_base <= ref * (1 + slip)
            require!(
                U256::from(paid) * U256::from(BPS) * U256::from(Q64)
                    <= U256::from(got) * U256::from(reference.price_x64) * U256::from(BPS + slip),
                ForgeError::SwapSlippage
            );
            leg.escrow_quote -= paid;
            leg.escrow_base += got;
        } else {
            // got_quote / paid_base >= ref * (1 - slip)
            require!(
                U256::from(got) * U256::from(BPS) * U256::from(Q64)
                    >= U256::from(paid) * U256::from(reference.price_x64) * U256::from(BPS - slip),
                ForgeError::SwapSlippage
            );
            leg.escrow_base -= paid;
            leg.escrow_quote += got;
        }
        leg.swap_in = leg.swap_in.saturating_add(paid);
        leg.swap_out = leg.swap_out.saturating_add(got);
        let sw_after = read_whirlpool(&a.swap_pool.to_account_info())?;
        check_pool_deviation(sw_after.sqrt_price, base_is_a, reference, p.pool_deviation_bps)?;
    }

    // Re-read the target pool, recompute exact amounts, recheck guards, then restore exactly L.
    let w = read_whirlpool(&a.whirlpool.to_account_info())?;
    check_pool_deviation(w.sqrt_price, base_is_a, reference, p.pool_deviation_bps)?;
    let (ra, rb) = liquidity_token_deltas(w.tick_current_index, w.sqrt_price, leg.tick_lower, leg.tick_upper, leg.liquidity, true)?;
    let (need_base, need_quote) = to_base_quote(base_is_a, ra, rb);
    require!(
        need_base <= leg.escrow_base && need_quote <= leg.escrow_quote,
        ForgeError::InsufficientRestorationFunds
    );
    let pos_before = read_position(infos.position)?;
    let b0 = token_util::amount(&a.escrow_base.to_account_info())?;
    let q0 = token_util::amount(&a.escrow_quote.to_account_info())?;
    let (owner_a, owner_b) = if base_is_a {
        (a.escrow_base.to_account_info(), a.escrow_quote.to_account_info())
    } else {
        (a.escrow_quote.to_account_info(), a.escrow_base.to_account_info())
    };
    orca::increase_liquidity(
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
        ra,
        rb,
        signer,
    )?;
    let pos_after = read_position(infos.position)?;
    require!(
        pos_after.liquidity == pos_before.liquidity + leg.liquidity,
        ForgeError::RestorationMismatch
    );
    let spent_base = b0 - token_util::amount(&a.escrow_base.to_account_info())?;
    let spent_quote = q0 - token_util::amount(&a.escrow_quote.to_account_info())?;
    require!(
        spent_base == need_base && spent_quote == need_quote,
        ForgeError::RestorationMismatch
    );
    leg.escrow_base -= spent_base;
    leg.escrow_quote -= spent_quote;
    let w_after = read_whirlpool(&a.whirlpool.to_account_info())?;
    check_pool_deviation(w_after.sqrt_price, base_is_a, reference, p.pool_deviation_bps)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Recovery (section 8.4 step 5). A failed restoration transaction persists nothing, so this
// separate instruction records that a leg cannot currently be restored within limits.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RecordRecovery<'info> {
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market)]
    pub strategy: Box<Account<'info, Strategy>>,
    /// CHECK: market Whirlpool (read).
    #[account(address = market.whirlpool)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: registered restoration pool (read).
    #[account(address = market.swap_pool)]
    pub swap_pool: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_base: UncheckedAccount<'info>,
    /// CHECK: validated against the market reference configuration.
    pub reference_quote: UncheckedAccount<'info>,
}

pub fn record_recovery(ctx: Context<RecordRecovery>, leg_index: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;
    let s = &ctx.accounts.strategy;
    require!(s.state == StrategyState::PendingClose, ForgeError::InvalidState);
    let idx = leg_index as usize;
    require!(idx < s.leg_count as usize, ForgeError::InvalidLeg);
    let leg = s.legs[idx];
    require!(leg.executed && !leg.restored, ForgeError::InvalidLeg);

    let blocked = match load_reference(
        market,
        &ctx.accounts.reference_base.to_account_info(),
        Some(&ctx.accounts.reference_quote.to_account_info()),
        now,
    ) {
        // reference unavailable: restoration cannot proceed safely
        Err(_) => true,
        Ok(reference) => {
            let p = &market.params;
            let w = read_whirlpool(&ctx.accounts.whirlpool.to_account_info())?;
            let sw = read_whirlpool(&ctx.accounts.swap_pool.to_account_info())?;
            let target_ok = check_pool_deviation(w.sqrt_price, market.base_is_a, &reference, p.pool_deviation_bps).is_ok();
            let swap_ok = check_pool_deviation(sw.sqrt_price, market.base_is_a, &reference, p.pool_deviation_bps).is_ok();
            let (ra, rb) = liquidity_token_deltas(w.tick_current_index, w.sqrt_price, leg.tick_lower, leg.tick_upper, leg.liquidity, true)?;
            let (need_base, need_quote) = to_base_quote(market.base_is_a, ra, rb);
            let slip = s.swap_slippage_bps.min(p.swap_slippage_bps) as u128;
            // value both sides at the worst allowed execution price
            let funded = if need_base > leg.escrow_base {
                let fair = base_to_quote(need_base - leg.escrow_base, reference.price_x64)?;
                let worst = ceil_div_u128(fair as u128 * (BPS + slip), BPS)?;
                (leg.escrow_quote.saturating_sub(need_quote) as u128) >= worst
            } else if need_quote > leg.escrow_quote {
                let fair = quote_to_base(need_quote - leg.escrow_quote, reference.price_x64, true)?;
                let worst = ceil_div_u128(fair as u128 * (BPS + slip), BPS)?;
                (leg.escrow_base.saturating_sub(need_base) as u128) >= worst
            } else {
                true
            };
            !(target_ok && swap_ok && funded)
        }
    };
    require!(blocked, ForgeError::RecoveryNotNeeded);
    let first = !ctx.accounts.strategy.recovery_recorded;
    let m = &mut ctx.accounts.market;
    m.borrow_paused = true;
    if first {
        m.unresolved_strategies += 1;
    }
    let s = &mut ctx.accounts.strategy;
    s.recovery_recorded = true;
    s.state = StrategyState::Recovery;
    Ok(())
}

#[derive(Accounts)]
pub struct TopUpBuffer<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ ForgeError::Unauthorized)]
    pub strategy: Box<Account<'info, Strategy>>,
    /// CHECK: owner's token account in the chosen mint; the token program enforces authority.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: one of the strategy's escrow accounts, checked in the handler.
    #[account(mut)]
    pub escrow: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn top_up_buffer(ctx: Context<TopUpBuffer>, leg_index: u8, amount: u64) -> Result<()> {
    require!(amount > 0, ForgeError::ZeroAmount);
    let s_key = ctx.accounts.strategy.key();
    let s = &ctx.accounts.strategy;
    require!(
        matches!(s.state, StrategyState::Open | StrategyState::PendingClose | StrategyState::Recovery),
        ForgeError::InvalidState
    );
    let idx = leg_index as usize;
    require!(idx < s.leg_count as usize && !s.legs[idx].restored, ForgeError::InvalidLeg);
    let base_escrow = Pubkey::create_program_address(&[ESCROW_BASE_SEED, s_key.as_ref(), &[s.escrow_base_bump]], &crate::ID)
        .map_err(|_| error!(ForgeError::LegAccountMismatch))?;
    let quote_escrow = Pubkey::create_program_address(&[ESCROW_QUOTE_SEED, s_key.as_ref(), &[s.escrow_quote_bump]], &crate::ID)
        .map_err(|_| error!(ForgeError::LegAccountMismatch))?;
    let to = ctx.accounts.escrow.key();
    require!(to == base_escrow || to == quote_escrow, ForgeError::LegAccountMismatch);
    token_util::transfer_from_user(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.source.to_account_info(),
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        amount,
    )?;
    let l = &mut ctx.accounts.strategy.legs[idx];
    if to == base_escrow {
        l.escrow_base += amount;
    } else {
        l.escrow_quote += amount;
    }
    l.buffer += amount;
    if ctx.accounts.strategy.state == StrategyState::Recovery {
        // retry under the same checks; the market stays paused until reviewed
        ctx.accounts.strategy.state = StrategyState::PendingClose;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// finalize_close: only after every leg is restored. Settles premium within the funded cap,
// records any LP shortfall, pays the keeper bounty, and releases the remainder to the owner.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct FinalizeClose<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, has_one = market, has_one = owner)]
    pub strategy: Box<Account<'info, Strategy>>,
    /// CHECK: strategy owner; receives escrow rent.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: strategy escrow (base).
    #[account(mut, seeds = [ESCROW_BASE_SEED, strategy.key().as_ref()], bump = strategy.escrow_base_bump)]
    pub escrow_base: UncheckedAccount<'info>,
    /// CHECK: strategy escrow (quote).
    #[account(mut, seeds = [ESCROW_QUOTE_SEED, strategy.key().as_ref()], bump = strategy.escrow_quote_bump)]
    pub escrow_quote: UncheckedAccount<'info>,
    /// CHECK: strategy premium budget.
    #[account(mut, seeds = [BUDGET_SEED, strategy.key().as_ref()], bump = strategy.budget_bump)]
    pub budget: UncheckedAccount<'info>,
    /// CHECK: market premium vault.
    #[account(mut, address = market.premium_vault)]
    pub premium_vault: UncheckedAccount<'info>,
    /// CHECK: owner's base token account, checked in the handler.
    #[account(mut)]
    pub user_base: UncheckedAccount<'info>,
    /// CHECK: owner's quote token account, checked in the handler.
    #[account(mut)]
    pub user_quote: UncheckedAccount<'info>,
    /// CHECK: keeper's quote token account (bounty); checked in the handler when used.
    #[account(mut)]
    pub keeper_quote: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn finalize_close<'info>(ctx: Context<'info, FinalizeClose<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let market_key = a.market.key();
    let mut s: Box<Strategy> = Box::new((**a.strategy).clone());
    require!(s.state == StrategyState::PendingClose, ForgeError::InvalidState);
    require!(s.all_restored(), ForgeError::InvalidState);

    let (ub_mint, ub_owner, _) = token_util::read_token_account(&a.user_base.to_account_info())?;
    let (uq_mint, uq_owner, _) = token_util::read_token_account(&a.user_quote.to_account_info())?;
    require!(ub_mint == a.market.base_mint && ub_owner == s.owner, ForgeError::Unauthorized);
    require!(uq_mint == a.market.quote_mint && uq_owner == s.owner, ForgeError::Unauthorized);

    let vb = [a.market.vault_bump];
    let seeds = vault_signer_seeds(&market_key, &vb);
    let signer: &[&[&[u8]]] = &[&seeds];
    let tp = a.token_program.to_account_info();
    let vault = a.vault.to_account_info();

    // Pro rata allocation of the remaining cap over unpaid leg premiums (deterministic).
    let lp_cap = s.lp_cap();
    let mut shortfall_total: u64 = 0;
    let unpaid: Vec<u64> = s.legs().iter().map(|l| l.premium.saturating_sub(l.premium_distributed)).collect();
    let total_unpaid: u64 = unpaid.iter().sum();
    if total_unpaid > 0 {
        let remaining_cap = lp_cap.saturating_sub(s.premium_paid);
        let mut alloc: Vec<u64> = unpaid
            .iter()
            .map(|u| mul_div(remaining_cap.min(total_unpaid) as u128, *u as u128, total_unpaid as u128, false).map(|v| v as u64))
            .collect::<Result<_>>()?;
        let allocated: u64 = alloc.iter().sum();
        let dust = remaining_cap.min(total_unpaid) - allocated;
        if dust > 0 {
            // first leg with the largest unpaid amount receives the rounding dust
            let (imax, _) = unpaid.iter().enumerate().fold((0, 0), |acc, (i, u)| if *u > acc.1 { (i, *u) } else { acc });
            alloc[imax] += dust;
        }
        let mut k = 0;
        for i in 0..s.leg_count as usize {
            if unpaid[i] == 0 {
                continue;
            }
            let info = ctx.remaining_accounts.get(k).ok_or(error!(ForgeError::LegAccountMismatch))?;
            k += 1;
            require_keys_eq!(*info.key, s.legs[i].bucket, ForgeError::LegAccountMismatch);
            let mut b: Account<Bucket> = Account::try_from(info)?;
            if alloc[i] > 0 {
                token_util::transfer_signed(&tp, &a.budget.to_account_info(), &a.premium_vault.to_account_info(), &vault, alloc[i], signer)?;
                credit_bucket(&mut b, alloc[i])?;
            }
            let short = unpaid[i] - alloc[i];
            b.lp_shortfall_quote += short;
            b.exit(&crate::ID)?;
            s.legs[i].premium_distributed += alloc[i];
            s.premium_paid += alloc[i];
            shortfall_total += short;
        }
    }
    s.lp_shortfall = shortfall_total;
    s.premium_accrued = s.legs().iter().map(|l| l.premium).sum();

    // Keeper bounty (only for keeper-driven closes); the unused reserve returns to the owner.
    let mut bounty = 0;
    if s.close_by_keeper && s.bounty_reserve > 0 {
        let (k_mint, k_owner, _) = token_util::read_token_account(&a.keeper_quote.to_account_info())?;
        require!(k_mint == a.market.quote_mint && k_owner == s.keeper, ForgeError::Unauthorized);
        bounty = s.bounty_reserve;
        token_util::transfer_signed(&tp, &a.budget.to_account_info(), &a.keeper_quote.to_account_info(), &vault, bounty, signer)?;
    }
    s.keeper_bounty_paid = bounty;

    // Accounting reconciliation before releasing anything.
    let budget_left = token_util::amount(&a.budget.to_account_info())?;
    require!(
        budget_left as u128 == s.premium_budget as u128 - s.premium_paid as u128 - bounty as u128,
        ForgeError::UnexpectedCpiAmounts
    );
    let esc_base = token_util::amount(&a.escrow_base.to_account_info())?;
    let esc_quote = token_util::amount(&a.escrow_quote.to_account_info())?;
    let ledger_base: u64 = s.legs().iter().map(|l| l.escrow_base).sum();
    let ledger_quote: u64 = s.legs().iter().map(|l| l.escrow_quote).sum();
    require!(esc_base == ledger_base && esc_quote == ledger_quote, ForgeError::UnexpectedCpiAmounts);

    token_util::transfer_signed(&tp, &a.budget.to_account_info(), &a.user_quote.to_account_info(), &vault, budget_left, signer)?;
    token_util::transfer_signed(&tp, &a.escrow_quote.to_account_info(), &a.user_quote.to_account_info(), &vault, esc_quote, signer)?;
    token_util::transfer_signed(&tp, &a.escrow_base.to_account_info(), &a.user_base.to_account_info(), &vault, esc_base, signer)?;
    let owner = a.owner.to_account_info();
    for acc in [&a.budget, &a.escrow_quote, &a.escrow_base] {
        token_util::close_signed(&tp, &acc.to_account_info(), &owner, &vault, signer)?;
    }
    for l in s.legs[..s.leg_count as usize].iter_mut() {
        l.escrow_base = 0;
        l.escrow_quote = 0;
    }
    let was_recorded = s.recovery_recorded;
    s.recovery_recorded = false;
    s.state = if s.aborting { StrategyState::Cancelled } else { StrategyState::Closed };
    write_back(&mut ctx.accounts.strategy, &mut s);
    let m = &mut ctx.accounts.market;
    if shortfall_total > 0 {
        m.outstanding_lp_shortfall += shortfall_total;
        m.borrow_paused = true;
    }
    if was_recorded {
        m.unresolved_strategies = m.unresolved_strategies.saturating_sub(1);
    }
    Ok(())
}
