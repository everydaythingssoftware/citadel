//! The library this server serves: which registered library was chosen, whether
//! it is open, and the administrator's ways of choosing one. Everything here
//! blocks on the filesystem or SQLite; routes call it off the async workers.
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use citadel_core::{
    error::{LibraryError, LibraryErrorCode},
    store::{CitadelStore, RegisteredLibrary, StoreError, User},
};
use libcalibre::{
    create_target_blocker, CalibreError, CreateTargetBlocker, Library, SchemaUpgrade,
};
use serde::Serialize;

use crate::{access, CalibreCatalogSource};

/// Folders in the state directory that are Citadel's own; a library may not
/// be created or adopted inside them.
const RESERVED_STATE_FOLDERS: &[&str] = &["secrets", "uploads"];

#[derive(Clone, Debug, Default)]
struct Served {
    registered: Option<RegisteredLibrary>,
    /// Why the registered library isn't open, when it isn't.
    problem: Option<String>,
}

pub struct ServedLibrary {
    accounts: Arc<CitadelStore>,
    source: Arc<CalibreCatalogSource>,
    state_directory: PathBuf,
    /// Where libraries are mounted, such as `/library` and `/libraries` in
    /// the container: each holds a library itself or one per subfolder.
    library_roots: Vec<PathBuf>,
    served: Mutex<Served>,
}

/// What the administrator sees about the served library.
#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServedLibraryInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub read_only: bool,
    /// The administrator chose to serve it read-only.
    pub read_only_chosen: bool,
    /// Why it is read-only when nobody chose that: the folder can't be
    /// changed by the server, and how to fix it.
    #[schema(required = true)]
    pub read_only_reason: Option<String>,
    /// False when the registered folder can't be opened right now; see `problem`.
    pub available: bool,
    #[schema(required = true)]
    pub problem: Option<String>,
    #[schema(required = true)]
    pub schema_version: Option<i32>,
    pub upgrade_available: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum InspectionStatus {
    /// A Calibre library; `library` says more.
    Library,
    /// A folder with nothing in it (or only OS droppings), or no folder yet.
    Empty,
    NotEmpty,
    /// The folder doesn't exist, but could be created.
    Missing,
    NotADirectory,
    /// The server process can't read it.
    Denied,
    /// Inside Citadel's own state folders, or would contain the state directory.
    Reserved,
    /// Not an absolute path.
    Relative,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectedLibrary {
    pub book_count: i64,
    pub author_count: i64,
    pub schema_version: i32,
    pub upgrade_available: bool,
    /// False when the schema is older than this server opens; `message` says
    /// what to do.
    pub supported: bool,
    /// The server can change it: add, edit and upgrade.
    pub writable: bool,
    /// Why not, when it can't, and how to fix it.
    #[schema(required = true)]
    pub read_only_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    /// The path as the server resolved it.
    pub path: String,
    /// The folder's own name, the default display name for a library here.
    pub name: String,
    pub status: InspectionStatus,
    #[schema(required = true)]
    pub library: Option<InspectedLibrary>,
    /// Why the path can't be used as asked, when it can't.
    #[schema(required = true)]
    pub message: Option<String>,
}

/// Libraries already in the folders mounted for them, and empty mounted
/// folders a new library could start in.
#[derive(Clone, Debug, Default, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FoundLibraries {
    /// One per Calibre library, however many paths reach it.
    pub libraries: Vec<Inspection>,
    pub create_in: Vec<Inspection>,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_library: bool,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    #[schema(required = true)]
    pub parent: Option<String>,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemaUpgradeInfo {
    pub from: i32,
    pub to: i32,
    /// The copy of `metadata.db` taken first, beside the library's database.
    pub backup: String,
}

pub(crate) fn store_error(error: StoreError) -> LibraryError {
    match error {
        StoreError::Invalid(message) => LibraryError::invalid(message),
        StoreError::NotFound(message) => LibraryError::new(LibraryErrorCode::NotFound, message),
        StoreError::Conflict(message) => LibraryError::new(LibraryErrorCode::Conflict, message),
        StoreError::Storage(message) | StoreError::Unusable { message, .. } => {
            LibraryError::new(LibraryErrorCode::Internal, message)
        }
    }
}

fn calibre_error(error: CalibreError) -> LibraryError {
    match error {
        CalibreError::UnsupportedSchema { .. } | CalibreError::LibraryAlreadyExists(_) => {
            LibraryError::invalid(error.to_string())
        }
        CalibreError::ReadOnlyLibrary => LibraryError::read_only(),
        other => LibraryError::new(LibraryErrorCode::Internal, other.to_string()),
    }
}

pub fn no_library_yet() -> LibraryError {
    LibraryError::new(
        LibraryErrorCode::Unavailable,
        "No library is set up on this server yet",
    )
}

impl ServedLibrary {
    pub fn new(
        accounts: Arc<CitadelStore>,
        source: Arc<CalibreCatalogSource>,
        state_directory: PathBuf,
    ) -> Self {
        Self {
            accounts,
            source,
            state_directory,
            library_roots: Vec::new(),
            served: Mutex::default(),
        }
    }

    /// Looks for libraries under `roots` (see [`ServedLibrary::found`]).
    pub fn with_library_roots(mut self, roots: Vec<PathBuf>) -> Self {
        self.library_roots = roots;
        self
    }

    pub fn state_directory(&self) -> &Path {
        &self.state_directory
    }

    pub fn accounts(&self) -> &Arc<CitadelStore> {
        &self.accounts
    }

    pub fn source(&self) -> &Arc<CalibreCatalogSource> {
        &self.source
    }

    fn served(&self) -> std::sync::MutexGuard<'_, Served> {
        self.served
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The Calibre UUID of the registered library, open or not.
    pub fn library_id(&self) -> Option<String> {
        self.served()
            .registered
            .as_ref()
            .map(|library| library.id.clone())
    }

    pub fn registered(&self) -> Option<RegisteredLibrary> {
        self.served().registered.clone()
    }

    pub fn is_configured(&self) -> bool {
        self.served().registered.is_some()
    }

    /// Opens the registry's active library, if any. A folder that can't be
    /// opened leaves the server running without it and is reported in
    /// [`ServedLibrary::info`]; only `citadel.db` failures are errors.
    pub fn open_registered(&self) -> Result<Option<ServedLibraryInfo>, String> {
        let registered = self
            .accounts
            .active_library()
            .map_err(|error| error.to_string())?;
        let Some(registered) = registered else {
            *self.served() = Served::default();
            return Ok(None);
        };
        let problem = match self.open(Path::new(&registered.path), registered.read_only) {
            Ok(()) => None,
            Err(error) => {
                self.source.close();
                Some(error)
            }
        };
        *self.served() = Served {
            registered: Some(registered),
            problem,
        };
        Ok(self.info())
    }

    /// Takes the library the source already has open as the served one,
    /// registering it under its Calibre UUID. For hosts and tests that open
    /// the library themselves.
    pub fn register_open(&self) -> Result<RegisteredLibrary, String> {
        let path = self
            .source
            .path()
            .ok_or_else(|| "no library is open".to_string())?;
        let id = self
            .source
            .with(|library| library.library_uuid())
            .map_err(|error| error.to_string())?;
        let registered = self
            .accounts
            .register_library(&id, &path, None)
            .and_then(|library| self.accounts.set_active_library(&library.id))
            .map_err(|error| error.to_string())?;
        *self.served() = Served {
            registered: Some(registered.clone()),
            problem: None,
        };
        Ok(registered)
    }

    pub fn info(&self) -> Option<ServedLibraryInfo> {
        let served = self.served().clone();
        let registered = served.registered?;
        let (schema_version, upgrade_available) = if served.problem.is_none() {
            self.source
                .with(|library| {
                    let version = library.schema_version()?;
                    let upgrade = library.upgrade_available()?;
                    Ok((Some(version), upgrade))
                })
                .unwrap_or((None, false))
        } else {
            (None, false)
        };
        let read_only = self.source.read_only();
        let read_only_reason = (read_only && !registered.read_only && served.problem.is_none())
            .then(|| access::explain_library(Path::new(&registered.path)))
            .flatten();
        Some(ServedLibraryInfo {
            read_only_chosen: registered.read_only,
            read_only_reason,
            id: registered.id,
            name: registered.display_name,
            path: registered.path,
            read_only,
            available: served.problem.is_none(),
            problem: served.problem,
            schema_version,
            upgrade_available,
        })
    }

    /// Where the directory browser opens: the first library mount, else the
    /// process's home, else the root.
    pub fn browse_root(&self) -> PathBuf {
        if let Some(root) = self.library_roots.iter().find(|root| root.is_dir()) {
            return root.clone();
        }
        dirs::home_dir()
            .filter(|home| home.is_absolute() && home.is_dir())
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
    }

    /// Absolute, resolved through whatever part of it exists.
    fn absolute_path(raw: &str) -> Result<PathBuf, (InspectionStatus, String)> {
        let path = Path::new(raw.trim());
        if raw.trim().is_empty() || !path.is_absolute() {
            return Err((
                InspectionStatus::Relative,
                "Enter an absolute path on the server, such as /srv/books".into(),
            ));
        }
        Ok(resolve(path))
    }

    /// [`Self::absolute_path`], and outside Citadel's own state folders: a
    /// place a library may be created or adopted.
    fn checked_path(&self, raw: &str) -> Result<PathBuf, (InspectionStatus, String)> {
        let resolved = Self::absolute_path(raw)?;
        let state = resolve(&self.state_directory);
        if state.starts_with(&resolved) {
            return Err((
                InspectionStatus::Reserved,
                format!(
                    "{} holds Citadel's own state directory; a library can't contain it",
                    resolved.display()
                ),
            ));
        }
        if RESERVED_STATE_FOLDERS
            .iter()
            .any(|folder| resolved.starts_with(state.join(folder)))
        {
            return Err((
                InspectionStatus::Reserved,
                format!("{} is reserved for Citadel's own files", resolved.display()),
            ));
        }
        Ok(resolved)
    }

    pub fn inspect(&self, raw: &str) -> Inspection {
        let resolved = match self.checked_path(raw) {
            Ok(path) => path,
            Err((status, message)) => {
                return Inspection {
                    path: raw.trim().to_string(),
                    name: String::new(),
                    status,
                    library: None,
                    message: Some(message),
                }
            }
        };
        let name = resolved
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let describe = |status, library, message: Option<String>| Inspection {
            path: resolved.to_string_lossy().into_owned(),
            name: name.clone(),
            status,
            library,
            message,
        };
        match std::fs::metadata(&resolved) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return describe(InspectionStatus::Missing, None, None)
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return describe(InspectionStatus::Denied, None, Some(cant_read(&resolved)))
            }
            Err(error) => return describe(InspectionStatus::Denied, None, Some(error.to_string())),
            Ok(metadata) if !metadata.is_dir() => {
                return describe(
                    InspectionStatus::NotADirectory,
                    None,
                    Some(format!("{} is a file, not a folder", resolved.display())),
                )
            }
            Ok(_) => {}
        }
        if let Some(database) = libcalibre::util::get_db_path(&resolved.to_string_lossy()) {
            return match inspect_library(&resolved, &database) {
                Ok(library) => {
                    let message = (!library.supported).then(|| {
                        format!(
                            "This library's database is schema version {}, older than Citadel supports ({}); open it in Calibre once to upgrade it",
                            library.schema_version,
                            libcalibre::MINIMUM_SCHEMA_VERSION
                        )
                    });
                    describe(InspectionStatus::Library, Some(library), message)
                }
                Err(error) => describe(
                    InspectionStatus::Denied,
                    None,
                    Some(format!("Couldn't read the library's database: {error}")),
                ),
            };
        }
        match create_target_blocker(&resolved) {
            Ok(None) => describe(InspectionStatus::Empty, None, None),
            Ok(Some(CreateTargetBlocker::NotEmpty)) => describe(
                InspectionStatus::NotEmpty,
                None,
                Some(
                    "This folder already contains files. Pick an empty folder for a new library."
                        .into(),
                ),
            ),
            Ok(Some(CreateTargetBlocker::AlreadyALibrary)) => describe(
                InspectionStatus::Library,
                None,
                Some("This folder is already a Calibre library.".into()),
            ),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                describe(InspectionStatus::Denied, None, Some(cant_read(&resolved)))
            }
            Err(error) => describe(InspectionStatus::Denied, None, Some(error.to_string())),
        }
    }

    /// Subfolders of `raw` (or the browse root), hiding dotfolders. Nothing
    /// under Citadel's reserved state folders is listed.
    pub fn list_directory(&self, raw: Option<&str>) -> Result<DirectoryListing, LibraryError> {
        let path = match raw {
            Some(raw) => {
                Self::absolute_path(raw).map_err(|(_, message)| LibraryError::invalid(message))?
            }
            None => self.browse_root(),
        };
        let read = std::fs::read_dir(&path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => LibraryError::new(
                LibraryErrorCode::NotFound,
                format!("{} doesn't exist", path.display()),
            ),
            std::io::ErrorKind::PermissionDenied => LibraryError::invalid(cant_read(&path)),
            _ => LibraryError::invalid(format!("Couldn't read {}: {error}", path.display())),
        })?;
        let mut entries: Vec<DirectoryEntry> = read
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            .map(|entry| {
                let path = entry.path();
                DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    is_library: path.join("metadata.db").is_file(),
                    path: path.to_string_lossy().into_owned(),
                }
            })
            .collect();
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(DirectoryListing {
            parent: path
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned()),
            path: path.to_string_lossy().into_owned(),
            entries,
        })
    }

    /// Makes a new library at `raw` and serves it. Refused while a library is
    /// already served.
    pub fn create(
        &self,
        raw: &str,
        name: Option<&str>,
        administrator: &User,
    ) -> Result<ServedLibraryInfo, LibraryError> {
        self.refuse_if_serving()?;
        let inspection = self.inspect(raw);
        match inspection.status {
            InspectionStatus::Empty | InspectionStatus::Missing => {}
            InspectionStatus::Library => {
                return Err(LibraryError::new(
                    LibraryErrorCode::Conflict,
                    "This folder is already a Calibre library; use it instead of creating one",
                ))
            }
            _ => {
                return Err(LibraryError::invalid(
                    inspection
                        .message
                        .unwrap_or_else(|| "This folder can't take a new library".into()),
                ))
            }
        }
        drop(Library::create_library_at(&inspection.path).map_err(calibre_error)?);
        self.serve(Path::new(&inspection.path), name, false, administrator)
    }

    /// Serves the existing library at `raw`, upgrading its schema first when
    /// asked. While the registered library is unavailable, only that same
    /// library (by UUID) can be adopted from a new location.
    pub fn adopt(
        &self,
        raw: &str,
        name: Option<&str>,
        upgrade: bool,
        read_only: bool,
        administrator: &User,
    ) -> Result<ServedLibraryInfo, LibraryError> {
        self.refuse_if_serving()?;
        if upgrade && read_only {
            return Err(LibraryError::invalid(
                "A library served read-only can't be upgraded; serve it writable to upgrade it",
            ));
        }
        let inspection = self.inspect(raw);
        let library = match (inspection.status, inspection.library) {
            (InspectionStatus::Library, Some(library)) => library,
            (InspectionStatus::Library, None) | (InspectionStatus::Denied, _) => {
                return Err(LibraryError::invalid(
                    inspection
                        .message
                        .unwrap_or_else(|| "Couldn't read that library".into()),
                ))
            }
            _ => {
                return Err(LibraryError::new(
                    LibraryErrorCode::NotFound,
                    format!("No Calibre library at {}", inspection.path),
                ))
            }
        };
        if !library.supported {
            return Err(LibraryError::invalid(
                inspection.message.unwrap_or_default(),
            ));
        }
        let path = Path::new(&inspection.path);
        if let Some(registered) = self.registered() {
            let database = libcalibre::util::get_db_path(&inspection.path).ok_or_else(|| {
                LibraryError::new(LibraryErrorCode::NotFound, "No Calibre library there")
            })?;
            let id = Library::open_read_only(database)
                .and_then(|mut library| library.library_uuid())
                .map_err(calibre_error)?;
            if id != registered.id {
                return Err(LibraryError::new(
                    LibraryErrorCode::Conflict,
                    format!(
                        "That folder holds a different library than the one this server serves ({}). Choose where {} moved to.",
                        registered.display_name, registered.display_name
                    ),
                ));
            }
        }
        if upgrade && library.upgrade_available {
            let database = libcalibre::util::get_db_path(&inspection.path).ok_or_else(|| {
                LibraryError::new(LibraryErrorCode::NotFound, "No Calibre library there")
            })?;
            Library::new(database)
                .and_then(|mut library| library.upgrade())
                .map_err(calibre_error)?;
        }
        self.serve(path, name, read_only, administrator)
    }

    fn refuse_if_serving(&self) -> Result<(), LibraryError> {
        let served = self.served().clone();
        if served.registered.is_some() && served.problem.is_none() {
            return Err(LibraryError::new(
                LibraryErrorCode::Conflict,
                "This server already serves a library",
            ));
        }
        Ok(())
    }

    /// Opens the library at `path`: read-only when asked, otherwise for
    /// writing where the folder allows it.
    fn open(&self, path: &Path, read_only: bool) -> Result<(), String> {
        if read_only {
            self.source.replace_read_only_from_path(path)
        } else {
            self.source.replace_from_path(path)
        }
    }

    fn serve(
        &self,
        path: &Path,
        name: Option<&str>,
        read_only: bool,
        administrator: &User,
    ) -> Result<ServedLibraryInfo, LibraryError> {
        self.open(path, read_only)
            .map_err(|error| LibraryError::new(LibraryErrorCode::Internal, error))?;
        let id = self
            .source
            .with(|library| library.library_uuid())
            .map_err(calibre_error)?;
        let registered = self
            .accounts
            .register_library(
                &id,
                path,
                name.map(str::trim).filter(|name| !name.is_empty()),
            )
            .and_then(|library| self.accounts.set_library_read_only(&library.id, read_only))
            .and_then(|library| self.accounts.set_active_library(&library.id))
            .and_then(|library| {
                self.accounts
                    .grant(&administrator.username, &library.id)
                    .map(|()| library)
            })
            .map_err(store_error)?;
        *self.served() = Served {
            registered: Some(registered),
            problem: None,
        };
        self.register_found();
        Ok(self.info().expect("a library was just registered"))
    }

    /// The libraries under the library roots: each root that is itself a
    /// library, else each of its subfolders that is one, each library listed
    /// once however many paths reach it. An empty root is offered for a new
    /// library only when something is mounted there, so a forgotten volume
    /// never puts books inside a container.
    pub fn found(&self) -> FoundLibraries {
        let mut found = FoundLibraries::default();
        let mut seen = std::collections::HashSet::new();
        for root in &self.library_roots {
            if !root.is_dir() {
                continue;
            }
            let candidates: Vec<PathBuf> = if root.join("metadata.db").is_file() {
                vec![root.clone()]
            } else {
                let mut children: Vec<PathBuf> = std::fs::read_dir(root)
                    .map(|entries| {
                        entries
                            .filter_map(Result::ok)
                            .map(|entry| entry.path())
                            .filter(|path| path.join("metadata.db").is_file())
                            .collect()
                    })
                    .unwrap_or_default();
                children.sort();
                if children.is_empty() && is_mount_point(root) {
                    let inspection = self.inspect(&root.to_string_lossy());
                    if inspection.status == InspectionStatus::Empty {
                        found.create_in.push(inspection);
                    }
                }
                children
            };
            for path in candidates {
                let inspection = self.inspect(&path.to_string_lossy());
                if inspection.status != InspectionStatus::Library || inspection.library.is_none() {
                    continue;
                }
                let key = library_uuid(&path).unwrap_or_else(|| inspection.path.clone());
                if seen.insert(key) {
                    found.libraries.push(inspection);
                }
            }
        }
        found
    }

    /// Records every found library in the registry, so serving another later
    /// (CDL-71) finds it already known. Best effort.
    fn register_found(&self) {
        for inspection in self.found().libraries {
            let path = Path::new(&inspection.path);
            if let Some(id) = library_uuid(path) {
                if let Err(error) = self.accounts.register_library(&id, path, None) {
                    eprintln!(
                        "citadel_server warning=\"could not record the library at {}: {error}\"",
                        path.display()
                    );
                }
            }
        }
    }

    /// Tries the registered folder again, for a library that was unreachable.
    pub fn reopen(&self) -> Result<ServedLibraryInfo, LibraryError> {
        self.open_registered()
            .map_err(|error| LibraryError::new(LibraryErrorCode::Internal, error))?
            .ok_or_else(no_library_yet)
    }

    /// Runs Calibre's pending schema steps on the served library.
    pub fn upgrade(&self) -> Result<SchemaUpgradeInfo, LibraryError> {
        if !self.is_configured() {
            return Err(no_library_yet());
        }
        if self.source.read_only() {
            return Err(LibraryError::read_only());
        }
        let SchemaUpgrade { from, to, backup } = self
            .source
            .with(|library| library.upgrade())
            .map_err(calibre_error)?
            .ok_or_else(|| {
                LibraryError::new(
                    LibraryErrorCode::Conflict,
                    "This library is already at Calibre's current format",
                )
            })?;
        Ok(SchemaUpgradeInfo {
            from,
            to,
            backup: backup.to_string_lossy().into_owned(),
        })
    }
}

/// A path as the server reports and stores it: canonicalized through
/// whatever part of it exists, so a folder that doesn't exist yet still
/// resolves symlinks and `..` in its parents (see
/// [`citadel_core::store::canonical_path`] for the Windows prefix).
pub fn resolve(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(canonical) = citadel_core::store::canonical_path(&current) {
            return missing
                .into_iter()
                .rev()
                .fold(canonical, |base, part: std::ffi::OsString| base.join(part));
        }
        match (current.file_name(), current.parent()) {
            (Some(name), Some(parent)) => {
                missing.push(name.to_os_string());
                current = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

fn inspect_library(
    folder: &Path,
    database: &libcalibre::util::ValidDbPath,
) -> Result<InspectedLibrary, CalibreError> {
    let stats = libcalibre::library_stats(database)?;
    let schema_version = libcalibre::peek_schema_version(database)?;
    let read_only_reason = access::explain_library(folder);
    Ok(InspectedLibrary {
        book_count: stats.book_count,
        author_count: stats.author_count,
        schema_version,
        upgrade_available: schema_version < libcalibre::SCHEMA_VERSION,
        supported: schema_version >= libcalibre::MINIMUM_SCHEMA_VERSION,
        writable: read_only_reason.is_none(),
        read_only_reason,
    })
}

/// Says the folder can't be read, and how to fix that when we can tell.
fn cant_read(path: &Path) -> String {
    access::explain(path, false)
        .unwrap_or_else(|| format!("The server can't read {}", path.display()))
}

fn library_uuid(folder: &Path) -> Option<String> {
    let database = libcalibre::util::get_db_path(&folder.to_string_lossy())?;
    Library::open_read_only(database)
        .and_then(|mut library| library.library_uuid())
        .ok()
}

/// Something is mounted at `path`: it is on a different device than its
/// parent.
#[cfg(unix)]
fn is_mount_point(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let parent = path.parent().unwrap_or(path);
    match (std::fs::metadata(path), std::fs::metadata(parent)) {
        (Ok(here), Ok(above)) => here.dev() != above.dev() || here.ino() == above.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn is_mount_point(_path: &Path) -> bool {
    false
}
