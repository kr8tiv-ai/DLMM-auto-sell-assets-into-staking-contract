use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{GovernanceConfig, StakingPool};

#[derive(Accounts)]
pub struct ReallocGovernanceConfig<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,

    #[account(
        mut,
        seeds = [GOVERNANCE_CONFIG_SEED],
        bump = governance_config.bump,
    )]
    pub governance_config: Account<'info, GovernanceConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handle_realloc_governance_config(ctx: Context<ReallocGovernanceConfig>) -> Result<()> {
    let new_size = 8 + GovernanceConfig::INIT_SPACE;
    let account_info = ctx.accounts.governance_config.to_account_info();

    let current_size = account_info.data_len();
    if current_size >= new_size {
        msg!("GovernanceConfig already at required size ({} >= {})", current_size, new_size);
        return Ok(());
    }

    // Calculate additional rent needed
    let rent = Rent::get()?;
    let new_rent = rent.minimum_balance(new_size);
    let current_rent = account_info.lamports();
    let diff = new_rent.saturating_sub(current_rent);

    if diff > 0 {
        // Transfer additional lamports from owner to cover rent
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.owner.key(),
            &account_info.key(),
            diff,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.owner.to_account_info(),
                account_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    // Realloc the account data
    account_info.realloc(new_size, false)?;

    // Initialize new fields to defaults
    let config = &mut ctx.accounts.governance_config;
    config.auto_execute = false;
    config.min_quorum_bps = 0;

    msg!(
        "GovernanceConfig reallocated from {} to {} bytes",
        current_size,
        new_size
    );

    Ok(())
}
