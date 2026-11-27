use crate::constants::*;
use crate::error::ForgeError;
use crate::orca::read_whirlpool;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// ---------------------------------------------------------------------------------------------
// initialize_config: the upgrade authority names the market-registry admin (a separate key).
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(init, payer = upgrade_authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::Forge>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ ForgeError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(ctx: Context<InitializeConfig>, admin: Pubkey) -> Result<()> {
    require_keys_neq!(admin, ctx.accounts.upgrade_authority.key(), ForgeError::Unauthorized);
    ctx.accounts.config.admin = admin;
    ctx.accounts.config.bump = ctx.bumps.config;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// initialize_market: register an Orca Whirlpool (and its separate restoration pool).
// ---------------------------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeMarketArgs {
    pub bucket_multiplier: u16,
    pub params: MarketParams,
    pub reference: ReferenceConfig,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ForgeError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED, whirlpool.key().as_ref()], bump)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: PDA authority for all vault positions and escrow accounts; holds no data.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: validated as an Orca Whirlpool in the handler.
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: validated as a separate Orca Whirlpool for the same pair in the handler.
    pub swap_pool: UncheckedAccount<'info>,
    pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, seeds = [PREMIUM_VAULT_SEED, market.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault)]
    pub premium_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, seeds = [b"staging_base", market.key().as_ref()], bump,
        token::mint = base_mint, token::authority = vault)]
    pub staging_base: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, seeds = [b"staging_quote", market.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault)]
    pub staging_quote: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, seeds = [b"fee_vault_base", market.key().as_ref()], bump,
        token::mint = base_mint, token::authority = vault)]
    pub fee_vault_base: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, seeds = [b"fee_vault_quote", market.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault)]
    pub fee_vault_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_market(ctx: Context<InitializeMarket>, args: InitializeMarketArgs) -> Result<()> {
    args.params.validate()?;
    require!(args.bucket_multiplier >= 1, ForgeError::InvalidParameters);
    let a = &ctx.accounts;
    let w = read_whirlpool(&a.whirlpool.to_account_info())?;
    let s = read_whirlpool(&a.swap_pool.to_account_info())?;
    require!(!w.rewards_active && !s.rewards_active, ForgeError::RewardsActive);
    require!(!w.non_transferable_positions, ForgeError::IneligiblePool);
    let (base, quote) = (a.base_mint.key(), a.quote_mint.key());
    let base_is_a = if w.mint_a == base && w.mint_b == quote {
        true
    } else if w.mint_b == base && w.mint_a == quote {
        false
    } else {
        return err!(ForgeError::IneligiblePool);
    };
    // Restoration pool: same classic mints, different address, static fee tier.
    require_keys_neq!(a.swap_pool.key(), a.whirlpool.key(), ForgeError::InvalidSwapPool);
    require!(s.mint_a == w.mint_a && s.mint_b == w.mint_b, ForgeError::InvalidSwapPool);
    require!(s.fee_tier_index < 1024, ForgeError::InvalidSwapPool);
    let width = i32::from(w.tick_spacing) * i32::from(args.bucket_multiplier);
    if args.reference.kind == ReferenceKind::PythPair {
        require!(
            args.reference.base_account != Pubkey::default()
                && args.reference.quote_account != Pubkey::default(),
            ForgeError::InvalidParameters
        );
    }

    let m = &mut ctx.accounts.market;
    m.admin = ctx.accounts.admin.key();
    m.whirlpool = ctx.accounts.whirlpool.key();
    m.swap_pool = ctx.accounts.swap_pool.key();
    m.base_mint = base;
    m.quote_mint = quote;
    m.base_is_a = base_is_a;
    m.base_decimals = ctx.accounts.base_mint.decimals;
    m.quote_decimals = ctx.accounts.quote_mint.decimals;
    m.tick_spacing = w.tick_spacing;
    m.bucket_width = width;
    m.reference = args.reference;
    m.params = args.params;
    m.premium_vault = ctx.accounts.premium_vault.key();
    m.fee_vault_base = ctx.accounts.fee_vault_base.key();
    m.fee_vault_quote = ctx.accounts.fee_vault_quote.key();
    m.bump = ctx.bumps.market;
    m.vault_bump = ctx.bumps.vault;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// update_market: parameters apply to new positions only (snapshotted at open).
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct UpdateMarket<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ ForgeError::Unauthorized)]
    pub market: Box<Account<'info, Market>>,
}

pub fn update_market(
    ctx: Context<UpdateMarket>,
    params: Option<MarketParams>,
    opens_paused: Option<bool>,
    borrow_paused: Option<bool>,
) -> Result<()> {
    let m = &mut ctx.accounts.market;
    if let Some(p) = params {
        p.validate()?;
        m.params = p;
    }
    if let Some(v) = opens_paused {
        m.opens_paused = v;
    }
    if let Some(v) = borrow_paused {
        // Unpausing after a shortfall is an explicit admin review step; it never touches
        // positions, escrow or recorded shortfalls.
        m.borrow_paused = v;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Protocol fees: the protocol's share of premium above forgone fees, booked at finalize_close.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct WithdrawProtocolFees<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ ForgeError::Unauthorized)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: vault PDA, signs for the premium vault.
    #[account(seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = market.premium_vault)]
    pub premium_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.quote_mint)]
    pub destination: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn withdraw_protocol_fees(ctx: Context<WithdrawProtocolFees>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount > 0 && amount <= a.market.protocol_fees, ForgeError::InvalidParameters);
    let market_key = a.market.key();
    let vb = [a.market.vault_bump];
    let seeds = a.market.vault_seeds(&market_key, &vb);
    crate::token_util::transfer_signed(
        &a.token_program.to_account_info(),
        &a.premium_vault.to_account_info(),
        &a.destination.to_account_info(),
        &a.vault.to_account_info(),
        amount,
        &[&seeds],
    )?;
    ctx.accounts.market.protocol_fees -= amount;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Fork-only scenario reference (section 8.4). Trusted demo assumption, explicitly labelled.
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitScenarioReference<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ForgeError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: the market's Orca Whirlpool; only its key is used as a seed.
    pub whirlpool: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = 8 + ScenarioReference::INIT_SPACE,
        seeds = [SCENARIO_SEED, whirlpool.key().as_ref()], bump)]
    pub scenario: Account<'info, ScenarioReference>,
    pub system_program: Program<'info, System>,
}

pub fn init_scenario_reference(ctx: Context<InitScenarioReference>, signer: Pubkey) -> Result<()> {
    let s = &mut ctx.accounts.scenario;
    s.market_whirlpool = ctx.accounts.whirlpool.key();
    s.signer = signer;
    s.bump = ctx.bumps.scenario;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateScenarioReference<'info> {
    pub signer: Signer<'info>,
    #[account(mut, has_one = signer @ ForgeError::Unauthorized)]
    pub scenario: Account<'info, ScenarioReference>,
}

pub fn update_scenario_reference(
    ctx: Context<UpdateScenarioReference>,
    price_x64: u128,
    conf_bps: u16,
) -> Result<()> {
    require!(price_x64 > 0, ForgeError::InvalidReference);
    let s = &mut ctx.accounts.scenario;
    s.price_x64 = price_x64;
    s.conf_bps = conf_bps;
    s.publish_time = Clock::get()?.unix_timestamp;
    Ok(())
}
