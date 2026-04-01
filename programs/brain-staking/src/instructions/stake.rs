use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{StakerAccount, StakingPool};

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        init,
        payer = user,
        space = 8 + StakerAccount::INIT_SPACE,
        seeds = [STAKER_SEED, user.key().as_ref()],
        bump,
    )]
    pub staker_account: Account<'info, StakerAccount>,

    /// User's BRAIN token account (source)
    #[account(
        mut,
        constraint = user_brain_ata.mint == staking_pool.brain_mint @ StakingError::InvalidMint,
    )]
    pub user_brain_ata: Account<'info, TokenAccount>,

    /// PDA-controlled BRAIN vault (destination)
    #[account(
        mut,
        address = staking_pool.brain_vault,
    )]
    pub brain_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
    let pool = &ctx.accounts.staking_pool;

    require!(!pool.is_paused, StakingError::PoolPaused);
    require!(amount > 0, StakingError::ZeroAmount);
    require!(
        amount >= pool.min_stake_amount,
        StakingError::BelowMinStake
    );

    // Transfer BRAIN from user to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.user_brain_ata.to_account_info(),
        to: ctx.accounts.brain_vault.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    // Initialize staker account
    let clock = Clock::get()?;
    let staker = &mut ctx.accounts.staker_account;
    staker.owner = ctx.accounts.user.key();
    staker.staked_amount = amount;
    staker.stake_timestamp = clock.unix_timestamp;
    staker.reward_debt = 0; // multiplier is 0 pre-cliff, so no debt
    staker.pending_rewards = 0;
    staker.last_claim_timestamp = clock.unix_timestamp;
    staker.current_multiplier = 0; // pre-cliff
    staker.bump = ctx.bumps.staker_account;

    // Update pool
    let pool = &mut ctx.accounts.staking_pool;
    pool.total_staked = pool
        .total_staked
        .checked_add(amount)
        .ok_or(StakingError::MathOverflow)?;
    // weighted_stake addition is 0 since multiplier = 0 (pre-cliff)

    msg!(
        "Staked {} BRAIN by {}. Total staked: {}",
        amount,
        staker.owner,
        pool.total_staked
    );

    Ok(())
}
