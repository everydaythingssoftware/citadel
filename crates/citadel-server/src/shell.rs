//! Everything [`crate::run_in`] needs from the process and the operating
//! system, so a test can run the whole server in-process: call its routers,
//! read what it logs, stop it, and trigger its periodic check.
use std::{future::Future, net::SocketAddr, pin::Pin, sync::Arc};

use axum::Router;
use citadel_core::http::HttpClient;
use citadel_opds::host::OpdsHost;
use tokio::sync::Notify;

pub type ShellFuture<TValue> = Pin<Box<dyn Future<Output = TValue> + Send>>;

pub struct Shell {
    /// Networking for OPDS sharing.
    pub opds_host: Arc<dyn OpdsHost>,
    /// Requests to metadata providers and update checks.
    pub http: Arc<dyn HttpClient>,
    /// Serves the JSON API.
    pub api: Arc<dyn ApiListener>,
    pub log: Arc<dyn ServerLog>,
    /// The server stops once this completes, failing with its error.
    pub shutdown: ShellFuture<Result<(), String>>,
    /// Asks for the periodic check (does OPDS have a reader yet?) to run now.
    pub check_now: Arc<Notify>,
}

impl Shell {
    /// The real process: its sockets, signals, stdout and stderr.
    pub fn system() -> Self {
        Self {
            opds_host: Arc::new(citadel_host::SystemHost),
            http: Arc::new(citadel_host::ReqwestHttp::new()),
            api: Arc::new(TcpApi),
            log: Arc::new(StdLog),
            shutdown: Box::pin(crate::shutdown_signal()),
            check_now: Arc::new(Notify::new()),
        }
    }
}

pub trait ServerLog: Send + Sync {
    /// A line for the operator's log; stdout in the real process.
    fn info(&self, line: String);
    /// A warning or error; stderr in the real process.
    fn warn(&self, line: String);
}

pub struct StdLog;

impl ServerLog for StdLog {
    fn info(&self, line: String) {
        println!("{line}");
    }

    fn warn(&self, line: String) {
        eprintln!("{line}");
    }
}

pub trait ApiListener: Send + Sync {
    /// Starts serving `app` at `listen` until the returned API is stopped.
    fn start(&self, listen: SocketAddr, app: Router) -> ShellFuture<Result<RunningApi, String>>;
}

/// A JSON API being served. It stops when [`RunningApi::stop`] is called or
/// when it is dropped.
pub struct RunningApi {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl RunningApi {
    /// `task` serves until `shutdown` fires.
    pub fn new(
        shutdown: tokio::sync::oneshot::Sender<()>,
        task: tokio::task::JoinHandle<std::io::Result<()>>,
    ) -> Self {
        Self {
            shutdown: Some(shutdown),
            task,
        }
    }

    pub async fn wait(&mut self) -> String {
        match (&mut self.task).await {
            Ok(Ok(())) => "JSON API stopped unexpectedly".into(),
            Ok(Err(error)) => format!("JSON API failed: {error}"),
            Err(error) => format!("JSON API task failed: {error}"),
        }
    }

    pub async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }
}

impl Drop for RunningApi {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Serves the API on a TCP socket.
pub struct TcpApi;

impl ApiListener for TcpApi {
    fn start(&self, listen: SocketAddr, app: Router) -> ShellFuture<Result<RunningApi, String>> {
        Box::pin(async move {
            let listener = tokio::net::TcpListener::bind(listen)
                .await
                .map_err(|error| format!("could not bind API {listen}: {error}"))?;
            let (shutdown, receiver) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                // The peer's address decides whether its forwarded headers count.
                axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(async move {
                    let _ = receiver.await;
                })
                .await
            });
            Ok(RunningApi::new(shutdown, task))
        })
    }
}
