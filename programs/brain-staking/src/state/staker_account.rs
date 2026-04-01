use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct StakerAccount {
    /// Staker's wallet address
    pub owner: Pubkey,
    /// Amount of BRAIN tokens staked
    pub staked_amount: u64,
    /// Unix timestamp when the stake was created
    pub stake_timestamp: i64,
    /// Reward-per-share snapshot × weighted stake at last interaction
    pub reward_debt: u128,
    /// Accumulated unclaimed SOL rewards (lamports)
    pub pending_rewards: u64,
    /// Unix timestamp of last claim or reward settlement
    pub last_claim_timestamp: i64,
    /// Current multiplier tier (0=pre-cliff, 1=1x, 2=2x, 3=3x)
    pub current_multiplier: u8,
    /// PDA bump
    pub bump: u8,
}
