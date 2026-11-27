//! Integer math. Every function mirrors `math/forge_math/{orca,premium}.py`, which is checked
//! bit for bit against Orca's SDK and the deployed program. No floating point.

pub mod orca;
pub mod premium;
mod u256;

pub use u256::U256;

use crate::error::ForgeError;
use anchor_lang::prelude::*;

pub const Q64: u128 = 1u128 << 64;
pub const BPS: u128 = 10_000;
pub const PPM: u128 = 1_000_000;

pub fn ceil_div_u128(a: u128, b: u128) -> Result<u128> {
    require!(b > 0, ForgeError::MathOverflow);
    Ok(a / b + u128::from(a % b != 0))
}

pub fn u256_to_u128(v: U256) -> Result<u128> {
    require!(v.bits() <= 128, ForgeError::MathOverflow);
    Ok(v.low_u128())
}

pub fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(ForgeError::MathOverflow))
}

/// a * b / den, rounded up or down, with a 256-bit intermediate.
pub fn mul_div(a: u128, b: u128, den: u128, round_up: bool) -> Result<u128> {
    require!(den > 0, ForgeError::MathOverflow);
    let p = U256::from(a) * U256::from(b);
    let d = U256::from(den);
    let (q, r) = p.div_mod(d);
    let q = if round_up && !r.is_zero() { q + U256::one() } else { q };
    u256_to_u128(q)
}

/// |a - b| * 10_000 / b, rounded up (conservative for limit checks).
pub fn deviation_bps(a: u128, b: u128) -> Result<u128> {
    require!(b > 0, ForgeError::InvalidReference);
    let diff = a.abs_diff(b);
    mul_div(diff, BPS, b, true)
}
