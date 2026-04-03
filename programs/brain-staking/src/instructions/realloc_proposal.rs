use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{Proposal, StakingPool};

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ReallocProposal<'info> {
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
        seeds = [PROPOSAL_SEED, staking_pool.key().as_ref(), &proposal_id.to_le_bytes()],
        bump = proposal.bump,
    )]
    pub proposal: Account<'info, Proposal>,

    pub system_program: Program<'info, System>,
}

pub fn handle_realloc_proposal(ctx: Context<ReallocProposal>, _proposal_id: u64) -> Result<()> {
    let new_size = 8 + Proposal::INIT_SPACE;
    let account_info = ctx.accounts.proposal.to_account_info();

    let current_size = account_info.data_len();
    if current_size >= new_size {
        msg!("Proposal already at required size ({} >= {})", current_size, new_size);
        return Ok(());
    }

    let rent = Rent::get()?;
    let new_rent = rent.minimum_balance(new_size);
    let current_rent = account_info.lamports();
    let diff = new_rent.saturating_sub(current_rent);

    if diff > 0 {
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

    account_info.realloc(new_size, false)?;

    let proposal = &mut ctx.accounts.proposal;
    proposal.winning_option_index = 255;
    proposal.executed = false;

    msg!(
        "Proposal {} reallocated from {} to {} bytes",
        proposal.id,
        current_size,
        new_size
    );

    Ok(())
}
