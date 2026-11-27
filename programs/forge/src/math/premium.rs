//! Premium model (sections 4.3, 4.4). Mirrors math/forge_math/premium.py step by step.
//! Amounts owed to LPs round up; amounts released to borrowers round down.

use super::{ceil_div_u128, mul_div, to_u64, BPS, PPM, Q64};
use crate::error::ForgeError;
use anchor_lang::prelude::*;

pub const SECONDS_PER_YEAR: u128 = 31_536_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct UtilizationCurve {
    pub base_ppm: u32,
    pub slope1_ppm: u32,
    pub kink_ppm: u32,
    pub slope2_ppm: u32,
    pub cap_ppm: u32,
}

/// Hybrid curve: a flat 1.1x on forgone fees while liquidity is plentiful (near fair value for
/// borrowers, a margin for LPs), then a steep rise above 60% utilization to ration scarce
/// liquidity. See benchmarks/research/2026-11-recent.
impl Default for UtilizationCurve {
    fn default() -> Self {
        Self {
            base_ppm: 1_100_000,
            slope1_ppm: 0,
            kink_ppm: 600_000,
            slope2_ppm: 6_000_000,
            cap_ppm: 800_000,
        }
    }
}

impl UtilizationCurve {
    pub fn validate(&self) -> Result<()> {
        require!(self.base_ppm as u128 >= PPM, ForgeError::InvalidParameters);
        require!(
            self.kink_ppm > 0 && self.kink_ppm <= self.cap_ppm && self.cap_ppm as u128 <= PPM,
            ForgeError::InvalidParameters
        );
        Ok(())
    }

    /// m(u) in ppm, rounded up. Rejects utilization above the cap.
    pub fn multiplier_ppm(&self, u_ppm: u32) -> Result<u32> {
        require!(u_ppm <= self.cap_ppm, ForgeError::UtilizationCap);
        let up = |slope: u32, x: u32| ceil_div_u128(slope as u128 * x as u128, PPM);
        let m = if u_ppm <= self.kink_ppm {
            self.base_ppm as u128 + up(self.slope1_ppm, u_ppm)?
        } else {
            self.base_ppm as u128
                + up(self.slope1_ppm, self.kink_ppm)?
                + up(self.slope2_ppm, u_ppm - self.kink_ppm)?
        };
        u32::try_from(m).map_err(|_| error!(ForgeError::MathOverflow))
    }
}

/// Post-reservation utilization in ppm, rounded up.
pub fn utilization_ppm(borrowed_plus_reserved: u128, total: u128) -> Result<u32> {
    require!(total > 0, ForgeError::EmptyBucket);
    require!(borrowed_plus_reserved <= total, ForgeError::UtilizationCap);
    let u = mul_div(borrowed_plus_reserved, PPM, total, true)?;
    u32::try_from(u).map_err(|_| error!(ForgeError::MathOverflow))
}

/// Token atoms of fees the borrowed liquidity would have earned, rounded up.
pub fn forgone_from_growth(growth_open: u128, growth_now: u128, liquidity: u128) -> Result<u64> {
    let delta = growth_now.wrapping_sub(growth_open);
    to_u64(mul_div(delta, liquidity, Q64, true)?)
}

/// Value base atoms in quote atoms at a reference price (quote atoms per base atom, Q64.64).
pub fn base_to_quote(base_atoms: u64, ref_price_x64: u128) -> Result<u64> {
    require!(ref_price_x64 > 0, ForgeError::InvalidReference);
    to_u64(mul_div(base_atoms as u128, ref_price_x64, Q64, true)?)
}

/// Quote atoms to base atoms at a reference price; `round_up` selects the direction.
pub fn quote_to_base(quote_atoms: u64, ref_price_x64: u128, round_up: bool) -> Result<u64> {
    require!(ref_price_x64 > 0, ForgeError::InvalidReference);
    to_u64(mul_div(quote_atoms as u128, Q64, ref_price_x64, round_up)?)
}

pub fn time_floor(notional_quote: u64, rate_bps: u16, elapsed_s: i64) -> Result<u64> {
    require!(elapsed_s >= 0, ForgeError::ClockWentBackwards);
    let num = (notional_quote as u128)
        .checked_mul(rate_bps as u128)
        .and_then(|v| v.checked_mul(elapsed_s as u128))
        .ok_or(error!(ForgeError::MathOverflow))?;
    to_u64(ceil_div_u128(num, BPS * SECONDS_PER_YEAR)?)
}

/// max(floor, ceil(m * forgone)) for one leg. The floor is an alternative, never added.
pub fn leg_premium(
    multiplier_ppm: u32,
    cum_forgone_quote: u64,
    notional_quote: u64,
    floor_rate_bps: u16,
    elapsed_s: i64,
) -> Result<u64> {
    let floor = time_floor(notional_quote, floor_rate_bps, elapsed_s)?;
    let scaled = to_u64(ceil_div_u128(
        multiplier_ppm as u128 * cum_forgone_quote as u128,
        PPM,
    )?)?;
    Ok(floor.max(scaled))
}

/// Protocol share still due on a leg: `fee_bps` of the premium above the forgone fees (rounded
/// down, so LPs keep at least their forgone fees), less what was already taken, at most `inc`.
pub fn protocol_cut(premium: u64, cum_forgone: u64, already: u64, fee_bps: u16, inc: u64) -> u64 {
    let excess = premium.saturating_sub(cum_forgone) as u128;
    let due = (excess * fee_bps as u128 / BPS) as u64;
    due.saturating_sub(already).min(inc)
}

pub fn bounty_reserve(budget: u64, bounty_bps: u16) -> u64 {
    ((budget as u128 * bounty_bps as u128) / BPS) as u64
}

pub fn crank_allowed(accrued: u64, lp_cap: u64, trigger_bps: u16) -> bool {
    accrued as u128 * BPS >= lp_cap as u128 * trigger_bps as u128
}

/// Distribute `amount` quote atoms over `total_shares` using a Q64.64 index with the exact
/// scaled remainder carried (see docs/math.md 3.6). Returns the index increment.
pub fn index_distribute(
    amount: u64,
    total_shares: u128,
    remainder_x64: &mut u128,
) -> Result<u128> {
    let scaled = (amount as u128)
        .checked_mul(Q64)
        .and_then(|v| v.checked_add(*remainder_x64))
        .ok_or(error!(ForgeError::MathOverflow))?;
    if total_shares == 0 {
        *remainder_x64 = scaled;
        return Ok(0);
    }
    *remainder_x64 = scaled % total_shares;
    Ok(scaled / total_shares)
}

pub fn index_claimable(shares: u128, index_now: u128, index_then: u128) -> Result<u64> {
    to_u64(mul_div(shares, index_now.wrapping_sub(index_then), Q64, false)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_curve_is_hybrid() {
        let c = UtilizationCurve::default();
        c.validate().unwrap();
        // flat 1.1x up to the kink
        assert_eq!(c.multiplier_ppm(0).unwrap(), 1_100_000);
        assert_eq!(c.multiplier_ppm(300_000).unwrap(), 1_100_000);
        assert_eq!(c.multiplier_ppm(600_000).unwrap(), 1_100_000);
        // then +6x per unit of utilization
        assert_eq!(c.multiplier_ppm(700_000).unwrap(), 1_700_000);
        assert_eq!(c.multiplier_ppm(800_000).unwrap(), 2_300_000);
        assert!(c.multiplier_ppm(800_001).is_err());
    }

    #[test]
    fn protocol_cut_only_from_excess() {
        // premium 1_100 on 1_000 forgone: excess 100, 10% = 10
        assert_eq!(protocol_cut(1_100, 1_000, 0, 1_000, 1_100), 10);
        // already taken: nothing more due
        assert_eq!(protocol_cut(1_100, 1_000, 10, 1_000, 50), 0);
        // never more than the increment
        assert_eq!(protocol_cut(1_100, 1_000, 0, 1_000, 4), 4);
        // floor-bound leg with no forgone fees: the excess is the whole premium
        assert_eq!(protocol_cut(500, 0, 0, 1_000, 500), 50);
        // premium at or below forgone fees: nothing
        assert_eq!(protocol_cut(900, 1_000, 0, 1_000, 900), 0);
        // rounds down (LP-friendly)
        assert_eq!(protocol_cut(1_009, 1_000, 0, 1_000, 1_009), 0);
    }

    #[test]
    fn lps_keep_their_forgone_fees() {
        // for any premium >= forgone, LP share = premium - cut >= forgone
        for (premium, forgone) in [(1_100u64, 1_000u64), (5_000, 0), (2_300, 1_000), (1_000, 1_000), (7, 3)] {
            for bps in [0u16, 1_000, 5_000] {
                let cut = protocol_cut(premium, forgone, 0, bps, premium);
                assert!(premium - cut >= forgone.min(premium), "premium {premium} forgone {forgone} bps {bps}");
            }
        }
    }

    #[test]
    fn floor_examples() {
        assert_eq!(time_floor(1_000_000, 500, 31_536_000).unwrap(), 50_000);
        assert_eq!(time_floor(1_000_000, 500, 1).unwrap(), 1);
        assert_eq!(time_floor(1_000_000, 500, 0).unwrap(), 0);
    }

    #[test]
    fn premium_is_max_not_sum() {
        assert_eq!(leg_premium(1_600_000, 10_000, 100_000_000, 500, 1).unwrap(), 16_000);
        assert_eq!(leg_premium(1_000_000, 0, 100_000_000, 500, 31_536_000).unwrap(), 5_000_000);
    }

    #[test]
    fn index_never_overpays() {
        let mut rem = 0u128;
        let shares = [1u128, 2];
        let total: u128 = shares.iter().sum();
        let mut index = 0u128;
        let mut deposited = 0u64;
        for a in [1u64, 0, 1, 7, 3] {
            index += index_distribute(a, total, &mut rem).unwrap();
            deposited += a;
        }
        let paid: u64 = shares
            .iter()
            .map(|s| index_claimable(*s, index, 0).unwrap())
            .sum();
        assert!(paid <= deposited);
    }

    #[test]
    fn forgone_wraps() {
        let g0 = u128::MAX - (1u128 << 64) + 1;
        let g1 = 1u128 << 64;
        assert_eq!(forgone_from_growth(g0, g1, 5).unwrap(), 10);
    }
}
