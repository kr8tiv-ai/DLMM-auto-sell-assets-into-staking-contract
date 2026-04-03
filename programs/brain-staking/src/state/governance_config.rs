use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GovernanceConfig {
    /// Parent staking pool
    pub pool: Pubkey,
    /// Auto-incrementing proposal counter
    pub next_proposal_id: u64,
    /// When false, only owner can call governance_initiate_exit.
    /// When true, crank can also execute passed votes.
    pub auto_execute: bool,
    /// Minimum quorum in basis points of total_staked (e.g. 1000 = 10%)
    /// 0 = no quorum requirement
    pub min_quorum_bps: u16,
    /// PDA bump
    pub bump: u8,
}
