use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{StakerAccount, StakingPool};

#[derive(Accounts)]
pub struct EmergencyRescue<'info> {
    /// User requesting emergency rescue
    pub user: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [STAKER_SEED, user.key().as_ref()],
        bump = staker_account.bump,
        constraint = staker_account.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub staker_account: Account<'info, StakerAccount>,

    /// User's BRAIN token account for returning stake
    #[account(
        mut,
        constraint = user_brain_ata.mint == staking_pool.brain_mint @ StakingError::InvalidMint,
        constraint = user_brain_ata.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub user_brain_ata: Account<'info, TokenAccount>,

    /// PDA-controlled BRAIN vault (source)
    #[account(
        mut,
        address = staking_pool.brain_vault,
    )]
    pub brain_vault: Account<'info, TokenAccount>,

    /// PDA SystemAccount holding SOL rewards
    #[account(
        mut,
        address = staking_pool.reward_vault,
    )]
    pub reward_vault: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Emergency rescue instruction - allows users to recover their stake
/// even if the pool is paused or admin keys are compromised.
/// This is the ultimate "unstake always works" guarantee.
pub fn handle_emergency_rescue(ctx: Context<EmergencyRescue>) -> Result<()> {
    let pool = &ctx.accounts.staking_pool;
    let staker = &ctx.accounts.staker_account;
    let user = &ctx.accounts.user;

    // Calculate pending rewards at current multiplier (if post-cliff)
    let pending = if staker.current_multiplier > 0 {
        let weighted = (staker.staked_amount as u128)
            .checked_mul(staker.current_multiplier as u128)
            .ok_or(StakingError::MathOverflow)?;

        let accumulated = weighted
            .checked_mul(pool.reward_per_share)
            .ok_or(StakingError::MathOverflow)?
            .checked_div(PRECISION)
            .ok_or(StakingError::MathOverflow)?;

        let owed = accumulated
            .checked_sub(staker.reward_debt)
            .ok_or(StakingError::MathOverflow)?;

        u64::try_from(owed).map_err(|_| StakingError::MathOverflow)?
    } else {
        0
    };

    // Return BRAIN tokens to user via CPI with PDA signer
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.brain_vault.to_account_info(),
            to: ctx.accounts.user_brain_ata.to_account_info(),
            authority: pool.brain_vault.to_account_info(),
        },
        &[&[BRAIN_VAULT_SEED, pool.key().as_ref(), &[pool.brain_vault_bump]]],
    );
    anchor_spl::token::transfer(transfer_ctx, staker.staked_amount)?;

    // Transfer pending SOL rewards if any
    if pending > 0 {
        let reward_vault_info = ctx.accounts.reward_vault.to_account_info();
        let user_info = user.to_account_info();
        
        let vault_lamports = reward_vault_info.lamports();
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(0);
        let available = vault_lamports.saturating_sub(min_balance);
        
        let claim_amount = pending.min(available);
        
        if claim_amount > 0 {
            **reward_vault_info.try_borrow_mut_lamports()? -= claim_amount;
            **user_info.try_borrow_mut_lamports()? += claim_amount;
            msg!("Emergency rescue: {} SOL rewards rescued", claim_amount);
        }
    }

    // Update pool totals
    let pool = &mut ctx.accounts.staking_pool;
    let weighted = (staker.staked_amount as u128)
        .checked_mul(staker.current_multiplier as u128)
        .ok_or(StakingError::MathOverflow)?;
    
    pool.total_staked = pool.total_staked.saturating_sub(staker.staked_amount);
    pool.total_weighted_stake = pool.total_weighted_stake.saturating_sub(weighted);

    msg!(
        "Emergency rescue: user {} recovered {} BRAIN",
        user.key(),
        staker.staked_amount
    );

    Ok(())
}
