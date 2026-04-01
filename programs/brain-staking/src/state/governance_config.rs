use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GovernanceConfig {
    /// Parent staking pool
    pub pool: Pubkey,
    /// Auto-incrementing proposal counter
    pub next_proposal_id: u64,
    /// PDA bump
    pub bump: u8,
}
