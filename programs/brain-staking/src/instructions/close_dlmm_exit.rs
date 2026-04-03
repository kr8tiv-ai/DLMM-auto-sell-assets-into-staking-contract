use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, StakingPool};

#[derive(Accounts)]
pub struct CloseDlmmExit<'info> {
    /// Authority: must be pool owner
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
        constraint = dlmm_exit.status != 0 @ StakingError::ExitAlreadyActive,
    )]
    pub dlmm_exit: Account<'info, DlmmExit>,

    /// Recipient of the closed account's rent
    pub recipient: SystemAccount<'info>,
}

pub fn handle_close_dlmm_exit(ctx: Context<CloseDlmmExit>) -> Result<()> {
    let exit = &ctx.accounts.dlmm_exit;
    let recipient = &ctx.accounts.recipient;

    msg!(
        "Closing DlmmExit: exit={}, status={}, total_sol_claimed={}",
        exit.key(),
        exit.status,
        exit.total_sol_claimed
    );

    // Close the account and transfer rent to recipient
    ctx.accounts.dlmm_exit.close(ctx.accounts.recipient.to_account_info())?;

    msg!("DlmmExit closed, rent refunded to {}", recipient.key());

    Ok(())
}
