use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, Proposal, StakerAccount, StakingPool, VoteRecord};

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,

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
        seeds = [PROPOSAL_SEED, proposal.pool.as_ref(), proposal.id.to_le_bytes().as_ref()],
        bump = proposal.bump,
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        init,
        payer = voter,
        space = 8 + VoteRecord::INIT_SPACE,
        seeds = [VOTE_RECORD_SEED, proposal.id.to_le_bytes().as_ref(), voter.key().as_ref()],
        bump,
    )]
    pub vote_record: Account<'info, VoteRecord>,

    /// Voter's BRAIN token account — used to determine wallet balance voting weight
    #[account(
        constraint = voter_brain_ata.mint == staking_pool.brain_mint @ StakingError::InvalidMint,
        constraint = voter_brain_ata.owner == voter.key() @ StakingError::Unauthorized,
    )]
    pub voter_brain_ata: Account<'info, TokenAccount>,

    /// Optional staker account — present if the voter is also a staker.
    /// When present, staked_amount is added to the voting weight.
    #[account(
        seeds = [STAKER_SEED, voter.key().as_ref()],
        bump = staker_account.bump,
        constraint = staker_account.owner == voter.key() @ StakingError::Unauthorized,
    )]
    pub staker_account: Option<Account<'info, StakerAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_cast_vote(ctx: Context<CastVote>, option_index: u8) -> Result<()> {
    let proposal = &ctx.accounts.proposal;

    // H3: Check pause
    require!(!ctx.accounts.staking_pool.is_paused, StakingError::PoolPaused);

    // Validate proposal is active
    require!(proposal.status == 0, StakingError::ProposalNotActive);

    // Validate voting window
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= proposal.voting_starts,
        StakingError::VotingPeriodNotStarted
    );
    require!(
        clock.unix_timestamp < proposal.voting_ends,
        StakingError::VotingPeriodEnded
    );

    // Validate option index
    require!(
        (option_index as usize) < proposal.options.len(),
        StakingError::InvalidOptionIndex
    );

    // C6: Hybrid voting weight: staked BRAIN gets 2x, wallet ATA gets 1x
    let wallet_balance = ctx.accounts.voter_brain_ata.amount;
    let staked_amount = match &ctx.accounts.staker_account {
        Some(staker) => staker.staked_amount,
        None => 0,
    };
    let staked_weight = staked_amount
        .checked_mul(2)
        .ok_or(StakingError::MathOverflow)?;
    let weight = wallet_balance
        .checked_add(staked_weight)
        .ok_or(StakingError::MathOverflow)?;

    require!(weight > 0, StakingError::NoVotingPower);

    // Record the vote
    let vote_record = &mut ctx.accounts.vote_record;
    vote_record.proposal_id = proposal.id;
    vote_record.voter = ctx.accounts.voter.key();
    vote_record.option_index = option_index;
    vote_record.weight = weight;
    vote_record.voted_at = clock.unix_timestamp;
    vote_record.bump = ctx.bumps.vote_record;

    // Update proposal tallies
    let proposal = &mut ctx.accounts.proposal;
    proposal.vote_counts[option_index as usize] = proposal.vote_counts[option_index as usize]
        .checked_add(weight)
        .ok_or(StakingError::MathOverflow)?;
    proposal.total_vote_weight = proposal
        .total_vote_weight
        .checked_add(weight as u128)
        .ok_or(StakingError::MathOverflow)?;

    msg!(
        "Vote cast on proposal {} by {}: option={}, weight={}",
        proposal.id,
        ctx.accounts.voter.key(),
        option_index,
        weight
    );

    Ok(())
}
