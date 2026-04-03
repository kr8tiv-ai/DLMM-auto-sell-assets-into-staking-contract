use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, Proposal, StakingPool};

#[derive(Accounts)]
#[instruction(new_treasury: Pubkey)]
pub struct UpdateTreasuryByGovernance<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        seeds = [GOVERNANCE_CONFIG_SEED],
        bump = governance_config.bump,
    )]
    pub governance_config: Account<'info, GovernanceConfig>,

    #[account(
        seeds = [PROPOSAL_SEED, staking_pool.key().as_ref(), proposal.id.to_le_bytes().as_ref()],
        bump = proposal.bump,
    )]
    pub proposal: Account<'info, Proposal>,
}

pub fn handle_update_treasury_by_governance(
    ctx: Context<UpdateTreasuryByGovernance>,
    new_treasury: Pubkey,
) -> Result<()> {
    // H-07: Treasury updates require governance approval
    let proposal = &ctx.accounts.proposal;
    
    // Proposal must have passed
    require!(proposal.status == 1, StakingError::ProposalNotPassed);
    
    // Must be a treasury update proposal type (we'll add this)
    require!(proposal.proposal_type == PROPOSAL_TYPE_TREASURY_UPDATE, StakingError::InvalidProposalType);
    
    // Execution timelock check (already in place from C-07)
    if proposal.passed_at > 0 {
        let clock = Clock::get()?;
        let time_since_passed = clock.unix_timestamp.saturating_sub(proposal.passed_at);
        require!(
            time_since_passed >= MIN_EXECUTION_DELAY_SECONDS,
            StakingError::ProposalNotPassed
        );
    }

    // H-07: Validate treasury is not a PDA owned by this program
    require!(new_treasury != ctx.accounts.staking_pool.reward_vault, StakingError::InvalidPendingOwner);
    require!(new_treasury != ctx.accounts.staking_pool.brain_vault, StakingError::InvalidPendingOwner);

    let pool = &mut ctx.accounts.staking_pool;
    let old_treasury = pool.treasury;
    pool.treasury = new_treasury;

    // Mark proposal as executed
    let proposal_mut = &mut ctx.accounts.proposal;
    proposal_mut.executed = true;

    msg!(
        "Treasury updated via governance: {} → {} (proposal {})",
        old_treasury,
        new_treasury,
        proposal.id
    );

    Ok(())
}
