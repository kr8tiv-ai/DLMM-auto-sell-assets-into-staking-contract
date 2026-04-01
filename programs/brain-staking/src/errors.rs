use anchor_lang::prelude::*;

#[error_code]
pub enum StakingError {
    #[msg("Unauthorized: signer is not the owner or crank")]
    Unauthorized,

    #[msg("Pool is paused")]
    PoolPaused,

    #[msg("Stake amount is below the minimum")]
    BelowMinStake,

    #[msg("Insufficient rewards to claim")]
    InsufficientRewards,

    #[msg("Invalid BRAIN token mint")]
    InvalidMint,

    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("User already has an active stake")]
    AlreadyStaking,

    #[msg("User has no active stake")]
    NotStaking,

    #[msg("Protocol fee exceeds maximum")]
    InvalidFee,

    #[msg("Minimum stake amount must be greater than zero")]
    InvalidMinStake,
}
