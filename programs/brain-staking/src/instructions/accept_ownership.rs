use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    pub new_owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,
}

pub fn handle_accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
    let pool = &mut ctx.accounts.staking_pool;

    require!(
        pool.pending_owner != Pubkey::default(),
        StakingError::NoPendingOwner
    );
    require!(
        ctx.accounts.new_owner.key() == pool.pending_owner,
        StakingError::InvalidPendingOwner
    );

    let old_owner = pool.owner;
    pool.owner = pool.pending_owner;
    pool.pending_owner = Pubkey::default();

    msg!(
        "Ownership transferred: {} → {}",
        old_owner,
        pool.owner
    );

    Ok(())
}
