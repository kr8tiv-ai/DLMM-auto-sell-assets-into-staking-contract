use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, Proposal, StakingPool};

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [GOVERNANCE_CONFIG_SEED],
        bump = governance_config.bump,
    )]
    pub governance_config: Account<'info, GovernanceConfig>,

    #[account(
        init,
        payer = owner,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, staking_pool.key().as_ref(), governance_config.next_proposal_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_proposal(
    ctx: Context<CreateProposal>,
    title: String,
    description_uri: String,
    proposal_type: u8,
    options: Vec<String>,
    voting_starts: i64,
    voting_ends: i64,
) -> Result<()> {
    // H3: Check pause
    require!(!ctx.accounts.staking_pool.is_paused, StakingError::PoolPaused);

    // Validate inputs
    require!(!title.is_empty(), StakingError::TitleTooLong);
    require!(title.len() <= MAX_TITLE_LEN, StakingError::TitleTooLong);
    require!(
        options.len() >= MIN_PROPOSAL_OPTIONS,
        StakingError::TooFewOptions
    );
    require!(
        options.len() <= MAX_PROPOSAL_OPTIONS,
        StakingError::TooManyOptions
    );
    require!(
        voting_ends > voting_starts,
        StakingError::InvalidVotingPeriod
    );

    // C-04: Enforce minimum voting period
    let voting_duration = voting_ends.saturating_sub(voting_starts);
    require!(
        voting_duration >= MIN_VOTING_PERIOD_SECONDS,
        StakingError::InvalidVotingPeriod
    );

    let clock = Clock::get()?;
    require!(
        voting_starts >= clock.unix_timestamp,
        StakingError::InvalidVotingPeriod
    );

    let config = &mut ctx.accounts.governance_config;
    let proposal = &mut ctx.accounts.proposal;

    proposal.id = config.next_proposal_id;
    proposal.pool = ctx.accounts.staking_pool.key();
    proposal.proposer = ctx.accounts.owner.key();
    proposal.title = title;
    proposal.description_uri = description_uri;
    proposal.proposal_type = proposal_type;
    proposal.vote_counts = vec![0u64; options.len()];
    proposal.options = options;
    proposal.voting_starts = voting_starts;
    proposal.voting_ends = voting_ends;
    proposal.status = 0; // Active
    proposal.total_vote_weight = 0;
    proposal.winning_option_index = 255; // Unresolved
    proposal.executed = false;
    proposal.passed_at = 0;
    proposal.bump = ctx.bumps.proposal;

    config.next_proposal_id = config
        .next_proposal_id
        .checked_add(1)
        .ok_or(StakingError::MathOverflow)?;

    msg!(
        "Proposal {} created: '{}' by {}",
        proposal.id,
        proposal.title,
        proposal.proposer
    );

    Ok(())
}
