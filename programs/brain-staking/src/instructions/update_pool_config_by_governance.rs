use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, Proposal, StakingPool};

#[derive(Accounts)]
#[instruction(new_min_stake: Option<u64>, new_protocol_fee_bps: Option<u16>)]
pub struct UpdatePoolConfigByGovernance<'info> {
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

pub fn handle_update_pool_config_by_governance(
    ctx: Context<UpdatePoolConfigByGovernance>,
    new_min_stake: Option<u64>,
    new_protocol_fee_bps: Option<u16>,
) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    
    // Proposal must have passed
    require!(proposal.status == 1, StakingError::ProposalNotPassed);
    
    // Must be a config update proposal type
    require!(proposal.proposal_type == PROPOSAL_TYPE_CONFIG_UPDATE, StakingError::InvalidProposalType);
    
    // Execution timelock check
    if proposal.passed_at > 0 {
        let clock = Clock::get()?;
        let time_since_passed = clock.unix_timestamp.saturating_sub(proposal.passed_at);
        require!(
            time_since_passed >= MIN_EXECUTION_DELAY_SECONDS,
            StakingError::ProposalNotPassed
        );
    }

    let pool = &mut ctx.accounts.staking_pool;

    if let Some(min_stake) = new_min_stake {
        require!(min_stake > 0, StakingError::InvalidMinStake);
        pool.min_stake_amount = min_stake;
        msg!("min_stake_amount updated to {}", min_stake);
    }

    if let Some(fee_bps) = new_protocol_fee_bps {
        require!(fee_bps <= MAX_PROTOCOL_FEE_BPS, StakingError::InvalidFee);
        pool.protocol_fee_bps = fee_bps;
        msg!("protocol_fee_bps updated to {}", fee_bps);
    }

    // Mark proposal as executed
    let proposal_mut = &mut ctx.accounts.proposal;
    proposal_mut.executed = true;

    msg!("Pool config updated via governance (proposal {})", proposal.id);

    Ok(())
}
