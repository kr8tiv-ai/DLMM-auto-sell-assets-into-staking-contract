use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, StakingPool};

#[derive(Accounts)]
pub struct TerminateExit<'info> {
    /// Authority: must be pool owner only
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        constraint = authority.key() == staking_pool.owner
            @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [DLMM_EXIT_SEED, dlmm_exit.asset_mint.as_ref(), dlmm_exit.dlmm_pool.as_ref()],
        bump = dlmm_exit.bump,
    )]
    pub dlmm_exit: Account<'info, DlmmExit>,
}

pub fn handle_terminate_exit(ctx: Context<TerminateExit>) -> Result<()> {
    let exit = &mut ctx.accounts.dlmm_exit;
    require!(exit.status == 0, StakingError::ExitNotActive);

    let clock = Clock::get()?;
    exit.status = 2; // Terminated
    exit.completed_at = clock.unix_timestamp;

    msg!(
        "DLMM exit terminated: exit={}, total_sol_claimed={}",
        exit.key(),
        exit.total_sol_claimed
    );

    Ok(())
}
