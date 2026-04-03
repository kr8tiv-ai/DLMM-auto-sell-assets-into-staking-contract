use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, StakingPool};

#[derive(Accounts)]
pub struct SetQuorum<'info> {
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

pub fn handle_set_quorum(ctx: Context<SetQuorum>, min_quorum_bps: u16) -> Result<()> {
    let config = &mut ctx.accounts.governance_config;
    let old_quorum = config.min_quorum_bps;
    config.min_quorum_bps = min_quorum_bps;

    msg!(
        "Quorum updated: {} bps → {} bps",
        old_quorum,
        min_quorum_bps
    );

    Ok(())
}
