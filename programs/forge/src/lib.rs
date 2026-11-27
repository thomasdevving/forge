//! FORGE: custom, fully collateralized derivatives compiled from Orca concentrated liquidity.
//! Hackathon software, not audited. Fork and devnet only.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod math;
pub mod orca;
pub mod reference;
pub mod state;
pub mod token_util;

use instructions::*;
use state::MarketParams;

declare_id!("8RQGTBgTpbvxZ9BFHpFthHRw5JkaHiUpfrMmjfUv3NN5");

#[program]
pub mod forge {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, admin: Pubkey) -> Result<()> {
        instructions::admin::initialize_config(ctx, admin)
    }

    pub fn initialize_market(ctx: Context<InitializeMarket>, args: InitializeMarketArgs) -> Result<()> {
        instructions::admin::initialize_market(ctx, args)
    }

    pub fn update_market(
        ctx: Context<UpdateMarket>,
        params: Option<MarketParams>,
        opens_paused: Option<bool>,
        borrow_paused: Option<bool>,
    ) -> Result<()> {
        instructions::admin::update_market(ctx, params, opens_paused, borrow_paused)
    }

    pub fn init_scenario_reference(ctx: Context<InitScenarioReference>, signer: Pubkey) -> Result<()> {
        instructions::admin::init_scenario_reference(ctx, signer)
    }

    pub fn update_scenario_reference(
        ctx: Context<UpdateScenarioReference>,
        price_x64: u128,
        conf_bps: u16,
    ) -> Result<()> {
        instructions::admin::update_scenario_reference(ctx, price_x64, conf_bps)
    }

    pub fn create_bucket(ctx: Context<CreateBucket>, tick_lower: i32) -> Result<()> {
        instructions::bucket::create_bucket(ctx, tick_lower)
    }

    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        liquidity: u128,
        max_base: u64,
        max_quote: u64,
    ) -> Result<()> {
        instructions::bucket::deposit_liquidity(ctx, liquidity, max_base, max_quote)
    }

    pub fn begin_open<'info>(ctx: Context<'info, BeginOpen<'info>>, args: BeginOpenArgs) -> Result<()> {
        instructions::strategy_open::begin_open(ctx, args)
    }

    pub fn execute_open_batch<'info>(
        ctx: Context<'info, ExecuteOpenBatch<'info>>,
        leg_indices: Vec<u8>,
    ) -> Result<()> {
        instructions::strategy_open::execute_open_batch(ctx, leg_indices)
    }

    pub fn finalize_open(ctx: Context<FinalizeOpen>) -> Result<()> {
        instructions::strategy_open::finalize_open(ctx)
    }

    pub fn abort_open<'info>(ctx: Context<'info, AbortOpen<'info>>) -> Result<()> {
        instructions::strategy_close::abort_open(ctx)
    }

    pub fn begin_close<'info>(ctx: Context<'info, BeginClose<'info>>) -> Result<()> {
        instructions::strategy_close::begin_close(ctx)
    }

    pub fn checkpoint_leg<'info>(ctx: Context<'info, CheckpointLeg<'info>>, leg_index: u8) -> Result<()> {
        instructions::strategy_close::checkpoint_leg(ctx, leg_index)
    }

    pub fn execute_close_batch<'info>(
        ctx: Context<'info, ExecuteCloseBatch<'info>>,
        leg_indices: Vec<u8>,
    ) -> Result<()> {
        instructions::strategy_close::execute_close_batch(ctx, leg_indices)
    }

    pub fn record_recovery(ctx: Context<RecordRecovery>, leg_index: u8) -> Result<()> {
        instructions::strategy_close::record_recovery(ctx, leg_index)
    }

    pub fn top_up_buffer(ctx: Context<TopUpBuffer>, leg_index: u8, amount: u64) -> Result<()> {
        instructions::strategy_close::top_up_buffer(ctx, leg_index, amount)
    }

    pub fn finalize_close<'info>(ctx: Context<'info, FinalizeClose<'info>>) -> Result<()> {
        instructions::strategy_close::finalize_close(ctx)
    }
}
