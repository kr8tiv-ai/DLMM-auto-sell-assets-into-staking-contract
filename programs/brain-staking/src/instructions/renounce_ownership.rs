use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

/// Renounce ownership of the staking pool.
/// After this, the owner key can no longer make administrative changes.
/// This makes the protocol truly decentralized.
/// 
/// IMPORTANT: This is IRREVERSIBLE. Once ownership is renounced:
/// - No more pool config changes
/// - No more treasury changes
/// - No more crank changes
/// - Only user-facing functions work (stake, unstake, claim)
#[derive(Accounts)]
pub struct RenounceOwnership<'info> {
    /// Current owner - must sign to renounce
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,
}

pub fn handle_renounce_ownership(ctx: Context<RenounceOwnership>) -> Result<()> {
    let pool = &mut ctx.accounts.staking_pool;
    
    // Set owner to a burn address that can never have the private key
    // Using a well-known invalid pubkey
    pool.owner = Pubkey::from_str("1DIg2LbN1UqD4K4NNEk2KqAY6dCwWq6K8").map_err(|_| StakingError::MathOverflow)?;
    pool.pending_owner = Pubkey::default();
    
    msg!("Ownership renounced. Protocol is now decentralized.");
    msg!("Owner key: {} (burned)", pool.owner);

    Ok(())
}
