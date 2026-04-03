use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct UpdatePoolConfig<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,
}

pub fn handle_update_pool_config(
    ctx: Context<UpdatePoolConfig>,
    new_min_stake: Option<u64>,
    new_protocol_fee_bps: Option<u16>,
) -> Result<()> {
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

    Ok(())
}
