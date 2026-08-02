use std::{
    ffi::OsString,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::NaiveDateTime;
use citadel_opds::{
    CatalogSource, OpdsErrorCode, OpdsLifecycleState, OpdsService, OpdsServiceStatus,
    OpdsStartConfig,
};
use libcalibre::{BookId, BookPage, CalibreError, Library, ResolvedBookAsset};
use serde::Deserialize;

const CREDENTIAL_FILENAME: &str = "opds-credentials.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerConfig {
    pub library_path: PathBuf,
    pub state_directory: PathBuf,
    pub sharing: OpdsStartConfig,
    pub credentials: Option<CredentialInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialInput {
    pub username: String,
    pub password_environment: String,
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
        let library = Library::new(database)
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
        limit: i64,
        offset: i64,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
        let mut library = self.library.lock().expect("server library mutex poisoned");
        let library_id = library.library_uuid()?;
        let updated_at = library.catalog_updated_at()?;
        let page = library.query_acquirable_books(limit, offset)?;
        Ok((library_id, updated_at, page))
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

pub fn config_path_from_args<I, S>(args: I) -> Result<PathBuf, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut args = args.into_iter().map(Into::into);
    let program = args
        .next()
        .unwrap_or_else(|| OsString::from("citadel-server"));
    let usage = || format!("usage: {} --config <path>", program.to_string_lossy());
    match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(path), None) if flag == "--config" => Ok(PathBuf::from(path)),
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
    if !config.state_directory.is_absolute() {
        return Err("stateDirectory must be absolute".to_string());
    }
    if config.sharing.port == 0 || config.sharing.port > u32::from(u16::MAX) {
        return Err("sharing.port must be between 1 and 65535".to_string());
    }
    if let citadel_opds::OpdsBindTarget::Addresses { addresses } = &config.sharing.target {
        if addresses.is_empty() {
            return Err("sharing.target.addresses must not be empty".to_string());
        }
        for address in addresses {
            let address = address
                .parse::<IpAddr>()
                .map_err(|_| format!("invalid sharing target address: {address}"))?;
            if address.is_unspecified() {
                return Err("wildcard sharing target addresses are not allowed".to_string());
            }
        }
    }
    if let Some(credentials) = &config.credentials {
        if credentials.username.trim().is_empty() {
            return Err("credentials.username must not be empty".to_string());
        }
        if credentials.password_environment.trim().is_empty() {
            return Err("credentials.passwordEnvironment must not be empty".to_string());
        }
    }
    Ok(())
}

pub async fn run(config: ServerConfig) -> Result<(), String> {
    std::fs::create_dir_all(&config.state_directory).map_err(|error| {
        format!(
            "could not create stateDirectory {}: {error}",
            config.state_directory.display()
        )
    })?;
    let source = Arc::new(CalibreCatalogSource::open(&config.library_path)?);
    let service = OpdsService::new(source, config.state_directory.join(CREDENTIAL_FILENAME))
        .map_err(|error| format!("could not load OPDS credentials: {error}"))?;

    if let Some(credentials) = config.credentials {
        let password = std::env::var_os(&credentials.password_environment).ok_or_else(|| {
            format!(
                "credential environment variable {} is not set",
                credentials.password_environment
            )
        })?;
        let password = password.into_string().map_err(|_| {
            format!(
                "credential environment variable {} is not valid UTF-8",
                credentials.password_environment
            )
        })?;
        service
            .configure_credentials(credentials.username, password)
            .await
            .map_err(|error| error.message)?;
    }

    let initial = service
        .start(config.sharing)
        .await
        .map_err(|error| error.message)?;
    log_status(&initial);
    if is_fatal_startup(&initial) {
        return Err(initial
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "OPDS failed to start".to_string()));
    }

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
            _ = interval.tick() => {
                let status = service.status().await;
                if status != last_status {
                    log_status(&status);
                    last_status = status;
                }
            }
        }
    }

    let stopped = service.stop().await;
    log_status(&stopped);
    Ok(())
}

fn is_fatal_startup(status: &OpdsServiceStatus) -> bool {
    matches!(
        status.error.as_ref().map(|error| &error.code),
        Some(
            OpdsErrorCode::InvalidPort
                | OpdsErrorCode::LibraryNotReady
                | OpdsErrorCode::InvalidCredentials
                | OpdsErrorCode::CredentialsRequired
                | OpdsErrorCode::CredentialStorageFailed
                | OpdsErrorCode::ConfigurationConflict
                | OpdsErrorCode::Unexpected
        )
    ) || status.state == OpdsLifecycleState::Stopped
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
            .port
            .map(|port| port.to_string())
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
            config_path_from_args(["citadel-server", "--config", "/tmp/server.toml"]).unwrap(),
            PathBuf::from("/tmp/server.toml")
        );
        assert!(config_path_from_args(["citadel-server"]).is_err());
        assert!(config_path_from_args(["citadel-server", "server.toml"]).is_err());
    }

    #[test]
    fn config_rejects_relative_paths_unknown_fields_and_invalid_ports() {
        for text in [
            r#"libraryPath = "library"
stateDirectory = "/tmp/state"
[sharing]
port = 8080
authenticationEnabled = false
[sharing.target]
type = "allLocalNetworks"
"#,
            r#"libraryPath = "/tmp/library"
stateDirectory = "/tmp/state"
unknown = true
[sharing]
port = 8080
authenticationEnabled = false
[sharing.target]
type = "allLocalNetworks"
"#,
            r#"libraryPath = "/tmp/library"
stateDirectory = "/tmp/state"
[sharing]
port = 0
authenticationEnabled = false
[sharing.target]
type = "allLocalNetworks"
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
