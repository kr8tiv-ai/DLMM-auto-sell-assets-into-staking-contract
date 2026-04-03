use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, StakingPool};

#[derive(Accounts)]
pub struct ReallocDlmmExit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [DLMM_EXIT_SEED, dlmm_exit.asset_mint.as_ref(), dlmm_exit.dlmm_pool.as_ref()],
        bump = dlmm_exit.bump,
    )]
    pub dlmm_exit: Account<'info, DlmmExit>,

    pub system_program: Program<'info, System>,
}

pub fn handle_realloc_dlmm_exit(ctx: Context<ReallocDlmmExit>) -> Result<()> {
    let new_size = 8 + DlmmExit::INIT_SPACE;
    let account_info = ctx.accounts.dlmm_exit.to_account_info();

    let current_size = account_info.data_len();
    if current_size >= new_size {
        msg!("DlmmExit already at required size ({} >= {})", current_size, new_size);
        return Ok(());
    }

    let rent = Rent::get()?;
    let new_rent = rent.minimum_balance(new_size);
    let current_rent = account_info.lamports();
    let diff = new_rent.saturating_sub(current_rent);

    if diff > 0 {
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.owner.key(),
            &account_info.key(),
            diff,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.owner.to_account_info(),
                account_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    account_info.realloc(new_size, false)?;

    let exit = &mut ctx.accounts.dlmm_exit;
    // Initialize new fields for idempotency (C-04)
    if exit.last_claimed_amount == 0 {
        exit.last_claimed_amount = 0;
    }

    msg!(
        "DlmmExit reallocated from {} to {} bytes",
        current_size,
        new_size
    );

    Ok(())
}
