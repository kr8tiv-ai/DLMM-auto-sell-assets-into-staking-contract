use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::StakingError;
use crate::helpers::get_multiplier;
use crate::state::{StakerAccount, StakingPool};

#[derive(Accounts)]
pub struct Unstake<'info> {
    /// The staker unstaking — must be the account owner
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    /// Staker PDA — `close = user` returns rent lamports at end of instruction
    #[account(
        mut,
        seeds = [STAKER_SEED, user.key().as_ref()],
        bump = staker_account.bump,
        constraint = staker_account.owner == user.key() @ StakingError::Unauthorized,
        close = user,
    )]
    pub staker_account: Account<'info, StakerAccount>,

    /// PDA-controlled BRAIN vault — returns staked tokens
    #[account(
        mut,
        address = staking_pool.brain_vault,
    )]
    pub brain_vault: Account<'info, TokenAccount>,

    /// User's BRAIN token account (destination for returned BRAIN)
    #[account(
        mut,
        constraint = user_brain_ata.mint == staking_pool.brain_mint @ StakingError::InvalidMint,
        constraint = user_brain_ata.owner == user.key() @ StakingError::Unauthorized,
    )]
    pub user_brain_ata: Account<'info, TokenAccount>,

    /// PDA SystemAccount holding SOL rewards
    /// CHECK: Validated by address match against pool config
    #[account(
        mut,
        address = staking_pool.reward_vault,
    )]
    pub reward_vault: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_unstake(ctx: Context<Unstake>) -> Result<()> {
    let pool = &mut ctx.accounts.staking_pool;
    let staker = &mut ctx.accounts.staker_account;

    // Unstaking is allowed even when paused — users can always exit (R004)

    let now = Clock::get()?.unix_timestamp;
    let new_mult = get_multiplier(staker.stake_timestamp, now);

    // ──────────────────────────────────────────────
    // 1. Settle any pending rewards (checkpoint)
    // ──────────────────────────────────────────────
    if new_mult != staker.current_multiplier {
        let old_mult = staker.current_multiplier;

        if old_mult > 0 {
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

        // Update pool weighted stake for multiplier change
        let weighted_old_stake = (staker.staked_amount as u128)
            .checked_mul(staker.current_multiplier as u128)
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

        // Reset debt to current state
        let new_accumulated = weighted_new_stake
            .checked_mul(pool.reward_per_share)
            .ok_or(StakingError::MathOverflow)?
            .checked_div(PRECISION)
            .ok_or(StakingError::MathOverflow)?;
        staker.reward_debt = new_accumulated;
    }

    // Calculate rewards owed since last settlement at current multiplier
    if new_mult > 0 {
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
        let owed =
            u64::try_from(owed_u128).map_err(|_| StakingError::MathOverflow)?;

        staker.pending_rewards = staker
            .pending_rewards
            .checked_add(owed)
            .ok_or(StakingError::MathOverflow)?;
    }

    // ──────────────────────────────────────────────
    // 2. Handle rewards based on cliff status (R004)
    //    Post-cliff: auto-claim pending rewards to staker
    //    Pre-cliff:  forfeit pending (should be 0; redistribute if nonzero)
    // ──────────────────────────────────────────────
    let forfeited: u64;

    if new_mult > 0 {
        // Post-cliff: auto-claim all pending SOL rewards to staker
        let total_claim = staker.pending_rewards;
        forfeited = 0;

        if total_claim > 0 {
            let reward_vault_info = ctx.accounts.reward_vault.to_account_info();
            let user_info = ctx.accounts.user.to_account_info();

            let vault_lamports = reward_vault_info.lamports();
            require!(
                vault_lamports >= total_claim,
                StakingError::InsufficientRewards
            );

            // Ensure vault stays above rent-exempt minimum after deduction
            let rent = Rent::get()?;
            let min_balance = rent.minimum_balance(0);
            require!(
                vault_lamports.checked_sub(total_claim).unwrap_or(0) >= min_balance,
                StakingError::RentExemptViolation
            );

            **reward_vault_info.try_borrow_mut_lamports()? -= total_claim;
            **user_info.try_borrow_mut_lamports()? += total_claim;

            // Emergency check - if vault drops below threshold, pause pool
            let vault_lamports_after = reward_vault_info.lamports();
            if vault_lamports_after < EMERGENCY_VAULT_THRESHOLD {
                pool.is_paused = true;
                msg!("WARNING: Reward vault below emergency threshold. Pool paused.");
            }

            msg!("Auto-claimed {} lamports on unstake", total_claim);
        }
    } else {
        // Pre-cliff: forfeit any pending rewards (should be 0 since multiplier=0 earns nothing)
        forfeited = staker.pending_rewards;

        if forfeited > 0 && pool.total_weighted_stake > 0 {
            // Redistribute forfeited rewards to remaining stakers via accumulator
            // SOL stays in reward_vault; we just bump reward_per_share
            let redistribution = (forfeited as u128)
                .checked_mul(PRECISION)
                .ok_or(StakingError::MathOverflow)?
                .checked_div(pool.total_weighted_stake)
                .ok_or(StakingError::MathOverflow)?;

            pool.reward_per_share = pool
                .reward_per_share
                .checked_add(redistribution)
                .ok_or(StakingError::MathOverflow)?;

            msg!(
                "Forfeited {} lamports redistributed to stakers",
                forfeited
            );
        }
        // If forfeited > 0 but total_weighted_stake == 0, SOL stays in vault for future stakers
    }

    // ──────────────────────────────────────────────
    // 3. Return full BRAIN to user (R004: always returned regardless)
    // ──────────────────────────────────────────────
    let staked_amount = staker.staked_amount;

    let seeds = &[STAKING_POOL_SEED, &[pool.bump]];
    let signer_seeds = &[&seeds[..]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.brain_vault.to_account_info(),
                to: ctx.accounts.user_brain_ata.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        ),
        staked_amount,
    )?;

    // ──────────────────────────────────────────────
    // 4. Update pool totals
    // ──────────────────────────────────────────────
    // Remove this staker's weighted contribution
    let current_weighted = (staked_amount as u128)
        .checked_mul(new_mult as u128)
        .ok_or(StakingError::MathOverflow)?;

    pool.total_weighted_stake = pool
        .total_weighted_stake
        .checked_sub(current_weighted)
        .ok_or(StakingError::MathOverflow)?;

    pool.total_staked = pool
        .total_staked
        .checked_sub(staked_amount)
        .ok_or(StakingError::MathOverflow)?;

    // StakerAccount is closed via Anchor `close = user` constraint — rent returned to user

    msg!(
        "Unstaked {} BRAIN by {}. Multiplier was {}x. Forfeited: {} lamports. Pool total: {}",
        staked_amount,
        staker.owner,
        new_mult,
        forfeited,
        pool.total_staked
    );

    Ok(())
}
