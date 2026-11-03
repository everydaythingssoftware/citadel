pub mod admin;
pub mod api;
pub mod served;

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use chrono::NaiveDateTime;
use citadel_core::{error::LibraryError, password::generate_setup_code, store::CitadelStore};
use citadel_opds::{
    credential_store::OpdsCredentialSecret, CatalogBookQuery, CatalogFacet, CatalogSource,
    OpdsBindTarget, OpdsLifecycleState, OpdsService, OpdsServiceStatus, OpdsStartConfig,
};
use libcalibre::{BookId, BookPage, CalibreError, Library, ResolvedBookAsset};
use serde::Deserialize;

use served::ServedLibrary;

const ACCOUNTS_DATABASE: &str = "citadel.db";
const UPLOADS_DIRECTORY: &str = "uploads";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerConfig {
    /// Removed setting, kept only to explain the migration.
    library_path: Option<PathBuf>,
    pub state_directory: Option<PathBuf>,
    pub sharing: SharingConfig,
    pub api: api::ApiConfig,
}

/// OPDS listener settings. Reader sign-in is always required: each Citadel
/// user signs in to OPDS with their app password.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingConfig {
    pub port: u32,
    pub target: OpdsBindTarget,
    /// Removed setting, kept only to explain the migration.
    authentication_enabled: Option<bool>,
}

impl SharingConfig {
    fn start_config(&self) -> OpdsStartConfig {
        OpdsStartConfig {
            target: self.target.clone(),
            port: self.port,
            authentication_enabled: true,
        }
    }
}

/// What the process was asked to do: serve, or administer `citadel.db`.
#[derive(Debug, Eq, PartialEq)]
pub enum Invocation {
    Serve(PathBuf),
    Admin(PathBuf, Vec<String>),
}

/// The library the server serves, or nothing yet. It starts empty in a fresh
/// installation and is filled once the administrator chooses a library; the
/// OPDS and API routes share it.
pub struct CalibreCatalogSource {
    library: Mutex<Option<Opened>>,
    read_only: AtomicBool,
}

struct Opened {
    library: Library,
    path: PathBuf,
}

impl Default for CalibreCatalogSource {
    fn default() -> Self {
        Self::empty()
    }
}

impl CalibreCatalogSource {
    /// No library yet.
    pub fn empty() -> Self {
        Self {
            library: Mutex::new(None),
            read_only: AtomicBool::new(false),
        }
    }

    /// Opens the library for queries only; it is never changed.
    pub fn open(library_path: &Path) -> Result<Self, String> {
        let source = Self::empty();
        source.replace(open_library(library_path, Library::open_read_only)?, true);
        Ok(source)
    }

    /// Opens the library for writing. Only one program should write to a
    /// library at a time; nothing enforces that.
    pub fn open_writable(library_path: &Path) -> Result<Self, String> {
        let source = Self::empty();
        source.replace(open_library(library_path, Library::new)?, false);
        Ok(source)
    }

    /// Opens the library for writing, or read-only (logging why) when it
    /// can't be written, for example a read-only file or folder.
    pub fn open_preferring_writes(library_path: &Path) -> Result<Self, String> {
        let source = Self::empty();
        source.replace_from_path(library_path)?;
        Ok(source)
    }

    /// Serves the library at `library_path` from now on, preferring writes.
    pub fn replace_from_path(&self, library_path: &Path) -> Result<(), String> {
        let path_text = library_path
            .to_str()
            .ok_or_else(|| "library path must be valid UTF-8".to_string())?;
        if libcalibre::util::get_db_path(path_text).is_none() {
            return Err(format!("not a Calibre library: {path_text}"));
        }
        match open_library(library_path, Library::new) {
            Ok(opened) => {
                self.replace(opened, false);
                Ok(())
            }
            Err(error) => {
                eprintln!("citadel_server library=read-only reason={error}");
                self.replace(open_library(library_path, Library::open_read_only)?, true);
                Ok(())
            }
        }
    }

    fn replace(&self, opened: Opened, read_only: bool) {
        *self.lock() = Some(opened);
        self.read_only.store(read_only, Ordering::SeqCst);
    }

    pub fn close(&self) {
        *self.lock() = None;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Opened>> {
        self.library
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn is_open(&self) -> bool {
        self.lock().is_some()
    }

    pub fn path(&self) -> Option<PathBuf> {
        self.lock().as_ref().map(|opened| opened.path.clone())
    }

    pub fn read_only(&self) -> bool {
        self.read_only.load(Ordering::SeqCst)
    }

    /// Runs `operation` on the open library, or fails with
    /// [`CalibreError::LibraryNotInitialized`] when there is none.
    pub fn with<T>(
        &self,
        operation: impl FnOnce(&mut Library) -> Result<T, CalibreError>,
    ) -> Result<T, CalibreError> {
        let mut guard = self.lock();
        match guard.as_mut() {
            Some(opened) => operation(&mut opened.library),
            None => Err(CalibreError::LibraryNotInitialized),
        }
    }

    /// The API's view of [`CalibreCatalogSource::with`]: no library is a
    /// 503 that says so.
    pub fn with_library<T>(
        &self,
        operation: impl FnOnce(&mut Library) -> Result<T, LibraryError>,
    ) -> Result<T, LibraryError> {
        let mut guard = self.lock();
        match guard.as_mut() {
            Some(opened) => operation(&mut opened.library),
            None => Err(served::no_library_yet()),
        }
    }
}

fn open_library(
    library_path: &Path,
    open: impl FnOnce(libcalibre::util::ValidDbPath) -> Result<Library, CalibreError>,
) -> Result<Opened, String> {
    let path_text = library_path
        .to_str()
        .ok_or_else(|| "library path must be valid UTF-8".to_string())?;
    let database = libcalibre::util::get_db_path(path_text)
        .ok_or_else(|| format!("not a Calibre library: {path_text}"))?;
    let library = open(database).map_err(|error| format!("could not open {path_text}: {error}"))?;
    Ok(Opened {
        library,
        path: library_path.to_path_buf(),
    })
}

impl CatalogSource for CalibreCatalogSource {
    fn active_library_id(&self) -> Result<String, CalibreError> {
        self.with(|library| library.library_uuid())
    }

    fn book_page(
        &self,
        query: CatalogBookQuery,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
        self.with(|library| {
            let library_id = library.library_uuid()?;
            let updated_at = library.catalog_updated_at()?;
            let page = library.query_acquirable_books_with(query.into_calibre())?;
            Ok((library_id, updated_at, page))
        })
    }

    fn authors(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        self.facets(libcalibre::CatalogFacetKind::Authors)
    }

    fn series(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        self.facets(libcalibre::CatalogFacetKind::Series)
    }

    fn tags(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        self.facets(libcalibre::CatalogFacetKind::Tags)
    }

    fn genres(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        self.facets(libcalibre::CatalogFacetKind::Genres)
    }

    fn book_file(&self, book_id: BookId, format: &str) -> Result<ResolvedBookAsset, CalibreError> {
        self.with(|library| library.resolve_book_file(book_id, format))
    }

    fn book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
        self.with(|library| library.resolve_book_cover(book_id))
    }
}

impl CalibreCatalogSource {
    fn facets(
        &self,
        kind: libcalibre::CatalogFacetKind,
    ) -> Result<Vec<CatalogFacet>, CalibreError> {
        self.with(|library| {
            library.catalog_facets(kind).map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id,
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
        })
    }
}

pub fn invocation_from_args<I, S>(args: I) -> Result<Invocation, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut args = args.into_iter().map(Into::into);
    let program = args
        .next()
        .unwrap_or_else(|| OsString::from("citadel-server"));
    let usage = || {
        format!(
            "usage: {program} --config <path> [command]\n\n{}",
            admin::USAGE,
            program = program.to_string_lossy()
        )
    };
    match (args.next(), args.next()) {
        (Some(flag), Some(path)) if flag == "--config" => {
            let rest = args
                .map(|arg| arg.into_string().map_err(|_| usage()))
                .collect::<Result<Vec<_>, _>>()?;
            let path = PathBuf::from(path);
            Ok(if rest.is_empty() {
                Invocation::Serve(path)
            } else {
                Invocation::Admin(path, rest)
            })
        }
        _ => Err(usage()),
    }
}

pub fn load_config(path: &Path) -> Result<ServerConfig, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("could not read config {}: {error}", path.display()))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| format!("config {} is not valid UTF-8", path.display()))?;
    let config: ServerConfig = toml::from_str(text).map_err(|error| {
        let message = error.to_string();
        if message.contains("missing field `api`") {
            format!(
                "could not parse config {}: the [api] table is required; it is where \
                 browsers reach Citadel and where the library is set up",
                path.display()
            )
        } else {
            format!("could not parse config {}: {message}", path.display())
        }
    })?;
    validate_config(&config)?;
    Ok(config)
}

fn validate_config(config: &ServerConfig) -> Result<(), String> {
    if config.library_path.is_some() {
        return Err(
            "libraryPath has been removed: Citadel keeps the library it serves in citadel.db. \
             Delete the line, then set the library up in the browser as the administrator, or \
             run `citadel-server --config <path> libraries add <absolute path>`."
                .into(),
        );
    }
    if config
        .state_directory
        .as_ref()
        .is_some_and(|path| !path.is_absolute())
    {
        return Err("stateDirectory must be absolute".to_string());
    }
    if config.sharing.authentication_enabled.is_some() {
        return Err(
            "sharing.authenticationEnabled has been removed: Citadel server always \
             requires sign-in. Delete the line; readers use their Citadel app password \
             (`citadel-server --config <path> users app-password <name>`)."
                .into(),
        );
    }
    if config.sharing.port == 0 || config.sharing.port > u32::from(u16::MAX) {
        return Err("sharing.port must be between 1 and 65535".to_string());
    }
    if let OpdsBindTarget::Addresses { addresses } = &config.sharing.target {
        citadel_opds::network::validate_explicit_addresses(addresses, true)?;
    }

    let api = &config.api;
    if api.listen.port() == 0 {
        return Err("api.listen must use a nonzero port".into());
    }
    citadel_opds::network::validate_explicit_addresses(&[api.listen.ip().to_string()], true)?;
    api::PublicUrl::parse(&api.public_url)?;
    api.uploads.validate()?;
    api.metadata.validate()?;
    if let Some(directory) = &api.web_directory {
        api::web::validate(directory)?;
    }
    Ok(())
}

/// The configured state directory (or the platform default), created if needed.
pub(crate) fn state_directory(config: &ServerConfig) -> Result<PathBuf, String> {
    let state_directory = config
        .state_directory
        .clone()
        .map(Ok)
        .unwrap_or_else(default_state_directory)?;
    std::fs::create_dir_all(&state_directory).map_err(|error| {
        format!(
            "could not create stateDirectory {}: {error}",
            state_directory.display()
        )
    })?;
    Ok(state_directory)
}

/// The accounts database in the state directory.
pub(crate) fn open_accounts(config: &ServerConfig) -> Result<(PathBuf, CitadelStore), String> {
    let state_directory = state_directory(config)?;
    let accounts = CitadelStore::open(&state_directory.join(ACCOUNTS_DATABASE))
        .map_err(|error| error.to_string())?;
    Ok((state_directory, accounts))
}

/// The vault sealing users' provider keys. Keys sealed with a lost or
/// replaced vault key are kept but unreadable; their owners re-enter them.
fn open_secrets(
    state_directory: &Path,
    accounts: &CitadelStore,
) -> Result<Arc<citadel_core::vault::Vault>, String> {
    let vault = citadel_core::vault::Vault::open_or_create(&citadel_core::vault::directory(
        state_directory,
    ))?;
    match accounts.unreadable_provider_credentials(&vault) {
        Ok(0) => {}
        Ok(count) => eprintln!(
            "citadel_server warning=\"{count} saved provider key(s) were sealed with a different \
             vault key and must be entered again by their users\""
        ),
        Err(error) => {
            eprintln!("citadel_server warning=\"could not check provider keys: {error}\"")
        }
    }
    Ok(Arc::new(vault))
}

/// The OPDS readers: users granted the served library, with their app
/// passwords. Empty until a library is chosen and someone is granted it.
fn opds_users(
    accounts: &CitadelStore,
    library_id: Option<&str>,
) -> Result<Vec<OpdsCredentialSecret>, String> {
    let Some(library_id) = library_id else {
        return Ok(Vec::new());
    };
    Ok(accounts
        .app_credentials(library_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|credential| OpdsCredentialSecret {
            username: credential.username,
            password: credential.password,
        })
        .collect())
}

pub async fn run(config: ServerConfig, _config_path: &Path) -> Result<(), String> {
    validate_config(&config)?;
    let (state_directory, accounts) = open_accounts(&config)?;
    let accounts = Arc::new(accounts);
    let source = Arc::new(CalibreCatalogSource::empty());
    let served = Arc::new(ServedLibrary::new(
        accounts.clone(),
        source.clone(),
        state_directory.clone(),
    ));
    match served.open_registered()? {
        Some(info) if info.available => println!(
            "citadel_server library={} path={}",
            info.name,
            info.path
        ),
        Some(info) => eprintln!(
            "citadel_server warning=\"library {} at {} is unavailable: {}\"",
            info.name,
            info.path,
            info.problem.unwrap_or_default()
        ),
        None => println!(
            "citadel_server library=none message=\"No library yet; an administrator sets one up at {}\"",
            config.api.public_url
        ),
    }
    let setup_code = if accounts
        .administrator_exists()
        .map_err(|error| error.to_string())?
    {
        None
    } else {
        let code = generate_setup_code();
        println!(
            "citadel_server setup_code={code} message=\"No administrator yet. Open {} and enter \
             this code to create the administrator account.\"",
            config.api.public_url
        );
        Some(code)
    };

    let users = opds_users(&accounts, served.library_id().as_deref())?;
    let service = OpdsService::with_ephemeral_credentials(source.clone(), users.clone())
        .map_err(|error| error.message)?;
    let mut opds_started = false;
    let mut last_status = service.status().await;
    if ensure_opds_started(
        &service,
        &config,
        source.is_open() && !users.is_empty(),
        &mut opds_started,
    )
    .await?
    {
        last_status = service.status().await;
    }

    let secrets = match open_secrets(&state_directory, &accounts) {
        Ok(secrets) => secrets,
        Err(error) => {
            service.stop().await;
            return Err(error);
        }
    };
    let access = api::ApiAccess {
        accounts: accounts.clone(),
        served: served.clone(),
        public_url: api::PublicUrl::parse(&config.api.public_url)?,
        secrets,
        setup_code,
    };
    let staging = match api::Staging::open(
        state_directory.join(UPLOADS_DIRECTORY),
        config.api.uploads.clone(),
    ) {
        Ok(staging) => staging,
        Err(error) => {
            service.stop().await;
            return Err(error);
        }
    };
    let metadata = match api::Metadata::new(config.api.metadata.clone()) {
        Ok(metadata) => Arc::new(metadata),
        Err(error) => {
            service.stop().await;
            return Err(error);
        }
    };
    let router = api::router(
        source.clone(),
        &service,
        access,
        config.api.web_directory.as_deref(),
        staging,
        metadata,
    );
    let mut api = match api::start(&config.api, router).await {
        Ok(api) => {
            println!(
                "citadel_server api=http://{} public_url={}",
                config.api.listen, config.api.public_url
            );
            api
        }
        Err(error) => {
            service.stop().await;
            return Err(error);
        }
    };

    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    let mut shutdown = Box::pin(shutdown_signal());
    loop {
        tokio::select! {
            result = &mut shutdown => {
                result?;
                break;
            }
            error = api.wait() => {
                service.stop().await;
                return Err(error);
            }
            _ = interval.tick() => {
                let readers = refresh_opds_users(&service, &accounts, served.library_id()).await;
                match ensure_opds_started(&service, &config, source.is_open() && readers > 0, &mut opds_started).await {
                    Ok(true) => last_status = service.status().await,
                    Ok(false) => {}
                    Err(error) => {
                        api.stop().await;
                        service.stop().await;
                        return Err(error);
                    }
                }
                let status = service.status().await;
                if status != last_status {
                    log_status(&status);
                    last_status = status;
                }
            }
        }
    }

    api.stop().await;
    let stopped = service.stop().await;
    log_status(&stopped);
    Ok(())
}

/// Starts OPDS once there is a library to serve and a reader to serve it to.
/// Returns whether it started on this call; a start that fails is fatal, as
/// a port the operator chose being taken was before.
async fn ensure_opds_started(
    service: &OpdsService,
    config: &ServerConfig,
    ready: bool,
    started: &mut bool,
) -> Result<bool, String> {
    if *started || !ready {
        return Ok(false);
    }
    let status = service
        .start(config.sharing.start_config())
        .await
        .map_err(|error| error.message)?;
    log_status(&status);
    if is_fatal_startup(&status) {
        return Err(status
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "OPDS failed to start".to_string()));
    }
    *started = true;
    Ok(true)
}

/// The admin CLI and the setup routes change `citadel.db`; pick up added,
/// removed and re-granted users and rotated app passwords without a restart.
/// Returns how many readers the served library has.
async fn refresh_opds_users(
    service: &OpdsService,
    accounts: &Arc<CitadelStore>,
    library_id: Option<String>,
) -> usize {
    let accounts = accounts.clone();
    let users =
        tokio::task::spawn_blocking(move || opds_users(&accounts, library_id.as_deref())).await;
    let result = match users {
        Ok(Ok(users)) => {
            let count = users.len();
            service
                .replace_credentials(users)
                .map(|()| count)
                .map_err(|error| error.message)
        }
        Ok(Err(error)) => Err(error),
        Err(error) => Err(error.to_string()),
    };
    match result {
        Ok(count) => count,
        Err(error) => {
            eprintln!("citadel_server warning=\"could not refresh OPDS users: {error}\"");
            0
        }
    }
}

fn is_fatal_startup(status: &OpdsServiceStatus) -> bool {
    matches!(
        status.state,
        OpdsLifecycleState::Error | OpdsLifecycleState::Stopped
    )
}

fn log_status(status: &OpdsServiceStatus) {
    let urls = if status.urls.is_empty() {
        "-".to_string()
    } else {
        status.urls.join(",")
    };
    let error_code = status
        .error
        .as_ref()
        .map(|error| format!("{:?}", error.code))
        .unwrap_or_else(|| "-".to_string());
    let message = status
        .error
        .as_ref()
        .map(|error| format!("{:?}", error.message))
        .unwrap_or_else(|| "-".to_string());
    println!(
        "citadel_server state={:?} port={} urls={} error={} message={}",
        status.state,
        status
            .config
            .as_ref()
            .map(|config| config.port.to_string())
            .unwrap_or_else(|| "-".to_string()),
        urls,
        error_code,
        message
    );
}

#[cfg(unix)]
async fn shutdown_signal() -> Result<(), String> {
    use tokio::signal::unix::{signal, SignalKind};

    let mut interrupt = signal(SignalKind::interrupt())
        .map_err(|error| format!("could not install SIGINT handler: {error}"))?;
    let mut terminate = signal(SignalKind::terminate())
        .map_err(|error| format!("could not install SIGTERM handler: {error}"))?;
    tokio::select! {
        _ = interrupt.recv() => Ok(()),
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() -> Result<(), String> {
    tokio::signal::ctrl_c()
        .await
        .map_err(|error| format!("could not install Ctrl-C handler: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_require_one_explicit_config_path() {
        assert_eq!(
            invocation_from_args(["citadel-server", "--config", "/tmp/server.toml"]).unwrap(),
            Invocation::Serve(PathBuf::from("/tmp/server.toml"))
        );
        assert_eq!(
            invocation_from_args(["citadel-server", "--config", "/tmp/s.toml", "users", "list"])
                .unwrap(),
            Invocation::Admin(
                PathBuf::from("/tmp/s.toml"),
                vec!["users".into(), "list".into()]
            )
        );
        assert!(invocation_from_args(["citadel-server"]).is_err());
        assert!(invocation_from_args(["citadel-server", "server.toml"]).is_err());
    }

    const API: &str =
        "[api]\nlisten = \"127.0.0.1:8081\"\npublicUrl = \"https://books.example.com\"\n";
    const SHARING: &str = "[sharing]\nport = 8080\ntarget = \"localNetworks\"\n";

    #[test]
    fn api_is_required_and_needs_a_public_url_and_a_valid_listener() {
        let error = load_config_text(SHARING).unwrap_err();
        assert!(error.contains("[api] table is required"), "{error}");
        assert!(toml::from_str::<ServerConfig>(&format!(
            "{SHARING}[api]\nlisten = \"127.0.0.1:8081\"\n"
        ))
        .is_err());
        let with_api = format!("{SHARING}{API}");
        assert!(validate_config(&toml::from_str::<ServerConfig>(&with_api).unwrap()).is_ok());
        for invalid in [
            with_api.replace("127.0.0.1:8081", "127.0.0.1:0"),
            with_api.replace("https://books.example.com", "books.example.com"),
        ] {
            assert!(validate_config(&toml::from_str::<ServerConfig>(&invalid).unwrap()).is_err());
        }
        let config = toml::from_str::<ServerConfig>(&format!(
            "{with_api}\n[api.uploads]\nmaxFileBytes = 1048576\nmaxUploadsPerUser = 2\n"
        ))
        .unwrap();
        let uploads = &config.api.uploads;
        assert_eq!(
            (uploads.max_file_bytes, uploads.max_uploads_per_user),
            (1048576, 2)
        );
        assert_eq!(
            uploads.chunk_bytes,
            api::UploadConfig::default().chunk_bytes
        );
        assert!(validate_config(&config).is_ok());
        let error = validate_config(
            &toml::from_str::<ServerConfig>(&format!(
                "{with_api}\n[api.uploads]\nchunkBytes = 10\n"
            ))
            .unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("chunkBytes"), "{error}");
        assert!(toml::from_str::<ServerConfig>(&format!(
            "{with_api}\n[api.uploads]\nmaxSize = 10\n"
        ))
        .is_err());
    }

    fn load_config_text(text: &str) -> Result<ServerConfig, String> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("server.toml");
        std::fs::write(&path, text).unwrap();
        load_config(&path)
    }

    #[test]
    fn removed_settings_explain_their_replacements() {
        let config: ServerConfig = toml::from_str(&format!(
            "[sharing]\nport = 8080\nauthenticationEnabled = true\ntarget = \"localNetworks\"\n{API}"
        ))
        .unwrap();
        let error = validate_config(&config).unwrap_err();
        assert!(error.contains("always requires sign-in"), "{error}");
        assert!(error.contains("users app-password"), "{error}");

        let config: ServerConfig =
            toml::from_str(&format!("libraryPath = \"/srv/books\"\n{SHARING}{API}")).unwrap();
        let error = validate_config(&config).unwrap_err();
        assert!(error.contains("libraryPath has been removed"), "{error}");
        assert!(error.contains("libraries add"), "{error}");
    }

    #[test]
    fn config_rejects_relative_paths_unknown_fields_and_invalid_ports() {
        for text in [
            format!("stateDirectory = \"state\"\n{SHARING}{API}"),
            format!("stateDirectory = \"/tmp/state\"\nunknown = true\n{SHARING}{API}"),
            format!(
                "stateDirectory = \"/tmp/state\"\n[sharing]\nport = 0\ntarget = \"localNetworks\"\n{API}"
            ),
        ] {
            let rejected = match toml::from_str::<ServerConfig>(&text) {
                Ok(config) => validate_config(&config).is_err(),
                Err(_) => true,
            };
            assert!(rejected, "{text}");
        }
    }
}

#[cfg(unix)]
fn xdg_state_directory(xdg: Option<&Path>, home: Option<&Path>) -> Result<PathBuf, String> {
    xdg.filter(|path| path.is_absolute())
        .map(|path| path.join("citadel"))
        .or_else(|| {
            home.filter(|path| path.is_absolute())
                .map(|path| path.join(".local/state/citadel"))
        })
        .ok_or_else(|| "Set an absolute stateDirectory or configure XDG_STATE_HOME/HOME.".into())
}

fn default_state_directory() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        xdg_state_directory(
            std::env::var_os("XDG_STATE_HOME").as_deref().map(Path::new),
            dirs::home_dir().as_deref(),
        )
    }
    #[cfg(not(unix))]
    {
        dirs::data_local_dir()
            .map(|path| path.join("citadel"))
            .ok_or_else(|| "Set an absolute stateDirectory.".into())
    }
}

#[cfg(test)]
mod environment_tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn xdg_state_defaults_and_relative_xdg_values() {
        assert_eq!(
            xdg_state_directory(Some(Path::new("/state")), Some(Path::new("/home/reader")))
                .unwrap(),
            PathBuf::from("/state/citadel")
        );
        assert_eq!(
            xdg_state_directory(None, Some(Path::new("/home/reader"))).unwrap(),
            PathBuf::from("/home/reader/.local/state/citadel")
        );
        assert_eq!(
            xdg_state_directory(Some(Path::new("relative")), Some(Path::new("/home/reader")))
                .unwrap(),
            PathBuf::from("/home/reader/.local/state/citadel")
        );
        assert!(xdg_state_directory(None, None).is_err());
    }
}
