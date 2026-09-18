use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    net::{SocketAddr, TcpListener as StdTcpListener},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{oneshot, Notify},
    task::JoinHandle,
};

use super::{
    network::{
        advertised_url, plan_bindings, InterfaceProvider, InterfaceSnapshot,
        NetdevInterfaceProvider, OpdsNetworkInterface, WaitingReason,
    },
    router, CatalogSource,
};

const MONITOR_INTERVAL: Duration = Duration::from_secs(2);
const LISTENER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(6);

pub use crate::network::OpdsBindTarget;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsStartConfig {
    pub target: OpdsBindTarget,
    pub port: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpdsLifecycleState {
    Stopped,
    Starting,
    Running,
    WaitingForInterface,
    Error,
    Stopping,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpdsErrorCode {
    InvalidPort,
    LibraryNotReady,
    ConfigurationConflict,
    InterfaceUnavailable,
    InterfaceEnumerationFailed,
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
    pub target: Option<OpdsBindTarget>,
    pub port: Option<u32>,
    pub active_library_id: Option<String>,
    pub urls: Vec<String>,
    pub error: Option<OpdsStatusError>,
}

impl Default for OpdsServiceStatus {
    fn default() -> Self {
        Self {
            state: OpdsLifecycleState::Stopped,
            target: None,
            port: None,
            active_library_id: None,
            urls: Vec::new(),
            error: None,
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
        tracker: Arc<ListenerTracker>,
    ) -> io::Result<ServerTask>;
}

struct TcpListenerFactory;

impl ListenerFactory for TcpListenerFactory {
    fn start(
        &self,
        address: SocketAddr,
        source: Arc<dyn CatalogSource>,
        tracker: Arc<ListenerTracker>,
    ) -> io::Result<ServerTask> {
        let listener = StdTcpListener::bind(address)?;
        listener.set_nonblocking(true)?;
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let app = router(source);
        let completion = tracker.register();
        let task = tokio::spawn(async move {
            let _completion = completion;
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_receiver.await;
                })
                .await
        });
        Ok(ServerTask {
            shutdown: Some(shutdown),
            task: Some(task),
        })
    }
}

struct ServiceDependencies {
    interfaces: Arc<dyn InterfaceSnapshots>,
    listeners: Arc<dyn ListenerFactory>,
    monitor_interval: Duration,
    worker_shutdown_timeout: Duration,
}

impl Default for ServiceDependencies {
    fn default() -> Self {
        Self {
            interfaces: Arc::new(NetdevInterfaceSnapshots),
            listeners: Arc::new(TcpListenerFactory),
            monitor_interval: MONITOR_INTERVAL,
            worker_shutdown_timeout: WORKER_SHUTDOWN_TIMEOUT,
        }
    }
}

struct RunningController {
    config: OpdsStartConfig,
    stop: oneshot::Sender<()>,
    worker: JoinHandle<()>,
}

struct ServiceInner {
    status: Arc<Mutex<OpdsServiceStatus>>,
    controller: tokio::sync::Mutex<Option<RunningController>>,
    source: Arc<dyn CatalogSource>,
    dependencies: ServiceDependencies,
    listener_tracker: Arc<ListenerTracker>,
}

#[derive(Clone)]
pub struct OpdsService {
    inner: Arc<ServiceInner>,
}

impl OpdsService {
    pub fn new(source: Arc<dyn CatalogSource>) -> Self {
        Self::with_dependencies(source, ServiceDependencies::default())
    }

    fn with_dependencies(source: Arc<dyn CatalogSource>, dependencies: ServiceDependencies) -> Self {
        Self {
            inner: Arc::new(ServiceInner {
                status: Arc::new(Mutex::new(OpdsServiceStatus::default())),
                controller: tokio::sync::Mutex::new(None),
                source,
                dependencies,
                listener_tracker: Arc::new(ListenerTracker::default()),
            }),
        }
    }

    pub async fn status(&self) -> OpdsServiceStatus {
        if let Ok(mut controller) = self.inner.controller.try_lock() {
            reap_finished_controller(&mut controller, &self.inner.status).await;
        }

        let mut status = status_snapshot(&self.inner.status);
        if status.state == OpdsLifecycleState::Stopped {
            status.active_library_id = None;
            return status;
        }
        status.active_library_id = active_library_id(self.inner.source.clone()).await;
        status
    }

    pub async fn list_interfaces(&self) -> Result<Vec<OpdsNetworkInterface>, OpdsStatusError> {
        snapshot_interfaces(self.inner.dependencies.interfaces.clone())
            .await
            .map(|interfaces| {
                interfaces
                    .into_iter()
                    .map(|interface| interface.public())
                    .collect()
            })
            .map_err(|_| OpdsStatusError {
                code: OpdsErrorCode::InterfaceEnumerationFailed,
                message: "Citadel could not list network interfaces.".to_string(),
            })
    }

    pub async fn start(
        &self,
        config: OpdsStartConfig,
    ) -> Result<OpdsServiceStatus, OpdsStatusError> {
        let mut controller = self.inner.controller.lock().await;
        reap_finished_controller(&mut controller, &self.inner.status).await;
        if let Some(running) = controller.as_ref() {
            if running.config == config {
                drop(controller);
                return Ok(self.status().await);
            }
            return Err(OpdsStatusError {
                code: OpdsErrorCode::ConfigurationConflict,
                message: "Sharing is already active with different network settings. Stop it before changing the interface or port.".to_string(),
            });
        }

        set_configured_status(
            &self.inner.status,
            &config,
            OpdsLifecycleState::Starting,
            None,
            Vec::new(),
            None,
        );
        let Ok(port) = u16::try_from(config.port)
            .ok()
            .filter(|port| *port != 0)
            .ok_or(())
        else {
            set_configured_status(
                &self.inner.status,
                &config,
                OpdsLifecycleState::Error,
                Some(OpdsStatusError {
                    code: OpdsErrorCode::InvalidPort,
                    message: "Choose a port between 1 and 65535.".to_string(),
                }),
                Vec::new(),
                None,
            );
            drop(controller);
            return Ok(self.status().await);
        };

        let library_id = active_library_id(self.inner.source.clone()).await;
        let Some(library_id) = library_id else {
            set_configured_status(
                &self.inner.status,
                &config,
                OpdsLifecycleState::Error,
                Some(OpdsStatusError {
                    code: OpdsErrorCode::LibraryNotReady,
                    message: "Open a library before starting sharing.".to_string(),
                }),
                Vec::new(),
                None,
            );
            drop(controller);
            return Ok(self.status().await);
        };

        let mut servers = BTreeMap::new();
        match snapshot_interfaces(self.inner.dependencies.interfaces.clone()).await {
            Ok(interfaces) => {
                apply_plan(
                    &interfaces,
                    &config,
                    port,
                    &mut servers,
                    self.inner.dependencies.listeners.as_ref(),
                    self.inner.listener_tracker.clone(),
                    self.inner.source.clone(),
                    &self.inner.status,
                    Some(library_id.clone()),
                )
                .await;
            }
            Err(_) => {
                set_configured_status(
                    &self.inner.status,
                    &config,
                    OpdsLifecycleState::Error,
                    Some(interface_enumeration_error(false)),
                    Vec::new(),
                    Some(library_id),
                );
            }
        }

        let (stop, stop_receiver) = oneshot::channel();
        let worker = tokio::spawn(monitor_service(
            self.inner.dependencies.interfaces.clone(),
            self.inner.dependencies.listeners.clone(),
            self.inner.listener_tracker.clone(),
            self.inner.source.clone(),
            self.inner.status.clone(),
            config.clone(),
            port,
            servers,
            stop_receiver,
            self.inner.dependencies.monitor_interval,
        ));
        *controller = Some(RunningController {
            config,
            stop,
            worker,
        });
        drop(controller);
        Ok(self.status().await)
    }

    pub async fn stop(&self) -> OpdsServiceStatus {
        let mut controller = self.inner.controller.lock().await;
        let Some(running) = controller.take() else {
            set_stopped_status(&self.inner.status);
            drop(controller);
            return self.status().await;
        };
        set_simple_status(
            &self.inner.status,
            OpdsLifecycleState::Stopping,
            None,
            Vec::new(),
        );
        let stopped = stop_controller(
            running,
            self.inner.listener_tracker.clone(),
            self.inner.dependencies.worker_shutdown_timeout,
        )
        .await;
        if stopped {
            set_stopped_status(&self.inner.status);
        } else {
            set_simple_status(
                &self.inner.status,
                OpdsLifecycleState::Error,
                Some(OpdsStatusError {
                    code: OpdsErrorCode::ListenerFailed,
                    message: "Citadel could not confirm that every OPDS listener stopped."
                        .to_string(),
                }),
                Vec::new(),
            );
        }
        drop(controller);
        self.status().await
    }
}

struct ServerTask {
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<io::Result<()>>>,
}

#[derive(Default)]
struct ListenerTracker {
    active: AtomicUsize,
    empty: Notify,
}

impl ListenerTracker {
    fn register(self: &Arc<Self>) -> ListenerCompletion {
        self.active.fetch_add(1, Ordering::AcqRel);
        ListenerCompletion {
            tracker: self.clone(),
        }
    }

    async fn wait_until_empty(&self) {
        loop {
            let notified = self.empty.notified();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}

struct ListenerCompletion {
    tracker: Arc<ListenerTracker>,
}

impl Drop for ListenerCompletion {
    fn drop(&mut self) {
        if self.tracker.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.tracker.empty.notify_waiters();
        }
    }
}

impl Drop for ServerTask {
    fn drop(&mut self) {
        if let Some(task) = self.task.as_ref() {
            task.abort();
        }
    }
}

async fn snapshot_interfaces(
    interfaces: Arc<dyn InterfaceSnapshots>,
) -> io::Result<Vec<InterfaceSnapshot>> {
    tokio::task::spawn_blocking(move || interfaces.snapshot())
        .await
        .map_err(|_| io::Error::other("interface snapshot task failed"))?
}

async fn active_library_id(source: Arc<dyn CatalogSource>) -> Option<String> {
    tokio::task::spawn_blocking(move || source.active_library_id().ok())
        .await
        .ok()
        .flatten()
}

async fn apply_plan(
    interfaces: &[InterfaceSnapshot],
    config: &OpdsStartConfig,
    port: u16,
    servers: &mut BTreeMap<SocketAddr, ServerTask>,
    listeners: &dyn ListenerFactory,
    tracker: Arc<ListenerTracker>,
    source: Arc<dyn CatalogSource>,
    status: &Mutex<OpdsServiceStatus>,
    library_id: Option<String>,
) {
    match plan_bindings(interfaces, &config.target, port) {
        super::network::BindPlan::Wait(reason) => {
            shutdown_servers(servers).await;
            set_configured_status(
                status,
                config,
                OpdsLifecycleState::WaitingForInterface,
                Some(waiting_error(&reason)),
                Vec::new(),
                library_id,
            );
        }
        super::network::BindPlan::Listen(desired) => {
            let stale = servers
                .keys()
                .filter(|address| !desired.contains(address))
                .copied()
                .collect::<Vec<_>>();
            let mut stale_servers = BTreeMap::new();
            for address in stale {
                if let Some(server) = servers.remove(&address) {
                    stale_servers.insert(address, server);
                }
            }
            shutdown_servers(&mut stale_servers).await;

            if let Err(error) = start_missing_servers(servers, &desired, listeners, tracker, source)
            {
                shutdown_servers(servers).await;
                set_configured_status(
                    status,
                    config,
                    OpdsLifecycleState::Error,
                    Some(bind_error(error)),
                    Vec::new(),
                    library_id,
                );
                return;
            }
            set_configured_status(
                status,
                config,
                OpdsLifecycleState::Running,
                None,
                urls(&desired),
                library_id,
            );
        }
    }
}

fn start_missing_servers(
    servers: &mut BTreeMap<SocketAddr, ServerTask>,
    desired: &BTreeSet<SocketAddr>,
    listeners: &dyn ListenerFactory,
    tracker: Arc<ListenerTracker>,
    source: Arc<dyn CatalogSource>,
) -> io::Result<()> {
    for address in desired {
        if address.ip().is_unspecified() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "wildcard listeners are forbidden",
            ));
        }
        if !servers.contains_key(address) {
            servers.insert(
                *address,
                listeners.start(*address, source.clone(), tracker.clone())?,
            );
        }
    }
    Ok(())
}

async fn monitor_service(
    interfaces: Arc<dyn InterfaceSnapshots>,
    listeners: Arc<dyn ListenerFactory>,
    tracker: Arc<ListenerTracker>,
    source: Arc<dyn CatalogSource>,
    status: Arc<Mutex<OpdsServiceStatus>>,
    config: OpdsStartConfig,
    port: u16,
    mut servers: BTreeMap<SocketAddr, ServerTask>,
    mut stop: oneshot::Receiver<()>,
    interval: Duration,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker.tick().await;
    loop {
        tokio::select! {
            _ = &mut stop => break,
            _ = ticker.tick() => {}
        }

        if servers
            .values()
            .any(|server| server.task.as_ref().is_some_and(JoinHandle::is_finished))
        {
            shutdown_servers(&mut servers).await;
            set_configured_status(
                &status,
                &config,
                OpdsLifecycleState::Error,
                Some(OpdsStatusError {
                    code: OpdsErrorCode::ListenerFailed,
                    message: "An OPDS listener stopped unexpectedly; Citadel will retry."
                        .to_string(),
                }),
                Vec::new(),
                None,
            );
            continue;
        }

        let snapshot = match snapshot_interfaces(interfaces.clone()).await {
            Ok(snapshot) => snapshot,
            Err(_) => {
                shutdown_servers(&mut servers).await;
                set_configured_status(
                    &status,
                    &config,
                    OpdsLifecycleState::Error,
                    Some(interface_enumeration_error(true)),
                    Vec::new(),
                    None,
                );
                continue;
            }
        };
        let library_id = active_library_id(source.clone()).await;
        apply_plan(
            &snapshot,
            &config,
            port,
            &mut servers,
            listeners.as_ref(),
            tracker.clone(),
            source.clone(),
            &status,
            library_id,
        )
        .await;
    }
    shutdown_servers(&mut servers).await;
}

async fn reap_finished_controller(
    controller: &mut Option<RunningController>,
    status: &Mutex<OpdsServiceStatus>,
) {
    if !controller
        .as_ref()
        .is_some_and(|running| running.worker.is_finished())
    {
        return;
    }
    let running = controller.take().expect("finished controller disappeared");
    let _ = running.worker.await;
    set_simple_status(
        status,
        OpdsLifecycleState::Error,
        Some(OpdsStatusError {
            code: OpdsErrorCode::ListenerFailed,
            message: "The OPDS service stopped unexpectedly. Start sharing again to retry."
                .to_string(),
        }),
        Vec::new(),
    );
}

async fn stop_controller(
    controller: RunningController,
    tracker: Arc<ListenerTracker>,
    worker_shutdown_timeout: Duration,
) -> bool {
    let _ = controller.stop.send(());
    let mut worker = controller.worker;
    if tokio::time::timeout(worker_shutdown_timeout, &mut worker)
        .await
        .is_err()
    {
        worker.abort();
        let _ = worker.await;
    }
    tokio::time::timeout(LISTENER_SHUTDOWN_TIMEOUT, tracker.wait_until_empty())
        .await
        .is_ok()
}

async fn shutdown_servers(servers: &mut BTreeMap<SocketAddr, ServerTask>) {
    let mut servers = std::mem::take(servers).into_values().collect::<Vec<_>>();
    for server in &mut servers {
        if let Some(shutdown) = server.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    let mut tasks = servers
        .iter_mut()
        .filter_map(|server| server.task.take())
        .collect::<Vec<_>>();
    if tokio::time::timeout(LISTENER_SHUTDOWN_TIMEOUT, join_all(tasks.iter_mut()))
        .await
        .is_err()
    {
        for task in &tasks {
            task.abort();
        }
        let _ = join_all(tasks).await;
    }
}

fn status_snapshot(status: &Mutex<OpdsServiceStatus>) -> OpdsServiceStatus {
    status.lock().expect("OPDS status mutex poisoned").clone()
}

fn set_stopped_status(status: &Mutex<OpdsServiceStatus>) {
    *status.lock().expect("OPDS status mutex poisoned") = OpdsServiceStatus::default();
}

fn set_simple_status(
    status: &Mutex<OpdsServiceStatus>,
    state: OpdsLifecycleState,
    error: Option<OpdsStatusError>,
    urls: Vec<String>,
) {
    let mut status = status.lock().expect("OPDS status mutex poisoned");
    status.state = state;
    status.error = error;
    status.urls = urls;
}

fn set_configured_status(
    status: &Mutex<OpdsServiceStatus>,
    config: &OpdsStartConfig,
    state: OpdsLifecycleState,
    error: Option<OpdsStatusError>,
    urls: Vec<String>,
    library_id: Option<String>,
) {
    let mut status = status.lock().expect("OPDS status mutex poisoned");
    status.state = state;
    status.target = Some(config.target.clone());
    status.port = Some(config.port);
    if library_id.is_some() {
        status.active_library_id = library_id;
    }
    status.error = error;
    status.urls = urls;
}

fn urls(addresses: &BTreeSet<SocketAddr>) -> Vec<String> {
    addresses.iter().copied().map(advertised_url).collect()
}

fn waiting_error(reason: &WaitingReason) -> OpdsStatusError {
    OpdsStatusError {
        code: OpdsErrorCode::InterfaceUnavailable,
        message: reason.message(),
    }
}

fn interface_enumeration_error(retrying: bool) -> OpdsStatusError {
    OpdsStatusError {
        code: OpdsErrorCode::InterfaceEnumerationFailed,
        message: if retrying {
            "Citadel could not inspect network interfaces; it will retry."
        } else {
            "Citadel could not inspect network interfaces."
        }
        .to_string(),
    }
}

fn bind_error(error: io::Error) -> OpdsStatusError {
    if error.kind() == io::ErrorKind::AddrInUse {
        OpdsStatusError {
            code: OpdsErrorCode::PortUnavailable,
            message: "That port is already in use on the selected network interface.".to_string(),
        }
    } else {
        OpdsStatusError {
            code: OpdsErrorCode::Unexpected,
            message: "Citadel could not open the requested OPDS listener.".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        net::{IpAddr, Ipv4Addr},
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
    };

    use super::*;
    use crate::network::{
        AddressScope, InterfaceAddress, OpdsInterfaceKind, OpdsInterfaceState,
    };

    struct FakeInterfaces {
        current: Mutex<Result<Vec<InterfaceSnapshot>, io::ErrorKind>>,
    }

    struct BlockingInterfaces {
        snapshot: Vec<InterfaceSnapshot>,
        entered: AtomicBool,
        release: AtomicBool,
    }

    struct HangingMonitorInterfaces {
        snapshot: Vec<InterfaceSnapshot>,
        calls: AtomicUsize,
        release: AtomicBool,
    }

    impl InterfaceSnapshots for HangingMonitorInterfaces {
        fn snapshot(&self) -> io::Result<Vec<InterfaceSnapshot>> {
            if self.calls.fetch_add(1, Ordering::AcqRel) != 0 {
                while !self.release.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
            Ok(self.snapshot.clone())
        }
    }

    impl InterfaceSnapshots for BlockingInterfaces {
        fn snapshot(&self) -> io::Result<Vec<InterfaceSnapshot>> {
            self.entered.store(true, Ordering::Release);
            while !self.release.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(self.snapshot.clone())
        }
    }

    impl FakeInterfaces {
        fn new(snapshot: Vec<InterfaceSnapshot>) -> Self {
            Self {
                current: Mutex::new(Ok(snapshot)),
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
    }

    impl ListenerFactory for FakeListeners {
        fn start(
            &self,
            address: SocketAddr,
            _source: Arc<dyn CatalogSource>,
            tracker: Arc<ListenerTracker>,
        ) -> io::Result<ServerTask> {
            if self.fail_bind.swap(false, Ordering::AcqRel) {
                return Err(io::Error::from(io::ErrorKind::AddrInUse));
            }
            self.active.lock().unwrap().insert(address);
            let active = self.active.clone();
            let self_hold_shutdown = self.hold_shutdown.clone();
            let task_should_fail = self.fail_task.swap(false, Ordering::AcqRel);
            let completion = tracker.register();
            let (shutdown, shutdown_receiver) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _completion = completion;
                let _active = FakeActiveListener { active, address };
                let result = if task_should_fail {
                    Err(io::Error::from(io::ErrorKind::BrokenPipe))
                } else {
                    let _ = shutdown_receiver.await;
                    while self_hold_shutdown.load(Ordering::Acquire) {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    Ok(())
                };
                result
            });
            Ok(ServerTask {
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
            target: OpdsBindTarget::Interface {
                id: "en0".to_string(),
            },
            port,
        }
    }

    fn service_with(
        source: Arc<dyn CatalogSource>,
        interfaces: Arc<dyn InterfaceSnapshots>,
        listeners: Arc<dyn ListenerFactory>,
        interval: Duration,
    ) -> OpdsService {
        OpdsService::with_dependencies(
            source,
            ServiceDependencies {
                interfaces,
                listeners,
                monitor_interval: interval,
                worker_shutdown_timeout: Duration::from_millis(100),
            },
        )
    }

    async fn wait_for_state(
        service: &OpdsService,
        expected: OpdsLifecycleState,
    ) -> OpdsServiceStatus {
        for _ in 0..100 {
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

    #[tokio::test(flavor = "multi_thread")]
    async fn selected_interface_loss_waits_without_broadening_and_recovers() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(vec![lan(
            OpdsInterfaceState::Up,
            [192, 168, 1, 5],
        )]));
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces.clone(),
            listeners.clone(),
            Duration::from_millis(10),
        );

        let running = service.start(config(8080)).await.unwrap();
        assert_eq!(running.state, OpdsLifecycleState::Running);
        assert_eq!(
            *listeners.active.lock().unwrap(),
            BTreeSet::from(["192.168.1.5:8080".parse().unwrap()])
        );

        interfaces.set(vec![lan(OpdsInterfaceState::Down, [192, 168, 1, 5])]);
        let waiting = wait_for_state(&service, OpdsLifecycleState::WaitingForInterface).await;
        assert_eq!(
            waiting.error.unwrap().code,
            OpdsErrorCode::InterfaceUnavailable
        );
        assert!(listeners.active.lock().unwrap().is_empty());

        interfaces.set(vec![lan(OpdsInterfaceState::Up, [192, 168, 1, 9])]);
        let recovered = wait_for_state(&service, OpdsLifecycleState::Running).await;
        assert_eq!(recovered.urls, vec!["http://192.168.1.9:8080/opds"]);
        assert_eq!(
            *listeners.active.lock().unwrap(),
            BTreeSet::from(["192.168.1.9:8080".parse().unwrap()])
        );

        assert_eq!(service.stop().await.state, OpdsLifecycleState::Stopped);
        assert!(listeners.active.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_same_config_starts_are_idempotent_and_conflicts_are_typed() {
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
            Duration::from_millis(10),
        );

        let requested = config(8080);
        let (first, second) = tokio::join!(
            service.start(requested.clone()),
            service.start(requested.clone())
        );
        assert_eq!(first.unwrap().state, OpdsLifecycleState::Running);
        assert_eq!(second.unwrap().state, OpdsLifecycleState::Running);
        assert_eq!(listeners.active.lock().unwrap().len(), 1);

        let conflict = service.start(config(8081)).await.unwrap_err();
        assert_eq!(conflict.code, OpdsErrorCode::ConfigurationConflict);
        assert_eq!(service.status().await.port, Some(8080));
        service.stop().await;
        assert_eq!(service.stop().await.state, OpdsLifecycleState::Stopped);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn invalid_port_missing_library_and_occupied_port_are_actionable() {
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
        let status = missing.start(config(8080)).await.unwrap();
        assert_eq!(status.error.unwrap().code, OpdsErrorCode::LibraryNotReady);

        let source = test_source();
        let service = service_with(
            source,
            interfaces,
            listeners.clone(),
            Duration::from_secs(1),
        );
        let invalid = service.start(config(70_000)).await.unwrap();
        assert_eq!(invalid.error.unwrap().code, OpdsErrorCode::InvalidPort);

        listeners.fail_bind.store(true, Ordering::Release);
        let occupied = service.start(config(8080)).await.unwrap();
        assert_eq!(occupied.error.unwrap().code, OpdsErrorCode::PortUnavailable);
        service.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn listener_task_failure_is_observable_and_then_retried() {
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
            Duration::from_millis(50),
        );

        service.start(config(8080)).await.unwrap();
        let failed = wait_for_state(&service, OpdsLifecycleState::Error).await;
        assert_eq!(failed.error.unwrap().code, OpdsErrorCode::ListenerFailed);
        wait_for_state(&service, OpdsLifecycleState::Running).await;
        assert_eq!(listeners.active.lock().unwrap().len(), 1);
        service.stop().await;
        assert!(listeners.active.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn interface_enumeration_failure_is_actionable_and_retried() {
        let source = test_source();
        let interfaces = Arc::new(FakeInterfaces::new(Vec::new()));
        interfaces.set_error(io::ErrorKind::Other);
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces.clone(),
            listeners,
            Duration::from_millis(10),
        );

        let failed = service.start(config(8080)).await.unwrap();
        assert_eq!(
            failed.error.unwrap().code,
            OpdsErrorCode::InterfaceEnumerationFailed
        );
        interfaces.set(vec![lan(OpdsInterfaceState::Up, [192, 168, 1, 5])]);
        wait_for_state(&service, OpdsLifecycleState::Running).await;
        service.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn starting_and_stopping_are_observable_during_blocked_dependencies() {
        let source = test_source();
        let interfaces = Arc::new(BlockingInterfaces {
            snapshot: vec![lan(OpdsInterfaceState::Up, [192, 168, 1, 5])],
            entered: AtomicBool::new(false),
            release: AtomicBool::new(false),
        });
        let listeners = Arc::new(FakeListeners::default());
        let service = service_with(
            source,
            interfaces.clone(),
            listeners.clone(),
            Duration::from_secs(1),
        );

        let starting_service = service.clone();
        let start = tokio::spawn(async move { starting_service.start(config(8080)).await });
        while !interfaces.entered.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        assert_eq!(service.status().await.state, OpdsLifecycleState::Starting);
        interfaces.release.store(true, Ordering::Release);
        assert_eq!(
            start.await.unwrap().unwrap().state,
            OpdsLifecycleState::Running
        );

        listeners.hold_shutdown.store(true, Ordering::Release);
        let stopping_service = service.clone();
        let stop = tokio::spawn(async move { stopping_service.stop().await });
        wait_for_state(&service, OpdsLifecycleState::Stopping).await;
        listeners.hold_shutdown.store(false, Ordering::Release);
        assert_eq!(stop.await.unwrap().state, OpdsLifecycleState::Stopped);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn real_listener_rejects_occupied_port_and_releases_it_on_stop() {
        let occupied = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = occupied.local_addr().unwrap();
        let factory = TcpListenerFactory;
        let tracker = Arc::new(ListenerTracker::default());
        let error = match factory.start(address, missing_source(), tracker.clone()) {
            Ok(_) => panic!("occupied listener unexpectedly bound"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        drop(occupied);

        let mut servers = BTreeMap::from([(
            address,
            factory
                .start(address, missing_source(), tracker.clone())
                .unwrap(),
        )]);
        shutdown_servers(&mut servers).await;
        tracker.wait_until_empty().await;
        assert!(StdTcpListener::bind(address).is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn forced_worker_abort_awaits_listener_cancellation_and_releases_port() {
        let probe = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let interfaces = Arc::new(HangingMonitorInterfaces {
            snapshot: vec![lan(OpdsInterfaceState::Up, [127, 0, 0, 1])],
            calls: AtomicUsize::new(0),
            release: AtomicBool::new(false),
        });
        let source = test_source();
        let service = service_with(
            source,
            interfaces.clone(),
            Arc::new(TcpListenerFactory),
            Duration::from_millis(5),
        );
        assert_eq!(
            service.start(config(u32::from(port))).await.unwrap().state,
            OpdsLifecycleState::Running
        );
        while interfaces.calls.load(Ordering::Acquire) < 2 {
            tokio::task::yield_now().await;
        }

        assert_eq!(service.stop().await.state, OpdsLifecycleState::Stopped);
        assert!(StdTcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
        interfaces.release.store(true, Ordering::Release);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn listener_completion_cannot_be_lost_between_count_check_and_wait() {
        for _ in 0..1_000 {
            let tracker = Arc::new(ListenerTracker::default());
            let completion = tracker.register();
            let waiter_tracker = tracker.clone();
            let waiter = tokio::spawn(async move { waiter_tracker.wait_until_empty().await });
            tokio::task::yield_now().await;
            drop(completion);
            tokio::time::timeout(Duration::from_millis(100), waiter)
                .await
                .expect("listener completion notification was lost")
                .unwrap();
        }
    }
}
