//! Admission for provider requests. Everyone behind one Citadel server shares
//! its IP address, so each provider gets a token bucket and a concurrency cap
//! across all users, honours upstream `429`s, and is skipped for a while after
//! repeated failures instead of making every user wait out its timeout.
use std::{
    collections::HashMap,
    future::Future,
    hash::{BuildHasher, RandomState},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::sync::Semaphore;

use crate::{error::MetadataError, model::MetadataProvider};

const FAILURE_THRESHOLD: u32 = 5;
const OPEN_FOR: Duration = Duration::from_secs(60);
/// How long a request may wait for one of the provider's concurrent slots.
const SLOT_WAIT: Duration = Duration::from_secs(5);
const MAX_BUCKETS: usize = 1024;

#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub burst: f64,
    pub per_second: f64,
    pub concurrency: usize,
    /// Hardcover rate-limits each account token, so its bucket is per
    /// credential; the others limit by client IP, so one bucket is shared.
    pub per_credential: bool,
}

pub(crate) fn limits(provider: MetadataProvider) -> Limits {
    match provider {
        MetadataProvider::Hardcover => Limits {
            burst: 10.0,
            per_second: 1.0,
            concurrency: 4,
            per_credential: true,
        },
        MetadataProvider::Loc => Limits {
            burst: 5.0,
            per_second: 0.5,
            concurrency: 2,
            per_credential: false,
        },
        MetadataProvider::OpenLibrary | MetadataProvider::Dnb | MetadataProvider::K10plus => {
            Limits {
                burst: 10.0,
                per_second: 1.0,
                concurrency: 4,
                per_credential: false,
            }
        }
    }
}

pub(crate) struct Guards {
    providers: HashMap<MetadataProvider, ProviderGuard>,
    hasher: RandomState,
}

struct ProviderGuard {
    provider: MetadataProvider,
    limits: Limits,
    slots: Arc<Semaphore>,
    state: Mutex<GuardState>,
}

impl Guards {
    pub fn new() -> Self {
        Self {
            providers: MetadataProvider::ALL
                .into_iter()
                .map(|provider| {
                    let limits = limits(provider);
                    (
                        provider,
                        ProviderGuard {
                            provider,
                            limits,
                            slots: Arc::new(Semaphore::new(limits.concurrency)),
                            state: Mutex::default(),
                        },
                    )
                })
                .collect(),
            hasher: RandomState::new(),
        }
    }

    /// Run one provider request if the provider's limits admit it, and learn
    /// from how it went.
    pub async fn run<T, F>(
        &self,
        provider: MetadataProvider,
        credential: Option<&str>,
        request: impl FnOnce() -> F,
    ) -> Result<T, MetadataError>
    where
        F: Future<Output = Result<T, MetadataError>>,
    {
        let guard = &self.providers[&provider];
        let key = credential
            .filter(|_| guard.limits.per_credential)
            .map(|credential| self.hasher.hash_one(credential));
        guard.lock().admit(guard, key, Instant::now())?;
        let _slot = tokio::time::timeout(SLOT_WAIT, guard.slots.clone().acquire_owned())
            .await
            .map_err(|_| MetadataError::rate_limited(Duration::from_secs(1)))?
            .map_err(|_| MetadataError::rate_limited(Duration::from_secs(1)))?;
        let result = request().await;
        guard
            .lock()
            .record(guard.provider, key, &result, Instant::now());
        result
    }
}

impl ProviderGuard {
    fn lock(&self) -> std::sync::MutexGuard<'_, GuardState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Default)]
struct GuardState {
    buckets: HashMap<Option<u64>, Bucket>,
    consecutive_failures: u32,
    open_until: Option<Instant>,
}

struct Bucket {
    tokens: f64,
    refilled_at: Instant,
    blocked_until: Option<Instant>,
}

impl Bucket {
    fn full(limits: &Limits, now: Instant) -> Self {
        Self {
            tokens: limits.burst,
            refilled_at: now,
            blocked_until: None,
        }
    }

    fn refill(&mut self, limits: &Limits, now: Instant) {
        let elapsed = now
            .saturating_duration_since(self.refilled_at)
            .as_secs_f64();
        self.tokens = (self.tokens + elapsed * limits.per_second).min(limits.burst);
        self.refilled_at = now;
    }

    fn idle(&self, limits: &Limits, now: Instant) -> bool {
        self.tokens >= limits.burst && self.blocked_until.is_none_or(|until| until <= now)
    }
}

impl GuardState {
    fn admit(
        &mut self,
        guard: &ProviderGuard,
        key: Option<u64>,
        now: Instant,
    ) -> Result<(), MetadataError> {
        let limits = &guard.limits;
        if let Some(until) = self.open_until.filter(|until| *until > now) {
            return Err(MetadataError::unavailable(
                guard.provider.display_name(),
                until - now,
            ));
        }
        if self.buckets.len() >= MAX_BUCKETS && !self.buckets.contains_key(&key) {
            self.buckets.retain(|_, bucket| {
                bucket.refill(limits, now);
                !bucket.idle(limits, now)
            });
        }
        let bucket = self
            .buckets
            .entry(key)
            .or_insert_with(|| Bucket::full(limits, now));
        if let Some(until) = bucket.blocked_until.filter(|until| *until > now) {
            return Err(MetadataError::rate_limited(until - now));
        }
        bucket.refill(limits, now);
        if bucket.tokens < 1.0 {
            let wait = (1.0 - bucket.tokens) / limits.per_second;
            return Err(MetadataError::rate_limited(Duration::from_secs_f64(wait)));
        }
        bucket.tokens -= 1.0;
        Ok(())
    }

    fn record<T>(
        &mut self,
        provider: MetadataProvider,
        key: Option<u64>,
        result: &Result<T, MetadataError>,
        now: Instant,
    ) {
        match result {
            Ok(_) => {
                self.consecutive_failures = 0;
                self.open_until = None;
            }
            Err(error) => {
                if let crate::MetadataErrorKind::RateLimited { retry_after } = error.kind {
                    if let Some(bucket) = self.buckets.get_mut(&key) {
                        bucket.blocked_until = Some(now + retry_after);
                    }
                } else if error.counts_against_provider() {
                    self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                    if self.consecutive_failures >= FAILURE_THRESHOLD {
                        if self.open_until.is_none_or(|until| until <= now) {
                            log::warn!(
                                "metadata provider {} failed {} times in a row; skipping it for {}s",
                                provider.display_name(),
                                self.consecutive_failures,
                                OPEN_FOR.as_secs()
                            );
                        }
                        self.open_until = Some(now + OPEN_FOR);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MetadataErrorKind;

    fn guard(provider: MetadataProvider) -> ProviderGuard {
        let limits = limits(provider);
        ProviderGuard {
            provider,
            limits,
            slots: Arc::new(Semaphore::new(limits.concurrency)),
            state: Mutex::default(),
        }
    }

    fn upstream() -> Result<(), MetadataError> {
        Err(MetadataError::upstream("boom"))
    }

    #[test]
    fn bucket_allows_a_burst_then_refills() {
        let guard = guard(MetadataProvider::OpenLibrary);
        let now = Instant::now();
        let mut state = guard.lock();
        for _ in 0..10 {
            state.admit(&guard, None, now).unwrap();
        }
        let refused = state.admit(&guard, None, now).unwrap_err();
        assert!(matches!(
            refused.kind,
            MetadataErrorKind::RateLimited { .. }
        ));
        state
            .admit(&guard, None, now + Duration::from_secs(1))
            .unwrap();
    }

    #[test]
    fn credentials_get_their_own_buckets_only_where_the_provider_limits_by_key() {
        let hardcover = guard(MetadataProvider::Hardcover);
        let now = Instant::now();
        let mut state = hardcover.lock();
        for _ in 0..10 {
            state.admit(&hardcover, Some(1), now).unwrap();
        }
        assert!(state.admit(&hardcover, Some(1), now).is_err());
        state.admit(&hardcover, Some(2), now).unwrap();
    }

    #[test]
    fn upstream_429_blocks_the_bucket_until_retry_after() {
        let guard = guard(MetadataProvider::OpenLibrary);
        let now = Instant::now();
        let mut state = guard.lock();
        state.admit(&guard, None, now).unwrap();
        state.record::<()>(
            guard.provider,
            None,
            &Err(MetadataError::rate_limited(Duration::from_secs(30))),
            now,
        );
        let refused = state
            .admit(&guard, None, now + Duration::from_secs(10))
            .unwrap_err();
        assert_eq!(
            refused.kind,
            MetadataErrorKind::RateLimited {
                retry_after: Duration::from_secs(20)
            }
        );
        state
            .admit(&guard, None, now + Duration::from_secs(31))
            .unwrap();
        assert_eq!(state.consecutive_failures, 0, "a 429 isn't a failure");
    }

    #[test]
    fn repeated_failures_open_the_circuit_and_a_success_closes_it() {
        let guard = guard(MetadataProvider::Loc);
        let now = Instant::now();
        let mut state = guard.lock();
        for _ in 0..FAILURE_THRESHOLD {
            state.record(guard.provider, None, &upstream(), now);
        }
        let refused = state.admit(&guard, None, now).unwrap_err();
        assert!(matches!(
            refused.kind,
            MetadataErrorKind::Unavailable { .. }
        ));
        assert!(refused.message.contains("Library of Congress"));

        // After the cooldown one trial goes through; failing reopens at once.
        let later = now + OPEN_FOR + Duration::from_secs(1);
        state.admit(&guard, None, later).unwrap();
        state.record(guard.provider, None, &upstream(), later);
        assert!(state.admit(&guard, None, later).is_err());

        let much_later = later + OPEN_FOR + Duration::from_secs(1);
        state.admit(&guard, None, much_later).unwrap();
        state.record(guard.provider, None, &Ok(()), much_later);
        assert_eq!(state.consecutive_failures, 0);
        assert_eq!(state.open_until, None);
    }

    #[test]
    fn credential_and_argument_errors_do_not_count_against_the_provider() {
        let guard = guard(MetadataProvider::Hardcover);
        let now = Instant::now();
        let mut state = guard.lock();
        for _ in 0..FAILURE_THRESHOLD * 2 {
            state.record::<()>(
                guard.provider,
                None,
                &Err(MetadataError::unauthorized("bad key")),
                now,
            );
            state.record::<()>(
                guard.provider,
                None,
                &Err(MetadataError::invalid("empty")),
                now,
            );
        }
        assert_eq!(state.open_until, None);
    }

    #[test]
    fn idle_buckets_are_dropped_when_the_map_is_full() {
        let guard = guard(MetadataProvider::Hardcover);
        let now = Instant::now();
        let mut state = guard.lock();
        for key in 0..MAX_BUCKETS as u64 {
            state.admit(&guard, Some(key), now).unwrap();
        }
        let later = now + Duration::from_secs(60);
        state.admit(&guard, Some(u64::MAX), later).unwrap();
        assert_eq!(state.buckets.len(), 1);
    }

    #[tokio::test]
    async fn run_records_outcomes() {
        let guards = Guards::new();
        for _ in 0..FAILURE_THRESHOLD {
            let _ = guards
                .run(MetadataProvider::Dnb, None, || async { upstream() })
                .await;
        }
        let refused = guards
            .run(MetadataProvider::Dnb, None, || async { Ok(()) })
            .await
            .unwrap_err();
        assert!(matches!(
            refused.kind,
            MetadataErrorKind::Unavailable { .. }
        ));
        guards
            .run(MetadataProvider::K10plus, None, || async { Ok(()) })
            .await
            .unwrap();
    }
}
