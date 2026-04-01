use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct Resume<'info> {
    /// Pool owner — only the owner can resume from a paused state.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        constraint = authority.key() == staking_pool.owner
            @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,
}

pub fn handle_resume(ctx: Context<Resume>) -> Result<()> {
    let pool = &mut ctx.accounts.staking_pool;
    pool.is_paused = false;

    msg!("Pool resumed by owner {}", ctx.accounts.authority.key());

    Ok(())
}
