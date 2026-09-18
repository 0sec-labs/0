use crate::{Error, Result};
use zero_protocol::http::HttpRateLimit;

/// Integer token bucket. One token costs `interval_ms` units; every elapsed
/// millisecond replenishes `requests_per_interval` units. Wall clock rollback
/// never replenishes tokens or moves the recorded clock backwards.
pub(super) fn available(
    limit: &HttpRateLimit,
    tokens: u64,
    last_ms: u64,
    now_ms: u64,
    cooldown_ms: u64,
) -> Result<(u64, u64, u64)> {
    if !(1..=10_000).contains(&limit.requests_per_interval)
        || !(1..=3_600_000).contains(&limit.interval_ms)
        || !(1..=1_000).contains(&limit.burst)
    {
        return Err(Error::Invalid("HTTP rate bounds invalid".into()));
    }
    let cap = limit.interval_ms * u64::from(limit.burst);
    if tokens > cap {
        return Err(Error::Invalid("HTTP stored token balance invalid".into()));
    }
    let time = now_ms.max(last_ms);
    let refill = u128::from(time - last_ms) * u128::from(limit.requests_per_interval);
    let balance = (u128::from(tokens) + refill).min(u128::from(cap)) as u64;
    let shortage = limit.interval_ms.saturating_sub(balance);
    let delay = shortage.div_ceil(u64::from(limit.requests_per_interval));
    let eligible = time
        .checked_add(delay)
        .ok_or_else(|| Error::Invalid("HTTP rate clock overflow".into()))?
        .max(cooldown_ms);
    Ok((balance, time, eligible))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_tokens_and_clock_rollback_do_not_allow_early_dispatch() {
        let rate = HttpRateLimit {
            requests_per_interval: 3,
            interval_ms: 1000,
            burst: 2,
        };
        assert_eq!(available(&rate, 0, 100, 433, 0).unwrap(), (999, 433, 434));
        assert_eq!(available(&rate, 0, 100, 434, 0).unwrap(), (1002, 434, 434));
        assert_eq!(available(&rate, 0, 100, 99, 0).unwrap(), (0, 100, 434));
    }

    #[test]
    fn cooldown_does_not_reset_or_overfill_bucket() {
        let rate = HttpRateLimit {
            requests_per_interval: 1,
            interval_ms: 1000,
            burst: 1,
        };
        assert_eq!(
            available(&rate, 0, 0, 10_000, 60_000).unwrap(),
            (1000, 10_000, 60_000)
        );
        assert_eq!(
            available(&rate, 0, 60_000, 60_000, 60_000).unwrap(),
            (0, 60_000, 61_000)
        );
        assert!(available(&rate, 1001, 0, 0, 0).is_err());
    }

    #[test]
    fn enormous_elapsed_time_saturates_without_integer_overflow() {
        let rate = HttpRateLimit {
            requests_per_interval: 10_000,
            interval_ms: 3_600_000,
            burst: 1000,
        };
        assert_eq!(
            available(&rate, 0, 0, u64::MAX, 0).unwrap(),
            (3_600_000_000, u64::MAX, u64::MAX)
        );
    }
}
