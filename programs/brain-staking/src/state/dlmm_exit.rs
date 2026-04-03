use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct DlmmExit {
    /// Parent staking pool
    pub pool: Pubkey,
    /// Pool owner who initiated the exit
    pub owner: Pubkey,
    /// Mint address of the asset being exited
    pub asset_mint: Pubkey,
    /// DLMM pool where liquidity is being removed
    pub dlmm_pool: Pubkey,
    /// DLMM position being unwound
    pub position: Pubkey,
    /// Cumulative SOL claimed from filled bins (lamports)
    pub total_sol_claimed: u64,
    /// Exit status: 0 = Active, 1 = Completed, 2 = Terminated
    pub status: u8,
    /// Unix timestamp when exit was initiated
    pub created_at: i64,
    /// Unix timestamp when exit was completed or terminated (0 while active)
    pub completed_at: i64,
    /// Governance proposal that triggered this exit (0 = owner-initiated)
    pub proposal_id: u64,
    /// C-04: Last claimed amount for idempotency check
    pub last_claimed_amount: u64,
    /// PDA bump
    pub bump: u8,
}
