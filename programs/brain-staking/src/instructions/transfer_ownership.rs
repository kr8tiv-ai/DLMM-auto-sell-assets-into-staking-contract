use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct TransferOwnership<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,
}

pub fn handle_transfer_ownership(ctx: Context<TransferOwnership>, new_owner: Pubkey) -> Result<()> {
    // M-05: Validate new owner is not zero address
    require!(new_owner != Pubkey::default(), StakingError::InvalidPendingOwner);
    
    let pool = &mut ctx.accounts.staking_pool;
    
    // M-05: Clear any existing pending owner to prevent confusion
    // This allows canceling a pending transfer by starting a new one
    pool.pending_owner = new_owner;

    msg!(
        "Ownership transfer initiated: {} → {} (pending acceptance)",
        pool.owner,
        new_owner
    );

    Ok(())
}
