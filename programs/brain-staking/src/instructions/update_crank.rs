use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct UpdateCrank<'info> {
    /// Authority: must be pool owner only (not crank!)
    #[account(mut)]
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

pub fn handle_update_crank(ctx: Context<UpdateCrank>, new_crank: Pubkey) -> Result<()> {
    // Prevent crank from being set to zero address
    require!(new_crank != Pubkey::default(), StakingError::InvalidPendingOwner);
    
    let pool = &mut ctx.accounts.staking_pool;
    let old_crank = pool.crank;
    pool.crank = new_crank;

    msg!(
        "Crank rotated: old={}, new={}",
        old_crank,
        new_crank
    );

    Ok(())
}
