//! Property-based fuzz tests for the reward math pipeline.
//!
//! These tests exercise the pure arithmetic (reward accumulation, claim
//! settlement, multiplier transitions) with random inputs to find panics,
//! overflows, or conservation violations. They intentionally bypass Anchor
//! instruction dispatch — the integration layer is covered by T02's tests.
//!
//! Run: `cargo test --package brain-staking fuzz_tests`

use crate::constants::*;
use crate::helpers::get_multiplier;
use proptest::prelude::*;

// ── Simulation helpers ──────────────────────────────────────────────

/// Minimal staker state for pure-math simulation.
#[derive(Clone, Debug)]
struct SimStaker {
    staked_amount: u64,
    stake_timestamp: i64,
    reward_debt: u128,
    pending_rewards: u64,
    current_multiplier: u8,
}

/// Minimal pool state for pure-math simulation.
#[derive(Clone, Debug)]
struct SimPool {
    total_weighted_stake: u128,
    reward_per_share: u128,
    protocol_fee_bps: u16,
}

/// Simulate deposit_rewards accumulator update (pure math, no CPI).
/// Returns (fee, net) or None on overflow.
fn sim_deposit(pool: &mut SimPool, amount: u64) -> Option<(u64, u64)> {
    let fee = (amount as u128)
        .checked_mul(pool.protocol_fee_bps as u128)?
        .checked_div(10_000)? as u64;
    let net = amount.checked_sub(fee)?;

    if pool.total_weighted_stake > 0 {
        let increment = (net as u128)
            .checked_mul(PRECISION)?
            .checked_div(pool.total_weighted_stake)?;
        pool.reward_per_share = pool.reward_per_share.checked_add(increment)?;
    }
    Some((fee, net))
}

/// Settle rewards for a staker whose multiplier may have changed.
/// Mirrors the claim/unstake multiplier-transition logic.
fn sim_settle_multiplier(pool: &mut SimPool, staker: &mut SimStaker, new_mult: u8) -> Option<()> {
    if new_mult != staker.current_multiplier {
        let old_mult = staker.current_multiplier;

        if old_mult > 0 {
            let weighted_old = (staker.staked_amount as u128)
                .checked_mul(old_mult as u128)?;
            let accumulated_old = weighted_old
                .checked_mul(pool.reward_per_share)?
                .checked_div(PRECISION)?;
            let pending = accumulated_old.checked_sub(staker.reward_debt)?;
            let pending_u64 = u64::try_from(pending).ok()?;
            staker.pending_rewards = staker.pending_rewards.checked_add(pending_u64)?;
        }

        // Update pool weighted stake
        let weighted_old_stake = (staker.staked_amount as u128)
            .checked_mul(old_mult as u128)?;
        let weighted_new_stake = (staker.staked_amount as u128)
            .checked_mul(new_mult as u128)?;

        pool.total_weighted_stake = pool
            .total_weighted_stake
            .checked_sub(weighted_old_stake)?
            .checked_add(weighted_new_stake)?;

        staker.current_multiplier = new_mult;

        // Reset debt
        let new_accumulated = weighted_new_stake
            .checked_mul(pool.reward_per_share)?
            .checked_div(PRECISION)?;
        staker.reward_debt = new_accumulated;
    }
    Some(())
}

/// Calculate claimable rewards at current multiplier (since last settlement).
fn sim_calculate_owed(pool: &SimPool, staker: &SimStaker) -> Option<u64> {
    if staker.current_multiplier == 0 {
        return Some(0);
    }
    let weighted = (staker.staked_amount as u128)
        .checked_mul(staker.current_multiplier as u128)?;
    let accumulated = weighted
        .checked_mul(pool.reward_per_share)?
        .checked_div(PRECISION)?;
    let owed_u128 = accumulated.checked_sub(staker.reward_debt)?;
    u64::try_from(owed_u128).ok()
}

/// Perform a full claim: settle multiplier, calculate owed, return total claimed.
fn sim_claim(pool: &mut SimPool, staker: &mut SimStaker, current_time: i64) -> Option<u64> {
    let new_mult = get_multiplier(staker.stake_timestamp, current_time);
    sim_settle_multiplier(pool, staker, new_mult)?;

    if new_mult == 0 {
        return Some(0);
    }

    let owed = sim_calculate_owed(pool, staker)?;
    let total = staker.pending_rewards.checked_add(owed)?;

    // Update staker state post-claim
    let weighted = (staker.staked_amount as u128)
        .checked_mul(new_mult as u128)?;
    staker.reward_debt = weighted
        .checked_mul(pool.reward_per_share)?
        .checked_div(PRECISION)?;
    staker.pending_rewards = 0;

    Some(total)
}

/// Register a new staker: add weighted stake to pool, initialize staker state.
fn sim_add_staker(pool: &mut SimPool, staked_amount: u64, stake_timestamp: i64, current_time: i64) -> Option<SimStaker> {
    let mult = get_multiplier(stake_timestamp, current_time);
    let weighted = (staked_amount as u128).checked_mul(mult as u128)?;
    pool.total_weighted_stake = pool.total_weighted_stake.checked_add(weighted)?;

    let debt = weighted
        .checked_mul(pool.reward_per_share)?
        .checked_div(PRECISION)?;

    Some(SimStaker {
        staked_amount,
        stake_timestamp,
        reward_debt: debt,
        pending_rewards: 0,
        current_multiplier: mult,
    })
}

// ── Property 1: Reward conservation ─────────────────────────────────
//
// For any deposit + claim sequence, total claimed ≤ total net deposited.
// (Rounding truncation means claimed may be slightly less, never more.)

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn prop_reward_conservation(
        // 2-5 stakers with random BRAIN amounts (min 100k tokens = 1e11 lamports)
        staker_amounts in proptest::collection::vec(100_000_000_000u64..=10_000_000_000_000u64, 2..=5),
        // 1-10 deposit events, each 0.01-100 SOL
        deposit_amounts in proptest::collection::vec(10_000_000u64..=100_000_000_000u64, 1..=10),
        fee_bps in 0u16..=500u16,
    ) {
        let base_time: i64 = 1_700_000_000;
        // All stakers are post-cliff tier 1 (7+ days ago)
        let stake_time = base_time - TIER_1_THRESHOLD - 1;
        let current_time = base_time;

        let mut pool = SimPool {
            total_weighted_stake: 0,
            reward_per_share: 0,
            protocol_fee_bps: fee_bps,
        };

        // Register stakers
        let mut stakers: Vec<SimStaker> = Vec::new();
        for &amount in &staker_amounts {
            let s = sim_add_staker(&mut pool, amount, stake_time, current_time)
                .expect("add_staker overflow");
            stakers.push(s);
        }

        // Deposit all rewards
        let mut total_net_deposited: u128 = 0;
        for &deposit in &deposit_amounts {
            let (_, net) = sim_deposit(&mut pool, deposit)
                .expect("deposit overflow");
            total_net_deposited += net as u128;
        }

        // All stakers claim
        let mut total_claimed: u128 = 0;
        for staker in &mut stakers {
            let claimed = sim_claim(&mut pool, staker, current_time)
                .expect("claim overflow");
            total_claimed += claimed as u128;
        }

        // Conservation: total claimed ≤ total net deposited
        // (difference is rounding dust, at most 1 lamport per staker)
        prop_assert!(
            total_claimed <= total_net_deposited,
            "Conservation violated: claimed {} > deposited {}",
            total_claimed,
            total_net_deposited
        );

        // Rounding dust: the accumulator's floor(net*PRECISION/tws) truncation
        // loses up to tws/PRECISION lamports per deposit. Each staker's
        // floor(weighted*rps/PRECISION) loses at most 1 more. The hard
        // invariant is total_claimed ≤ total_deposited (no SOL created).
        // The dust bound is a sanity check scaled to pool parameters.
        let per_deposit_dust = pool.total_weighted_stake / PRECISION + 1;
        let max_dust = (deposit_amounts.len() as u128) * (per_deposit_dust + staker_amounts.len() as u128);
        let dust = total_net_deposited - total_claimed;
        prop_assert!(
            dust <= max_dust,
            "Excessive rounding dust: {} lamports (max expected {})",
            dust,
            max_dust
        );
    }
}

// ── Property 2: Proportional distribution ───────────────────────────
//
// Two stakers with identical stakes and multipliers receive equal
// rewards (within 1 lamport rounding tolerance).

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn prop_proportional_distribution(
        stake_amount in 100_000_000_000u64..=10_000_000_000_000u64,
        deposit_amount in 10_000_000u64..=100_000_000_000u64,
        fee_bps in 0u16..=500u16,
    ) {
        let base_time: i64 = 1_700_000_000;
        let stake_time = base_time - TIER_2_THRESHOLD - 1; // Both at 2x
        let current_time = base_time;

        let mut pool = SimPool {
            total_weighted_stake: 0,
            reward_per_share: 0,
            protocol_fee_bps: fee_bps,
        };

        // Two identical stakers
        let mut staker_a = sim_add_staker(&mut pool, stake_amount, stake_time, current_time)
            .expect("add A");
        let mut staker_b = sim_add_staker(&mut pool, stake_amount, stake_time, current_time)
            .expect("add B");

        // Deposit
        sim_deposit(&mut pool, deposit_amount).expect("deposit");

        // Both claim
        let claimed_a = sim_claim(&mut pool, &mut staker_a, current_time).expect("claim A");
        let claimed_b = sim_claim(&mut pool, &mut staker_b, current_time).expect("claim B");

        // Equal within 1 lamport
        let diff = if claimed_a > claimed_b {
            claimed_a - claimed_b
        } else {
            claimed_b - claimed_a
        };

        prop_assert!(
            diff <= 1,
            "Proportionality violated: A got {} B got {} (diff {})",
            claimed_a,
            claimed_b,
            diff
        );
    }
}

// ── Property 3: No overflow/panic ───────────────────────────────────
//
// Random u64 stakes, deposits, and multipliers (0-3) never cause panic.
// Operations may return None (overflow detected by checked_*), but must
// never panic or produce an undetected overflow.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn prop_no_overflow_panic(
        stake_amount in 1u64..=u64::MAX,
        deposit_amount in 1u64..=u64::MAX,
        multiplier in 0u8..=3u8,
        fee_bps in 0u16..=500u16,
        reward_per_share_seed in 0u128..=u128::MAX / PRECISION,  // Keep RPS in valid range
    ) {
        // This test asserts that operations either succeed or return None
        // (overflow caught by checked_* math). They must NEVER panic.

        let mut pool = SimPool {
            total_weighted_stake: 0,
            reward_per_share: reward_per_share_seed,
            protocol_fee_bps: fee_bps,
        };

        // Weighted stake calculation
        let weighted = (stake_amount as u128).checked_mul(multiplier as u128);
        if let Some(w) = weighted {
            pool.total_weighted_stake = w;
        }

        // Deposit — may overflow on extreme values, that's fine
        let _ = sim_deposit(&mut pool, deposit_amount);

        // Reward debt calculation — must not panic
        if let Some(w) = weighted {
            let _ = w.checked_mul(pool.reward_per_share)
                .and_then(|v| v.checked_div(PRECISION));
        }

        // Owed calculation — must not panic
        let staker = SimStaker {
            staked_amount: stake_amount,
            stake_timestamp: 0,
            reward_debt: reward_per_share_seed, // arbitrary debt
            pending_rewards: 0,
            current_multiplier: multiplier,
        };
        let _ = sim_calculate_owed(&pool, &staker);

        // If we reach here without panic, the property holds.
        prop_assert!(true);
    }
}

// ── Property 4: Multiplier monotonicity ─────────────────────────────
//
// A staker's multiplier only increases (0→1→2→3) as time advances.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn prop_multiplier_monotonicity(
        stake_timestamp in 0i64..=1_700_000_000i64,
        // Generate 5-20 increasing time deltas
        deltas in proptest::collection::vec(1i64..=100_000_000i64, 5..=20),
    ) {
        let mut current_time = stake_timestamp;
        let mut prev_mult = get_multiplier(stake_timestamp, current_time);

        for delta in deltas {
            // Advance time forward (saturating to avoid i64 overflow)
            current_time = current_time.saturating_add(delta);
            let new_mult = get_multiplier(stake_timestamp, current_time);

            prop_assert!(
                new_mult >= prev_mult,
                "Multiplier decreased: {} -> {} at time {} (staked at {})",
                prev_mult,
                new_mult,
                current_time,
                stake_timestamp
            );

            prop_assert!(
                new_mult <= 3,
                "Multiplier exceeded maximum: {} at time {}",
                new_mult,
                current_time
            );

            prev_mult = new_mult;
        }
    }
}

// ── Property 5: Zero weighted stake safety ──────────────────────────
//
// When total_weighted_stake is 0, deposit_rewards must not divide by
// zero — reward_per_share stays unchanged and SOL sits in vault.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn prop_zero_weighted_stake_safety(
        deposit_amount in 1u64..=u64::MAX,
        fee_bps in 0u16..=500u16,
        initial_rps in 0u128..=1_000_000_000_000_000_000u128,
    ) {
        let mut pool = SimPool {
            total_weighted_stake: 0, // No stakers or all pre-cliff
            reward_per_share: initial_rps,
            protocol_fee_bps: fee_bps,
        };

        let rps_before = pool.reward_per_share;

        // Deposit when no weighted stake — must not panic or divide by zero
        let result = sim_deposit(&mut pool, deposit_amount);

        // Should always succeed (no division when tws == 0)
        prop_assert!(result.is_some(), "deposit_rewards failed with zero weighted stake");

        // reward_per_share must not change
        prop_assert_eq!(
            pool.reward_per_share,
            rps_before,
            "reward_per_share changed with zero weighted stake"
        );
    }
}

// ── Property 6 (bonus): Full cycle conservation ─────────────────────
//
// Stake → advance time → deposit → claim → unstake: no SOL created.
// Tests the complete lifecycle with multiplier transitions.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(5_000))]

    #[test]
    fn prop_full_cycle_conservation(
        stake_amount in 100_000_000_000u64..=5_000_000_000_000u64,
        deposit_amount in 10_000_000u64..=50_000_000_000u64,
        fee_bps in 0u16..=500u16,
        // Time advance in days (7-100 to cover multiplier transitions)
        advance_days in 7u32..=100u32,
    ) {
        let base_time: i64 = 1_700_000_000;
        let stake_time = base_time;

        let mut pool = SimPool {
            total_weighted_stake: 0,
            reward_per_share: 0,
            protocol_fee_bps: fee_bps,
        };

        // Staker starts at time 0 (pre-cliff, mult=0)
        let mut staker = SimStaker {
            staked_amount: stake_amount,
            stake_timestamp: stake_time,
            reward_debt: 0,
            pending_rewards: 0,
            current_multiplier: 0,
        };
        // Pre-cliff: weighted stake is 0, nothing to add

        // Advance time past cliff
        let current_time = base_time + (advance_days as i64) * 86_400;
        let new_mult = get_multiplier(stake_time, current_time);

        // If post-cliff, register the weighted stake
        if new_mult > 0 {
            let weighted = (stake_amount as u128)
                .checked_mul(new_mult as u128)
                .expect("weighted overflow");
            pool.total_weighted_stake = weighted;
            staker.current_multiplier = new_mult;
            staker.reward_debt = weighted
                .checked_mul(pool.reward_per_share)
                .expect("debt mul")
                .checked_div(PRECISION)
                .expect("debt div");
        }

        // Deposit rewards
        let (_, net) = sim_deposit(&mut pool, deposit_amount)
            .expect("deposit");

        // Claim
        let claimed = sim_claim(&mut pool, &mut staker, current_time)
            .expect("claim");

        if new_mult > 0 {
            // Single staker: should get all net rewards (minus rounding)
            // Dust from floor(net*PRECISION/tws) can be up to tws/PRECISION lamports.
            prop_assert!(
                claimed <= net,
                "Single staker claimed {} > net deposited {}",
                claimed,
                net
            );
            let dust = (net as u128) - (claimed as u128);
            let max_single_dust = pool.total_weighted_stake / PRECISION + 2;
            prop_assert!(
                dust <= max_single_dust,
                "Single staker dust {} exceeds {} lamport tolerance",
                dust,
                max_single_dust
            );
        } else {
            // Pre-cliff: nothing earned
            prop_assert_eq!(claimed, 0, "Pre-cliff staker should earn nothing");
        }
    }
}
