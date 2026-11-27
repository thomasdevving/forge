//! Orca Whirlpool account readers and hand-built CPI instructions (V1, classic SPL Token).
//! Layouts and discriminators: docs/orca-integration.md. Built by hand rather than through the
//! generated client because its remaining-accounts builder swaps signer/writable flags.

use crate::constants::{TOKEN_PROGRAM_ID, WHIRLPOOL_PROGRAM_ID};
use crate::error::ForgeError;
use crate::math::orca::{TickGrowth, TICK_ARRAY_SIZE};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

const WHIRLPOOL_DISC: [u8; 8] = [63, 149, 209, 12, 225, 128, 99, 9];
const POSITION_DISC: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
const FIXED_TICK_ARRAY_DISC: [u8; 8] = [69, 97, 189, 190, 110, 7, 66, 187];
const DYNAMIC_TICK_ARRAY_DISC: [u8; 8] = [17, 216, 246, 142, 225, 199, 218, 56];
const TICK_LEN: usize = 113;

const IX_OPEN_POSITION: [u8; 8] = [135, 128, 47, 77, 15, 152, 240, 49];
const IX_INCREASE_LIQUIDITY: [u8; 8] = [46, 156, 243, 118, 13, 205, 251, 178];
const IX_DECREASE_LIQUIDITY: [u8; 8] = [160, 38, 208, 111, 104, 91, 44, 1];
const IX_UPDATE_FEES_AND_REWARDS: [u8; 8] = [154, 230, 250, 13, 236, 209, 75, 223];
const IX_COLLECT_FEES: [u8; 8] = [164, 152, 207, 99, 30, 186, 19, 182];
const IX_SWAP: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

fn rd_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}
fn rd_i32(d: &[u8], o: usize) -> i32 {
    i32::from_le_bytes(d[o..o + 4].try_into().unwrap_or([0; 4]))
}
fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap_or([0; 8]))
}
fn rd_u128(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap_or([0; 16]))
}
fn rd_key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap_or([0; 32]))
}

#[derive(Clone, Copy, Debug)]
pub struct WhirlpoolView {
    pub tick_spacing: u16,
    pub fee_tier_index: u16,
    pub liquidity: u128,
    pub sqrt_price: u128,
    pub tick_current_index: i32,
    pub mint_a: Pubkey,
    pub vault_a: Pubkey,
    pub fee_growth_global_a: u128,
    pub mint_b: Pubkey,
    pub vault_b: Pubkey,
    pub fee_growth_global_b: u128,
    pub rewards_active: bool,
    pub non_transferable_positions: bool,
}

pub fn read_whirlpool(info: &AccountInfo) -> Result<WhirlpoolView> {
    require_keys_eq!(*info.owner, WHIRLPOOL_PROGRAM_ID, ForgeError::InvalidOrcaAccount);
    let d = info.try_borrow_data()?;
    require!(d.len() >= 653 && d[..8] == WHIRLPOOL_DISC, ForgeError::InvalidOrcaAccount);
    let mut rewards_active = false;
    for i in 0..3 {
        let o = 269 + 128 * i;
        let mint = rd_key(&d, o);
        let emissions = rd_u128(&d, o + 96);
        if mint != Pubkey::default() && emissions > 0 {
            rewards_active = true;
        }
    }
    let flags = rd_u16(&d, 269 + 128 + 64);
    Ok(WhirlpoolView {
        tick_spacing: rd_u16(&d, 41),
        fee_tier_index: rd_u16(&d, 43),
        liquidity: rd_u128(&d, 49),
        sqrt_price: rd_u128(&d, 65),
        tick_current_index: rd_i32(&d, 81),
        mint_a: rd_key(&d, 101),
        vault_a: rd_key(&d, 133),
        fee_growth_global_a: rd_u128(&d, 165),
        mint_b: rd_key(&d, 181),
        vault_b: rd_key(&d, 213),
        fee_growth_global_b: rd_u128(&d, 245),
        rewards_active,
        non_transferable_positions: flags & 1 != 0,
    })
}

#[derive(Clone, Copy, Debug)]
pub struct PositionView {
    pub whirlpool: Pubkey,
    pub position_mint: Pubkey,
    pub liquidity: u128,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub fee_owed_a: u64,
    pub fee_owed_b: u64,
}

pub fn read_position(info: &AccountInfo) -> Result<PositionView> {
    require_keys_eq!(*info.owner, WHIRLPOOL_PROGRAM_ID, ForgeError::InvalidOrcaAccount);
    let d = info.try_borrow_data()?;
    require!(d.len() >= 216 && d[..8] == POSITION_DISC, ForgeError::InvalidOrcaAccount);
    Ok(PositionView {
        whirlpool: rd_key(&d, 8),
        position_mint: rd_key(&d, 40),
        liquidity: rd_u128(&d, 72),
        tick_lower: rd_i32(&d, 88),
        tick_upper: rd_i32(&d, 92),
        fee_owed_a: rd_u64(&d, 112),
        fee_owed_b: rd_u64(&d, 136),
    })
}

/// Read one tick's fee growth from a fixed or dynamic tick array of `whirlpool`.
pub fn read_tick(
    info: &AccountInfo,
    whirlpool: &Pubkey,
    tick_index: i32,
    tick_spacing: u16,
) -> Result<TickGrowth> {
    require_keys_eq!(*info.owner, WHIRLPOOL_PROGRAM_ID, ForgeError::InvalidOrcaAccount);
    let d = info.try_borrow_data()?;
    require!(d.len() >= 60, ForgeError::InvalidOrcaAccount);
    let start = rd_i32(&d, 8);
    let ts = i32::from(tick_spacing);
    let rel = tick_index - start;
    require!(
        rel >= 0 && rel % ts == 0 && rel / ts < TICK_ARRAY_SIZE,
        ForgeError::InvalidOrcaAccount
    );
    let k = (rel / ts) as usize;
    if d[..8] == FIXED_TICK_ARRAY_DISC {
        require!(d.len() >= 9988, ForgeError::InvalidOrcaAccount);
        require_keys_eq!(rd_key(&d, 9956), *whirlpool, ForgeError::InvalidOrcaAccount);
        let o = 12 + TICK_LEN * k;
        return Ok(TickGrowth {
            initialized: d[o] != 0,
            fee_growth_outside_a: rd_u128(&d, o + 1 + 32),
            fee_growth_outside_b: rd_u128(&d, o + 1 + 48),
        });
    }
    require!(d[..8] == DYNAMIC_TICK_ARRAY_DISC, ForgeError::InvalidOrcaAccount);
    require_keys_eq!(rd_key(&d, 12), *whirlpool, ForgeError::InvalidOrcaAccount);
    let bitmap = rd_u128(&d, 44);
    if bitmap & (1u128 << k) == 0 {
        return Ok(TickGrowth::default());
    }
    let before = (bitmap & ((1u128 << k) - 1)).count_ones() as usize;
    let o = 60 + before * TICK_LEN + (k - before);
    require!(d.len() >= o + TICK_LEN && d[o] == 1, ForgeError::InvalidOrcaAccount);
    Ok(TickGrowth {
        initialized: true,
        fee_growth_outside_a: rd_u128(&d, o + 1 + 32),
        fee_growth_outside_b: rd_u128(&d, o + 1 + 48),
    })
}

pub fn tick_array_address(whirlpool: &Pubkey, start: i32) -> Pubkey {
    let s = start.to_string();
    Pubkey::find_program_address(
        &[b"tick_array", whirlpool.as_ref(), s.as_bytes()],
        &WHIRLPOOL_PROGRAM_ID,
    )
    .0
}

pub fn position_address(position_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"position", position_mint.as_ref()], &WHIRLPOOL_PROGRAM_ID)
}

pub fn oracle_address(whirlpool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"oracle", whirlpool.as_ref()], &WHIRLPOOL_PROGRAM_ID).0
}

fn ro(k: &Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(*k, false)
}
fn rw(k: &Pubkey) -> AccountMeta {
    AccountMeta::new(*k, false)
}

/// Accounts for increase/decrease liquidity (same layout for both).
pub struct LiquidityAccounts<'a, 'info> {
    pub whirlpool: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub position_authority: &'a AccountInfo<'info>,
    pub position: &'a AccountInfo<'info>,
    pub position_token_account: &'a AccountInfo<'info>,
    pub owner_a: &'a AccountInfo<'info>,
    pub owner_b: &'a AccountInfo<'info>,
    pub vault_a: &'a AccountInfo<'info>,
    pub vault_b: &'a AccountInfo<'info>,
    pub tick_array_lower: &'a AccountInfo<'info>,
    pub tick_array_upper: &'a AccountInfo<'info>,
    pub whirlpool_program: &'a AccountInfo<'info>,
}

fn liquidity_ix(
    a: &LiquidityAccounts,
    disc: [u8; 8],
    liquidity: u128,
    amount_a: u64,
    amount_b: u64,
) -> Result<Instruction> {
    require_keys_eq!(*a.token_program.key, TOKEN_PROGRAM_ID, ForgeError::UnsupportedMint);
    require_keys_eq!(
        *a.whirlpool_program.key,
        WHIRLPOOL_PROGRAM_ID,
        ForgeError::InvalidOrcaAccount
    );
    let mut data = Vec::with_capacity(8 + 16 + 8 + 8);
    data.extend_from_slice(&disc);
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&amount_a.to_le_bytes());
    data.extend_from_slice(&amount_b.to_le_bytes());
    Ok(Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            rw(a.whirlpool.key),
            ro(a.token_program.key),
            AccountMeta::new_readonly(*a.position_authority.key, true),
            rw(a.position.key),
            ro(a.position_token_account.key),
            rw(a.owner_a.key),
            rw(a.owner_b.key),
            rw(a.vault_a.key),
            rw(a.vault_b.key),
            rw(a.tick_array_lower.key),
            rw(a.tick_array_upper.key),
        ],
        data,
    })
}

fn liquidity_infos<'info>(a: &LiquidityAccounts<'_, 'info>) -> Vec<AccountInfo<'info>> {
    vec![
        a.whirlpool.clone(),
        a.token_program.clone(),
        a.position_authority.clone(),
        a.position.clone(),
        a.position_token_account.clone(),
        a.owner_a.clone(),
        a.owner_b.clone(),
        a.vault_a.clone(),
        a.vault_b.clone(),
        a.tick_array_lower.clone(),
        a.tick_array_upper.clone(),
        a.whirlpool_program.clone(),
    ]
}

pub fn decrease_liquidity(
    a: &LiquidityAccounts,
    liquidity: u128,
    min_a: u64,
    min_b: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let ix = liquidity_ix(a, IX_DECREASE_LIQUIDITY, liquidity, min_a, min_b)?;
    invoke_signed(&ix, &liquidity_infos(a), signer).map_err(Into::into)
}

pub fn increase_liquidity(
    a: &LiquidityAccounts,
    liquidity: u128,
    max_a: u64,
    max_b: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let ix = liquidity_ix(a, IX_INCREASE_LIQUIDITY, liquidity, max_a, max_b)?;
    invoke_signed(&ix, &liquidity_infos(a), signer).map_err(Into::into)
}

pub struct OpenPositionAccounts<'a, 'info> {
    pub funder: &'a AccountInfo<'info>,
    pub owner: &'a AccountInfo<'info>,
    pub position: &'a AccountInfo<'info>,
    pub position_mint: &'a AccountInfo<'info>,
    pub position_token_account: &'a AccountInfo<'info>,
    pub whirlpool: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub rent: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub whirlpool_program: &'a AccountInfo<'info>,
}

/// Open a classic-SPL-NFT position. `position_mint` is a FORGE PDA signed via `signer`.
pub fn open_position(
    a: &OpenPositionAccounts,
    position_bump: u8,
    tick_lower: i32,
    tick_upper: i32,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(17);
    data.extend_from_slice(&IX_OPEN_POSITION);
    data.push(position_bump);
    data.extend_from_slice(&tick_lower.to_le_bytes());
    data.extend_from_slice(&tick_upper.to_le_bytes());
    let ix = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*a.funder.key, true),
            ro(a.owner.key),
            rw(a.position.key),
            AccountMeta::new(*a.position_mint.key, true),
            rw(a.position_token_account.key),
            ro(a.whirlpool.key),
            ro(a.token_program.key),
            ro(a.system_program.key),
            ro(a.rent.key),
            ro(a.associated_token_program.key),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.funder.clone(),
            a.owner.clone(),
            a.position.clone(),
            a.position_mint.clone(),
            a.position_token_account.clone(),
            a.whirlpool.clone(),
            a.token_program.clone(),
            a.system_program.clone(),
            a.rent.clone(),
            a.associated_token_program.clone(),
            a.whirlpool_program.clone(),
        ],
        signer,
    )
    .map_err(Into::into)
}

pub fn update_fees_and_rewards<'info>(
    whirlpool: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    tick_array_lower: &AccountInfo<'info>,
    tick_array_upper: &AccountInfo<'info>,
    whirlpool_program: &AccountInfo<'info>,
) -> Result<()> {
    let ix = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            rw(whirlpool.key),
            rw(position.key),
            ro(tick_array_lower.key),
            ro(tick_array_upper.key),
        ],
        data: IX_UPDATE_FEES_AND_REWARDS.to_vec(),
    };
    invoke_signed(
        &ix,
        &[
            whirlpool.clone(),
            position.clone(),
            tick_array_lower.clone(),
            tick_array_upper.clone(),
            whirlpool_program.clone(),
        ],
        &[],
    )
    .map_err(Into::into)
}

pub struct CollectFeesAccounts<'a, 'info> {
    pub whirlpool: &'a AccountInfo<'info>,
    pub position_authority: &'a AccountInfo<'info>,
    pub position: &'a AccountInfo<'info>,
    pub position_token_account: &'a AccountInfo<'info>,
    pub owner_a: &'a AccountInfo<'info>,
    pub vault_a: &'a AccountInfo<'info>,
    pub owner_b: &'a AccountInfo<'info>,
    pub vault_b: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub whirlpool_program: &'a AccountInfo<'info>,
}

pub fn collect_fees(a: &CollectFeesAccounts, signer: &[&[&[u8]]]) -> Result<()> {
    let ix = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            ro(a.whirlpool.key),
            AccountMeta::new_readonly(*a.position_authority.key, true),
            rw(a.position.key),
            ro(a.position_token_account.key),
            rw(a.owner_a.key),
            rw(a.vault_a.key),
            rw(a.owner_b.key),
            rw(a.vault_b.key),
            ro(a.token_program.key),
        ],
        data: IX_COLLECT_FEES.to_vec(),
    };
    invoke_signed(
        &ix,
        &[
            a.whirlpool.clone(),
            a.position_authority.clone(),
            a.position.clone(),
            a.position_token_account.clone(),
            a.owner_a.clone(),
            a.vault_a.clone(),
            a.owner_b.clone(),
            a.vault_b.clone(),
            a.token_program.clone(),
            a.whirlpool_program.clone(),
        ],
        signer,
    )
    .map_err(Into::into)
}

pub struct SwapAccounts<'a, 'info> {
    pub token_program: &'a AccountInfo<'info>,
    pub token_authority: &'a AccountInfo<'info>,
    pub whirlpool: &'a AccountInfo<'info>,
    pub owner_a: &'a AccountInfo<'info>,
    pub vault_a: &'a AccountInfo<'info>,
    pub owner_b: &'a AccountInfo<'info>,
    pub vault_b: &'a AccountInfo<'info>,
    pub tick_array_0: &'a AccountInfo<'info>,
    pub tick_array_1: &'a AccountInfo<'info>,
    pub tick_array_2: &'a AccountInfo<'info>,
    pub oracle: &'a AccountInfo<'info>,
    pub whirlpool_program: &'a AccountInfo<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn swap(
    a: &SwapAccounts,
    amount: u64,
    other_amount_threshold: u64,
    sqrt_price_limit: u128,
    amount_specified_is_input: bool,
    a_to_b: bool,
    signer: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*a.token_program.key, TOKEN_PROGRAM_ID, ForgeError::UnsupportedMint);
    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 2);
    data.extend_from_slice(&IX_SWAP);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&other_amount_threshold.to_le_bytes());
    data.extend_from_slice(&sqrt_price_limit.to_le_bytes());
    data.push(amount_specified_is_input as u8);
    data.push(a_to_b as u8);
    let ix = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            ro(a.token_program.key),
            AccountMeta::new_readonly(*a.token_authority.key, true),
            rw(a.whirlpool.key),
            rw(a.owner_a.key),
            rw(a.vault_a.key),
            rw(a.owner_b.key),
            rw(a.vault_b.key),
            rw(a.tick_array_0.key),
            rw(a.tick_array_1.key),
            rw(a.tick_array_2.key),
            rw(a.oracle.key),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.token_program.clone(),
            a.token_authority.clone(),
            a.whirlpool.clone(),
            a.owner_a.clone(),
            a.vault_a.clone(),
            a.owner_b.clone(),
            a.vault_b.clone(),
            a.tick_array_0.clone(),
            a.tick_array_1.clone(),
            a.tick_array_2.clone(),
            a.oracle.clone(),
            a.whirlpool_program.clone(),
        ],
        signer,
    )
    .map_err(Into::into)
}
