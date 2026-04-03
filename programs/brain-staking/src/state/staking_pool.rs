use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct StakingPool {
    /// Program authority (owner)
    pub owner: Pubkey,
    /// Crank wallet — limited authority for deposit_rewards only
    pub crank: Pubkey,
    /// $BRAIN token mint address
    pub brain_mint: Pubkey,
    /// PDA token account holding staked BRAIN
    pub brain_vault: Pubkey,
    /// PDA SystemAccount holding SOL rewards (lamports)
    pub reward_vault: Pubkey,
    /// Treasury wallet for protocol fee
    pub treasury: Pubkey,
    /// Total BRAIN tokens staked across all users
    pub total_staked: u64,
    /// Sum of (stake × multiplier) across all active stakers
    pub total_weighted_stake: u128,
    /// Accumulated rewards per unit of weighted stake, scaled by PRECISION
    pub reward_per_share: u128,
    /// Lifetime SOL distributed (tracking only)
    pub total_rewards_distributed: u64,
    /// Protocol fee in basis points (e.g. 200 = 2%)
    pub protocol_fee_bps: u16,
    /// Minimum BRAIN tokens required to stake
    pub min_stake_amount: u64,
    /// Pending new owner for two-step ownership transfer (Pubkey::default = no pending)
    pub pending_owner: Pubkey,
    /// Emergency pause flag
    pub is_paused: bool,
    /// PDA bump for the staking pool
    pub bump: u8,
    /// PDA bump for the brain vault
    pub brain_vault_bump: u8,
    /// PDA bump for the reward vault
    pub reward_vault_bump: u8,
}
