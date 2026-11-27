//! Shared strategy logic: side checks, per-leg account validation, premium accrual/payment.

use crate::constants::*;
use crate::error::ForgeError;
use crate::math::orca::{fee_growths_inside, sqrt_price_from_tick_index};
use crate::math::premium::{base_to_quote, forgone_from_growth, index_distribute, leg_premium};
use crate::math::{u256_to_u128, U256, Q64};
use crate::orca::{read_tick, WhirlpoolView};
use crate::reference::ReferencePrice;
use crate::state::*;
use crate::token_util;
use anchor_lang::prelude::*;

/// Accounts supplied per leg, in this order, in `remaining_accounts`.
pub const LEG_ACCOUNTS: usize = 5;

pub struct LegInfos<'info> {
    pub bucket: &'info AccountInfo<'info>,
    pub position: &'info AccountInfo<'info>,
    pub position_token_account: &'info AccountInfo<'info>,
    pub tick_array_lower: &'info AccountInfo<'info>,
    pub tick_array_upper: &'info AccountInfo<'info>,
}

pub fn leg_infos<'info>(rem: &'info [AccountInfo<'info>], slot: usize) -> Result<LegInfos<'info>> {
    let base = slot * LEG_ACCOUNTS;
    require!(rem.len() >= base + LEG_ACCOUNTS, ForgeError::LegAccountMismatch);
    Ok(LegInfos {
        bucket: &rem[base],
        position: &rem[base + 1],
        position_token_account: &rem[base + 2],
        tick_array_lower: &rem[base + 3],
        tick_array_upper: &rem[base + 4],
    })
}

/// Load the bucket for a leg and check it, and the leg's Orca accounts, against the commitment.
#[inline(never)]
pub fn load_leg_bucket<'info>(
    infos: &LegInfos<'info>,
    leg: &Leg,
    market: &Pubkey,
) -> Result<Account<'info, Bucket>> {
    require_keys_eq!(*infos.bucket.key, leg.bucket, ForgeError::LegAccountMismatch);
    let bucket: Account<'info, Bucket> = Account::try_from(infos.bucket)?;
    require_keys_eq!(bucket.market, *market, ForgeError::LegAccountMismatch);
    require_keys_eq!(*infos.position.key, bucket.position, ForgeError::LegAccountMismatch);
    require_keys_eq!(
        *infos.position_token_account.key,
        bucket.position_token_account,
        ForgeError::LegAccountMismatch
    );
    require!(
        bucket.tick_lower == leg.tick_lower && bucket.tick_upper == leg.tick_upper,
        ForgeError::LegAccountMismatch
    );
    Ok(bucket)
}

/// A borrowed range must be strictly out of range, holding only the required token, with no
/// boundary contact. Quote-only = below spot (put); base-only = above spot (call).
pub fn check_borrow_side(
    kind: LegKind,
    base_is_a: bool,
    w: &WhirlpoolView,
    tick_lower: i32,
    tick_upper: i32,
) -> Result<()> {
    // Range holds only token A when the price is strictly below it, only B when strictly above.
    let only_a = w.tick_current_index < tick_lower
        && w.sqrt_price < sqrt_price_from_tick_index(tick_lower)?;
    let only_b = w.tick_current_index > tick_upper;
    let ok = match (kind, base_is_a) {
        (LegKind::BorrowQuote, true) | (LegKind::BorrowBase, false) => only_b,
        (LegKind::BorrowQuote, false) | (LegKind::BorrowBase, true) => only_a,
    };
    require!(ok, ForgeError::BorrowNotOutOfRange);
    Ok(())
}

pub fn to_base_quote(base_is_a: bool, a: u64, b: u64) -> (u64, u64) {
    if base_is_a {
        (a, b)
    } else {
        (b, a)
    }
}

pub fn to_a_b(base_is_a: bool, base: u64, quote: u64) -> (u64, u64) {
    if base_is_a {
        (base, quote)
    } else {
        (quote, base)
    }
}

/// Fee growth inside a bucket right now.
#[inline(never)]
pub fn growth_inside(
    w: &WhirlpoolView,
    whirlpool: &Pubkey,
    tick_array_lower: &AccountInfo,
    tick_array_upper: &AccountInfo,
    tick_lower: i32,
    tick_upper: i32,
) -> Result<(u128, u128)> {
    let lo = read_tick(tick_array_lower, whirlpool, tick_lower, w.tick_spacing)?;
    let hi = read_tick(tick_array_upper, whirlpool, tick_upper, w.tick_spacing)?;
    Ok(fee_growths_inside(
        w.tick_current_index,
        lo,
        tick_lower,
        hi,
        tick_upper,
        w.fee_growth_global_a,
        w.fee_growth_global_b,
    ))
}

/// Accrue forgone fees since the leg's last checkpoint and update its premium.
/// Base-token fees are valued at the validated reference; earlier accrual is never revalued.
#[inline(never)]
pub fn accrue_leg(
    leg: &mut Leg,
    growth: (u128, u128),
    base_is_a: bool,
    reference: &ReferencePrice,
    floor_rate_bps: u16,
    now: i64,
) -> Result<()> {
    let fa = forgone_from_growth(leg.growth_a_x64, growth.0, leg.liquidity)?;
    let fb = forgone_from_growth(leg.growth_b_x64, growth.1, leg.liquidity)?;
    let (base_fees, quote_fees) = to_base_quote(base_is_a, fa, fb);
    let added = quote_fees
        .checked_add(base_to_quote(base_fees, reference.price_x64)?)
        .ok_or(error!(ForgeError::MathOverflow))?;
    leg.cum_forgone_quote = leg
        .cum_forgone_quote
        .checked_add(added)
        .ok_or(error!(ForgeError::MathOverflow))?;
    leg.growth_a_x64 = growth.0;
    leg.growth_b_x64 = growth.1;
    leg.premium = leg_premium(
        leg.multiplier_ppm,
        leg.cum_forgone_quote,
        leg.notional_quote,
        floor_rate_bps,
        now - leg.opened_at,
    )?;
    Ok(())
}

pub struct PayAccounts<'a, 'info> {
    pub token_program: &'a AccountInfo<'info>,
    pub budget: &'a AccountInfo<'info>,
    pub premium_vault: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
}

/// Transfer the leg's newly accrued premium from the budget to the LP premium vault and credit
/// the bucket's per-share index. Funded tokens only; once the cap binds, the remainder is
/// allocated pro rata at final settlement and any excess is recorded as LP shortfall.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub fn pay_leg_increment(
    strategy_premium_paid: &mut u64,
    cap_binding: &mut bool,
    lp_cap: u64,
    leg: &mut Leg,
    bucket: &mut Bucket,
    pay: &PayAccounts,
    signer: &[&[&[u8]]],
    now: i64,
) -> Result<()> {
    if leg.last_checkpoint_ts != now {
        bucket.record_leg_checkpoint(now);
        leg.last_checkpoint_ts = now;
    }
    let inc = leg.premium.saturating_sub(leg.premium_distributed);
    if inc == 0 || *cap_binding {
        return Ok(());
    }
    let remaining_cap = lp_cap.saturating_sub(*strategy_premium_paid);
    if inc > remaining_cap {
        *cap_binding = true;
        return Ok(());
    }
    token_util::transfer_signed(pay.token_program, pay.budget, pay.premium_vault, pay.vault, inc, signer)?;
    credit_bucket(bucket, inc)?;
    leg.premium_distributed += inc;
    *strategy_premium_paid += inc;
    Ok(())
}

pub fn credit_bucket(bucket: &mut Bucket, amount: u64) -> Result<()> {
    let inc = index_distribute(amount, bucket.total_liquidity, &mut bucket.premium_remainder_x64)?;
    bucket.premium_index_x64 = bucket
        .premium_index_x64
        .checked_add(inc)
        .ok_or(error!(ForgeError::MathOverflow))?;
    bucket.premium_distributed = bucket
        .premium_distributed
        .checked_add(amount)
        .ok_or(error!(ForgeError::MathOverflow))?;
    Ok(())
}

/// Write a heap-allocated working copy back into the account without staging it on the stack
/// (a Strategy is ~2 KB and SBF frames are limited to 4 KB).
pub fn write_back(acc: &mut Account<Strategy>, s: &mut Box<Strategy>) {
    std::mem::swap(&mut **acc, &mut **s);
}

pub fn vault_signer_seeds<'a>(market: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [VAULT_SEED, market.as_ref(), bump]
}

/// Integer square root of a U256 (floor).
pub fn isqrt_u256(n: U256) -> U256 {
    if n.is_zero() {
        return U256::zero();
    }
    let mut x = U256::one() << ((n.bits() + 1) / 2);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Orca sqrt-price limit (Q64.64) for a quote-per-base price (Q64.64) on this market.
pub fn sqrt_limit_for_price(quote_per_base_x64: u128, base_is_a: bool) -> Result<u128> {
    require!(quote_per_base_x64 > 0, ForgeError::InvalidReference);
    // Orca price is B per A. If base is A that is quote per base; otherwise its inverse.
    let price_b_per_a_x64 = if base_is_a {
        U256::from(quote_per_base_x64)
    } else {
        (U256::from(Q64) * U256::from(Q64)) / U256::from(quote_per_base_x64)
    };
    // sqrt_x64 = sqrt(price_x64 * 2^64)
    let s = isqrt_u256(price_b_per_a_x64 << 64);
    let s = u256_to_u128(s)?;
    Ok(s.clamp(4_295_048_016, 79_226_673_515_401_279_992_447_579_055))
}
