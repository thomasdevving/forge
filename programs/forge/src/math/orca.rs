//! Exact port of Orca Whirlpool math (tick math, token deltas, fee growth inside).
//! Reference: math/forge_math/orca.py and docs/orca-integration.md.

use super::{u256_to_u128, U256};
use crate::error::ForgeError;
use anchor_lang::prelude::*;

pub const MAX_TICK_INDEX: i32 = 443_636;
pub const MIN_TICK_INDEX: i32 = -443_636;
pub const TICK_ARRAY_SIZE: i32 = 88;

const POS: [(i32, u128); 18] = [
    (2, 79236085330515764027303304731),
    (4, 79244008939048815603706035061),
    (8, 79259858533276714757314932305),
    (16, 79291567232598584799939703904),
    (32, 79355022692464371645785046466),
    (64, 79482085999252804386437311141),
    (128, 79736823300114093921829183326),
    (256, 80248749790819932309965073892),
    (512, 81282483887344747381513967011),
    (1024, 83390072131320151908154831281),
    (2048, 87770609709833776024991924138),
    (4096, 97234110755111693312479820773),
    (8192, 119332217159966728226237229890),
    (16384, 179736315981702064433883588727),
    (32768, 407748233172238350107850275304),
    (65536, 2098478828474011932436660412517),
    (131072, 55581415166113811149459800483533),
    (262144, 38992368544603139932233054999993551),
];

const NEG: [(i32, u128); 18] = [
    (2, 18444899583751176498),
    (4, 18443055278223354162),
    (8, 18439367220385604838),
    (16, 18431993317065449817),
    (32, 18417254355718160513),
    (64, 18387811781193591352),
    (128, 18329067761203520168),
    (256, 18212142134806087854),
    (512, 17980523815641551639),
    (1024, 17526086738831147013),
    (2048, 16651378430235024244),
    (4096, 15030750278693429944),
    (8192, 12247334978882834399),
    (16384, 8131365268884726200),
    (32768, 3584323654723342297),
    (65536, 696457651847595233),
    (131072, 26294789957452057),
    (262144, 37481735321082),
];

pub fn sqrt_price_from_tick_index(tick: i32) -> Result<u128> {
    require!(
        (MIN_TICK_INDEX..=MAX_TICK_INDEX).contains(&tick),
        ForgeError::InvalidTick
    );
    if tick >= 0 {
        let mut ratio: u128 = if tick & 1 != 0 {
            79232123823359799118286999567
        } else {
            79228162514264337593543950336
        };
        for (bit, k) in POS {
            if tick & bit != 0 {
                ratio = u256_to_u128((U256::from(ratio) * U256::from(k)) >> 96)?;
            }
        }
        Ok(ratio >> 32)
    } else {
        let a = -tick;
        let mut ratio: u128 = if a & 1 != 0 {
            18445821805675392311
        } else {
            18446744073709551616
        };
        for (bit, k) in NEG {
            if a & bit != 0 {
                ratio = (ratio * k) >> 64;
            }
        }
        Ok(ratio)
    }
}

pub fn get_amount_delta_a(p0: u128, p1: u128, liquidity: u128, round_up: bool) -> Result<u64> {
    let (lo, hi) = if p0 <= p1 { (p0, p1) } else { (p1, p0) };
    let diff = hi - lo;
    let prod = U256::from(liquidity) * U256::from(diff);
    require!(prod.bits() <= 192, ForgeError::MathOverflow); // (L*diff) << 64 < 2^256
    let num = prod << 64;
    let den = U256::from(hi) * U256::from(lo);
    require!(!den.is_zero(), ForgeError::MathOverflow);
    let (q, r) = num.div_mod(den);
    let q = if round_up && !r.is_zero() { q + U256::one() } else { q };
    let q = u256_to_u128(q)?;
    u64::try_from(q).map_err(|_| error!(ForgeError::TokenMaxExceeded))
}

pub fn get_amount_delta_b(p0: u128, p1: u128, liquidity: u128, round_up: bool) -> Result<u64> {
    let (lo, hi) = if p0 <= p1 { (p0, p1) } else { (p1, p0) };
    let n1 = hi - lo;
    if liquidity == 0 || n1 == 0 {
        return Ok(0);
    }
    let p = liquidity
        .checked_mul(n1)
        .ok_or(error!(ForgeError::MathOverflow))?;
    let result = (p >> 64) as u64;
    let should_round = round_up && (p & u128::from(u64::MAX)) > 0;
    if should_round {
        result
            .checked_add(1)
            .ok_or(error!(ForgeError::MathOverflow))
    } else {
        Ok(result)
    }
}

/// Token A/B amounts for a liquidity change on [lower, upper) at the given pool state.
/// Increase rounds up (the depositor pays more), decrease rounds down.
pub fn liquidity_token_deltas(
    tick_current: i32,
    sqrt_price: u128,
    tick_lower: i32,
    tick_upper: i32,
    liquidity: u128,
    round_up: bool,
) -> Result<(u64, u64)> {
    require!(liquidity > 0, ForgeError::ZeroAmount);
    let lower = sqrt_price_from_tick_index(tick_lower)?;
    let upper = sqrt_price_from_tick_index(tick_upper)?;
    if tick_current < tick_lower {
        Ok((get_amount_delta_a(lower, upper, liquidity, round_up)?, 0))
    } else if tick_current < tick_upper {
        Ok((
            get_amount_delta_a(sqrt_price, upper, liquidity, round_up)?,
            get_amount_delta_b(lower, sqrt_price, liquidity, round_up)?,
        ))
    } else {
        Ok((0, get_amount_delta_b(lower, upper, liquidity, round_up)?))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TickGrowth {
    pub initialized: bool,
    pub fee_growth_outside_a: u128,
    pub fee_growth_outside_b: u128,
}

fn inside(
    current: i32,
    lower_idx: i32,
    upper_idx: i32,
    lower_init: bool,
    upper_init: bool,
    global: u128,
    lower_out: u128,
    upper_out: u128,
) -> u128 {
    let below = if !lower_init {
        global
    } else if current < lower_idx {
        global.wrapping_sub(lower_out)
    } else {
        lower_out
    };
    let above = if !upper_init {
        0
    } else if current < upper_idx {
        upper_out
    } else {
        global.wrapping_sub(upper_out)
    };
    global.wrapping_sub(below).wrapping_sub(above)
}

/// Orca `next_fee_growths_inside`: wrapping Q64.64 fee growth inside [lower, upper).
pub fn fee_growths_inside(
    tick_current: i32,
    lower: TickGrowth,
    lower_idx: i32,
    upper: TickGrowth,
    upper_idx: i32,
    global_a: u128,
    global_b: u128,
) -> (u128, u128) {
    (
        inside(
            tick_current,
            lower_idx,
            upper_idx,
            lower.initialized,
            upper.initialized,
            global_a,
            lower.fee_growth_outside_a,
            upper.fee_growth_outside_a,
        ),
        inside(
            tick_current,
            lower_idx,
            upper_idx,
            lower.initialized,
            upper.initialized,
            global_b,
            lower.fee_growth_outside_b,
            upper.fee_growth_outside_b,
        ),
    )
}

pub fn tick_array_start_index(tick: i32, tick_spacing: u16) -> i32 {
    let span = i32::from(tick_spacing) * TICK_ARRAY_SIZE;
    tick.div_euclid(span) * span
}

/// Token B atoms per token A atom in Q64.64.
pub fn price_x64_from_sqrt(sqrt_price: u128) -> Result<u128> {
    u256_to_u128((U256::from(sqrt_price) * U256::from(sqrt_price)) >> 64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_bounds() {
        assert_eq!(sqrt_price_from_tick_index(0).unwrap(), 1u128 << 64);
        assert_eq!(
            sqrt_price_from_tick_index(MIN_TICK_INDEX).unwrap(),
            4295048016
        );
        assert_eq!(
            sqrt_price_from_tick_index(MAX_TICK_INDEX).unwrap(),
            79226673515401279992447579055
        );
    }

    #[test]
    fn deltas_round_in_pool_favor() {
        let lo = sqrt_price_from_tick_index(-400).unwrap();
        let hi = sqrt_price_from_tick_index(400).unwrap();
        let up = get_amount_delta_a(lo, hi, 10u128.pow(12), true).unwrap();
        let down = get_amount_delta_a(lo, hi, 10u128.pow(12), false).unwrap();
        assert!(up >= down && up - down <= 1);
    }

    #[test]
    fn tick_array_start() {
        assert_eq!(tick_array_start_index(-1, 4), -352);
        assert_eq!(tick_array_start_index(352, 4), 352);
        assert_eq!(tick_array_start_index(351, 4), 0);
    }
}
