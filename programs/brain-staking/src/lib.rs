use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod helpers;
pub mod instructions;
pub mod state;

#[cfg(test)]
mod fuzz_tests;

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

    pub fn close_dlmm_exit(ctx: Context<CloseDlmmExit>) -> Result<()> {
        instructions::close_dlmm_exit::handle_close_dlmm_exit(ctx)
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

    // ── Governance ──────────────────────────────────────

    pub fn initialize_governance(ctx: Context<InitializeGovernance>) -> Result<()> {
        instructions::initialize_governance::handle_initialize_governance(ctx)
    }

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        title: String,
        description_uri: String,
        proposal_type: u8,
        options: Vec<String>,
        voting_starts: i64,
        voting_ends: i64,
    ) -> Result<()> {
        instructions::create_proposal::handle_create_proposal(
            ctx,
            title,
            description_uri,
            proposal_type,
            options,
            voting_starts,
            voting_ends,
        )
    }

    pub fn cast_vote(ctx: Context<CastVote>, option_index: u8) -> Result<()> {
        instructions::cast_vote::handle_cast_vote(ctx, option_index)
    }

    pub fn close_proposal(ctx: Context<CloseProposal>) -> Result<()> {
        instructions::close_proposal::handle_close_proposal(ctx)
    }

    pub fn governance_initiate_exit(
        ctx: Context<GovernanceInitiateExit>,
        asset_mint: Pubkey,
        dlmm_pool: Pubkey,
        position: Pubkey,
    ) -> Result<()> {
        instructions::governance_initiate_exit::handle_governance_initiate_exit(
            ctx, asset_mint, dlmm_pool, position,
        )
    }

    pub fn set_auto_execute(ctx: Context<SetAutoExecute>, enabled: bool) -> Result<()> {
        instructions::set_auto_execute::handle_set_auto_execute(ctx, enabled)
    }

    pub fn realloc_governance_config(ctx: Context<ReallocGovernanceConfig>) -> Result<()> {
        instructions::realloc_governance_config::handle_realloc_governance_config(ctx)
    }

    pub fn realloc_dlmm_exit(ctx: Context<ReallocDlmmExit>) -> Result<()> {
        instructions::realloc_dlmm_exit::handle_realloc_dlmm_exit(ctx)
    }

    pub fn realloc_proposal(ctx: Context<ReallocProposal>, proposal_id: u64) -> Result<()> {
        instructions::realloc_proposal::handle_realloc_proposal(ctx, proposal_id)
    }

    pub fn realloc_staking_pool(ctx: Context<ReallocStakingPool>) -> Result<()> {
        instructions::realloc_staking_pool::handle_realloc_staking_pool(ctx)
    }

    pub fn transfer_ownership(ctx: Context<TransferOwnership>, new_owner: Pubkey) -> Result<()> {
        instructions::transfer_ownership::handle_transfer_ownership(ctx, new_owner)
    }

    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        instructions::accept_ownership::handle_accept_ownership(ctx)
    }

    pub fn update_treasury(ctx: Context<UpdateTreasury>, new_treasury: Pubkey) -> Result<()> {
        instructions::update_treasury::handle_update_treasury(ctx, new_treasury)
    }

    pub fn update_treasury_by_governance(ctx: Context<UpdateTreasuryByGovernance>, new_treasury: Pubkey) -> Result<()> {
        instructions::update_treasury_by_governance::handle_update_treasury_by_governance(ctx, new_treasury)
    }

    pub fn set_quorum(ctx: Context<SetQuorum>, min_quorum_bps: u16) -> Result<()> {
        instructions::set_quorum::handle_set_quorum(ctx, min_quorum_bps)
    }

    pub fn update_pool_config(
        ctx: Context<UpdatePoolConfig>,
        new_min_stake: Option<u64>,
        new_protocol_fee_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_pool_config::handle_update_pool_config(ctx, new_min_stake, new_protocol_fee_bps)
    }
}
