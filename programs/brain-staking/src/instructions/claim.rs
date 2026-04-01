use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::helpers::get_multiplier;
use crate::state::{StakerAccount, StakingPool};

#[derive(Accounts)]
pub struct Claim<'info> {
    /// The staker claiming rewards — must be the account owner
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
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

    /// PDA SystemAccount holding SOL rewards
    /// CHECK: Validated by address match against pool config
    #[account(
        mut,
        address = staking_pool.reward_vault,
    )]
    pub reward_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    let pool = &mut ctx.accounts.staking_pool;
    let staker = &mut ctx.accounts.staker_account;

    require!(!pool.is_paused, StakingError::PoolPaused);

    let now = Clock::get()?.unix_timestamp;
    let new_mult = get_multiplier(staker.stake_timestamp, now);

    // Settle rewards at old multiplier if multiplier changed
    if new_mult != staker.current_multiplier {
        let old_mult = staker.current_multiplier;

        if old_mult > 0 {
            // Settle pending at old multiplier rate
            let weighted_old = (staker.staked_amount as u128)
                .checked_mul(old_mult as u128)
                .ok_or(StakingError::MathOverflow)?;

            let accumulated_old = weighted_old
                .checked_mul(pool.reward_per_share)
                .ok_or(StakingError::MathOverflow)?
                .checked_div(PRECISION)
                .ok_or(StakingError::MathOverflow)?;

            let pending = accumulated_old
                .checked_sub(staker.reward_debt)
                .ok_or(StakingError::MathOverflow)?;

            let pending_u64 =
                u64::try_from(pending).map_err(|_| StakingError::MathOverflow)?;
            staker.pending_rewards = staker
                .pending_rewards
                .checked_add(pending_u64)
                .ok_or(StakingError::MathOverflow)?;
        }

        // Update pool weighted stake: remove old contribution, add new
        let weighted_old_stake = (staker.staked_amount as u128)
            .checked_mul(old_mult as u128)
            .ok_or(StakingError::MathOverflow)?;
        let weighted_new_stake = (staker.staked_amount as u128)
            .checked_mul(new_mult as u128)
            .ok_or(StakingError::MathOverflow)?;

        pool.total_weighted_stake = pool
            .total_weighted_stake
            .checked_sub(weighted_old_stake)
            .ok_or(StakingError::MathOverflow)?
            .checked_add(weighted_new_stake)
            .ok_or(StakingError::MathOverflow)?;

        staker.current_multiplier = new_mult;

        // Reset debt to current state after multiplier upgrade
        let new_accumulated = weighted_new_stake
            .checked_mul(pool.reward_per_share)
            .ok_or(StakingError::MathOverflow)?
            .checked_div(PRECISION)
            .ok_or(StakingError::MathOverflow)?;
        staker.reward_debt = new_accumulated;
    }

    // If pre-cliff, nothing to claim
    if new_mult == 0 {
        msg!("Staker is pre-cliff, no rewards to claim");
        return Ok(());
    }

    // Calculate currently owed rewards since last settlement
    let weighted = (staker.staked_amount as u128)
        .checked_mul(new_mult as u128)
        .ok_or(StakingError::MathOverflow)?;

    let accumulated = weighted
        .checked_mul(pool.reward_per_share)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(PRECISION)
        .ok_or(StakingError::MathOverflow)?;

    let owed_u128 = accumulated
        .checked_sub(staker.reward_debt)
        .ok_or(StakingError::MathOverflow)?;
    let owed = u64::try_from(owed_u128).map_err(|_| StakingError::MathOverflow)?;

    let total = staker
        .pending_rewards
        .checked_add(owed)
        .ok_or(StakingError::MathOverflow)?;

    if total == 0 {
        msg!("No rewards to claim");
        return Ok(());
    }

    // Transfer SOL from reward_vault PDA to staker via direct lamport manipulation
    // This is the standard pattern for PDA SystemAccount outgoing transfers
    let reward_vault_info = ctx.accounts.reward_vault.to_account_info();
    let user_info = ctx.accounts.user.to_account_info();

    let vault_lamports = reward_vault_info.lamports();
    require!(vault_lamports >= total, StakingError::InsufficientRewards);

    // Ensure vault stays above rent-exempt minimum after deduction
    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(0);
    require!(
        vault_lamports.checked_sub(total).unwrap_or(0) >= min_balance,
        StakingError::RentExemptViolation
    );

    **reward_vault_info.try_borrow_mut_lamports()? -= total;
    **user_info.try_borrow_mut_lamports()? += total;

    // Update staker state
    staker.reward_debt = accumulated;
    staker.pending_rewards = 0;
    staker.last_claim_timestamp = now;

    msg!(
        "Claimed {} lamports by {}. Multiplier: {}x",
        total,
        staker.owner,
        new_mult
    );

    Ok(())
}
