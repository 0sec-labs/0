use futures_util::future::BoxFuture;
/// Host-only monotonic time. Test clocks advance without real deadline sleeps.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
    fn sleep_until(&self, deadline_ms: u64) -> BoxFuture<'_, ()>;
}
pub struct MonotonicClock {
    start: tokio::time::Instant,
}
impl Default for MonotonicClock {
    fn default() -> Self {
        Self {
            start: tokio::time::Instant::now(),
        }
    }
}
impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }
    fn sleep_until(&self, deadline_ms: u64) -> BoxFuture<'_, ()> {
        Box::pin(tokio::time::sleep_until(
            self.start + std::time::Duration::from_millis(deadline_ms),
        ))
    }
}
