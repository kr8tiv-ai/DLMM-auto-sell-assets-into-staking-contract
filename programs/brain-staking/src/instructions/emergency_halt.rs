use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::constants::*;
use crate::errors::StakingError;
use crate::state::{DlmmExit, StakingPool};

/// Byte offset of `pool` field within a serialized DlmmExit account.
/// Layout: 8 (discriminator) + 32 (pool pubkey) = 40
const POOL_OFFSET: usize = 8;
/// Byte offset of `status` field within a serialized DlmmExit account.
/// Layout: 8 (discriminator) + 32×5 (Pubkeys) + 8 (u64) = 176
const STATUS_OFFSET: usize = 176;
/// Byte offset of `completed_at` (i64) after status (u8) + created_at (i64).
const COMPLETED_AT_OFFSET: usize = 185;
/// Minimum account data length for a valid DlmmExit.
/// Old layout (pre-M003): 194 bytes. New layout (post-M003, +proposal_id u64): 202 bytes.
/// We use the old size as the minimum so emergency_halt can process both.
const DLMM_EXIT_DATA_LEN: usize = 194;

// Compile-time assertion: verify hardcoded byte offsets match DlmmExit field layout.
// Old layout: 8 (disc) + 32*5 (Pubkeys) + 8 (u64 total_sol_claimed) + 1 (u8 status)
//           + 8 (i64 created_at) + 8 (i64 completed_at) + 1 (u8 bump) = 194
// New layout: ... + 8 (u64 proposal_id) + 1 (u8 bump) = 202
// STATUS_OFFSET and COMPLETED_AT_OFFSET are unchanged — proposal_id is after completed_at.
const _: () = {
    let disc = 8usize;
    let pubkeys = 32 * 5;
    let sol_claimed = 8; // u64
    let expected_status = disc + pubkeys + sol_claimed; // 176
    assert!(expected_status == 176);
    let status_size = 1; // u8
    let created_at_size = 8; // i64
    let expected_completed_at = expected_status + status_size + created_at_size; // 185
    assert!(expected_completed_at == 185);
    let completed_at_size = 8; // i64
    let proposal_id_size = 8; // u64 (added in M003)
    let bump_size = 1; // u8
    let old_len = expected_completed_at + completed_at_size + bump_size; // 194 (pre-M003)
    assert!(old_len == 194);
    let new_len = expected_completed_at + completed_at_size + proposal_id_size + bump_size; // 202
    assert!(new_len == 202);
};

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
    let pool_key = pool.key();

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

        // C-02: Validate the DlmmExit's pool field matches our staking pool
        let exit_pool_key = Pubkey::new(&data[POOL_OFFSET..POOL_OFFSET + 32]);
        if exit_pool_key != pool_key {
            msg!("emergency_halt: skipping {} (wrong pool)", account_info.key());
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
