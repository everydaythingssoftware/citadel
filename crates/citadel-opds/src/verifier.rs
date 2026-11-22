//! The verifier pool (ADR 0017): the only place password hashes are checked.
//! Argon2id is deliberately slow and takes 19 MiB per check, so exactly
//! [`VERIFIER_THREADS`] dedicated threads run checks, whatever arrives; CPU
//! and memory stay bounded and the async runtime and blocking pool are never
//! tied up. Known devices go first. Everyone else waits in a fair queue that
//! takes turns between neighbourhoods (`/24` or `/48`), so one network can't
//! crowd the rest out.
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard, PoisonError,
    },
};

use tokio::sync::oneshot;

use crate::{
    client::{AddressKey, ClientAddress},
    guard::Ticket,
};

/// Threads checking passwords. Not a setting: two Argon2id checks at once
/// is what a small server can always afford.
pub const VERIFIER_THREADS: usize = 2;
/// Checks waiting from one neighbourhood…
pub const QUEUED_PER_NEIGHBOURHOOD: usize = 4;
/// …and from everyone, in the fair queue. With the known-device lane,
/// waiting sign-ins hold at most 24 of the API's 64 short slots.
pub const QUEUED_TOTAL: usize = 16;
/// Checks from known devices waiting in their own lane.
pub const QUEUED_KNOWN: usize = 8;

/// Which queue a check waits in.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Lane {
    /// A known device: goes before everyone else.
    Known,
    /// Takes turns with other neighbourhoods.
    Neighbourhood(AddressKey),
}

impl Lane {
    /// The lane for a check reserved with `ticket` by `client`.
    pub fn of(ticket: &Ticket, client: &ClientAddress) -> Self {
        if ticket.known_device() {
            Self::Known
        } else {
            Self::Neighbourhood(
                client
                    .aggregate_keys()
                    .last()
                    .copied()
                    .unwrap_or_else(|| client.key()),
            )
        }
    }
}

/// The queues are full; the ticket was refunded.
#[derive(Debug, Eq, PartialEq)]
pub struct PoolFull;

type Job = Box<dyn FnOnce(&Counters) + Send>;

#[derive(Default)]
struct Counters {
    checked: AtomicU64,
    skipped: AtomicU64,
}

#[derive(Default)]
struct Queue {
    known: VecDeque<Job>,
    neighbourhoods: HashMap<AddressKey, VecDeque<Job>>,
    turns: VecDeque<AddressKey>,
    waiting: usize,
    closed: bool,
}

impl Queue {
    fn next(&mut self) -> Option<Job> {
        if let Some(job) = self.known.pop_front() {
            return Some(job);
        }
        let neighbourhood = self.turns.pop_front()?;
        let jobs = self.neighbourhoods.get_mut(&neighbourhood)?;
        let job = jobs.pop_front();
        if jobs.is_empty() {
            self.neighbourhoods.remove(&neighbourhood);
        } else {
            self.turns.push_back(neighbourhood);
        }
        self.waiting -= 1;
        job
    }
}

struct Shared {
    queue: Mutex<Queue>,
    ready: Condvar,
    counters: Counters,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Stops the threads when the last handle goes.
struct Threads(Arc<Shared>);

impl Drop for Threads {
    fn drop(&mut self) {
        self.0.lock().closed = true;
        self.0.ready.notify_all();
    }
}

#[derive(Clone)]
pub struct VerifierPool {
    threads: Arc<Threads>,
}

impl VerifierPool {
    /// Starts the pool's threads.
    pub fn start() -> Self {
        let shared = Arc::new(Shared {
            queue: Mutex::default(),
            ready: Condvar::new(),
            counters: Counters::default(),
        });
        for index in 0..VERIFIER_THREADS {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name(format!("citadel-verify-{index}"))
                .spawn(move || work(&shared))
                .expect("the verifier threads start");
        }
        Self {
            threads: Arc::new(Threads(shared)),
        }
    }

    fn shared(&self) -> &Shared {
        &self.threads.0
    }

    /// Queues `check`, which owns `ticket` and settles it. If the requester
    /// has gone by the time a thread reaches the check, it is skipped and
    /// the ticket dropped, which counts as a failure; either way the
    /// client's sign-in stays in flight until then.
    pub fn submit<T: Send + 'static>(
        &self,
        lane: Lane,
        ticket: Ticket,
        check: impl FnOnce(Ticket) -> T + Send + 'static,
    ) -> Result<oneshot::Receiver<T>, PoolFull> {
        let shared = self.shared();
        let mut queue = shared.lock();
        let room = match lane {
            Lane::Known => queue.known.len() < QUEUED_KNOWN,
            Lane::Neighbourhood(neighbourhood) => {
                queue.waiting < QUEUED_TOTAL
                    && queue
                        .neighbourhoods
                        .get(&neighbourhood)
                        .map_or(0, VecDeque::len)
                        < QUEUED_PER_NEIGHBOURHOOD
            }
        };
        if !room {
            drop(queue);
            // The check never ran: the guess is given back.
            ticket.refund();
            return Err(PoolFull);
        }
        let (sender, receiver) = oneshot::channel();
        let job: Job = Box::new(move |counters: &Counters| {
            if sender.is_closed() {
                counters.skipped.fetch_add(1, Ordering::Relaxed);
                drop(ticket);
                return;
            }
            counters.checked.fetch_add(1, Ordering::Relaxed);
            let _ = sender.send(check(ticket));
        });
        match lane {
            Lane::Known => queue.known.push_back(job),
            Lane::Neighbourhood(neighbourhood) => {
                let jobs = queue.neighbourhoods.entry(neighbourhood).or_default();
                jobs.push_back(job);
                if jobs.len() == 1 {
                    queue.turns.push_back(neighbourhood);
                }
                queue.waiting += 1;
            }
        }
        drop(queue);
        shared.ready.notify_one();
        Ok(receiver)
    }

    /// Checks run so far; for tests.
    pub fn checked(&self) -> u64 {
        self.shared().counters.checked.load(Ordering::Relaxed)
    }

    /// Checks skipped because their requester had gone; for tests.
    pub fn skipped(&self) -> u64 {
        self.shared().counters.skipped.load(Ordering::Relaxed)
    }
}

fn work(shared: &Shared) {
    loop {
        let job = {
            let mut queue = shared.lock();
            loop {
                if queue.closed {
                    return;
                }
                if let Some(job) = queue.next() {
                    break job;
                }
                queue = shared
                    .ready
                    .wait(queue)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        };
        job(&shared.counters);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        net::SocketAddr,
        sync::mpsc,
        time::{Duration, Instant},
    };

    use super::*;
    use crate::guard::{Credential, Outcome, SignInGuard, Slowdown};

    fn at(address: &str) -> ClientAddress {
        ClientAddress::direct(SocketAddr::new(address.parse().unwrap(), 1))
    }

    fn reserve(guard: &SignInGuard, client: &ClientAddress, secret: &str) -> Ticket {
        guard
            .reserve(
                client,
                Credential::Password {
                    username: secret,
                    password: secret.as_bytes(),
                    device: None,
                },
            )
            .unwrap()
    }

    /// Occupies both threads until the returned sender is dropped.
    fn occupy(
        pool: &VerifierPool,
        guard: &SignInGuard,
    ) -> (mpsc::Sender<()>, Vec<oneshot::Receiver<()>>) {
        let (release, gate) = mpsc::channel::<()>();
        let gate = Arc::new(Mutex::new(gate));
        let (started, running) = mpsc::channel();
        let mut waiting = Vec::new();
        for index in 0..VERIFIER_THREADS {
            let gate = gate.clone();
            let started = started.clone();
            let client = at(&format!("192.0.2.{}", index + 1));
            waiting.push(
                pool.submit(
                    Lane::Known,
                    reserve(guard, &client, &format!("blocker{index}")),
                    move |ticket| {
                        started.send(()).unwrap();
                        let _ = gate.lock().unwrap().recv();
                        ticket.settle(Outcome::Failure);
                    },
                )
                .unwrap(),
            );
        }
        for _ in 0..VERIFIER_THREADS {
            running.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        (release, waiting)
    }

    fn wait_until(mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn known_devices_go_first_then_neighbourhoods_take_turns_within_bounds() {
        let guard = SignInGuard::new();
        let pool = VerifierPool::start();
        let (release, _waiting) = occupy(&pool, &guard);
        let order = Arc::new(Mutex::new(Vec::new()));
        let receivers = std::cell::RefCell::new(Vec::new());
        let submit = |lane: Lane, client: &ClientAddress, label: String| {
            let order = order.clone();
            let ticket = reserve(&guard, client, &label);
            pool.submit(lane, ticket, move |ticket| {
                order.lock().unwrap().push(label);
                ticket.settle(Outcome::Failure);
            })
            .map(|receiver| receivers.borrow_mut().push(receiver))
        };
        let neighbourhood =
            |client: &ClientAddress| Lane::Neighbourhood(client.aggregate_keys()[0]);

        for index in 0..QUEUED_PER_NEIGHBOURHOOD {
            let client = at(&format!("198.51.100.{}", index + 1));
            submit(neighbourhood(&client), &client, format!("busy-{index}")).unwrap();
        }
        let extra = at("198.51.100.200");
        assert_eq!(
            submit(neighbourhood(&extra), &extra, "busy-extra".into()).err(),
            Some(PoolFull),
            "four per neighbourhood"
        );
        assert_eq!(
            guard.charged(&extra),
            0.0,
            "a check that couldn't queue is refunded"
        );
        let quiet = at("203.0.113.1");
        submit(neighbourhood(&quiet), &quiet, "quiet".into()).unwrap();
        for network in 0..QUEUED_TOTAL {
            let client = at(&format!("10.{}.{}.1", network / 256, network % 256));
            let accepted = submit(neighbourhood(&client), &client, format!("other-{network}"));
            assert_eq!(accepted.is_ok(), network < QUEUED_TOTAL - 5, "{network}");
        }
        let known = at("192.0.2.77");
        submit(Lane::Known, &known, "known".into()).unwrap();
        drop(release);
        wait_until(|| order.lock().unwrap().len() == QUEUED_TOTAL + 1);
        let order = order.lock().unwrap().clone();
        assert_eq!(order[0], "known", "known devices go first");
        assert!(
            order.iter().position(|label| label == "quiet").unwrap() <= 3,
            "a quiet neighbourhood doesn't wait behind a busy one: {order:?}"
        );
        assert!(
            order.iter().position(|label| label == "busy-1").unwrap() > 10,
            "a busy neighbourhood waits its turn: {order:?}"
        );
        assert_eq!(pool.checked(), (QUEUED_TOTAL + 1 + VERIFIER_THREADS) as u64);
    }

    #[test]
    fn a_cancelled_check_is_skipped_but_stays_in_flight_and_counts() {
        let guard = SignInGuard::new();
        let pool = VerifierPool::start();
        let (release, _waiting) = occupy(&pool, &guard);
        let client = at("203.0.113.7");
        let lane = Lane::Neighbourhood(client.aggregate_keys()[0]);
        let hashed = Arc::new(AtomicU64::new(0));
        for attempt in 0..2 {
            let hashed = hashed.clone();
            let receiver = pool
                .submit(
                    lane,
                    reserve(&guard, &client, &format!("a{attempt}")),
                    move |ticket| {
                        hashed.fetch_add(1, Ordering::Relaxed);
                        ticket.settle(Outcome::Failure);
                    },
                )
                .unwrap();
            // The browser gives up and sends again.
            drop(receiver);
        }
        for attempt in 0..20 {
            let refused = guard.reserve(
                &client,
                Credential::Password {
                    username: "phil",
                    password: format!("b{attempt}").as_bytes(),
                    device: None,
                },
            );
            assert_eq!(
                refused.err().unwrap().reason,
                Slowdown::InFlight,
                "cancelled checks stay in flight until a thread reaches them"
            );
        }
        drop(release);
        wait_until(|| pool.skipped() == 2);
        assert_eq!(hashed.load(Ordering::Relaxed), 0, "skipped before hashing");
        assert!(guard.charged(&client) > 1.99, "and still counted");
        drop(reserve(&guard, &client, "afterwards"));
    }

    #[test]
    fn a_full_known_lane_refuses_and_refunds() {
        let guard = SignInGuard::new();
        let pool = VerifierPool::start();
        let (release, mut waiting) = occupy(&pool, &guard);
        for index in 0..QUEUED_KNOWN {
            let client = at(&format!("198.51.100.{}", index + 1));
            waiting.push(
                pool.submit(
                    Lane::Known,
                    reserve(&guard, &client, &format!("k{index}")),
                    |ticket| ticket.settle(Outcome::Success),
                )
                .unwrap(),
            );
        }
        let client = at("203.0.113.9");
        assert_eq!(
            pool.submit(Lane::Known, reserve(&guard, &client, "k-extra"), drop)
                .err(),
            Some(PoolFull)
        );
        assert_eq!(guard.charged(&client), 0.0);
        drop(release);
    }
}
