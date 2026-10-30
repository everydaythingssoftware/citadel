pub mod admin;
pub mod api;

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::NaiveDateTime;
use citadel_core::store::{CitadelStore, RegisteredLibrary};
use citadel_opds::{
    credential_store::OpdsCredentialSecret, CatalogBookQuery, CatalogFacet, CatalogSource,
    OpdsBindTarget, OpdsLifecycleState, OpdsService, OpdsServiceStatus, OpdsStartConfig,
};
use libcalibre::{BookId, BookPage, CalibreError, Library, ResolvedBookAsset};
use serde::Deserialize;

const ACCOUNTS_DATABASE: &str = "citadel.db";
const UPLOADS_DIRECTORY: &str = "uploads";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerConfig {
    pub library_path: PathBuf,
    pub state_directory: Option<PathBuf>,
    pub sharing: SharingConfig,
    pub api: Option<api::ApiConfig>,
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

pub struct CalibreCatalogSource {
    library: Mutex<Library>,
}

impl CalibreCatalogSource {
    pub fn open(library_path: &Path) -> Result<Self, String> {
        let library_path = library_path
            .to_str()
            .ok_or_else(|| "libraryPath must be valid UTF-8".to_string())?;
        let database = libcalibre::util::get_db_path(library_path)
            .ok_or_else(|| format!("libraryPath is not a Calibre library: {library_path}"))?;
        let library = Library::open_read_only(database)
            .map_err(|error| format!("could not open libraryPath: {error}"))?;
        Ok(Self {
            library: Mutex::new(library),
        })
    }
}

impl CatalogSource for CalibreCatalogSource {
    fn active_library_id(&self) -> Result<String, CalibreError> {
        self.library
            .lock()
            .expect("server library mutex poisoned")
            .library_uuid()
    }

    fn book_page(
        &self,
        query: CatalogBookQuery,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
        let mut library = self.library.lock().expect("server library mutex poisoned");
        let library_id = library.library_uuid()?;
        let updated_at = library.catalog_updated_at()?;
        let page = library.query_acquirable_books_with(query.into_calibre())?;
        Ok((library_id, updated_at, page))
    }

    fn authors(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        let mut library = self.library.lock().unwrap();
        library
            .catalog_facets(libcalibre::CatalogFacetKind::Authors)
            .map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id,
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
    }

    fn series(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        let mut library = self.library.lock().unwrap();
        library
            .catalog_facets(libcalibre::CatalogFacetKind::Series)
            .map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id,
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
    }

    fn tags(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        let mut library = self.library.lock().unwrap();
        library
            .catalog_facets(libcalibre::CatalogFacetKind::Tags)
            .map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id,
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
    }

    fn genres(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        let mut library = self.library.lock().unwrap();
        library
            .catalog_facets(libcalibre::CatalogFacetKind::Genres)
            .map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id,
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
    }

    fn book_file(&self, book_id: BookId, format: &str) -> Result<ResolvedBookAsset, CalibreError> {
        self.library
            .lock()
            .expect("server library mutex poisoned")
            .resolve_book_file(book_id, format)
    }

    fn book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
        self.library
            .lock()
            .expect("server library mutex poisoned")
            .resolve_book_cover(book_id)
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
    let config: ServerConfig = toml::from_str(text)
        .map_err(|error| format!("could not parse config {}: {error}", path.display()))?;
    validate_config(&config)?;
    Ok(config)
}

fn validate_config(config: &ServerConfig) -> Result<(), String> {
    if !config.library_path.is_absolute() {
        return Err("libraryPath must be absolute".to_string());
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

    if let Some(api) = &config.api {
        if api.listen.port() == 0 {
            return Err("api.listen must use a nonzero port".into());
        }
        citadel_opds::network::validate_explicit_addresses(&[api.listen.ip().to_string()], true)?;
        api::PublicUrl::parse(&api.public_url)?;
        api.uploads.validate()?;
        if let Some(directory) = &api.web_directory {
            api::web::validate(directory)?;
        }
    }
    Ok(())
}

/// The configured state directory (or the platform default), created if needed.
fn state_directory(config: &ServerConfig) -> Result<PathBuf, String> {
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

/// The accounts database, with this config's library registered under its
/// Calibre library UUID.
pub(crate) fn open_accounts(
    config: &ServerConfig,
    source: &CalibreCatalogSource,
) -> Result<(CitadelStore, RegisteredLibrary), String> {
    let library_id = source
        .active_library_id()
        .map_err(|error| format!("could not read the library's Calibre UUID: {error}"))?;
    let state_directory = state_directory(config)?;
    let accounts = CitadelStore::open(&state_directory.join(ACCOUNTS_DATABASE))
        .map_err(|error| error.to_string())?;
    let library = accounts
        .register_library(&library_id, &config.library_path, None)
        .map_err(|error| error.to_string())?;
    Ok((accounts, library))
}

fn opds_users(
    accounts: &CitadelStore,
    library_id: &str,
) -> Result<Vec<OpdsCredentialSecret>, String> {
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

pub async fn run(config: ServerConfig, config_path: &Path) -> Result<(), String> {
    validate_config(&config)?;
    let source = Arc::new(CalibreCatalogSource::open(&config.library_path)?);
    let (accounts, library) = open_accounts(&config, &source)?;
    let accounts = Arc::new(accounts);
    let users = opds_users(&accounts, &library.id)?;
    if users.is_empty() {
        return Err(format!(
            "No Citadel user can access this library yet. Create one with:\n  \
             citadel-server --config {} users add <name>",
            config_path.display()
        ));
    }
    let service = OpdsService::with_ephemeral_credentials(source.clone(), users)
        .map_err(|error| error.message)?;

    let initial = service
        .start(config.sharing.start_config())
        .await
        .map_err(|error| error.message)?;
    log_status(&initial);
    if is_fatal_startup(&initial) {
        return Err(initial
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "OPDS failed to start".to_string()));
    }

    let config_root = &config;
    let mut api = if let Some(config) = &config.api {
        let access = api::ApiAccess {
            accounts: accounts.clone(),
            library_id: library.id.clone(),
            public_url: api::PublicUrl::parse(&config.public_url)?,
        };
        let staging = match api::Staging::open(
            state_directory(&config_root)?.join(UPLOADS_DIRECTORY),
            config.uploads.clone(),
        ) {
            Ok(staging) => staging,
            Err(error) => {
                service.stop().await;
                return Err(error);
            }
        };
        let router = api::router(
            source,
            &service,
            access,
            config.web_directory.as_deref(),
            staging,
        );
        match api::start(config, router).await {
            Ok(api) => {
                println!(
                    "citadel_server api=http://{} public_url={}",
                    config.listen, config.public_url
                );
                Some(api)
            }
            Err(error) => {
                service.stop().await;
                return Err(error);
            }
        }
    } else {
        None
    };

    let mut last_status = initial;
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
            error = async {
                match &mut api {
                    Some(api) => api.wait().await,
                    None => std::future::pending::<String>().await,
                }
            } => {
                service.stop().await;
                return Err(error);
            }
            _ = interval.tick() => {
                refresh_opds_users(&service, &accounts, &library.id).await;
                let status = service.status().await;
                if status != last_status {
                    log_status(&status);
                    last_status = status;
                }
            }
        }
    }

    if let Some(api) = api {
        api.stop().await;
    }
    let stopped = service.stop().await;
    log_status(&stopped);
    Ok(())
}

/// The admin CLI edits `citadel.db` from another process; pick up added,
/// removed and re-granted users and rotated app passwords without a restart.
async fn refresh_opds_users(service: &OpdsService, accounts: &Arc<CitadelStore>, library_id: &str) {
    let accounts = accounts.clone();
    let library_id = library_id.to_string();
    let users = tokio::task::spawn_blocking(move || opds_users(&accounts, &library_id)).await;
    let result = match users {
        Ok(Ok(users)) => service
            .replace_credentials(users)
            .map_err(|error| error.message),
        Ok(Err(error)) => Err(error),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = result {
        eprintln!("citadel_server warning=\"could not refresh OPDS users: {error}\"");
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

    #[test]
    fn api_is_opt_in_and_requires_a_public_url_and_a_valid_listener() {
        let directory = tempfile::tempdir().unwrap();
        let base = format!(
            r#"libraryPath = {}
[sharing]
port = 8080
target = "localNetworks"
"#,
            toml::Value::String(directory.path().to_string_lossy().into_owned())
        );
        let config: ServerConfig = toml::from_str(&base).unwrap();
        assert!(config.api.is_none());
        assert!(validate_config(&config).is_ok());
        assert!(toml::from_str::<ServerConfig>(&format!(
            "{base}\n[api]\nlisten = \"127.0.0.1:8081\"\n"
        ))
        .is_err());
        let with_api = format!(
            "{base}\n[api]\nlisten = \"127.0.0.1:8081\"\npublicUrl = \"https://books.example.com\"\n"
        );
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
        let uploads = &config.api.as_ref().unwrap().uploads;
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

    #[test]
    fn removed_authentication_setting_explains_the_migration() {
        let directory = tempfile::tempdir().unwrap();
        let config: ServerConfig = toml::from_str(&format!(
            r#"libraryPath = {}
[sharing]
port = 8080
authenticationEnabled = true
target = "localNetworks"
"#,
            toml::Value::String(directory.path().to_string_lossy().into_owned())
        ))
        .unwrap();
        let error = validate_config(&config).unwrap_err();
        assert!(error.contains("always requires sign-in"), "{error}");
        assert!(error.contains("users app-password"), "{error}");
    }

    #[test]
    fn config_rejects_relative_paths_unknown_fields_and_invalid_ports() {
        for text in [
            r#"libraryPath = "library"
stateDirectory = "/tmp/state"
[sharing]
port = 8080
target = "localNetworks"
"#,
            r#"libraryPath = "/tmp/library"
stateDirectory = "/tmp/state"
unknown = true
[sharing]
port = 8080
target = "localNetworks"
"#,
            r#"libraryPath = "/tmp/library"
stateDirectory = "/tmp/state"
[sharing]
port = 0
target = "localNetworks"
"#,
        ] {
            let rejected = match toml::from_str::<ServerConfig>(text) {
                Ok(config) => validate_config(&config).is_err(),
                Err(_) => true,
            };
            assert!(rejected);
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
