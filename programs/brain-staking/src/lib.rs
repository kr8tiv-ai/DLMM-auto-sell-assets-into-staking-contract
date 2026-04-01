use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod helpers;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("5o2uBwvKUy4oF78ziR4tEiqz59k7XBXuZBwiZFqCfca2");

#[program]
pub mod brain_staking {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        crank: Pubkey,
        protocol_fee_bps: u16,
        min_stake_amount: u64,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, crank, protocol_fee_bps, min_stake_amount)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::handle_stake(ctx, amount)
    }

    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
        instructions::deposit_rewards::handle_deposit_rewards(ctx, amount)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handle_claim(ctx)
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        instructions::unstake::handle_unstake(ctx)
    }

    pub fn initiate_exit(
        ctx: Context<InitiateExit>,
        asset_mint: Pubkey,
        dlmm_pool: Pubkey,
        position: Pubkey,
    ) -> Result<()> {
        instructions::initiate_exit::handle_initiate_exit(ctx, asset_mint, dlmm_pool, position)
    }

    pub fn record_claim(ctx: Context<RecordClaim>, amount: u64) -> Result<()> {
        instructions::record_claim::handle_record_claim(ctx, amount)
    }

    pub fn complete_exit(ctx: Context<CompleteExit>) -> Result<()> {
        instructions::complete_exit::handle_complete_exit(ctx)
    }

    pub fn terminate_exit(ctx: Context<TerminateExit>) -> Result<()> {
        instructions::terminate_exit::handle_terminate_exit(ctx)
    }

    pub fn emergency_halt(ctx: Context<EmergencyHalt>) -> Result<()> {
        instructions::emergency_halt::handle_emergency_halt(ctx)
    }

    pub fn resume(ctx: Context<Resume>) -> Result<()> {
        instructions::resume::handle_resume(ctx)
    }

    pub fn update_crank(ctx: Context<UpdateCrank>, new_crank: Pubkey) -> Result<()> {
        instructions::update_crank::handle_update_crank(ctx, new_crank)
    }
}
