use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, StakingPool};

/// Byte offset of `status` field within a serialized DlmmExit account.
/// Layout: 8 (discriminator) + 32×5 (Pubkeys) + 8 (u64) = 176
const STATUS_OFFSET: usize = 176;
/// Byte offset of `completed_at` (i64) immediately after status (u8).
const COMPLETED_AT_OFFSET: usize = 177;
/// Minimum account data length for a valid DlmmExit (194 bytes).
const DLMM_EXIT_DATA_LEN: usize = 194;

#[derive(Accounts)]
pub struct EmergencyHalt<'info> {
    /// Pool owner — only the owner can trigger an emergency halt.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STAKING_POOL_SEED],
        bump = staking_pool.bump,
        constraint = authority.key() == staking_pool.owner
            @ StakingError::Unauthorized,
    )]
    pub staking_pool: Account<'info, StakingPool>,
}

pub fn handle_emergency_halt(ctx: Context<EmergencyHalt>) -> Result<()> {
    let pool = &mut ctx.accounts.staking_pool;
    pool.is_paused = true;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let program_id = crate::ID;
    let discriminator = DlmmExit::DISCRIMINATOR;

    let mut terminated_count: u64 = 0;

    for account_info in ctx.remaining_accounts.iter() {
        // Must be owned by this program
        if account_info.owner != &program_id {
            msg!("emergency_halt: skipping {} (wrong owner)", account_info.key());
            continue;
        }

        // Must be writable so we can mutate status
        if !account_info.is_writable {
            msg!("emergency_halt: skipping {} (not writable)", account_info.key());
            continue;
        }

        let mut data = account_info.try_borrow_mut_data()?;

        // Must be large enough to hold a DlmmExit
        if data.len() < DLMM_EXIT_DATA_LEN {
            msg!("emergency_halt: skipping {} (data too short)", account_info.key());
            continue;
        }

        // Discriminator must match DlmmExit
        if &data[..8] != discriminator {
            msg!("emergency_halt: skipping {} (wrong discriminator)", account_info.key());
            continue;
        }

        // Only terminate Active exits (status == 0)
        if data[STATUS_OFFSET] != 0 {
            continue;
        }

        // Set status = 2 (Terminated)
        data[STATUS_OFFSET] = 2;
        // Set completed_at = now (little-endian i64)
        data[COMPLETED_AT_OFFSET..COMPLETED_AT_OFFSET + 8]
            .copy_from_slice(&now.to_le_bytes());

        terminated_count += 1;
    }

    msg!(
        "Emergency halt: pool paused, {} active exit(s) terminated",
        terminated_count
    );

    Ok(())
}
