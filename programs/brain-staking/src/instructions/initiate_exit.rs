use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, StakingPool};

#[derive(Accounts)]
#[instruction(asset_mint: Pubkey, dlmm_pool: Pubkey, position: Pubkey)]
pub struct InitiateExit<'info> {
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
        init,
        payer = authority,
        space = 8 + DlmmExit::INIT_SPACE,
        seeds = [DLMM_EXIT_SEED, asset_mint.as_ref(), dlmm_pool.as_ref()],
        bump,
    )]
    pub dlmm_exit: Account<'info, DlmmExit>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initiate_exit(
    ctx: Context<InitiateExit>,
    asset_mint: Pubkey,
    dlmm_pool: Pubkey,
    position: Pubkey,
) -> Result<()> {
    let pool = &ctx.accounts.staking_pool;
    require!(!pool.is_paused, StakingError::PoolPaused);

    let clock = Clock::get()?;
    let exit = &mut ctx.accounts.dlmm_exit;

    exit.pool = pool.key();
    exit.owner = ctx.accounts.authority.key();
    exit.asset_mint = asset_mint;
    exit.dlmm_pool = dlmm_pool;
    exit.position = position;
    exit.total_sol_claimed = 0;
    exit.status = 0; // Active
    exit.created_at = clock.unix_timestamp;
    exit.completed_at = 0;
    exit.bump = ctx.bumps.dlmm_exit;

    msg!(
        "DLMM exit initiated: asset_mint={}, dlmm_pool={}, position={}",
        asset_mint,
        dlmm_pool,
        position
    );

    Ok(())
}
