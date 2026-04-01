use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod helpers;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("5o2uBwvKUy4oF78ziR4tEiqz59k7XBXuZBwiZFqCfca2");

#[program]
pub mod brain_staking {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        crank: Pubkey,
        protocol_fee_bps: u16,
        min_stake_amount: u64,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, crank, protocol_fee_bps, min_stake_amount)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::handle_stake(ctx, amount)
    }

    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
        instructions::deposit_rewards::handle_deposit_rewards(ctx, amount)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handle_claim(ctx)
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        instructions::unstake::handle_unstake(ctx)
    }
}
