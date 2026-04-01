use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    /// Proposal this vote belongs to
    pub proposal_id: u64,
    /// Voter's wallet address
    pub voter: Pubkey,
    /// Index into the proposal's `options` array
    pub option_index: u8,
    /// Vote weight (staked BRAIN amount)
    pub weight: u64,
    /// Unix timestamp when the vote was cast
    pub voted_at: i64,
    /// PDA bump
    pub bump: u8,
}
