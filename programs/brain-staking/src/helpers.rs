use crate::constants::*;

/// Calculate the reward multiplier based on staking duration.
/// Returns 0 (pre-cliff), 1 (7+ days), 2 (30+ days), or 3 (90+ days).
pub fn get_multiplier(stake_timestamp: i64, current_timestamp: i64) -> u8 {
    let elapsed = current_timestamp.saturating_sub(stake_timestamp);
    if elapsed >= TIER_3_THRESHOLD {
        3
    } else if elapsed >= TIER_2_THRESHOLD {
        2
    } else if elapsed >= TIER_1_THRESHOLD {
        1
    } else {
        0 // Before cliff — earns nothing
    }
}
