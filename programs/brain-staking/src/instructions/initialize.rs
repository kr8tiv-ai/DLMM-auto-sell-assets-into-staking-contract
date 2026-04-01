use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::StakingPool;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + StakingPool::INIT_SPACE,
        seeds = [STAKING_POOL_SEED],
        bump,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    /// The BRAIN token mint
    pub brain_mint: Account<'info, Mint>,

    /// PDA-controlled token account for holding staked BRAIN
    #[account(
        init,
        payer = owner,
        token::mint = brain_mint,
        token::authority = staking_pool,
        seeds = [BRAIN_VAULT_SEED],
        bump,
    )]
    pub brain_vault: Account<'info, TokenAccount>,

    /// PDA SystemAccount for holding SOL rewards
    /// CHECK: This is a PDA that holds lamports, validated by seeds
    #[account(
        mut,
        seeds = [REWARD_VAULT_SEED],
        bump,
    )]
    pub reward_vault: SystemAccount<'info>,

    /// Treasury wallet that receives protocol fees
    /// CHECK: Stored in pool config, validated on use
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    crank: Pubkey,
    protocol_fee_bps: u16,
    min_stake_amount: u64,
) -> Result<()> {
    require!(
        protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
        StakingError::InvalidFee
    );
    require!(min_stake_amount > 0, StakingError::InvalidMinStake);

    let pool = &mut ctx.accounts.staking_pool;
    pool.owner = ctx.accounts.owner.key();
    pool.crank = crank;
    pool.brain_mint = ctx.accounts.brain_mint.key();
    pool.brain_vault = ctx.accounts.brain_vault.key();
    pool.reward_vault = ctx.accounts.reward_vault.key();
    pool.treasury = ctx.accounts.treasury.key();
    pool.total_staked = 0;
    pool.total_weighted_stake = 0;
    pool.reward_per_share = 0;
    pool.total_rewards_distributed = 0;
    pool.protocol_fee_bps = protocol_fee_bps;
    pool.min_stake_amount = min_stake_amount;
    pool.is_paused = false;
    pool.bump = ctx.bumps.staking_pool;
    pool.brain_vault_bump = ctx.bumps.brain_vault;
    pool.reward_vault_bump = ctx.bumps.reward_vault;

    msg!(
        "Staking pool initialized. Mint: {}, Fee: {} bps, Min stake: {}",
        pool.brain_mint,
        pool.protocol_fee_bps,
        pool.min_stake_amount
    );

    Ok(())
}
