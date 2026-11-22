//! The sign-in guard (ADR 0017): how many guesses at a password, device key
//! or setup code each client and each username may make.
//!
//! Two tiers decide, before any work is done. The **address tier** gives each
//! client (`/32` or `/64`) a bucket of [`ADDRESS_FAILURES_PER_HOUR`] and its
//! neighbourhoods (`/24`, `/56`, `/48`) larger ones; a spent bucket bans that
//! key for an hour, doubling on each re-ban up to a day. It is off for soft
//! clients, which may stand for many people. The **username tier** slows each
//! username to one guess every [`USERNAME_REFILL`] after a burst of
//! [`USERNAME_BURST`], whoever asks, and never bans. Devices that signed in
//! before (a browser's signed cookie, or an OPDS reader's address) skip the
//! username tier within a budget of their own, so an attack on a name doesn't
//! lock its owner out.
//!
//! [`SignInGuard::reserve`] debits every tier up front and returns a
//! [`Ticket`]; settling it as a success refunds the debits, and a ticket
//! dropped unsettled counts as a failure. Nothing here reads a database, so
//! real and unknown usernames are treated alike.
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    hash::Hasher,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use siphasher::sip::SipHasher24;
use subtle::ConstantTimeEq;

use crate::client::{AddressKey, ClientAddress};

const HOUR: Duration = Duration::from_secs(60 * 60);
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// Failures one client (`/32` or `/64`) may make: a bucket this size that
/// refills at this rate per hour.
pub const ADDRESS_FAILURES_PER_HOUR: u32 = 100;
/// Failures a `/24` or `/56` may make, per hour.
pub const NARROW_NEIGHBOURHOOD_FAILURES_PER_HOUR: u32 = 400;
/// Failures a `/48` may make, per hour.
pub const WIDE_NEIGHBOURHOOD_FAILURES_PER_HOUR: u32 = 1_000;
/// A spent address bucket bans for this long, doubling on each re-ban…
pub const FIRST_BAN: Duration = HOUR;
/// …up to this.
pub const LONGEST_BAN: Duration = DAY;
/// Clients tracked one by one. When full, the least recently seen client
/// that isn't banned is forgotten; its failures still count in its
/// neighbourhoods.
pub const TRACKED_ADDRESSES: usize = 100_000;
/// Neighbourhoods and usernames are counted in fixed hashed tables this size.
pub const HASHED_BUCKETS: usize = 65_536;
/// Guesses a username may take at once…
pub const USERNAME_BURST: u32 = 10;
/// …and how often it gets another.
pub const USERNAME_REFILL: Duration = Duration::from_secs(30);
/// Browser sign-ins one client may have being verified at once.
pub const SIGN_INS_IN_FLIGHT: u8 = 2;
/// The same failed credential from the same client within this window
/// counts once.
pub const REPEAT_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Failed credentials remembered per client for [`REPEAT_WINDOW`].
pub const REPEATS_PER_ADDRESS: usize = 64;
/// Failures a known device may make before its exemption from the username
/// tier is suspended for [`KNOWN_DEVICE_SUSPENSION`].
pub const KNOWN_DEVICE_FAILURES_PER_HOUR: u32 = 20;
pub const KNOWN_DEVICE_SUSPENSION: Duration = HOUR;
/// OPDS readers known per username: the most recent addresses that signed
/// in, each for [`KNOWN_PAIR_LIFETIME`] after its last success.
pub const KNOWN_PAIRS_PER_USERNAME: usize = 8;
pub const KNOWN_PAIR_LIFETIME: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// How long a browser's known-device cookie lasts.
pub const DEVICE_COOKIE_LIFETIME: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// Where the guard gets the time, so tests can move it.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// A clock that moves only when told to; for tests.
#[doc(hidden)]
pub struct ManualClock {
    start: Instant,
    offset: Mutex<Duration>,
}

impl ManualClock {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            start: Instant::now(),
            offset: Mutex::new(Duration::ZERO),
        })
    }

    pub fn advance(&self, by: Duration) {
        *self.offset.lock().unwrap_or_else(PoisonError::into_inner) += by;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Instant {
        self.start + *self.offset.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A username as sign-in compares it: trimmed, with ASCII letters folded,
/// as `COLLATE NOCASE` and `eq_ignore_ascii_case` do. Other letters keep
/// their case.
pub fn normalise(username: &str) -> String {
    username.trim().to_ascii_lowercase()
}

/// What is being guessed.
#[derive(Clone, Copy, Debug)]
pub enum Credential<'a> {
    /// A browser's username and password, with the known-device cookie it
    /// sent for that username, if it was genuine.
    Password {
        username: &'a str,
        password: &'a [u8],
        device: Option<DeviceId>,
    },
    /// An OPDS reader's username and device key; no username when the
    /// `Authorization` header couldn't be read.
    DeviceKey {
        username: Option<&'a str>,
        key: &'a [u8],
    },
    /// The one-time code for creating the first administrator. Only the
    /// address tier applies.
    SetupCode { code: &'a [u8] },
}

impl<'a> Credential<'a> {
    fn username(&self) -> Option<&'a str> {
        match self {
            Self::Password { username, .. } => Some(username),
            Self::DeviceKey { username, .. } => *username,
            Self::SetupCode { .. } => None,
        }
    }

    fn secret(&self) -> (&'static [u8], &'a [u8]) {
        match self {
            Self::Password { password, .. } => (b"password", password),
            Self::DeviceKey { key, .. } => (b"device-key", key),
            Self::SetupCode { code } => (b"setup-code", code),
        }
    }
}

/// Why a guess was refused without being checked.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Slowdown {
    /// The client spent its allowance and is banned for a while.
    Address,
    /// The client's `/24`, `/56` or `/48` spent its allowance.
    Neighbourhood,
    /// The client already has [`SIGN_INS_IN_FLIGHT`] sign-ins being checked.
    InFlight,
    /// The username is being guessed at from elsewhere; it gets another
    /// guess soon.
    Username,
    /// This exact credential already failed from this client within
    /// [`REPEAT_WINDOW`]. It is answered as wrong without being checked or
    /// counted again, so resending one guess costs nothing.
    Repeat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Refusal {
    pub reason: Slowdown,
    /// How long until the same guess could be checked.
    pub retry_after: Duration,
}

impl Refusal {
    /// Whether to answer as a wrong credential rather than as a slowdown.
    pub fn is_repeat(&self) -> bool {
        self.reason == Slowdown::Repeat
    }

    fn after(reason: Slowdown, milliseconds: u64) -> Self {
        Self {
            reason,
            retry_after: Duration::from_millis(milliseconds),
        }
    }

    /// `Retry-After`, in whole seconds, at least one.
    pub fn retry_after_seconds(&self) -> u64 {
        self.retry_after.as_millis().div_ceil(1000).max(1) as u64
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Success,
    Failure,
}

/// What administrators see of the guard: counts, never addresses or names.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GuardSummary {
    /// Clients (`/32` or `/64`) banned right now.
    pub banned_addresses: usize,
    /// Neighbourhoods (`/24`, `/56`, `/48`) banned right now.
    pub banned_neighbourhoods: usize,
    /// Usernames being slowed right now (hashed, so names that share a slot
    /// count once).
    pub slowed_usernames: usize,
}

/// How a bucket fills and what happens when it's empty.
#[derive(Clone, Copy)]
struct Rule {
    capacity: f64,
    milliseconds_per_token: f64,
    first_ban: u64,
    longest_ban: u64,
}

impl Rule {
    const fn hourly(per_hour: u32, first_ban: Duration, longest_ban: Duration) -> Self {
        Self {
            capacity: per_hour as f64,
            milliseconds_per_token: HOUR.as_millis() as f64 / per_hour as f64,
            first_ban: first_ban.as_millis() as u64,
            longest_ban: longest_ban.as_millis() as u64,
        }
    }
}

const ADDRESS_RULE: Rule = Rule::hourly(ADDRESS_FAILURES_PER_HOUR, FIRST_BAN, LONGEST_BAN);
const NARROW_RULE: Rule = Rule::hourly(
    NARROW_NEIGHBOURHOOD_FAILURES_PER_HOUR,
    FIRST_BAN,
    LONGEST_BAN,
);
const WIDE_RULE: Rule = Rule::hourly(WIDE_NEIGHBOURHOOD_FAILURES_PER_HOUR, FIRST_BAN, LONGEST_BAN);
const USERNAME_RULE: Rule = Rule {
    capacity: USERNAME_BURST as f64,
    milliseconds_per_token: USERNAME_REFILL.as_millis() as f64,
    first_ban: 0,
    longest_ban: 0,
};
const KNOWN_DEVICE_RULE: Rule = Rule::hourly(
    KNOWN_DEVICE_FAILURES_PER_HOUR,
    KNOWN_DEVICE_SUSPENSION,
    KNOWN_DEVICE_SUSPENSION,
);
/// Rounding slack, so a bucket refilled to exactly one token has one.
const EPSILON: f64 = 1e-9;

/// A token bucket counted as tokens spent, so all zeroes is a full bucket.
/// Times are milliseconds since the guard started.
#[derive(Clone, Copy, Default)]
struct Bucket {
    spent: f64,
    bans: u32,
    at: u64,
    banned_until: u64,
}

impl Bucket {
    fn refill(&mut self, now: u64, rule: &Rule) {
        let elapsed = now.saturating_sub(self.at);
        self.spent = (self.spent - elapsed as f64 / rule.milliseconds_per_token).max(0.0);
        self.at = now;
    }

    fn spent_at(&self, now: u64, rule: &Rule) -> f64 {
        (self.spent - now.saturating_sub(self.at) as f64 / rule.milliseconds_per_token).max(0.0)
    }

    fn has_token(&mut self, now: u64, rule: &Rule) -> bool {
        self.refill(now, rule);
        rule.capacity - self.spent >= 1.0 - EPSILON
    }

    /// Milliseconds until the bucket has a token again.
    fn wait_for_token(&self, rule: &Rule) -> u64 {
        let short = self.spent - (rule.capacity - 1.0);
        (short.max(0.0) * rule.milliseconds_per_token).ceil() as u64
    }

    fn ban_remaining(&self, now: u64) -> Option<u64> {
        (self.banned_until > now).then(|| self.banned_until - now)
    }

    /// Bans for the rule's first ban, doubled for each earlier ban, up to
    /// its longest; returns the length.
    fn ban(&mut self, now: u64, rule: &Rule) -> u64 {
        let length = rule
            .first_ban
            .saturating_mul(1u64 << self.bans.min(32))
            .min(rule.longest_ban);
        self.bans = self.bans.saturating_add(1);
        self.banned_until = now + length;
        length
    }

    fn debit(&mut self) {
        self.spent += 1.0;
    }

    fn refund(&mut self, now: u64, rule: &Rule) {
        self.refill(now, rule);
        self.spent = (self.spent - 1.0).max(0.0);
    }
}

/// A fixed table of buckets that keys hash into.
struct Buckets {
    rule: Rule,
    slots: Vec<Bucket>,
}

impl Buckets {
    fn new(rule: Rule) -> Self {
        Self {
            rule,
            slots: Vec::new(),
        }
    }

    /// Allocated on first use, so a host nobody guesses at pays nothing.
    fn slot(&mut self, index: usize) -> &mut Bucket {
        if self.slots.is_empty() {
            self.slots = vec![Bucket::default(); HASHED_BUCKETS];
        }
        &mut self.slots[index % HASHED_BUCKETS]
    }

    fn banned(&self, now: u64) -> usize {
        self.slots
            .iter()
            .filter(|bucket| bucket.ban_remaining(now).is_some())
            .count()
    }

    fn empty(&self, now: u64) -> usize {
        self.slots
            .iter()
            .filter(|bucket| self.rule.capacity - bucket.spent_at(now, &self.rule) < 1.0 - EPSILON)
            .count()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Neighbourhood {
    V4Narrow,
    V6Narrow,
    V6Wide,
}

impl Neighbourhood {
    fn of(key: &AddressKey) -> Self {
        match (key.network().is_ipv4(), key.prefix()) {
            (true, _) => Self::V4Narrow,
            (false, prefix) if prefix > 48 => Self::V6Narrow,
            (false, _) => Self::V6Wide,
        }
    }
}

#[derive(Clone, Copy)]
enum Place {
    Recent(u64),
    Banned(u64),
}

struct Repeat {
    digest: u64,
    until: u64,
}

struct ClientEntry {
    bucket: Bucket,
    in_flight: u8,
    place: Place,
    repeats: Vec<Repeat>,
}

impl ClientEntry {
    fn is_repeat(&self, digest: u64, now: u64) -> bool {
        self.repeats
            .iter()
            .any(|repeat| repeat.digest == digest && repeat.until > now)
    }

    fn remember(&mut self, digest: u64, now: u64) {
        self.repeats
            .retain(|repeat| repeat.until > now && repeat.digest != digest);
        if self.repeats.len() >= REPEATS_PER_ADDRESS {
            self.repeats.remove(0);
        }
        self.repeats.push(Repeat {
            digest,
            until: now + REPEAT_WINDOW.as_millis() as u64,
        });
    }

    fn forget(&mut self, digest: u64) {
        self.repeats.retain(|repeat| repeat.digest != digest);
    }
}

/// Clients one by one, bounded: the least recently seen that isn't banned
/// or being checked is forgotten first.
struct Clients {
    entries: HashMap<AddressKey, ClientEntry>,
    recent: BTreeMap<u64, AddressKey>,
    banned: BTreeSet<(u64, AddressKey)>,
    sequence: u64,
    capacity: usize,
}

/// How many recently seen clients with sign-ins in flight eviction steps
/// over before giving up.
const EVICTION_TRIES: usize = 8;

impl Clients {
    fn new(capacity: usize) -> Self {
        Self {
            entries: HashMap::new(),
            recent: BTreeMap::new(),
            banned: BTreeSet::new(),
            sequence: 0,
            capacity,
        }
    }

    fn next(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    /// Marks `key` as just seen, making room for it when it's new. `false`
    /// when every tracked client is banned, so `key` isn't tracked.
    fn touch(&mut self, key: AddressKey, now: u64) -> bool {
        let Some(place) = self.entries.get(&key).map(|entry| entry.place) else {
            if self.entries.len() >= self.capacity && !self.make_room(now) {
                return false;
            }
            let sequence = self.next();
            self.recent.insert(sequence, key);
            self.entries.insert(
                key,
                ClientEntry {
                    bucket: Bucket::default(),
                    in_flight: 0,
                    place: Place::Recent(sequence),
                    repeats: Vec::new(),
                },
            );
            return true;
        };
        let sequence = match place {
            Place::Recent(old) => {
                self.recent.remove(&old);
                self.next()
            }
            Place::Banned(until) if until <= now => {
                self.banned.remove(&(until, key));
                self.next()
            }
            Place::Banned(_) => return true,
        };
        self.recent.insert(sequence, key);
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.place = Place::Recent(sequence);
        }
        true
    }

    fn make_room(&mut self, now: u64) -> bool {
        if let Some(&(until, key)) = self.banned.first() {
            if until <= now {
                self.banned.pop_first();
                self.entries.remove(&key);
                return true;
            }
        }
        for _ in 0..EVICTION_TRIES {
            let Some((_, key)) = self.recent.pop_first() else {
                return false;
            };
            if self
                .entries
                .get(&key)
                .is_some_and(|entry| entry.in_flight > 0)
            {
                let sequence = self.next();
                self.recent.insert(sequence, key);
                if let Some(entry) = self.entries.get_mut(&key) {
                    entry.place = Place::Recent(sequence);
                }
                continue;
            }
            self.entries.remove(&key);
            return true;
        }
        false
    }

    fn get(&mut self, key: &AddressKey) -> Option<&mut ClientEntry> {
        self.entries.get_mut(key)
    }

    /// Bans `key` and keeps it from being forgotten while banned.
    fn ban(&mut self, key: AddressKey, now: u64) -> u64 {
        let Some(entry) = self.entries.get_mut(&key) else {
            return 0;
        };
        let length = entry.bucket.ban(now, &ADDRESS_RULE);
        let until = entry.bucket.banned_until;
        match entry.place {
            Place::Recent(sequence) => {
                self.recent.remove(&sequence);
            }
            Place::Banned(old) => {
                self.banned.remove(&(old, key));
            }
        }
        entry.place = Place::Banned(until);
        self.banned.insert((until, key));
        length
    }

    fn banned(&self, now: u64) -> usize {
        self.banned.iter().filter(|(until, _)| *until > now).count()
    }
}

/// OPDS readers that signed in: per username key, the most recent client
/// keys and when each last succeeded. Only successes add to it, so it holds
/// real readers.
#[derive(Default)]
struct KnownPairs {
    by_username: HashMap<u64, VecDeque<(AddressKey, u64)>>,
}

impl KnownPairs {
    fn contains(&self, username: u64, client: AddressKey, now: u64) -> bool {
        let lifetime = KNOWN_PAIR_LIFETIME.as_millis() as u64;
        self.by_username.get(&username).is_some_and(|pairs| {
            pairs
                .iter()
                .any(|(key, at)| *key == client && at + lifetime > now)
        })
    }

    fn record(&mut self, username: u64, client: AddressKey, now: u64) {
        let lifetime = KNOWN_PAIR_LIFETIME.as_millis() as u64;
        let pairs = self.by_username.entry(username).or_default();
        pairs.retain(|(key, at)| *key != client && at + lifetime > now);
        pairs.push_front((client, now));
        pairs.truncate(KNOWN_PAIRS_PER_USERNAME);
    }
}

struct State {
    clients: Clients,
    v4_narrow: Buckets,
    v6_narrow: Buckets,
    v6_wide: Buckets,
    usernames: Buckets,
    known: Buckets,
    pairs: KnownPairs,
}

impl State {
    fn neighbourhood(&mut self, level: Neighbourhood) -> &mut Buckets {
        match level {
            Neighbourhood::V4Narrow => &mut self.v4_narrow,
            Neighbourhood::V6Narrow => &mut self.v6_narrow,
            Neighbourhood::V6Wide => &mut self.v6_wide,
        }
    }
}

struct Inner {
    state: Mutex<State>,
    clock: Arc<dyn Clock>,
    epoch: Instant,
    keys: (u64, u64),
}

impl Inner {
    fn now(&self) -> u64 {
        self.clock
            .now()
            .saturating_duration_since(self.epoch)
            .as_millis() as u64
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// SipHash-2-4 under this process's random key, over length-prefixed
    /// parts.
    fn keyed(&self, parts: &[&[u8]]) -> u64 {
        let mut hasher = SipHasher24::new_with_keys(self.keys.0, self.keys.1);
        for part in parts {
            hasher.write_u64(part.len() as u64);
            hasher.write(part);
        }
        hasher.finish()
    }

    fn address_index(&self, key: &AddressKey) -> usize {
        self.keyed(&[b"neighbourhood", &address_bytes(key)]) as usize % HASHED_BUCKETS
    }
}

fn address_bytes(key: &AddressKey) -> Vec<u8> {
    let mut bytes = match key.network() {
        std::net::IpAddr::V4(address) => address.octets().to_vec(),
        std::net::IpAddr::V6(address) => address.octets().to_vec(),
    };
    bytes.push(key.prefix());
    bytes
}

/// One guard per process, shared by every way of signing in. Clones share
/// it.
#[derive(Clone)]
pub struct SignInGuard {
    inner: Arc<Inner>,
}

impl Default for SignInGuard {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
struct Debits {
    address: Option<AddressKey>,
    neighbourhoods: Vec<(Neighbourhood, usize)>,
    username: Option<usize>,
    known: Option<usize>,
    in_flight: Option<AddressKey>,
}

impl SignInGuard {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemClock))
    }

    pub fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self::with_capacity(clock, TRACKED_ADDRESSES)
    }

    fn with_capacity(clock: Arc<dyn Clock>, capacity: usize) -> Self {
        let epoch = clock.now();
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    clients: Clients::new(capacity),
                    v4_narrow: Buckets::new(NARROW_RULE),
                    v6_narrow: Buckets::new(NARROW_RULE),
                    v6_wide: Buckets::new(WIDE_RULE),
                    usernames: Buckets::new(USERNAME_RULE),
                    known: Buckets::new(KNOWN_DEVICE_RULE),
                    pairs: KnownPairs::default(),
                }),
                clock,
                // Never zero, so a fresh bucket's time is always in the past.
                epoch: epoch.checked_sub(Duration::from_millis(1)).unwrap_or(epoch),
                keys: (OsRng.next_u64(), OsRng.next_u64()),
            }),
        }
    }

    /// Decides whether `client` may have `credential` checked now. On `Ok`
    /// every tier has been debited; check the credential, then settle the
    /// ticket.
    pub fn reserve(
        &self,
        client: &ClientAddress,
        credential: Credential<'_>,
    ) -> Result<Ticket, Refusal> {
        let inner = &self.inner;
        let now = inner.now();
        let username = credential
            .username()
            .map(normalise)
            .filter(|username| !username.is_empty());
        let username_key = username
            .as_deref()
            .map(|username| inner.keyed(&[b"username", username.as_bytes()]));
        let (tag, secret) = credential.secret();
        let digest = {
            let hash = Sha256::new()
                .chain_update(tag)
                .chain_update(username_key.unwrap_or_default().to_le_bytes())
                .chain_update(secret)
                .finalize();
            u64::from_le_bytes(hash[..8].try_into().expect("SHA-256 has 8 bytes"))
        };
        let strict = !client.is_soft();
        let password = matches!(credential, Credential::Password { .. });
        let key = client.key();
        let neighbourhoods: Vec<(Neighbourhood, usize)> = if strict {
            client
                .aggregate_keys()
                .iter()
                .map(|aggregate| (Neighbourhood::of(aggregate), inner.address_index(aggregate)))
                .collect()
        } else {
            Vec::new()
        };
        let identity = |device: &[u8]| {
            username_key.map(|username| {
                inner.keyed(&[b"known-device", &username.to_le_bytes(), device]) as usize
            })
        };
        let cookie_identity = match credential {
            Credential::Password {
                device: Some(device),
                ..
            } => identity(&device.0),
            _ => None,
        };
        let pair_identity = matches!(credential, Credential::DeviceKey { .. })
            .then(|| identity(&address_bytes(&key)))
            .flatten();

        let mut guard = inner.lock();
        let state = &mut *guard;
        let tracked = state.clients.touch(key, now);
        if strict {
            if let Some(entry) = state.clients.get(&key) {
                if let Some(remaining) = entry.bucket.ban_remaining(now) {
                    return Err(Refusal::after(Slowdown::Address, remaining));
                }
                if password && entry.in_flight >= SIGN_INS_IN_FLIGHT {
                    return Err(Refusal::after(Slowdown::InFlight, 1000));
                }
            }
            for (level, index) in &neighbourhoods {
                if let Some(remaining) = state.neighbourhood(*level).slot(*index).ban_remaining(now)
                {
                    return Err(Refusal::after(Slowdown::Neighbourhood, remaining));
                }
            }
        }

        let repeat = state
            .clients
            .get(&key)
            .is_some_and(|entry| entry.is_repeat(digest, now));
        if repeat {
            return Err(Refusal::after(Slowdown::Repeat, 0));
        }
        let mut debits = Debits::default();
        let mut known = false;
        if strict {
            let spent = state
                .clients
                .get(&key)
                .is_some_and(|entry| !entry.bucket.has_token(now, &ADDRESS_RULE));
            if spent {
                let length = state.clients.ban(key, now);
                return Err(Refusal::after(Slowdown::Address, length));
            }
            for (level, index) in &neighbourhoods {
                let buckets = state.neighbourhood(*level);
                let rule = buckets.rule;
                let bucket = buckets.slot(*index);
                if !bucket.has_token(now, &rule) {
                    let length = bucket.ban(now, &rule);
                    return Err(Refusal::after(Slowdown::Neighbourhood, length));
                }
            }
        }
        if let Some(username_key) = username_key {
            let device = match cookie_identity {
                Some(identity) => Some(identity),
                None => pair_identity.filter(|_| state.pairs.contains(username_key, key, now)),
            };
            if let Some(index) = device {
                let bucket = state.known.slot(index);
                if bucket.ban_remaining(now).is_none() {
                    if bucket.has_token(now, &KNOWN_DEVICE_RULE) {
                        debits.known = Some(index);
                        known = true;
                    } else {
                        bucket.ban(now, &KNOWN_DEVICE_RULE);
                    }
                }
            }
            if !known {
                let index = username_key as usize % HASHED_BUCKETS;
                let bucket = state.usernames.slot(index);
                if !bucket.has_token(now, &USERNAME_RULE) {
                    let wait = bucket.wait_for_token(&USERNAME_RULE);
                    return Err(Refusal::after(Slowdown::Username, wait));
                }
                debits.username = Some(index);
            }
        }
        if let Some(index) = debits.known {
            state.known.slot(index).debit();
        }
        if let Some(index) = debits.username {
            state.usernames.slot(index).debit();
        }
        if strict {
            if let Some(entry) = state.clients.get(&key) {
                entry.bucket.debit();
                debits.address = Some(key);
            }
            for (level, index) in &neighbourhoods {
                state.neighbourhood(*level).slot(*index).debit();
            }
            debits.neighbourhoods = neighbourhoods;
        }
        if strict && password && tracked {
            if let Some(entry) = state.clients.get(&key) {
                entry.in_flight += 1;
                debits.in_flight = Some(key);
            }
        }
        drop(guard);
        Ok(Ticket {
            inner: inner.clone(),
            debits,
            client: key,
            digest,
            pair: pair_identity.and(username_key),
            known,
            settled: false,
        })
    }

    /// Failures charged to `client` right now; for tests.
    #[cfg(test)]
    pub(crate) fn charged(&self, client: &ClientAddress) -> f64 {
        let now = self.inner.now();
        self.inner
            .lock()
            .clients
            .entries
            .get(&client.key())
            .map_or(0.0, |entry| entry.bucket.spent_at(now, &ADDRESS_RULE))
    }

    /// Counts for administrators.
    pub fn summary(&self) -> GuardSummary {
        let now = self.inner.now();
        let state = self.inner.lock();
        GuardSummary {
            banned_addresses: state.clients.banned(now),
            banned_neighbourhoods: state.v4_narrow.banned(now)
                + state.v6_narrow.banned(now)
                + state.v6_wide.banned(now),
            slowed_usernames: state.usernames.empty(now),
        }
    }
}

/// A reserved guess. Settle it once the credential has been checked;
/// dropping it unsettled counts as a failure.
pub struct Ticket {
    inner: Arc<Inner>,
    debits: Debits,
    client: AddressKey,
    digest: u64,
    /// The username key an OPDS success records a known reader under.
    pair: Option<u64>,
    known: bool,
    settled: bool,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Finish {
    Success,
    Failure,
    Dropped,
    Refund,
}

impl Ticket {
    /// Whether the guess came from a known device, which skips the
    /// username tier and goes first for verification.
    pub fn known_device(&self) -> bool {
        self.known
    }

    pub fn settle(mut self, outcome: Outcome) {
        self.finish(match outcome {
            Outcome::Success => Finish::Success,
            Outcome::Failure => Finish::Failure,
        });
    }

    /// Gives every debit back without judging the guess, when the server
    /// couldn't check it.
    pub fn refund(mut self) {
        self.finish(Finish::Refund);
    }

    fn finish(&mut self, finish: Finish) {
        self.settled = true;
        let now = self.inner.now();
        let mut guard = self.inner.lock();
        let state = &mut *guard;
        if let Some(key) = self.debits.in_flight {
            if let Some(entry) = state.clients.get(&key) {
                entry.in_flight = entry.in_flight.saturating_sub(1);
            }
        }
        if matches!(finish, Finish::Success | Finish::Refund) {
            if let Some(key) = self.debits.address {
                if let Some(entry) = state.clients.get(&key) {
                    entry.bucket.refund(now, &ADDRESS_RULE);
                }
            }
            for (level, index) in &self.debits.neighbourhoods {
                let buckets = state.neighbourhood(*level);
                let rule = buckets.rule;
                buckets.slot(*index).refund(now, &rule);
            }
            if let Some(index) = self.debits.username {
                state.usernames.slot(index).refund(now, &USERNAME_RULE);
            }
            if let Some(index) = self.debits.known {
                state.known.slot(index).refund(now, &KNOWN_DEVICE_RULE);
            }
        }
        match finish {
            Finish::Success => {
                if let Some(entry) = state.clients.get(&self.client) {
                    entry.forget(self.digest);
                }
                if let Some(username) = self.pair {
                    state.pairs.record(username, self.client, now);
                }
            }
            Finish::Failure => {
                if let Some(entry) = state.clients.get(&self.client) {
                    entry.remember(self.digest, now);
                }
            }
            Finish::Dropped | Finish::Refund => {}
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.settled {
            self.finish(Finish::Dropped);
        }
    }
}

/// Identifies one browser that signed in, from its known-device cookie.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeviceId([u8; 16]);

/// Known-device cookies (OWASP's "device cookies"): a random device ID and
/// an expiry, signed with HMAC-SHA-256 over them and the normalised
/// username, so a cookie only vouches for the name it was issued to.
pub struct DeviceCookies {
    secret: [u8; 32],
}

impl DeviceCookies {
    pub fn new(secret: [u8; 32]) -> Self {
        Self { secret }
    }

    fn mac(&self, device: &[u8; 16], expires: i64, username: &str) -> [u8; 32] {
        let mut message = b"citadel-known-device\0".to_vec();
        message.extend_from_slice(device);
        message.extend_from_slice(&expires.to_le_bytes());
        message.extend_from_slice(normalise(username).as_bytes());
        hmac_sha256(&self.secret, &message)
    }

    /// A cookie value for `username`, valid for [`DEVICE_COOKIE_LIFETIME`]
    /// from `now` (Unix seconds).
    pub fn issue(&self, username: &str, now: i64) -> String {
        let mut device = [0u8; 16];
        OsRng.fill_bytes(&mut device);
        let expires = now + DEVICE_COOKIE_LIFETIME.as_secs() as i64;
        format!(
            "{}.{expires}.{}",
            URL_SAFE_NO_PAD.encode(device),
            URL_SAFE_NO_PAD.encode(self.mac(&device, expires, username))
        )
    }

    /// The device `value` names, when it was issued for `username` and
    /// hasn't expired.
    pub fn recognise(&self, value: &str, username: &str, now: i64) -> Option<DeviceId> {
        let mut parts = value.split('.');
        let (Some(device), Some(expires), Some(mac), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        let device: [u8; 16] = URL_SAFE_NO_PAD.decode(device).ok()?.try_into().ok()?;
        let expires: i64 = expires.parse().ok()?;
        let mac = URL_SAFE_NO_PAD.decode(mac).ok()?;
        let genuine: bool = self.mac(&device, expires, username).ct_eq(&mac).into();
        (genuine && expires > now).then_some(DeviceId(device))
    }
}

/// HMAC-SHA-256 (RFC 2104) with a key of at most one block.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    block[..key.len()].copy_from_slice(key);
    let pad = |byte: u8| block.map(|key_byte| key_byte ^ byte);
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, SocketAddr};

    use axum::http::HeaderMap;

    use super::*;
    use crate::client::ClientResolver;

    const WRONG: &[u8] = b"wrong";

    fn new_guard() -> (Arc<ManualClock>, SignInGuard) {
        let clock = ManualClock::new();
        (clock.clone(), SignInGuard::with_clock(clock))
    }

    fn at(address: &str) -> ClientAddress {
        ClientAddress::direct(SocketAddr::new(address.parse().unwrap(), 50_000))
    }

    /// An untrusted private peer sending forwarding headers: soft.
    fn soft(address: &str) -> ClientAddress {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.1".parse().unwrap());
        let client = ClientResolver::loopback_only().resolve(
            Some(SocketAddr::new(address.parse().unwrap(), 50_000)),
            &headers,
        );
        assert!(client.is_soft());
        client
    }

    fn password<'a>(username: &'a str, secret: &'a [u8]) -> Credential<'a> {
        Credential::Password {
            username,
            password: secret,
            device: None,
        }
    }

    fn key<'a>(username: &'a str, secret: &'a [u8]) -> Credential<'a> {
        Credential::DeviceKey {
            username: Some(username),
            key: secret,
        }
    }

    /// A distinct secret for each attempt, so none is a repeat.
    fn nth(attempt: usize) -> Vec<u8> {
        format!("guess-{attempt}").into_bytes()
    }

    /// A distinct username for each attempt, so the username tier stays out
    /// of the way.
    fn name(attempt: usize) -> String {
        format!("user{attempt}")
    }

    fn fail(guard: &SignInGuard, client: &ClientAddress, credential: Credential<'_>) -> bool {
        match guard.reserve(client, credential) {
            Ok(ticket) => {
                ticket.settle(Outcome::Failure);
                true
            }
            Err(_) => false,
        }
    }

    /// Whether `credential` was answered as an earlier failure, without a
    /// ticket, so it is neither checked nor counted.
    fn repeated(guard: &SignInGuard, client: &ClientAddress, credential: Credential<'_>) -> bool {
        guard
            .reserve(client, credential)
            .err()
            .is_some_and(|refusal| refusal.is_repeat() && refusal.retry_after.is_zero())
    }

    /// A wrong password from `client` under a fresh username.
    fn guess(guard: &SignInGuard, client: &ClientAddress, attempt: usize) -> bool {
        fail(guard, client, password(&name(attempt), WRONG))
    }

    /// Distinct client addresses, each in its own `/24`.
    fn spread(index: usize) -> ClientAddress {
        at(&format!("10.{}.{}.1", index / 256, index % 256))
    }

    fn spent(guard: &SignInGuard, client: &ClientAddress) -> f64 {
        let now = guard.inner.now();
        guard.inner.lock().clients.entries[&client.key()]
            .bucket
            .spent_at(now, &ADDRESS_RULE)
    }

    #[test]
    fn an_address_is_banned_after_its_allowance_and_bans_double_up_to_a_day() {
        let (clock, guard) = new_guard();
        let client = at("203.0.113.7");
        for attempt in 0..100 {
            assert!(guess(&guard, &client, attempt), "{attempt}");
        }
        let refused = guard
            .reserve(&client, password("next", WRONG))
            .err()
            .unwrap();
        assert_eq!(refused.reason, Slowdown::Address);
        assert_eq!(refused.retry_after, FIRST_BAN);
        assert_eq!(refused.retry_after_seconds(), 3600);
        clock.advance(Duration::from_secs(1800));
        let refused = guard
            .reserve(&client, password("next", WRONG))
            .err()
            .unwrap();
        assert_eq!(refused.retry_after_seconds(), 1800, "the real wait");
        clock.advance(Duration::from_secs(1800));

        let mut seen = Vec::new();
        let mut expected = Vec::new();
        for ban in 1..8u32 {
            let mut attempts = 0;
            let length = loop {
                attempts += 1;
                match guard.reserve(&client, password(&name(attempts), &nth(ban as usize))) {
                    Ok(ticket) => ticket.settle(Outcome::Failure),
                    Err(refusal) => break refusal.retry_after,
                }
            };
            assert_eq!(attempts, 101, "the bucket refilled during the ban");
            seen.push(length);
            expected.push((FIRST_BAN * 2u32.pow(ban)).min(LONGEST_BAN));
            clock.advance(length);
        }
        assert_eq!(seen, expected);
        assert_eq!(*seen.last().unwrap(), LONGEST_BAN);
    }

    #[test]
    fn cycling_usernames_from_one_address_is_banned_at_its_allowance() {
        let (_clock, guard) = new_guard();
        let client = at("203.0.113.7");
        let admitted = (0..10_000)
            .filter(|attempt| guess(&guard, &client, *attempt))
            .count();
        assert_eq!(admitted, ADDRESS_FAILURES_PER_HOUR as usize);
    }

    #[test]
    fn one_username_from_a_thousand_addresses_gets_a_guess_every_thirty_seconds() {
        let (clock, guard) = new_guard();
        let mut admitted = 0;
        let mut attempt = 0;
        for index in 0..1000 {
            attempt += 1;
            admitted += usize::from(fail(&guard, &spread(index), key("phil", &nth(attempt))));
        }
        assert_eq!(admitted, USERNAME_BURST as usize, "the burst, then nothing");
        let refused = guard
            .reserve(&spread(1001), key("phil", b"another"))
            .err()
            .unwrap();
        assert_eq!(refused.reason, Slowdown::Username);
        assert_eq!(refused.retry_after, USERNAME_REFILL);
        clock.advance(Duration::from_secs(29));
        let refused = guard
            .reserve(&spread(1002), key("phil", b"another"))
            .err()
            .unwrap();
        assert_eq!(
            refused.retry_after_seconds(),
            1,
            "seconds to the next token"
        );

        // A day of the addresses trying once a second each in turn.
        for second in 0..24 * 60 * 60 {
            clock.advance(Duration::from_secs(1));
            attempt += 1;
            admitted += usize::from(fail(
                &guard,
                &spread(second % 1000),
                key("phil", &nth(attempt)),
            ));
        }
        assert!(admitted <= 10 + 2_880, "{admitted}");
        assert!(admitted >= 2_880, "{admitted}");
    }

    #[test]
    fn success_refunds_without_resetting_and_a_dropped_ticket_counts() {
        let (_clock, guard) = new_guard();
        let client = at("203.0.113.7");
        for attempt in 0..99 {
            assert!(guess(&guard, &client, attempt));
        }
        for _ in 0..5 {
            guard
                .reserve(&client, key("reader", b"right"))
                .unwrap()
                .settle(Outcome::Success);
        }
        assert!(
            guess(&guard, &client, 1000),
            "successes gave their own debits back"
        );
        assert!(
            !guess(&guard, &client, 1001),
            "but didn't forgive the earlier failures"
        );

        let (_clock, guard) = new_guard();
        let client = at("203.0.113.8");
        for attempt in 0..100 {
            drop(
                guard
                    .reserve(&client, password(&name(attempt), b"never checked"))
                    .unwrap(),
            );
        }
        assert_eq!(
            guard
                .reserve(&client, password("phil", b"x"))
                .err()
                .unwrap()
                .reason,
            Slowdown::Address,
            "a dropped ticket counts as a failure"
        );
    }

    #[test]
    fn refunded_tickets_cost_nothing() {
        let (_clock, guard) = new_guard();
        let client = at("203.0.113.7");
        for _ in 0..1000 {
            guard
                .reserve(&client, password("phil", b"busy"))
                .unwrap()
                .refund();
        }
        assert_eq!(spent(&guard, &client), 0.0);
        assert!(fail(&guard, &client, password("phil", b"still fine")));
    }

    #[test]
    fn known_devices_skip_the_username_tier_within_their_own_budget() {
        let (clock, guard) = new_guard();
        let cookies = DeviceCookies::new([7; 32]);
        let now = 1_700_000_000;
        let cookie = cookies.issue("Phil", now);
        let device = cookies.recognise(&cookie, " phil ", now);
        assert!(device.is_some(), "the cookie vouches for the same name");
        let reader = at("192.0.2.50");
        let reader_signs_in = || {
            guard
                .reserve(&reader, key("phil", b"device key"))
                .map(|ticket| {
                    let known = ticket.known_device();
                    ticket.settle(Outcome::Success);
                    known
                })
        };
        assert_eq!(reader_signs_in(), Ok(false));
        let hammer = |from: usize| {
            for index in from..from + 20 {
                fail(&guard, &spread(index), password("phil", &nth(index)));
            }
        };
        // Someone else spends the username's allowance.
        hammer(0);
        let refused = guard.reserve(&spread(99), password("phil", b"right"));
        assert_eq!(refused.err().unwrap().reason, Slowdown::Username);

        let browser = at("198.51.100.20");
        let with_cookie = |secret: Vec<u8>| {
            let secret: &'static [u8] = secret.leak();
            Credential::Password {
                username: "phil",
                password: secret,
                device,
            }
        };
        let ticket = guard
            .reserve(&browser, with_cookie(b"right".to_vec()))
            .unwrap();
        assert!(ticket.known_device());
        ticket.settle(Outcome::Success);
        assert_eq!(reader_signs_in(), Ok(true), "the reader's address is known");
        assert!(
            guard
                .reserve(&at("192.0.2.51"), key("phil", b"device key"))
                .is_err(),
            "a pair counts only for its own address"
        );

        // A known device has 20 failures before its exemption is suspended.
        for attempt in 0..KNOWN_DEVICE_FAILURES_PER_HOUR as usize {
            assert!(fail(&guard, &browser, with_cookie(nth(attempt))));
        }
        assert_eq!(
            guard
                .reserve(&browser, with_cookie(b"right".to_vec()))
                .err()
                .unwrap()
                .reason,
            Slowdown::Username,
            "suspended: the username tier applies again"
        );
        clock.advance(KNOWN_DEVICE_SUSPENSION);
        let ticket = guard
            .reserve(&browser, with_cookie(b"right".to_vec()))
            .unwrap();
        assert!(ticket.known_device());
        ticket.settle(Outcome::Success);

        // A cookie for someone else, a forged one or an expired one vouches
        // for nothing.
        let other = cookies.issue("someone-else", now);
        assert!(cookies.recognise(&other, "phil", now).is_none());
        assert!(DeviceCookies::new([8; 32])
            .recognise(&cookie, "phil", now)
            .is_none());
        let (id, rest) = cookie.split_once('.').unwrap();
        let (_, mac) = rest.split_once('.').unwrap();
        let later = format!("{id}.{}.{mac}", now + 400 * 24 * 60 * 60);
        assert!(
            cookies.recognise(&later, "phil", now).is_none(),
            "the expiry is signed"
        );
        let lifetime = DEVICE_COOKIE_LIFETIME.as_secs() as i64;
        assert!(cookies
            .recognise(&cookie, "phil", now + lifetime - 1)
            .is_some());
        assert!(cookies.recognise(&cookie, "phil", now + lifetime).is_none());
        assert!(cookies.recognise("not.a.cookie", "phil", now).is_none());
        let forged = Credential::Password {
            username: "phil",
            password: b"right",
            device: cookies.recognise(&later, "phil", now),
        };
        hammer(200);
        assert!(guard.reserve(&browser, forged).is_err());

        // A reader's address stays known for 30 days after its last success.
        assert_eq!(reader_signs_in(), Ok(true));
        clock.advance(KNOWN_PAIR_LIFETIME - Duration::from_secs(1));
        hammer(300);
        assert_eq!(reader_signs_in(), Ok(true));
        clock.advance(KNOWN_PAIR_LIFETIME);
        hammer(400);
        assert_eq!(
            reader_signs_in().err().unwrap().reason,
            Slowdown::Username,
            "the pair expired"
        );
    }

    #[test]
    fn a_reader_pair_keeps_the_eight_most_recent_addresses() {
        let (_clock, guard) = new_guard();
        for index in 0..9 {
            guard
                .reserve(&spread(index), key("phil", b"device key"))
                .unwrap()
                .settle(Outcome::Success);
        }
        for index in 0..20 {
            fail(&guard, &spread(100 + index), key("phil", &nth(index)));
        }
        assert!(guard
            .reserve(&spread(0), key("phil", b"device key"))
            .is_err());
        assert!(guard
            .reserve(&spread(1), key("phil", b"device key"))
            .unwrap()
            .known_device());
    }

    #[test]
    fn a_banned_address_never_locks_anyone_else_out() {
        let (_clock, guard) = new_guard();
        let attacker = at("203.0.113.7");
        for attempt in 0..200 {
            guess(&guard, &attacker, attempt);
        }
        assert!(guard.reserve(&attacker, password("phil", b"x")).is_err());
        assert!(guard
            .reserve(&at("198.51.100.1"), password("phil", b"x"))
            .is_ok());
        assert!(guard
            .reserve(&at("203.0.113.8"), password("phil", b"x"))
            .is_ok());
        assert_eq!(guard.summary().banned_addresses, 1);
    }

    #[test]
    fn real_and_unknown_usernames_get_identical_decisions() {
        let decisions = |username: &str| {
            let (clock, guard) = new_guard();
            let mut decisions = Vec::new();
            for attempt in 0..300 {
                if attempt % 7 == 0 {
                    clock.advance(Duration::from_secs(11));
                }
                decisions.push(
                    guard
                        .reserve(&spread(attempt % 13), password(username, &nth(attempt)))
                        .map(|ticket| ticket.settle(Outcome::Failure))
                        .map_err(|refusal| (refusal.reason, refusal.retry_after)),
                );
            }
            decisions
        };
        // The guard is never told which names exist.
        assert_eq!(decisions("phil"), decisions("nobody-by-this-name"));
    }

    #[test]
    fn neighbourhoods_ban_when_their_clients_add_up() {
        let (_clock, guard) = new_guard();
        let mut attempt = 0;
        let mut admitted = 0;
        let mut refused = 0;
        for host in 0..300usize {
            // Each /64 in its own /56 (at most two per /56), all in one /48.
            let group = ((host % 256) << 8) | (host / 256);
            let client = at(&format!("2001:db8:7:{group:x}::1"));
            assert_eq!(client.key().prefix(), 64);
            for _ in 0..4 {
                attempt += 1;
                match guard.reserve(&client, password(&name(attempt), WRONG)) {
                    Ok(ticket) => {
                        ticket.settle(Outcome::Failure);
                        admitted += 1;
                    }
                    Err(refusal) => {
                        assert_eq!(refusal.reason, Slowdown::Neighbourhood);
                        refused += 1;
                    }
                }
            }
        }
        assert_eq!(admitted, WIDE_NEIGHBOURHOOD_FAILURES_PER_HOUR as usize);
        assert_eq!(refused, 200, "300 /64s in one /48 hit its ban");
        assert!(guard
            .reserve(&at("2001:db8:8::1"), password("u", WRONG))
            .is_ok());

        let (_clock, guard) = new_guard();
        let mut admitted = 0;
        for host in 0..=255 {
            let client = at(&format!("198.51.100.{host}"));
            for round in 0..2 {
                admitted += usize::from(guess(&guard, &client, host * 2 + round));
            }
        }
        assert_eq!(
            admitted, NARROW_NEIGHBOURHOOD_FAILURES_PER_HOUR as usize,
            "every client in one /24 shares its 400"
        );
        assert_eq!(
            guard
                .reserve(&at("198.51.100.77"), password("u", b"new"))
                .err()
                .unwrap()
                .reason,
            Slowdown::Neighbourhood
        );
        assert!(guard
            .reserve(&at("198.51.101.77"), password("u", b"new"))
            .is_ok());
        assert_eq!(guard.summary().banned_neighbourhoods, 1);
    }

    #[test]
    fn forgetting_addresses_never_resets_a_neighbourhood_or_drops_a_ban() {
        let (_clock, guard) = new_guard();
        let banned = at("192.0.2.9");
        for attempt in 0..101 {
            guess(&guard, &banned, attempt);
        }
        let mut attempt = 1000;
        for host in 1..=50 {
            for _ in 0..7 {
                attempt += 1;
                assert!(guess(&guard, &at(&format!("198.51.100.{host}")), attempt));
            }
        }
        // 200,000 fresh addresses push everything else out of the table.
        for index in 0..200_000u128 {
            let address = IpAddr::from(std::net::Ipv6Addr::from(
                0x2001_0db8_0000_0000_0000_0000_0000_0001u128 + (index << 64),
            ));
            fail(
                &guard,
                &ClientAddress::direct(SocketAddr::new(address, 1)),
                password("flood", &(index as usize).to_le_bytes()),
            );
        }
        {
            let state = guard.inner.lock();
            assert_eq!(state.clients.entries.len(), TRACKED_ADDRESSES);
            assert!(!state
                .clients
                .entries
                .contains_key(&at("198.51.100.1").key()));
        }
        assert_eq!(
            guard
                .reserve(&banned, password("phil", b"after"))
                .err()
                .unwrap()
                .reason,
            Slowdown::Address,
            "the ban survived"
        );
        let mut admitted = 0;
        for host in 51..=100 {
            for _ in 0..2 {
                attempt += 1;
                admitted += usize::from(guess(&guard, &at(&format!("198.51.100.{host}")), attempt));
            }
        }
        assert_eq!(admitted, 400 - 350, "the /24 kept its 350 failures");
    }

    #[test]
    fn a_table_full_of_bans_judges_new_addresses_by_their_neighbourhoods() {
        let clock = ManualClock::new();
        let guard = SignInGuard::with_capacity(clock.clone(), 3);
        let mut attempt = 0;
        for host in 1..=3 {
            let client = at(&format!("192.0.2.{host}"));
            for _ in 0..101 {
                attempt += 1;
                guess(&guard, &client, attempt);
            }
        }
        assert_eq!(guard.summary().banned_addresses, 3);
        // Untracked: no address bucket, but its /24 still counts.
        let stranger = at("198.51.100.1");
        let admitted = (0..500)
            .filter(|offset| guess(&guard, &stranger, 10_000 + offset))
            .count();
        assert_eq!(admitted, NARROW_NEIGHBOURHOOD_FAILURES_PER_HOUR as usize);
        assert!(guard
            .reserve(&at("203.0.113.1"), password("x", WRONG))
            .is_ok());
        clock.advance(FIRST_BAN);
        assert!(guard
            .reserve(&at("203.0.113.2"), password("x", WRONG))
            .is_ok());
        let state = guard.inner.lock();
        assert_eq!(state.clients.entries.len(), 3);
        assert!(state.clients.entries.contains_key(&at("203.0.113.2").key()));
    }

    #[test]
    fn the_same_wrong_credential_counts_once_and_soft_mode_never_bans() {
        let (clock, guard) = new_guard();
        let reader = at("203.0.113.7");
        assert!(fail(&guard, &reader, key("reader", b"stale key")));
        for _ in 0..999 {
            assert!(repeated(&guard, &reader, key("reader", b"stale key")));
        }
        assert_eq!(spent(&guard, &reader), 1.0);
        clock.advance(REPEAT_WINDOW - Duration::from_millis(1));
        assert!(repeated(&guard, &reader, key("reader", b"stale key")));
        assert!(spent(&guard, &reader) < 0.9, "still a repeat: refilled");
        clock.advance(REPEAT_WINDOW);
        assert!(fail(&guard, &reader, key("reader", b"stale key")));
        assert!(
            spent(&guard, &reader) > 0.9,
            "forgotten after the window, so it counted again"
        );

        // The username tier counted the repeat once too.
        let (_clock, guard) = new_guard();
        assert!(fail(&guard, &reader, password("phil", b"same")));
        for _ in 0..99 {
            assert!(repeated(&guard, &reader, password("phil", b"same")));
        }
        for attempt in 0..9 {
            assert!(fail(
                &guard,
                &spread(attempt),
                password("phil", &nth(attempt))
            ));
        }
        assert!(guard
            .reserve(&spread(10), password("phil", b"tenth"))
            .is_err());

        let (_clock, guard) = new_guard();
        let proxy = soft("192.168.1.30");
        let admitted = (0..5_000)
            .filter(|attempt| guess(&guard, &proxy, *attempt))
            .count();
        assert_eq!(admitted, 5_000, "soft mode: no address tier at all");
        assert_eq!(guard.summary(), GuardSummary::default());
        // A fresh guard, so none of those 5,000 names shares phil's slot.
        let (_clock, guard) = new_guard();
        let slowed = (0..20)
            .filter(|attempt| !fail(&guard, &proxy, password("phil", &nth(*attempt))))
            .count();
        assert_eq!(slowed, 10, "the username tier still applies");
        let in_flight: Vec<_> = (0..10)
            .map(|attempt| guard.reserve(&proxy, password(&name(attempt), WRONG)))
            .collect();
        assert!(in_flight.iter().all(Result::is_ok), "no in-flight cap");
    }

    #[test]
    fn cancel_and_resend_never_has_more_than_two_in_flight() {
        let (_clock, guard) = new_guard();
        let client = at("203.0.113.7");
        let first = guard.reserve(&client, password("phil", b"one")).unwrap();
        let second = guard.reserve(&client, password("phil", b"two")).unwrap();
        for attempt in 0..50 {
            let refused = guard
                .reserve(&client, password(&name(attempt), WRONG))
                .err()
                .unwrap();
            assert_eq!(refused.reason, Slowdown::InFlight);
            assert_eq!(refused.retry_after_seconds(), 1);
        }
        drop(
            guard
                .reserve(&client, key("phil", b"opds"))
                .expect("OPDS checks are cheap, so they aren't capped"),
        );
        // A job skipped because its requester left drops its ticket: the
        // slot frees only then, and the guess counts.
        drop(first);
        let third = guard.reserve(&client, password("phil", b"three")).unwrap();
        assert!(guard.reserve(&client, password("phil", b"four")).is_err());
        second.settle(Outcome::Failure);
        third.settle(Outcome::Failure);
        assert_eq!(spent(&guard, &client), 4.0, "every checked guess counted");
        assert_eq!(
            guard.inner.lock().clients.entries[&client.key()].in_flight,
            0
        );
    }

    #[test]
    fn usernames_fold_ascii_case_only_as_collate_nocase_does() {
        use diesel::{prelude::*, sql_query, sql_types::Text, sqlite::SqliteConnection};
        #[derive(QueryableByName)]
        struct Same {
            #[diesel(sql_type = diesel::sql_types::Bool)]
            same: bool,
        }
        let mut connection = SqliteConnection::establish(":memory:").unwrap();
        for (left, right) in [
            ("Phil", "phil"),
            (" PHIL ", "phil"),
            ("Ärger", "ärger"),
            ("ÄRGER", "Ärger"),
            ("straße", "STRASSE"),
            ("İstanbul", "istanbul"),
            ("ǅ", "ǆ"),
            ("phil", "phil2"),
        ] {
            let Same { same } = sql_query("SELECT ? = ? COLLATE NOCASE AS same")
                .bind::<Text, _>(left.trim())
                .bind::<Text, _>(right.trim())
                .get_result(&mut connection)
                .unwrap();
            assert_eq!(normalise(left) == normalise(right), same, "{left} {right}");
            assert_eq!(
                left.trim().eq_ignore_ascii_case(right.trim()),
                same,
                "{left} {right}"
            );
        }
        let (_clock, guard) = new_guard();
        for attempt in 0..10 {
            fail(&guard, &spread(attempt), password(" PHIL", &nth(attempt)));
        }
        assert!(guard.reserve(&spread(20), password("phil", WRONG)).is_err());
        assert!(guard
            .reserve(&spread(21), password("Phil ", WRONG))
            .is_err());
        assert!(guard.reserve(&spread(22), password("Ärger", WRONG)).is_ok());
    }

    #[test]
    fn the_setup_code_only_has_the_address_tier() {
        let (_clock, guard) = new_guard();
        for index in 0..1000 {
            assert!(fail(
                &guard,
                &spread(index),
                Credential::SetupCode { code: &nth(index) }
            ));
        }
        let client = at("203.0.113.7");
        let admitted = (0..200)
            .filter(|attempt| {
                fail(
                    &guard,
                    &client,
                    Credential::SetupCode {
                        code: &nth(5000 + attempt),
                    },
                )
            })
            .count();
        assert_eq!(admitted, 100);
    }

    #[test]
    fn an_unreadable_opds_header_counts_against_the_address_only() {
        let (_clock, guard) = new_guard();
        let client = at("203.0.113.7");
        let admitted = (0..150)
            .filter(|attempt| {
                fail(
                    &guard,
                    &client,
                    Credential::DeviceKey {
                        username: (attempt % 2 == 1).then_some("  "),
                        key: &nth(*attempt),
                    },
                )
            })
            .count();
        assert_eq!(admitted, 100);
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        let mac = hmac_sha256(&[0x0b; 20], b"Hi There");
        let hex: String = mac.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }
}
