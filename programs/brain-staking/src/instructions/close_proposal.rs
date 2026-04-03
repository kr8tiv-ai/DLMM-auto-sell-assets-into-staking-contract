use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, Proposal, StakingPool};

#[derive(Accounts)]
pub struct CloseProposal<'info> {
    /// Anyone can close a proposal after its voting period ends (permissionless)
    pub anyone: Signer<'info>,

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
}

pub fn handle_close_proposal(ctx: Context<CloseProposal>) -> Result<()> {
    let proposal = &mut ctx.accounts.proposal;

    require!(proposal.status == 0, StakingError::ProposalNotActive);

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= proposal.voting_ends,
        StakingError::VotingPeriodNotEnded
    );

    // Tally votes: find the option with the highest weight
    let vote_counts = &proposal.vote_counts;

    // Defensive invariant checks for migration/live-account safety.
    require!(!vote_counts.is_empty(), StakingError::InvalidProposalState);
    require!(
        vote_counts.len() == proposal.options.len(),
        StakingError::InvalidProposalState
    );

    // H3: Check pause
    require!(!ctx.accounts.staking_pool.is_paused, StakingError::PoolPaused);

    if proposal.total_vote_weight == 0 {
        // No votes cast — reject
        proposal.status = 2; // Rejected
        proposal.winning_option_index = 255;
        msg!("Proposal {} closed — no votes cast, rejected.", proposal.id);
        return Ok(());
    }

    // C5: Quorum check — total_vote_weight must meet min_quorum_bps of total_staked
    let quorum_bps = ctx.accounts.governance_config.min_quorum_bps;
    if quorum_bps > 0 {
        let total_staked = ctx.accounts.staking_pool.total_staked as u128;
        let required = total_staked
            .checked_mul(quorum_bps as u128)
            .unwrap_or(0)
            .checked_div(10_000)
            .unwrap_or(0);
        if proposal.total_vote_weight < required {
            proposal.status = 2; // Rejected — quorum not met
            proposal.winning_option_index = 255;
            msg!(
                "Proposal {} closed — quorum not met ({} < {}), rejected.",
                proposal.id,
                proposal.total_vote_weight,
                required
            );
            return Ok(());
        }
    }

    let mut max_weight: u64 = 0;
    let mut max_index: usize = 0;
    let mut is_tie = false;

    for (i, &count) in vote_counts.iter().enumerate() {
        if count > max_weight {
            max_weight = count;
            max_index = i;
            is_tie = false;
        } else if count == max_weight && count > 0 {
            is_tie = true;
        }
    }

    if is_tie {
        // Ties are rejected (conservative)
        proposal.status = 2; // Rejected
        proposal.winning_option_index = 255;
        proposal.passed_at = 0;
        msg!("Proposal {} closed — tie, rejected.", proposal.id);
    } else {
        // Option 0 is the "Yes"/"Sell"/"Pass" option by convention.
        // The winning option index determines Passed vs Rejected:
        // - If the first option (index 0) wins → Passed
        // - Otherwise → Rejected
        proposal.winning_option_index = max_index as u8;
        if max_index == 0 {
            proposal.status = 1; // Passed
            proposal.passed_at = clock.unix_timestamp;
        } else {
            proposal.status = 2; // Rejected
            proposal.passed_at = 0;
        }
        msg!(
            "Proposal {} closed. Winner: option {} with weight {}. Status: {}",
            proposal.id,
            max_index,
            max_weight,
            proposal.status
        );
    }

    Ok(())
}
