use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct DepositRewards<'info> {
    /// Authority: must be pool owner OR crank (R013)
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        constraint = authority.key() == staking_pool.owner
            || authority.key() == staking_pool.crank
            @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    /// PDA SystemAccount holding SOL rewards
    /// CHECK: Validated by address match against pool config
    #[account(
        mut,
        address = staking_pool.reward_vault,
    )]
    pub reward_vault: SystemAccount<'info>,

    /// Treasury wallet that receives protocol fees
    /// CHECK: Validated by address match against pool config
    #[account(
        mut,
        address = staking_pool.treasury,
    )]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
    let pool = &ctx.accounts.staking_pool;

    require!(!pool.is_paused, StakingError::PoolPaused);
    require!(amount > 0, StakingError::ZeroAmount);
    require!(pool.total_staked > 0, StakingError::NoActiveStakers);

    // Calculate protocol fee
    let fee = amount
        .checked_mul(pool.protocol_fee_bps as u64)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(StakingError::MathOverflow)?;

    let net = amount
        .checked_sub(fee)
        .ok_or(StakingError::MathOverflow)?;

    // Transfer fee to treasury
    if fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    // Transfer net reward to reward vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.reward_vault.to_account_info(),
            },
        ),
        net,
    )?;

    // Update accumulator
    let pool = &mut ctx.accounts.staking_pool;
    if pool.total_weighted_stake > 0 {
        let reward_increment = (net as u128)
            .checked_mul(PRECISION)
            .ok_or(StakingError::MathOverflow)?
            .checked_div(pool.total_weighted_stake)
            .ok_or(StakingError::MathOverflow)?;

        pool.reward_per_share = pool
            .reward_per_share
            .checked_add(reward_increment)
            .ok_or(StakingError::MathOverflow)?;
    }
    // If total_weighted_stake == 0, SOL sits in vault for future stakers

    pool.total_rewards_distributed = pool
        .total_rewards_distributed
        .checked_add(net)
        .ok_or(StakingError::MathOverflow)?;

    msg!(
        "Deposited {} lamports (fee: {}, net: {}). reward_per_share: {}",
        amount,
        fee,
        net,
        pool.reward_per_share
    );

    Ok(())
}
