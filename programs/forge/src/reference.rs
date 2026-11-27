//! Independent reference price (section 8.4). Never derived from the pool being restored.
//!
//! * PythPair: two Pyth `PriceUpdateV2` accounts (base/USD and quote/USD) owned by the Pyth
//!   receiver program, fully verified, matching the registered feed IDs, fresh, positive and
//!   within the confidence limit. The cross rate is base/quote, adjusted for mint decimals.
//! * ForkScenario: a `ScenarioReference` account updated by a dedicated team signer. This is a
//!   trusted, fork-only demo assumption and is labelled as such everywhere it is shown.

use crate::constants::PYTH_RECEIVER_PROGRAM_ID;
use crate::error::ForgeError;
use crate::math::{deviation_bps, mul_div, orca::price_x64_from_sqrt, u256_to_u128, U256, BPS, Q64};
use crate::state::{Market, ReferenceKind, ScenarioReference};
use anchor_lang::prelude::*;

#[derive(Clone, Copy, Debug)]
pub struct ReferencePrice {
    /// Quote atoms per base atom, Q64.64.
    pub price_x64: u128,
    /// Conservative combined confidence in bps of price.
    pub conf_bps: u128,
    pub publish_time: i64,
}

struct PythPrice {
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
}

fn read_pyth(info: &AccountInfo, feed_id: &[u8; 32]) -> Result<PythPrice> {
    require_keys_eq!(*info.owner, PYTH_RECEIVER_PROGRAM_ID, ForgeError::ReferenceMismatch);
    let d = info.try_borrow_data()?;
    // discriminator(8) write_authority(32) verification_level(enum: 0=Partial{u8}, 1=Full)
    require!(d.len() >= 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8, ForgeError::InvalidReference);
    let mut o = 40;
    let level = d[o];
    o += 1;
    // only fully verified updates are accepted
    require!(level == 1, ForgeError::InvalidReference);
    require!(&d[o..o + 32] == feed_id, ForgeError::ReferenceMismatch);
    o += 32;
    let rd = |o: usize, n: usize| -> [u8; 8] {
        let mut b = [0u8; 8];
        b[..n].copy_from_slice(&d[o..o + n]);
        b
    };
    let price = i64::from_le_bytes(rd(o, 8));
    let conf = u64::from_le_bytes(rd(o + 8, 8));
    let exponent = i32::from_le_bytes(rd(o + 16, 4)[..4].try_into().unwrap_or([0; 4]));
    let publish_time = i64::from_le_bytes(rd(o + 20, 8));
    Ok(PythPrice {
        price,
        conf,
        exponent,
        publish_time,
    })
}

fn pow10(e: u32) -> Result<u128> {
    10u128
        .checked_pow(e)
        .ok_or(error!(ForgeError::MathOverflow))
}

/// Load and validate the market's reference price. `base_info` / `quote_info` must be the
/// accounts registered in the market configuration.
pub fn load_reference(
    market: &Market,
    base_info: &AccountInfo,
    quote_info: Option<&AccountInfo>,
    now: i64,
) -> Result<ReferencePrice> {
    let cfg = &market.reference;
    let p = &market.params;
    require_keys_eq!(*base_info.key, cfg.base_account, ForgeError::ReferenceMismatch);
    match cfg.kind {
        ReferenceKind::ForkScenario => {
            require_keys_eq!(*base_info.owner, crate::ID, ForgeError::ReferenceMismatch);
            let data = base_info.try_borrow_data()?;
            let s = ScenarioReference::try_deserialize(&mut &data[..])?;
            require_keys_eq!(s.market_whirlpool, market.whirlpool, ForgeError::ReferenceMismatch);
            require!(s.price_x64 > 0, ForgeError::InvalidReference);
            require!(now - s.publish_time <= p.ref_max_age_s as i64, ForgeError::StaleReference);
            require!(s.conf_bps <= p.ref_max_conf_bps, ForgeError::ReferenceConfidence);
            Ok(ReferencePrice {
                price_x64: s.price_x64,
                conf_bps: s.conf_bps as u128,
                publish_time: s.publish_time,
            })
        }
        ReferenceKind::PythPair => {
            let quote_info = quote_info.ok_or(error!(ForgeError::ReferenceMismatch))?;
            require_keys_eq!(*quote_info.key, cfg.quote_account, ForgeError::ReferenceMismatch);
            let b = read_pyth(base_info, &cfg.base_feed_id)?;
            let q = read_pyth(quote_info, &cfg.quote_feed_id)?;
            require!(b.price > 0 && q.price > 0, ForgeError::InvalidReference);
            for pt in [b.publish_time, q.publish_time] {
                require!(now - pt <= p.ref_max_age_s as i64, ForgeError::StaleReference);
            }
            let (bp, qp) = (b.price as u128, q.price as u128);
            let b_conf = mul_div(b.conf as u128, BPS, bp, true)?;
            let q_conf = mul_div(q.conf as u128, BPS, qp, true)?;
            require!(
                b_conf <= p.ref_max_conf_bps as u128 && q_conf <= p.ref_max_conf_bps as u128,
                ForgeError::ReferenceConfidence
            );
            let conf_bps = b_conf + q_conf;
            require!(conf_bps <= p.pool_deviation_bps as u128, ForgeError::ReferenceConfidence);
            // quote atoms per base atom = (bp 10^be) / (qp 10^qe) * 10^(qd - bd)
            let k: i32 = b.exponent - q.exponent + market.quote_decimals as i32
                - market.base_decimals as i32;
            let mut num = U256::from(bp) << 64;
            let mut den = U256::from(qp);
            if k >= 0 {
                num *= U256::from(pow10(k as u32)?);
            } else {
                den *= U256::from(pow10((-k) as u32)?);
            }
            let price_x64 = u256_to_u128(num / den)?;
            require!(price_x64 > 0, ForgeError::InvalidReference);
            Ok(ReferencePrice {
                price_x64,
                conf_bps,
                publish_time: b.publish_time.min(q.publish_time),
            })
        }
    }
}

/// Pool price as quote atoms per base atom (Q64.64), from an Orca sqrt price.
pub fn pool_quote_per_base_x64(sqrt_price: u128, base_is_a: bool) -> Result<u128> {
    let p = price_x64_from_sqrt(sqrt_price)?; // B atoms per A atom
    require!(p > 0, ForgeError::InvalidReference);
    if base_is_a {
        Ok(p)
    } else {
        // invert: (2^64 * 2^64) / p
        u256_to_u128((U256::from(Q64) * U256::from(Q64)) / U256::from(p))
    }
}

/// Require a pool's price within `limit_bps` of the reference.
pub fn check_pool_deviation(
    sqrt_price: u128,
    base_is_a: bool,
    reference: &ReferencePrice,
    limit_bps: u16,
) -> Result<()> {
    let pool = pool_quote_per_base_x64(sqrt_price, base_is_a)?;
    require!(
        deviation_bps(pool, reference.price_x64)? <= limit_bps as u128,
        ForgeError::PoolDeviation
    );
    Ok(())
}
