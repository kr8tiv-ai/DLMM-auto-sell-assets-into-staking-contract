use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, StakingPool};

#[derive(Accounts)]
pub struct SetAutoExecute<'info> {
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
}

pub fn handle_set_auto_execute(
    ctx: Context<SetAutoExecute>,
    enabled: bool,
) -> Result<()> {
    let config = &mut ctx.accounts.governance_config;
    config.auto_execute = enabled;

    msg!(
        "Governance auto_execute set to {} by {}",
        enabled,
        ctx.accounts.owner.key()
    );

    Ok(())
}
