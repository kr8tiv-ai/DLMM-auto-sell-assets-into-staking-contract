use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, StakingPool};

#[derive(Accounts)]
pub struct RecordClaim<'info> {
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

pub fn handle_record_claim(ctx: Context<RecordClaim>, amount: u64) -> Result<()> {
    require!(amount > 0, StakingError::ZeroAmount);

    let exit = &mut ctx.accounts.dlmm_exit;
    // C-04: Strict state transition - only Active exits can record claims
    require!(exit.status == 0, StakingError::ExitNotActive);
    
    // C-04: Add idempotency - track last claimed amount to prevent double-claiming
    // If same amount is recorded again, it's a replay attempt
    require!(exit.last_claimed_amount == 0 || exit.last_claimed_amount != amount, StakingError::InvalidState);

    exit.total_sol_claimed = exit
        .total_sol_claimed
        .checked_add(amount)
        .ok_or(StakingError::MathOverflow)?;
    
    // C-04: Track last claimed amount for idempotency
    exit.last_claimed_amount = amount;

    msg!(
        "DLMM exit claim recorded: exit={}, claimed={}, total={}",
        exit.key(),
        amount,
        exit.total_sol_claimed
    );

    Ok(())
}
