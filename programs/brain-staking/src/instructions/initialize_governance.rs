use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, StakingPool};

#[derive(Accounts)]
pub struct InitializeGovernance<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        init,
        payer = owner,
        space = 8 + GovernanceConfig::INIT_SPACE,
        seeds = [GOVERNANCE_CONFIG_SEED],
        bump,
    )]
    pub governance_config: Account<'info, GovernanceConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_governance(ctx: Context<InitializeGovernance>) -> Result<()> {
    let config = &mut ctx.accounts.governance_config;
    config.pool = ctx.accounts.staking_pool.key();
    config.next_proposal_id = 0;
    config.bump = ctx.bumps.governance_config;

    msg!("Governance initialized for pool: {}", config.pool);
    Ok(())
}
