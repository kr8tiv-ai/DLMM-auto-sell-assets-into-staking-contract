use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct ReallocStakingPool<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    pub system_program: Program<'info, System>,
}

pub fn handle_realloc_staking_pool(ctx: Context<ReallocStakingPool>) -> Result<()> {
    let new_size = 8 + StakingPool::INIT_SPACE;
    let account_info = ctx.accounts.staking_pool.to_account_info();

    let current_size = account_info.data_len();
    if current_size >= new_size {
        msg!("StakingPool already at required size ({} >= {})", current_size, new_size);
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

    let pool = &mut ctx.accounts.staking_pool;
    pool.pending_owner = Pubkey::default();

    msg!(
        "StakingPool reallocated from {} to {} bytes",
        current_size,
        new_size
    );

    Ok(())
}
