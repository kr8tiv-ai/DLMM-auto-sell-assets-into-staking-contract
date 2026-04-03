use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{Proposal, VoteRecord};

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct CloseVoteRecord<'info> {
    /// Authority that can close - voter themselves or anyone after proposal closes
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.pool.as_ref(), proposal.id.to_le_bytes().as_ref()],
        bump = proposal.bump,
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        mut,
        close = recipient,
        seeds = [VOTE_RECORD_SEED, proposal.id.to_le_bytes().as_ref(), authority.key().as_ref()],
        bump = vote_record.bump,
        constraint = vote_record.voter == authority.key() @ StakingError::Unauthorized,
    )]
    pub vote_record: Account<'info, VoteRecord>,

    /// Recipient of the closed account's rent
    pub recipient: SystemAccount<'info>,
}

pub fn handle_close_vote_record(ctx: Context<CloseVoteRecord>) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    
    // Can only close after voting period ends
    require!(
        proposal.status != 0,
        StakingError::ProposalNotActive
    );

    msg!(
        "Vote record closed for voter {} on proposal {}",
        ctx.accounts.vote_record.voter,
        proposal.id
    );

    Ok(())
}
