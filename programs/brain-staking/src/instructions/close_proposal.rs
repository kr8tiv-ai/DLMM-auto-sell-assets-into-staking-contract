use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::Proposal;

#[derive(Accounts)]
pub struct CloseProposal<'info> {
    /// Anyone can close a proposal after its voting period ends (permissionless)
    pub anyone: Signer<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.id.to_le_bytes().as_ref()],
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

    proposal.status = 1; // Closed

    msg!(
        "Proposal {} closed. Total weight: {}",
        proposal.id,
        proposal.total_vote_weight
    );

    Ok(())
}
