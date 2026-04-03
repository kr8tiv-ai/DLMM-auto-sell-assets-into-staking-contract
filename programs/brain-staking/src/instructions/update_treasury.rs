use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,
}

pub fn handle_update_treasury(ctx: Context<UpdateTreasury>, new_treasury: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.staking_pool;
    let old_treasury = pool.treasury;
    pool.treasury = new_treasury;

    msg!(
        "Treasury updated: {} → {}",
        old_treasury,
        new_treasury
    );

    Ok(())
}
