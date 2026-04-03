use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, GovernanceConfig, Proposal, StakingPool};

#[derive(Accounts)]
#[instruction(asset_mint: Pubkey, dlmm_pool: Pubkey, position: Pubkey)]
pub struct GovernanceInitiateExit<'info> {
    /// Authority: owner always allowed; crank allowed only when auto_execute is true.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        seeds = [GOVERNANCE_CONFIG_SEED],
        bump = governance_config.bump,
    )]
    pub governance_config: Account<'info, GovernanceConfig>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, staking_pool.key().as_ref(), proposal.id.to_le_bytes().as_ref()],
        bump = proposal.bump,
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        init,
        payer = authority,
        space = 8 + DlmmExit::INIT_SPACE,
        seeds = [DLMM_EXIT_SEED, asset_mint.as_ref(), dlmm_pool.as_ref()],
        bump,
    )]
    pub dlmm_exit: Account<'info, DlmmExit>,

    pub system_program: Program<'info, System>,
}

pub fn handle_governance_initiate_exit(
    ctx: Context<GovernanceInitiateExit>,
    asset_mint: Pubkey,
    dlmm_pool: Pubkey,
    position: Pubkey,
) -> Result<()> {
    let pool = &ctx.accounts.staking_pool;
    let config = &ctx.accounts.governance_config;
    let proposal = &ctx.accounts.proposal;
    let authority_key = ctx.accounts.authority.key();

    // Pool must not be paused
    require!(!pool.is_paused, StakingError::PoolPaused);

    // Authority check: owner always allowed, crank only when auto_execute is on
    let is_owner = authority_key == pool.owner;
    let is_crank = authority_key == pool.crank;
    require!(
        is_owner || (is_crank && config.auto_execute),
        StakingError::Unauthorized
    );

    // Proposal must have passed (status == 1)
    require!(proposal.status == 1, StakingError::ProposalNotPassed);

    // C-07: Enforce execution timelock — proposal must have passed at least MIN_EXECUTION_DELAY_SECONDS ago
    if proposal.passed_at > 0 {
        let clock = Clock::get()?;
        let time_since_passed = clock.unix_timestamp.saturating_sub(proposal.passed_at);
        require!(
            time_since_passed >= MIN_EXECUTION_DELAY_SECONDS,
            StakingError::ProposalNotPassed
        );
    }

    // Defensive check: passed proposals must preserve "option 0 is pass" invariant.
    require!(
        proposal.winning_option_index == 0,
        StakingError::InvalidProposalState
    );

    // Proposal must be a sell/exit type
    require!(
        proposal.proposal_type == PROPOSAL_TYPE_SELL,
        StakingError::InvalidProposalType
    );

    // C7: Proposal must not have been already executed
    require!(!proposal.executed, StakingError::ProposalAlreadyExecuted);

    let clock = Clock::get()?;
    let exit = &mut ctx.accounts.dlmm_exit;

    exit.pool = pool.key();
    exit.owner = pool.owner;
    exit.asset_mint = asset_mint;
    exit.dlmm_pool = dlmm_pool;
    exit.position = position;
    exit.total_sol_claimed = 0;
    exit.status = 0; // Active
    exit.created_at = clock.unix_timestamp;
    exit.completed_at = 0;
    exit.proposal_id = proposal.id;
    exit.last_claimed_amount = 0; // C-04: Initialize for idempotency
    exit.bump = ctx.bumps.dlmm_exit;

    // C7: Mark proposal as executed
    let proposal = &mut ctx.accounts.proposal;
    proposal.executed = true;

    msg!(
        "Governance-triggered DLMM exit initiated: proposal={}, asset_mint={}, dlmm_pool={}",
        proposal.id,
        asset_mint,
        dlmm_pool
    );

    Ok(())
}
