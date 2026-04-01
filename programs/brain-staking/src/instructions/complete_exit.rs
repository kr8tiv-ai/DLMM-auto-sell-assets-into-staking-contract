use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, StakingPool};

#[derive(Accounts)]
pub struct CompleteExit<'info> {
    /// Authority: must be pool owner OR crank
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        constraint = authority.key() == staking_pool.owner
            || authority.key() == staking_pool.crank
            @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [DLMM_EXIT_SEED, dlmm_exit.asset_mint.as_ref(), dlmm_exit.dlmm_pool.as_ref()],
        bump = dlmm_exit.bump,
        constraint = dlmm_exit.pool == staking_pool.key() @ StakingError::Unauthorized,
    )]
    pub dlmm_exit: Account<'info, DlmmExit>,
}

pub fn handle_complete_exit(ctx: Context<CompleteExit>) -> Result<()> {
    let exit = &mut ctx.accounts.dlmm_exit;
    require!(exit.status == 0, StakingError::ExitNotActive);

    let clock = Clock::get()?;
    exit.status = 1; // Completed
    exit.completed_at = clock.unix_timestamp;

    msg!(
        "DLMM exit completed: exit={}, total_sol_claimed={}",
        exit.key(),
        exit.total_sol_claimed
    );

    Ok(())
}
