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

    #[msg("An exit is already active for this asset/pool pair")]
    ExitAlreadyActive,

    #[msg("Exit is not in Active status")]
    ExitNotActive,

    #[msg("Exit has already been completed or terminated")]
    ExitAlreadyCompleted,

    #[msg("Withdrawal would leave vault below rent-exempt minimum")]
    RentExemptViolation,

    // ── Governance ──────────────────────────────────────

    #[msg("Proposal is not in Active status")]
    ProposalNotActive,

    #[msg("Voting period has ended")]
    VotingPeriodEnded,

    #[msg("Voting period has not started yet")]
    VotingPeriodNotStarted,

    #[msg("Voting period has not ended yet")]
    VotingPeriodNotEnded,

    #[msg("Option index is out of range")]
    InvalidOptionIndex,

    #[msg("Voting end must be after voting start")]
    InvalidVotingPeriod,

    #[msg("Proposal must have at least 2 options")]
    TooFewOptions,

    #[msg("Proposal exceeds maximum number of options")]
    TooManyOptions,

    #[msg("Proposal title exceeds maximum length")]
    TitleTooLong,

    #[msg("Staker has no voting power (zero staked amount)")]
    NoVotingPower,

    #[msg("Governance has already been initialized for this pool")]
    GovernanceAlreadyInitialized,
}
