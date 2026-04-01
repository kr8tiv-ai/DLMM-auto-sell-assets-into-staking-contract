use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    /// Unique proposal identifier
    pub id: u64,
    /// Parent staking pool
    pub pool: Pubkey,
    /// Wallet that created the proposal
    pub proposer: Pubkey,
    /// Short title for the proposal
    #[max_len(64)]
    pub title: String,
    /// URI pointing to full proposal description (IPFS, Arweave, etc.)
    #[max_len(200)]
    pub description_uri: String,
    /// Proposal type identifier (application-defined)
    pub proposal_type: u8,
    /// Voting options (e.g. ["Yes", "No", "Abstain"])
    #[max_len(5, 32)]
    pub options: Vec<String>,
    /// Vote weight tallies per option (parallel to `options`)
    #[max_len(5)]
    pub vote_counts: Vec<u64>,
    /// Unix timestamp when voting opens
    pub voting_starts: i64,
    /// Unix timestamp when voting closes
    pub voting_ends: i64,
    /// Proposal status: 0 = Active, 1 = Passed, 2 = Rejected, 3 = Cancelled
    pub status: u8,
    /// Sum of all vote weights cast
    pub total_vote_weight: u128,
    /// PDA bump
    pub bump: u8,
}
