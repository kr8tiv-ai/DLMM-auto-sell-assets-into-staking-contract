/// Precision multiplier for reward-per-share calculations (1e12)
pub const PRECISION: u128 = 1_000_000_000_000;

/// Tier 1: 7 days in seconds — staker begins earning at 1x
pub const TIER_1_THRESHOLD: i64 = 7 * 24 * 60 * 60;

/// Tier 2: 30 days in seconds — staker earns at 2x
pub const TIER_2_THRESHOLD: i64 = 30 * 24 * 60 * 60;

/// Tier 3: 90 days in seconds — staker earns at 3x
pub const TIER_3_THRESHOLD: i64 = 90 * 24 * 60 * 60;

/// PDA seed for the global staking pool
pub const STAKING_POOL_SEED: &[u8] = b"staking_pool";

/// PDA seed prefix for per-user staker accounts
pub const STAKER_SEED: &[u8] = b"staker";

/// PDA seed for the BRAIN token vault
pub const BRAIN_VAULT_SEED: &[u8] = b"brain_vault";

/// PDA seed for the SOL reward vault
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault";

/// Default minimum BRAIN stake amount (100k BRAIN with 6 decimals = 1e11)
pub const DEFAULT_MIN_STAKE: u64 = 100_000_000_000;

/// Maximum protocol fee in basis points (5% = 500 bps)
pub const MAX_PROTOCOL_FEE_BPS: u16 = 500;

/// PDA seed for DLMM exit tracker accounts
pub const DLMM_EXIT_SEED: &[u8] = b"dlmm_exit";
