use std::{
    collections::BTreeSet,
    io,
    net::{SocketAddr, TcpListener as StdTcpListener},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{sync::oneshot, task::JoinHandle};

use super::{
    auth::OpdsBasicAuth,
    credential_store::OpdsCredentialStore,
    network::{
        advertised_url, plan_bindings, BindPolicy, InterfaceProvider, InterfaceSnapshot,
        NetdevInterfaceProvider, WaitingReason,
    },
    router, CatalogSource,
};

const LISTENER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const WAIT_RETRY_INTERVAL: Duration = Duration::from_secs(2);

pub use crate::network::OpdsBindTarget;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsStartConfig {
    pub target: OpdsBindTarget,
    pub port: u32,
    pub authentication_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpdsLifecycleState {
    Stopped,
    Starting,
    Running,
    WaitingForInterface,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpdsErrorCode {
    InvalidPort,
    LibraryNotReady,
    AuthRequired,
    ConfigurationConflict,
    InterfaceUnavailable,
    PortUnavailable,
    ListenerFailed,
    Unexpected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsStatusError {
    pub code: OpdsErrorCode,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsServiceStatus {
    pub state: OpdsLifecycleState,
    pub active_library_id: Option<String>,
    pub urls: Vec<String>,
    pub error: Option<OpdsStatusError>,
    /// The configuration the server is actually running with, so the UI can
    /// show the live port and scope instead of a possibly-stale draft.
    pub config: Option<OpdsStartConfig>,
}

impl Default for OpdsServiceStatus {
    fn default() -> Self {
        Self {
            state: OpdsLifecycleState::Stopped,
            active_library_id: None,
            urls: Vec::new(),
            error: None,
            config: None,
        }
    }
}

trait InterfaceSnapshots: Send + Sync {
    fn snapshot(&self) -> io::Result<Vec<InterfaceSnapshot>>;
}

struct NetdevInterfaceSnapshots;

impl InterfaceSnapshots for NetdevInterfaceSnapshots {
    fn snapshot(&self) -> io::Result<Vec<InterfaceSnapshot>> {
        let mut provider = NetdevInterfaceProvider;
        provider.snapshot()
    }
}

trait ListenerFactory: Send + Sync {
    fn start(
        &self,
        address: SocketAddr,
        source: Arc<dyn CatalogSource>,
        auth: OpdsBasicAuth,
    ) -> io::Result<ServerTask>;
}

struct TcpListenerFactory;

impl ListenerFactory for TcpListenerFactory {
    fn start(
        &self,
        address: SocketAddr,
        source: Arc<dyn CatalogSource>,
        auth: OpdsBasicAuth,
    ) -> io::Result<ServerTask> {
        let listener = bind_socket(address)?;
        listener.set_nonblocking(true)?;
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let app = router(source, auth);
        let task = tokio::spawn(async move {
            let _ = tokio::spawn(async move {
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async move {
                        let _ = shutdown_receiver.await;
                    })
                    .await;
            })
            .await;
        });
        Ok(ServerTask {
            address,
            shutdown: Some(shutdown),
            task: Some(task),
        })
    }
}

fn bind_socket(address: SocketAddr) -> io::Result<StdTcpListener> {
    if let SocketAddr::V6(v6) = address {
        let socket = socket2::Socket::new(
            socket2::Domain::IPV6,
            socket2::Type::STREAM,
            Some(socket2::Protocol::TCP),
        )?;
        // IPv4 and IPv6 wildcard binds must not overlap: keep the v6 socket
        // IPv6-only on every platform (Linux defaults to dual-stack).
        socket.set_only_v6(true)?;
        socket.set_nonblocking(true)?;
        socket.bind(&socket2::SockAddr::from(v6))?;
        socket.listen(1024)?;
        Ok(StdTcpListener::from(socket))
    } else {
        Ok(StdTcpListener::bind(address)?)
    }
}

struct ServerTask {
    address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

/// Owns the running listeners. Dropping it signals a graceful shutdown;
/// [`Listeners::drain`] awaits that shutdown with a timeout.
struct Listeners(Vec<ServerTask>);

impl Listeners {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn push(&mut self, task: ServerTask) {
        self.0.push(task);
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn addresses(&self) -> BTreeSet<SocketAddr> {
        self.0.iter().map(|task| task.address).collect()
    }

    async fn drain(mut self) {
        for server in &mut self.0 {
            if let Some(shutdown) = server.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
        let mut tasks = self
            .0
            .iter_mut()
            .filter_map(|server| server.task.take())
            .collect::<Vec<_>>();
        let _ = tokio::time::timeout(LISTENER_SHUTDOWN_TIMEOUT, async {
            for task in &mut tasks {
                let _ = task.await;
            }
        })
        .await;
        for task in tasks {
            task.abort();
        }
    }
}

impl Drop for Listeners {
    fn drop(&mut self) {
        for server in &mut self.0 {
            if let Some(shutdown) = server.shutdown.take() {
                let _ = shutdown.send(());
            }
            // Detach rather than abort: the serve future must stay alive to
            // process the shutdown signal we just sent. Orphaned connections
            // run to completion on their own.
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum BindFailureClass {
    Persistent,
    Transient,
}

fn classify_bind_error(error: &io::Error) -> BindFailureClass {
    match error.kind() {
        io::ErrorKind::AddrInUse | io::ErrorKind::PermissionDenied => BindFailureClass::Persistent,
        _ => BindFailureClass::Transient,
    }
}

fn bind_failure_error(address: SocketAddr, class: BindFailureClass) -> OpdsStatusError {
    match class {
        BindFailureClass::Persistent => OpdsStatusError {
            code: OpdsErrorCode::PortUnavailable,
            message: format!("Network address {address} is not available; please pick a new port."),
        },
        BindFailureClass::Transient => OpdsStatusError {
            code: OpdsErrorCode::Unexpected,
            message: "Citadel could not open its sharing listener. Try turning sharing off and on."
                .to_string(),
        },
    }
}

fn listener_failed_error() -> OpdsStatusError {
    OpdsStatusError {
        code: OpdsErrorCode::ListenerFailed,
        message: "Sharing stopped unexpectedly. Turn it back on to share again.".to_string(),
    }
}

struct Preflight {
    port: u16,
    policy: BindPolicy,
}

/// The whole sharing lifecycle. Variants own their resources, so state and
/// sockets cannot drift apart; transitions are the only place state changes,
/// and every one matches explicitly. `gen` is a generation counter: events
/// spawned for one run (death watchers, the waiting poll, an in-flight bind)
/// carry it, and transitions ignore anything stale.
enum SharingState {
    Stopped,
    Starting {
        gen: u64,
    },
    Running {
        gen: u64,
        config: OpdsStartConfig,
        listeners: Listeners,
        urls: Vec<String>,
    },
    Waiting {
        gen: u64,
        reason: WaitingReason,
    },
    Failed {
        error: OpdsStatusError,
        urls: Vec<String>,
    },
}

impl SharingState {
    fn begin_start(&mut self, gen: u64) -> Result<(), OpdsStatusError> {
        match self {
            SharingState::Stopped | SharingState::Failed { .. } | SharingState::Waiting { .. } => {
                *self = SharingState::Starting { gen };
                Ok(())
            }
            SharingState::Starting { .. } | SharingState::Running { .. } => Err(OpdsStatusError {
                code: OpdsErrorCode::ConfigurationConflict,
                message: "Sharing is already active. Stop it before starting again.".to_string(),
            }),
        }
    }

    /// Completes a start. If `stop` ran while the bind was in flight the
    /// generation is stale and the fresh listeners come back for draining.
    fn started(
        &mut self,
        gen: u64,
        config: OpdsStartConfig,
        listeners: Listeners,
        urls: Vec<String>,
    ) -> Result<(), Listeners> {
        match self {
            SharingState::Starting { gen: current }
            | SharingState::Waiting { gen: current, .. }
                if *current == gen =>
            {
                *self = SharingState::Running {
                    gen,
                    config,
                    listeners,
                    urls,
                };
                Ok(())
            }
            _ => Err(listeners),
        }
    }

    fn waiting(&mut self, gen: u64, reason: WaitingReason) -> bool {
        if matches!(self, SharingState::Starting { gen: current } if *current == gen) {
            *self = SharingState::Waiting { gen, reason };
            true
        } else {
            false
        }
    }

    fn listener_died(&mut self, gen: u64, error: OpdsStatusError) -> bool {
        if matches!(self, SharingState::Running { gen: current, .. } if *current == gen) {
            let old = std::mem::replace(self, SharingState::Stopped);
            let urls = match old {
                SharingState::Running { urls, .. } => urls,
                _ => Vec::new(),
            };
            *self = SharingState::Failed { error, urls };
            true
        } else {
            false
        }
    }

    /// Any state -> Stopped. Returns live listeners for an awaited drain;
    /// stale watchers keep working because they re-check the state anyway.
    fn stop(&mut self) -> Option<Listeners> {
        match std::mem::replace(self, SharingState::Stopped) {
            SharingState::Running { listeners, .. } => Some(listeners),
            _ => None,
        }
    }

    fn failed(&mut self, gen: u64, error: OpdsStatusError) -> bool {
        if matches!(
            self,
            SharingState::Starting { gen: current } | SharingState::Waiting { gen: current, .. } if *current == gen
        ) {
            *self = SharingState::Failed {
                error,
                urls: Vec::new(),
            };
            true
        } else {
            false
        }
    }
}

impl From<&SharingState> for OpdsServiceStatus {
    fn from(state: &SharingState) -> Self {
        let plain = |state: OpdsLifecycleState,
                     urls: Vec<String>,
                     error: Option<OpdsStatusError>,
                     config: Option<OpdsStartConfig>| {
            OpdsServiceStatus {
                state,
                active_library_id: None,
                urls,
                error,
                config,
            }
        };
        match state {
            SharingState::Stopped => plain(OpdsLifecycleState::Stopped, Vec::new(), None, None),
            SharingState::Starting { .. } => {
                plain(OpdsLifecycleState::Starting, Vec::new(), None, None)
            }
            SharingState::Running { urls, config, .. } => plain(
                OpdsLifecycleState::Running,
                urls.clone(),
                None,
                Some(config.clone()),
            ),
            SharingState::Waiting { reason, .. } => plain(
                OpdsLifecycleState::WaitingForInterface,
                Vec::new(),
                Some(OpdsStatusError {
                    code: OpdsErrorCode::InterfaceUnavailable,
                    message: reason.message(),
                }),
                None,
            ),
            SharingState::Failed { error, urls } => plain(
                OpdsLifecycleState::Error,
                urls.clone(),
                Some(error.clone()),
                None,
            ),
        }
    }
}

struct ServiceDependencies {
    interfaces: Arc<dyn InterfaceSnapshots>,
    listeners: Arc<dyn ListenerFactory>,
    wait_retry_interval: Duration,
}

impl Default for ServiceDependencies {
    fn default() -> Self {
        Self {
            interfaces: Arc::new(NetdevInterfaceSnapshots),
            listeners: Arc::new(TcpListenerFactory),
            wait_retry_interval: WAIT_RETRY_INTERVAL,
        }
    }
}

mod credentials;

struct ServiceInner {
    state: Mutex<SharingState>,
    next_gen: std::sync::atomic::AtomicU64,
    source: Arc<dyn CatalogSource>,
    credentials: OpdsCredentialStore,
    auth: OpdsBasicAuth,
    /// Serializes start/stop/reconfigure/clear across their await points so
    /// two windows (or a window and a poll race) cannot interleave a stop
    /// into a restart's drain.
    op_lock: tokio::sync::Mutex<()>,
    dependencies: ServiceDependencies,
}

#[derive(Clone)]
pub struct OpdsService {
    inner: Arc<ServiceInner>,
}

enum BindOutcome {
    Bound {
        listeners: Listeners,
        death_notifications: tokio::sync::mpsc::UnboundedReceiver<SocketAddr>,
    },
    Waiting(WaitingReason),
    Failed(OpdsStatusError),
}

impl OpdsService {
    pub fn new(
        source: Arc<dyn CatalogSource>,
        credential_path: std::path::PathBuf,
    ) -> io::Result<Self> {
        let credentials = OpdsCredentialStore::load(credential_path)?;
        Ok(Self::with_dependencies_and_credentials(
            source,
            credentials,
            ServiceDependencies::default(),
        ))
    }

    #[cfg(test)]
    fn with_dependencies(
        source: Arc<dyn CatalogSource>,
        dependencies: ServiceDependencies,
    ) -> Self {
        Self::with_dependencies_and_credentials(
            source,
            OpdsCredentialStore::in_memory(),
            dependencies,
        )
    }

    fn with_dependencies_and_credentials(
        source: Arc<dyn CatalogSource>,
        credentials: OpdsCredentialStore,
        dependencies: ServiceDependencies,
    ) -> Self {
        Self {
            inner: Arc::new(ServiceInner {
                state: Mutex::new(SharingState::Stopped),
                next_gen: AtomicU64::new(0),
                source,
                credentials,
                auth: OpdsBasicAuth::new(),
                op_lock: tokio::sync::Mutex::new(()),
                dependencies,
            }),
        }
    }

    /// Clearing credentials while sharing is live stops sharing: the
    /// all-networks bind policy exists only while credentials exist, and a
    /// required auth snapshot with no secret could only reject everyone.
    /// Configure and generate do NOT stop; they hot-swap the snapshot.
    async fn stop_if_active(&self) {
        let listeners = {
            let mut state = self.inner.state.lock().unwrap();
            state.stop()
        };
        if let Some(listeners) = listeners {
            listeners.drain().await;
        }
    }

    pub async fn status(&self) -> OpdsServiceStatus {
        let library_id = active_library_id(self.inner.source.clone());
        let mut status = OpdsServiceStatus::from(&*self.inner.state.lock().unwrap());
        if status.state == OpdsLifecycleState::Running {
            status.active_library_id = library_id;
        }
        status
    }

    /// Applies a changed port or scope to a live share: a deliberate restart
    /// through the normal stop/start transitions, so binding rules and the
    /// auth gate are re-checked in one place. Stopped shares just start.
    pub async fn reconfigure(
        &self,
        config: OpdsStartConfig,
    ) -> Result<OpdsServiceStatus, OpdsStatusError> {
        let _guard = self.inner.op_lock.lock().await;
        self.preflight(&config)?;
        let listeners = {
            let mut state = self.inner.state.lock().unwrap();
            state.stop()
        };
        if let Some(listeners) = listeners {
            listeners.drain().await;
        }
        self.start_inner(config).await
    }

    pub async fn start(
        &self,
        config: OpdsStartConfig,
    ) -> Result<OpdsServiceStatus, OpdsStatusError> {
        let _guard = self.inner.op_lock.lock().await;
        self.start_inner(config).await
    }

    async fn start_inner(
        &self,
        config: OpdsStartConfig,
    ) -> Result<OpdsServiceStatus, OpdsStatusError> {
        let Preflight { port, policy } = self.preflight(&config)?;

        let already_running = {
            let state = self.inner.state.lock().unwrap();
            matches!(
                &*state,
                SharingState::Running { config: active_config, .. } if *active_config == config
            )
        };
        if already_running {
            return Ok(self.status().await);
        }

        let gen = self.inner.next_gen.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut state = self.inner.state.lock().unwrap();
            state.begin_start(gen)?;
        }

        // The transition above committed us to starting; only now may the
        // shared auth gate change — a rejected start must never mutate what
        // live listeners serve.
        self.inner.auth.set_required(config.authentication_enabled);
        self.swap_auth_from_store();

        let outcome = attempt_bind(
            &self.inner.dependencies,
            self.inner.source.clone(),
            &config.target,
            port,
            policy,
            self.inner.auth.clone(),
        )
        .await;

        let mut lost = None;
        let mut death_notifications = None;
        {
            let mut state = self.inner.state.lock().unwrap();
            match outcome {
                BindOutcome::Bound {
                    listeners,
                    death_notifications: receiver,
                } => {
                    let urls = urls(&listeners.addresses());
                    match state.started(gen, config.clone(), listeners, urls) {
                        Ok(()) => death_notifications = Some(receiver),
                        Err(stale_listeners) => lost = Some(stale_listeners),
                    }
                }
                BindOutcome::Waiting(reason) => {
                    if state.waiting(gen, reason) {
                        drop(state);
                        self.spawn_wait_poll(gen, config, port);
                    }
                }
                BindOutcome::Failed(error) => {
                    state.failed(gen, error);
                }
            }
        }
        if let Some(death_notifications) = death_notifications {
            self.spawn_death_pump(gen, death_notifications);
        }
        if let Some(listeners) = lost {
            listeners.drain().await;
        }
        Ok(self.status().await)
    }

    /// Every check a config must pass before any state changes, so
    /// `reconfigure` can reject a bad config without stopping a live share.
    fn preflight(&self, config: &OpdsStartConfig) -> Result<Preflight, OpdsStatusError> {
        let port = u16::try_from(config.port)
            .ok()
            .filter(|port| *port != 0)
            .ok_or(OpdsStatusError {
                code: OpdsErrorCode::InvalidPort,
                message: "Choose a port between 1 and 65535.".to_string(),
            })?;
        if active_library_id(self.inner.source.clone()).is_none() {
            return Err(OpdsStatusError {
                code: OpdsErrorCode::LibraryNotReady,
                message: "Open a library before starting sharing.".to_string(),
            });
        }

        let stored = if config.authentication_enabled {
            let stored = self.inner.credentials.get();
            if stored.is_none() {
                return Err(OpdsStatusError {
                    code: OpdsErrorCode::AuthRequired,
                    message: "Reader sign-in needs a password. Generate or set one, then turn sharing on.".to_string(),
                });
            }
            stored
        } else {
            None
        };
        // Credentials configured is the only thing that unlocks serving
        // beyond the local network.
        let policy = BindPolicy {
            allow_global: stored.is_some(),
        };
        if matches!(config.target, OpdsBindTarget::AllInterfaces) && !policy.allow_global {
            // AllInterfaces serves every network the computer can reach; it
            // exists to be paired with credentials.
            return Err(OpdsStatusError {
                code: OpdsErrorCode::AuthRequired,
                message: "Sharing on all networks requires reader sign-in. Set a password first."
                    .to_string(),
            });
        }

        Ok(Preflight { port, policy })
    }

    pub async fn stop(&self) -> OpdsServiceStatus {
        let _guard = self.inner.op_lock.lock().await;
        self.stop_inner().await
    }

    async fn stop_inner(&self) -> OpdsServiceStatus {
        let listeners = {
            let mut state = self.inner.state.lock().unwrap();
            state.stop()
        };
        if let Some(listeners) = listeners {
            listeners.drain().await;
        }
        self.status().await
    }

    fn spawn_death_pump(
        &self,
        gen: u64,
        mut death_notifications: tokio::sync::mpsc::UnboundedReceiver<SocketAddr>,
    ) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            while let Some(_address) = death_notifications.recv().await {
                let handled = {
                    let mut state = inner.state.lock().unwrap();
                    state.listener_died(gen, listener_failed_error())
                };
                if !handled {
                    break;
                }
            }
        });
    }

    fn spawn_wait_poll(&self, gen: u64, config: OpdsStartConfig, port: u16) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(inner.dependencies.wait_retry_interval).await;
                {
                    let state = inner.state.lock().unwrap();
                    if !matches!(
                        &*state,
                        SharingState::Waiting { gen: current, .. } if *current == gen
                    ) {
                        return;
                    }
                }

                let outcome = attempt_bind(
                    &inner.dependencies,
                    inner.source.clone(),
                    &config.target,
                    port,
                    BindPolicy::default(),
                    inner.auth.clone(),
                )
                .await;

                let mut succeeded = None;
                let mut permanent_failure = None;
                {
                    let mut state = inner.state.lock().unwrap();
                    match outcome {
                        BindOutcome::Bound {
                            listeners,
                            death_notifications,
                        } => {
                            let urls = urls(&listeners.addresses());
                            if state.started(gen, config.clone(), listeners, urls).is_ok() {
                                succeeded = Some(death_notifications);
                            }
                            // A stale start means stop won; the listeners
                            // come back drained below.
                        }
                        BindOutcome::Failed(error) => permanent_failure = Some(error),
                        BindOutcome::Waiting(_) => continue,
                    }
                }
                if let Some(death_notifications) = succeeded {
                    OpdsService {
                        inner: inner.clone(),
                    }
                    .spawn_death_pump(gen, death_notifications);
                    return;
                }
                if let Some(error) = permanent_failure {
                    let mut state = inner.state.lock().unwrap();
                    if state.failed(gen, error) {
                        return;
                    }
                }
            }
        });
    }
}

fn active_library_id(source: Arc<dyn CatalogSource>) -> Option<String> {
    source.active_library_id().ok()
}

fn urls(addresses: &BTreeSet<SocketAddr>) -> Vec<String> {
    addresses.iter().copied().map(advertised_url).collect()
}

async fn attempt_bind(
    dependencies: &ServiceDependencies,
    source: Arc<dyn CatalogSource>,
    target: &OpdsBindTarget,
    port: u16,
    policy: BindPolicy,
    auth: OpdsBasicAuth,
) -> BindOutcome {
    let desired = match target {
        OpdsBindTarget::AllInterfaces => {
            let mut sockets = BTreeSet::new();
            sockets.insert(SocketAddr::new(
                std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
                port,
            ));
            sockets.insert(SocketAddr::new(
                std::net::IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED),
                port,
            ));
            sockets
        }
        OpdsBindTarget::LocalNetworks => {
            let snapshot = match dependencies.interfaces.snapshot() {
                Ok(snapshot) => snapshot,
                // A hiccup while inspecting interfaces is indistinguishable
                // from "no network yet": wait and retry.
                Err(_) => return BindOutcome::Waiting(WaitingReason::NoLocalInterface),
            };
            match plan_bindings(&snapshot, target, port, policy) {
                super::network::BindPlan::Listen(sockets) => sockets,
                super::network::BindPlan::Wait(reason) => return BindOutcome::Waiting(reason),
            }
        }
    };

    let (death_sender, death_receiver) = tokio::sync::mpsc::unbounded_channel();
    let mut listeners = Listeners::new();
    let mut first_failure = None;
    for address in desired {
        match dependencies
            .listeners
            .start(address, source.clone(), auth.clone())
        {
            Ok(mut task) => {
                task.address = address;
                let completion = task.task.take().expect("fresh listener has a task");
                let notify = death_sender.clone();
                let watched = tokio::spawn(async move {
                    let _ = completion.await;
                    let _ = notify.send(address);
                });
                task.task = Some(watched);
                listeners.push(task);
            }
            Err(error) => {
                if first_failure.is_none() {
                    first_failure = Some((address, error));
                }
            }
        }
    }
    drop(death_sender);

    if !listeners.is_empty() {
        BindOutcome::Bound {
            listeners,
            death_notifications: death_receiver,
        }
    } else if let Some((address, error)) = first_failure {
        BindOutcome::Failed(bind_failure_error(address, classify_bind_error(&error)))
    } else {
        BindOutcome::Waiting(WaitingReason::NoLocalInterface)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        net::{IpAddr, Ipv4Addr},
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use super::*;
    use crate::network::{AddressScope, InterfaceAddress, OpdsInterfaceKind, OpdsInterfaceState};

    struct FakeInterfaces {
        current: Mutex<Result<Vec<InterfaceSnapshot>, io::ErrorKind>>,
        calls: AtomicUsize,
    }

    impl FakeInterfaces {
        fn new(snapshot: Vec<InterfaceSnapshot>) -> Self {
            Self {
                current: Mutex::new(Ok(snapshot)),
                calls: AtomicUsize::new(0),
            }
        }

        fn set(&self, snapshot: Vec<InterfaceSnapshot>) {
            *self.current.lock().unwrap() = Ok(snapshot);
        }

        fn set_error(&self, kind: io::ErrorKind) {
            *self.current.lock().unwrap() = Err(kind);
        }
    }

    impl InterfaceSnapshots for FakeInterfaces {
        fn snapshot(&self) -> io::Result<Vec<InterfaceSnapshot>> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            match &*self.current.lock().unwrap() {
                Ok(snapshot) => Ok(snapshot.clone()),
                Err(kind) => Err(io::Error::from(*kind)),
            }
        }
    }

    #[derive(Default)]
    struct FakeListeners {
        active: Arc<Mutex<BTreeSet<SocketAddr>>>,
        fail_bind: AtomicBool,
        fail_task: AtomicBool,
        hold_shutdown: Arc<AtomicBool>,
        fail_every: Mutex<Option<io::ErrorKind>>,
    }

    impl ListenerFactory for FakeListeners {
        fn start(
            &self,
            address: SocketAddr,
            _source: Arc<dyn CatalogSource>,
            _auth: OpdsBasicAuth,
        ) -> io::Result<ServerTask> {
            if let Some(kind) = *self.fail_every.lock().unwrap() {
                return Err(io::Error::from(kind));
            }
            if self.fail_bind.swap(false, Ordering::AcqRel) {
                return Err(io::Error::from(io::ErrorKind::AddrInUse));
            }
            self.active.lock().unwrap().insert(address);
            let active = self.active.clone();
            let self_hold_shutdown = self.hold_shutdown.clone();
            let task_should_fail = self.fail_task.swap(false, Ordering::AcqRel);
            let (shutdown, shutdown_receiver) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _active = FakeActiveListener { active, address };
                if task_should_fail {
                    return;
                }
                let _ = shutdown_receiver.await;
                while self_hold_shutdown.load(Ordering::Acquire) {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            });
            Ok(ServerTask {
                address,
                shutdown: Some(shutdown),
                task: Some(task),
            })
        }
    }

    struct FakeActiveListener {
        active: Arc<Mutex<BTreeSet<SocketAddr>>>,
        address: SocketAddr,
    }

    impl Drop for FakeActiveListener {
        fn drop(&mut self) {
            self.active.lock().unwrap().remove(&self.address);
        }
    }

    struct TestSource {
        library_id: Option<String>,
    }

    use chrono::NaiveDateTime;

    impl CatalogSource for TestSource {
        fn active_library_id(&self) -> Result<String, libcalibre::CalibreError> {
            self.library_id
                .clone()
                .ok_or(libcalibre::CalibreError::LibraryNotInitialized)
        }

        fn book_page(
            &self,
            _limit: i64,
            _offset: i64,
        ) -> Result<(String, Option<NaiveDateTime>, libcalibre::BookPage), libcalibre::CalibreError>
        {
            Ok((
                self.active_library_id()?,
                None,
                libcalibre::BookPage {
                    items: Vec::new(),
                    total: 0,
                },
            ))
        }

        fn book_file(
            &self,
            book_id: libcalibre::BookId,
            format: &str,
        ) -> Result<libcalibre::ResolvedBookAsset, libcalibre::CalibreError> {
            Err(libcalibre::CalibreError::BookFileNotFound(
                book_id,
                format.to_string(),
            ))
        }

        fn book_cover(
            &self,
            book_id: libcalibre::BookId,
        ) -> Result<libcalibre::ResolvedBookAsset, libcalibre::CalibreError> {
            Err(libcalibre::CalibreError::BookCoverNotFound(book_id))
        }
    }

    fn test_source() -> Arc<dyn CatalogSource> {
        Arc::new(TestSource {
            library_id: Some("test-library".to_string()),
        })
    }

    fn missing_source() -> Arc<dyn CatalogSource> {
        Arc::new(TestSource { library_id: None })
    }

    fn lan(state: OpdsInterfaceState, address: [u8; 4]) -> InterfaceSnapshot {
        InterfaceSnapshot {
            id: "en0".to_string(),
            label: "Ethernet".to_string(),
            description: None,
            state,
            kind: OpdsInterfaceKind::Lan,
            addresses: vec![InterfaceAddress {
                address: IpAddr::V4(Ipv4Addr::from(address)),
                scope: AddressScope::Private,
                deprecated: false,
                tentative: false,
                duplicated: false,
            }],
        }
    }

    fn config(port: u32) -> OpdsStartConfig {
        OpdsStartConfig {
            target: OpdsBindTarget::LocalNetworks,
            port,
            authentication_enabled: false,
        }
    }

    fn service_with(
        source: Arc<dyn CatalogSource>,
        interfaces: Arc<dyn InterfaceSnapshots>,
        listeners: Arc<dyn ListenerFactory>,
        wait_retry_interval: Duration,
    ) -> OpdsService {
        OpdsService::with_dependencies(
            source,
            ServiceDependencies {
                interfaces,
                listeners,
                wait_retry_interval,
            },
        )
    }

    async fn wait_for_state(
        service: &OpdsService,
        expected: OpdsLifecycleState,
    ) -> OpdsServiceStatus {
        for _ in 0..200 {
            let status = service.status().await;
            if status.state == expected {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!(
            "timed out waiting for {expected:?}; current status: {:?}",
            service.status().await
        );
    }

    // ---- state machine transitions (pure, no sockets) ----

    fn starting() -> SharingState {
        SharingState::Starting { gen: 7 }
    }

    #[test]
    fn begin_start_only_from_non_active_states() {
        let mut state = SharingState::Stopped;
        assert!(state.begin_start(11).is_ok());
        assert!(matches!(state, SharingState::Starting { gen: 11 }));

        let mut state = SharingState::Failed {
            error: listener_failed_error(),
            urls: Vec::new(),
        };
        assert!(state.begin_start(12).is_ok());

        let mut state = starting();
        assert!(state.begin_start(13).is_err());

        let mut state = SharingState::Running {
            gen: 3,
            config: config(8080),
            listeners: Listeners::new(),
            urls: Vec::new(),
        };
        assert!(state.begin_start(14).is_err());
    }

    #[test]
    fn started_with_stale_generation_is_rejected() {
        let mut state = starting();
        assert!(state
            .started(
                6,
                OpdsStartConfig {
                    target: OpdsBindTarget::LocalNetworks,
                    port: 8080,
                    authentication_enabled: false,
                },
                Listeners::new(),
                Vec::new()
            )
            .is_err());
        assert!(matches!(state, SharingState::Starting { gen: 7 }));

        let mut state = SharingState::Stopped;
        assert!(state
            .started(
                7,
                OpdsStartConfig {
                    target: OpdsBindTarget::LocalNetworks,
                    port: 8080,
                    authentication_enabled: false,
                },
                Listeners::new(),
                Vec::new()
            )
            .is_err());
    }

    #[test]
    fn listener_died_only_fails_the_matching_run() {
        let mut state = SharingState::Running {
            gen: 7,
            config: config(8080),
            listeners: Listeners::new(),
            urls: vec!["http://192.168.1.5:8080/opds".to_string()],
        };
        assert!(state.listener_died(6, listener_failed_error()) == false);
        assert!(matches!(state, SharingState::Running { gen: 7, .. }));

        assert!(state.listener_died(7, listener_failed_error()));
        assert!(matches!(state, SharingState::Failed { .. }));
    }

    #[test]
    fn stop_from_any_state_lands_on_stopped() {
        let mut state = starting();
        assert!(state.stop().is_none());
        assert!(matches!(state, SharingState::Stopped));

        let mut state = SharingState::Running {
            gen: 2,
            config: config(8080),
            listeners: Listeners::new(),
            urls: Vec::new(),
        };
        assert!(state.stop().is_some());
        assert!(matches!(state, SharingState::Stopped));

        let mut state = SharingState::Stopped;
        assert!(state.stop().is_none());
    }

    #[test]
    fn status_is_derived_from_the_state() {
        let status = OpdsServiceStatus::from(&SharingState::Waiting {
            gen: 1,
            reason: WaitingReason::NoLocalInterface,
        });
        assert_eq!(status.state, OpdsLifecycleState::WaitingForInterface);
        assert_eq!(
            status.error.unwrap().code,
            OpdsErrorCode::InterfaceUnavailable
        );

        let status = OpdsServiceStatus::from(&SharingState::Stopped);
        assert_eq!(status, OpdsServiceStatus::default());
    }

    // ---- service behaviour ----

    #[tokio::test(flavor = "multi_thread")]
    async fn start_validates_port_and_library_without_touching_the_state() {
        let interfaces = Arc::new(FakeInterfaces::new(vec![lan(
            OpdsInterfaceState::Up,
            [192, 168, 1, 5],
        )]));
        let listeners = Arc::new(FakeListeners::default());
        let missing = service_with(
            missing_source(),
            interfaces.clone(),
            listeners.clone(),
            Duration::from_secs(1),
        );
        assert!(matches!(
            missing.start(config(8080)).await,
            Err(OpdsStatusError {
                code: OpdsErrorCode::LibraryNotReady,
                ..
            })
        ));
        assert_eq!(missing.status().await.state, OpdsLifecycleState::Stopped);

        let source = test_source();
        let service = service_with(source, interfaces, listeners, Duration::from_secs(1));
        assert!(matches!(
            service.start(config(70_000)).await,
            Err(OpdsStatusError {
                code: OpdsErrorCode::InvalidPort,
                ..
            })
        ));
        assert_eq!(service.status().await.state, OpdsLifecycleState::Stopped);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn starting_twice_same_config_is_idempotent_and_different_config_conflicts() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(vec![lan(
            OpdsInterfaceState::Up,
            [192, 168, 1, 5],
        )]));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(source, interfaces, listeners, Duration::from_secs(1));

        service.start(config(8080)).await.unwrap();
        // Same config: idempotent no-op (UI double-click).
        service.start(config(8080)).await.unwrap();
        assert_eq!(service.status().await.state, OpdsLifecycleState::Running);
        // Different config while running: conflict.
        assert!(matches!(
            service.start(config(9090)).await,
            Err(OpdsStatusError {
                code: OpdsErrorCode::ConfigurationConflict,
                ..
            })
        ));
        service.stop().await;
        service.start(config(8080)).await.unwrap();
        assert_eq!(service.status().await.state, OpdsLifecycleState::Running);
        service.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn waiting_polls_until_a_network_appears() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(Vec::new()));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces.clone(),
            listeners.clone(),
            Duration::from_millis(10),
        );

        let started = service.start(config(8080)).await.unwrap();
        assert_eq!(started.state, OpdsLifecycleState::WaitingForInterface);
        assert_eq!(listeners.active.lock().unwrap().len(), 0);

        interfaces.set(vec![lan(OpdsInterfaceState::Up, [192, 168, 1, 5])]);
        wait_for_state(&service, OpdsLifecycleState::Running).await;
        assert_eq!(listeners.active.lock().unwrap().len(), 1);
        service.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_while_waiting_cancels_the_poll() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(Vec::new()));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces.clone(),
            listeners.clone(),
            Duration::from_millis(10),
        );

        service.start(config(8080)).await.unwrap();
        service.stop().await;
        assert_eq!(service.status().await.state, OpdsLifecycleState::Stopped);

        interfaces.set(vec![lan(OpdsInterfaceState::Up, [192, 168, 1, 5])]);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(listeners.active.lock().unwrap().is_empty());
        assert_eq!(service.status().await.state, OpdsLifecycleState::Stopped);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dead_listener_fails_the_service_and_it_can_restart() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(vec![lan(
            OpdsInterfaceState::Up,
            [192, 168, 1, 5],
        )]));
        let listeners = Arc::new(FakeListeners::default());
        listeners.fail_task.store(true, Ordering::Release);
        let service = service_with(
            source,
            interfaces,
            listeners.clone(),
            Duration::from_millis(10),
        );

        service.start(config(8080)).await.unwrap();
        let failed = wait_for_state(&service, OpdsLifecycleState::Error).await;
        assert_eq!(failed.error.unwrap().code, OpdsErrorCode::ListenerFailed);

        listeners.fail_task.store(false, Ordering::Release);
        service.start(config(8080)).await.unwrap();
        wait_for_state(&service, OpdsLifecycleState::Running).await;
        assert_eq!(listeners.active.lock().unwrap().len(), 1);
        service.stop().await;
        assert!(listeners.active.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn permanent_bind_failure_reports_port_unavailable() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(vec![lan(
            OpdsInterfaceState::Up,
            [192, 168, 1, 5],
        )]));
        let listeners = Arc::new(FakeListeners::default());
        listeners.fail_bind.store(true, Ordering::Release);
        let service = service_with(
            source,
            interfaces,
            listeners.clone(),
            Duration::from_millis(10),
        );

        let failed = service.start(config(8080)).await.unwrap();
        assert_eq!(failed.state, OpdsLifecycleState::Error);
        assert_eq!(failed.error.unwrap().code, OpdsErrorCode::PortUnavailable);
        assert!(listeners.active.lock().unwrap().is_empty());
        service.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn real_factory_binds_dual_wildcards_on_one_port() {
        let probe = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let factory = TcpListenerFactory;
        let v4 = factory
            .start(
                SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
                missing_source(),
                OpdsBasicAuth::new(),
            )
            .expect("v4 wildcard bind");
        let v6 = factory
            .start(
                SocketAddr::new(IpAddr::V6("::".parse().unwrap()), port),
                missing_source(),
                OpdsBasicAuth::new(),
            )
            .expect("v6 wildcard bind (V6ONLY must be set)");

        // Both sockets answer; then both shut down cleanly.
        let _ = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        drop((v4, v6));
        let probe2 = StdTcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
        drop(probe2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn all_interfaces_requires_credentials_until_auth_allows_it() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(Vec::new()));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(source, interfaces, listeners, Duration::from_secs(1));

        assert!(matches!(
            service
                .start(OpdsStartConfig {
                    target: OpdsBindTarget::AllInterfaces,
                    port: 8080,
                    authentication_enabled: false,
                })
                .await,
            Err(OpdsStatusError {
                code: OpdsErrorCode::AuthRequired,
                ..
            })
        ));
        assert_eq!(service.status().await.state, OpdsLifecycleState::Stopped);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn all_interfaces_binds_without_enumerating() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(Vec::new()));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces.clone(),
            listeners.clone(),
            Duration::from_secs(1),
        );

        service
            .configure_credentials("reader".to_string(), "correct-horse".to_string())
            .unwrap();
        let started = service
            .start(OpdsStartConfig {
                target: OpdsBindTarget::AllInterfaces,
                port: 8080,
                authentication_enabled: true,
            })
            .await
            .unwrap();
        assert_eq!(started.state, OpdsLifecycleState::Running);
        assert_eq!(started.urls.len(), 2);
        assert_eq!(interfaces.calls.load(Ordering::Acquire), 0);
        assert_eq!(listeners.active.lock().unwrap().len(), 2);
        service.stop().await;
        assert!(listeners.active.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn generating_credentials_while_running_keeps_sharing_live() {
        // Generate hot-swaps the live credential snapshot; rotation never
        // reads as "sharing turned off".
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(vec![lan(
            OpdsInterfaceState::Up,
            [192, 168, 1, 5],
        )]));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces,
            listeners.clone(),
            Duration::from_secs(1),
        );

        service
            .configure_credentials("reader".to_string(), "correct-horse".to_string())
            .unwrap();
        service.start(config(8080)).await.unwrap();
        assert_eq!(service.status().await.state, OpdsLifecycleState::Running);

        let generated = service.generate_credentials("reader".to_string()).unwrap();
        assert!(!generated.password.is_empty());
        // The snapshot swapped in place: the share never went down.
        assert_eq!(service.status().await.state, OpdsLifecycleState::Running);
        assert_eq!(listeners.active.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn credential_change_while_waiting_keeps_the_poll_alive() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(Vec::new()));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces.clone(),
            listeners.clone(),
            Duration::from_millis(10),
        );

        service
            .configure_credentials("reader".to_string(), "correct-horse".to_string())
            .unwrap();
        let started = service
            .start(OpdsStartConfig {
                target: OpdsBindTarget::LocalNetworks,
                port: 8080,
                authentication_enabled: true,
            })
            .await
            .unwrap();
        assert_eq!(started.state, OpdsLifecycleState::WaitingForInterface);

        // The poll reads the live snapshot per attempt, so reconfiguring
        // mid-wait is safe: it keeps waiting and will bind the latest secret.
        service
            .configure_credentials("other".to_string(), "battery-staple".to_string())
            .unwrap();
        assert_eq!(
            service.status().await.state,
            OpdsLifecycleState::WaitingForInterface
        );
        assert!(listeners.active.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn clearing_credentials_while_gated_stops_sharing() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(Vec::new()));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces,
            listeners.clone(),
            Duration::from_secs(1),
        );

        service
            .configure_credentials("reader".to_string(), "correct-horse".to_string())
            .unwrap();
        let started = service
            .start(OpdsStartConfig {
                target: OpdsBindTarget::AllInterfaces,
                port: 8080,
                authentication_enabled: true,
            })
            .await
            .unwrap();
        assert_eq!(started.state, OpdsLifecycleState::Running);
        assert_eq!(listeners.active.lock().unwrap().len(), 2);

        let status = service.clear_credentials().await.unwrap();
        assert!(!status.configured);
        assert_eq!(service.status().await.state, OpdsLifecycleState::Stopped);
        assert!(listeners.active.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejected_start_leaves_the_live_auth_gate_untouched() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(vec![lan(
            OpdsInterfaceState::Up,
            [192, 168, 1, 5],
        )]));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces,
            listeners.clone(),
            Duration::from_secs(1),
        );

        service
            .configure_credentials("reader".to_string(), "correct-horse".to_string())
            .unwrap();
        service
            .start(OpdsStartConfig {
                target: OpdsBindTarget::LocalNetworks,
                port: 8080,
                authentication_enabled: true,
            })
            .await
            .unwrap();
        assert_eq!(service.status().await.state, OpdsLifecycleState::Running);
        assert!(service.inner.auth.required());

        // A stale pane calling start with a conflicting auth flag must fail
        // without flipping the gate the running listeners serve.
        let conflict = service
            .start(OpdsStartConfig {
                target: OpdsBindTarget::LocalNetworks,
                port: 8081,
                authentication_enabled: false,
            })
            .await;
        assert!(conflict.is_err());
        assert!(service.inner.auth.required());
        assert_eq!(service.status().await.state, OpdsLifecycleState::Running);
        service.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reconfigure_with_an_invalid_config_keeps_the_share_running() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(vec![lan(
            OpdsInterfaceState::Up,
            [192, 168, 1, 5],
        )]));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces,
            listeners.clone(),
            Duration::from_secs(1),
        );

        service.start(config(8080)).await.unwrap();
        assert_eq!(service.status().await.state, OpdsLifecycleState::Running);

        // No credentials stored: requiring sign-in must be rejected up front,
        // not after the live share has been torn down.
        let rejected = service
            .reconfigure(OpdsStartConfig {
                target: OpdsBindTarget::LocalNetworks,
                port: 8080,
                authentication_enabled: true,
            })
            .await;
        assert_eq!(rejected.unwrap_err().code, OpdsErrorCode::AuthRequired);
        assert_eq!(service.status().await.state, OpdsLifecycleState::Running);
        assert!(!listeners.active.lock().unwrap().is_empty());
        service.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn configure_credentials_rejects_a_colon_in_the_username() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(vec![]));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(source, interfaces, listeners, Duration::from_secs(1));

        let rejected =
            service.configure_credentials("me:home".to_string(), "correct-horse".to_string());
        assert!(rejected.is_err());
        assert!(!service.credential_status().configured);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn restarting_after_a_client_connection_releases_the_port() {
        let probe = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let factory = TcpListenerFactory;
        let source = missing_source();
        let mut first = factory
            .start(address, source.clone(), OpdsBasicAuth::new())
            .unwrap();
        // A client connects and the SERVER closes first: this port now has a
        // TIME_WAIT-eligible connection on the server side.
        let client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = first.shutdown.take().unwrap().send(());
        let _ = first.task.take().unwrap().await;
        drop(client);

        // Immediate rebind must succeed (SO_REUSEADDR on the socket2 path).
        let second = factory
            .start(address, source, OpdsBasicAuth::new())
            .expect("rebind after server-side close must not hit TIME_WAIT");
        drop(second);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn start_completion_after_stop_discards_the_fresh_listeners() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(Vec::new()));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces.clone(),
            listeners.clone(),
            Duration::from_millis(10),
        );

        // Start while nothing is bindable lands in Waiting; the poll then
        // retries. Stop right before setting a network so a poll retry is
        // possible, and assert the retry path respects the stop.
        service.start(config(8080)).await.unwrap();
        service.stop().await;
        interfaces.set(vec![lan(OpdsInterfaceState::Up, [192, 168, 1, 5])]);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(listeners.active.lock().unwrap().is_empty());
    }
}
