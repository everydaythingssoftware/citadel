//! Detection-led first-run onboarding: find an existing Calibre library,
//! judge candidate paths (cloud-sync risk, create-target validity), and
//! suggest where a brand-new library should live.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where [`detect_calibre_library`] found its hit.
#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DetectionSource {
    /// `library_path` in Calibre's own `global.py.json`.
    CalibreConfig,
    /// Calibre's default `~/Calibre Library` folder.
    DefaultFolder,
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq, Eq)]
pub struct DetectedLibrary {
    pub path: String,
    pub source: DetectionSource,
}

/// Best-effort cloud-sync verdict for a candidate library path. Informational
/// only — the UX warns, it never blocks. Unknown providers (Seafile, Syncthing,
/// …) report `synced: false`.
#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq, Eq)]
pub struct SyncStatus {
    pub synced: bool,
    pub provider: Option<String>,
}

/// Find an existing Calibre library: the location Calibre itself records in
/// its config wins; otherwise probe Calibre's default folder. Either candidate
/// must actually hold a `metadata.db` (via `get_db_path`) or it falls through.
pub fn detect_calibre_library(home: &Path) -> Option<DetectedLibrary> {
    detect_from(calibre_config_file(home).as_deref(), home)
}

/// Testable core of [`detect_calibre_library`]: the config-file location is
/// explicit instead of resolved from the host OS.
fn detect_from(config_file: Option<&Path>, home: &Path) -> Option<DetectedLibrary> {
    if let Some(path) = config_file.and_then(configured_library_path) {
        if libcalibre::util::get_db_path(&path).is_some() {
            return Some(DetectedLibrary {
                path,
                source: DetectionSource::CalibreConfig,
            });
        }
    }

    let default_folder = home.join("Calibre Library").to_string_lossy().into_owned();
    if libcalibre::util::get_db_path(&default_folder).is_some() {
        return Some(DetectedLibrary {
            path: default_folder,
            source: DetectionSource::DefaultFolder,
        });
    }

    None
}

/// Calibre's `global.py.json` for the host OS. All branches are plain path
/// math, so every platform's resolution stays unit-testable from any host.
fn calibre_config_file(home: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(macos_calibre_config(home))
    } else if cfg!(windows) {
        windows_calibre_config(std::env::var_os("APPDATA").map(PathBuf::from))
    } else {
        Some(unix_calibre_config(
            home,
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        ))
    }
}

fn macos_calibre_config(home: &Path) -> PathBuf {
    home.join("Library/Preferences/calibre/global.py.json")
}

/// `$XDG_CONFIG_HOME/calibre/global.py.json`; the XDG spec says a missing or
/// relative `$XDG_CONFIG_HOME` means `~/.config`.
fn unix_calibre_config(home: &Path, xdg_config_home: Option<PathBuf>) -> PathBuf {
    xdg_config_home
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| home.join(".config"))
        .join("calibre/global.py.json")
}

fn windows_calibre_config(appdata: Option<PathBuf>) -> Option<PathBuf> {
    appdata.map(|dir| dir.join("calibre").join("global.py.json"))
}

/// `library_path` from a Calibre `global.py.json`. A missing file, unreadable
/// file, malformed JSON, missing key, or non-string value all mean "nothing
/// configured" — detection falls through, it never errors.
fn configured_library_path(config_file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config_file).ok()?;
    let config: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(config.get("library_path")?.as_str()?.to_string())
}

/// Suggested location for a brand-new library: `~/Citadel` (macOS/Linux),
/// `%USERPROFILE%\Citadel` (Windows). Only resolved here — creation happens
/// in `clb_cmd_create_library` once the user confirms.
pub fn default_new_library_path(home: &Path) -> String {
    home.join("Citadel").to_string_lossy().into_owned()
}

pub fn path_sync_status(path: &Path) -> SyncStatus {
    match sync_provider(path) {
        Some(provider) => SyncStatus {
            synced: true,
            provider: Some(provider),
        },
        None => SyncStatus {
            synced: false,
            provider: None,
        },
    }
}

/// Best-effort provider identification, in two passes:
///
/// 1. Path components:
///    - `Mobile Documents` — every iCloud-synced container lives under
///      `~/Library/Mobile Documents/` (iCloud Drive proper is its
///      `com~apple~CloudDocs` child).
///    - `CloudStorage` — macOS File Provider roots mount as
///      `~/Library/CloudStorage/<Provider>-<Account>`; anything under it is
///      synced by definition, known or not.
///    - `Dropbox` / `OneDrive*` / `Google Drive` / `GoogleDrive` — the
///      classic app-managed folder names. OneDrive matches as a prefix
///      because business accounts name it "OneDrive - <Org>"; `GoogleDrive`
///      is the stream-mount volume name (`/Volumes/GoogleDrive/My Drive`).
/// 2. Well-known marker entries in ancestors: a Dropbox root carries a hidden
///    `.dropbox.cache` dir (legacy clients, a `.dropbox` file) even when the
///    folder was renamed or relocated.
fn sync_provider(path: &Path) -> Option<String> {
    let components: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();

    for (i, name) in components.iter().enumerate() {
        if name == "Mobile Documents" {
            return Some("iCloud Drive".to_string());
        }
        if name == "CloudStorage" {
            if let Some(root) = components.get(i + 1) {
                return Some(cloud_storage_provider(root));
            }
        }
        if name.eq_ignore_ascii_case("Dropbox") {
            return Some("Dropbox".to_string());
        }
        if name.to_ascii_lowercase().starts_with("onedrive") {
            return Some("OneDrive".to_string());
        }
        if name.eq_ignore_ascii_case("Google Drive") || name.eq_ignore_ascii_case("GoogleDrive") {
            return Some("Google Drive".to_string());
        }
    }

    for dir in path.ancestors() {
        if dir.join(".dropbox.cache").exists() || dir.join(".dropbox").exists() {
            return Some("Dropbox".to_string());
        }
    }

    None
}

/// File Provider roots look like `GoogleDrive-user@gmail.com`,
/// `OneDrive-Personal`, or plain `Dropbox`. Unknown prefixes still count as
/// synced (the location itself proves it); the raw prefix names the provider.
fn cloud_storage_provider(root_folder: &str) -> String {
    let prefix = root_folder.split('-').next().unwrap_or(root_folder);
    match prefix {
        "GoogleDrive" => "Google Drive".to_string(),
        "OneDrive" => "OneDrive".to_string(),
        "Dropbox" => "Dropbox".to_string(),
        other => other.to_string(),
    }
}

/// Why `clb_cmd_create_library` refuses a target folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateTargetBlocker {
    /// Target already contains a `metadata.db`; the frontend offers "open it
    /// instead".
    AlreadyALibrary,
    /// Target exists and holds real (non-junk) content, or is a file.
    NotEmpty,
}

/// OS droppings that don't make a folder "non-empty". Compared
/// case-insensitively; `Thumbs.db`/`desktop.ini` casing varies on Windows.
const JUNK_FILES: &[&str] = &[".ds_store", ".localized", "thumbs.db", "desktop.ini"];

fn is_junk(file_name: &str) -> bool {
    JUNK_FILES.contains(&file_name.to_ascii_lowercase().as_str())
}

/// A missing target is fine (creation makes the folder); an existing one must
/// be an empty-ish directory. IO errors (e.g. unreadable folder) propagate —
/// emptiness can't be verified, so creation must not proceed.
pub fn create_target_blocker(target: &Path) -> std::io::Result<Option<CreateTargetBlocker>> {
    if !target.exists() {
        return Ok(None);
    }
    if target.join("metadata.db").exists() {
        return Ok(Some(CreateTargetBlocker::AlreadyALibrary));
    }
    if !target.is_dir() {
        return Ok(Some(CreateTargetBlocker::NotEmpty));
    }
    for entry in std::fs::read_dir(target)? {
        if !is_junk(&entry?.file_name().to_string_lossy()) {
            return Ok(Some(CreateTargetBlocker::NotEmpty));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// The minimum `get_db_path` accepts: a folder holding a `metadata.db`.
    fn make_library(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("metadata.db"), b"").unwrap();
    }

    fn write_config(dir: &Path, contents: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let config = dir.join("global.py.json");
        fs::write(&config, contents).unwrap();
        config
    }

    // ---- configured_library_path -------------------------------------------

    #[test]
    fn config_parsing_reads_library_path() {
        let tmp = tempfile::tempdir().unwrap();
        let config = write_config(
            tmp.path(),
            r#"{"language": "en", "library_path": "/books/lib"}"#,
        );
        assert_eq!(
            configured_library_path(&config),
            Some("/books/lib".to_string())
        );
    }

    #[test]
    fn config_parsing_tolerates_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(configured_library_path(&tmp.path().join("nope.json")), None);
    }

    #[test]
    fn config_parsing_tolerates_missing_key() {
        let tmp = tempfile::tempdir().unwrap();
        let config = write_config(tmp.path(), r#"{"language": "en"}"#);
        assert_eq!(configured_library_path(&config), None);
    }

    #[test]
    fn config_parsing_tolerates_malformed_json() {
        let tmp = tempfile::tempdir().unwrap();
        let config = write_config(tmp.path(), "{library_path: not json");
        assert_eq!(configured_library_path(&config), None);
    }

    #[test]
    fn config_parsing_tolerates_non_string_value() {
        let tmp = tempfile::tempdir().unwrap();
        let config = write_config(tmp.path(), r#"{"library_path": null}"#);
        assert_eq!(configured_library_path(&config), None);
    }

    // ---- detect_from --------------------------------------------------------

    #[test]
    fn detection_prefers_configured_library() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let configured = home.join("My Books");
        make_library(&configured);
        make_library(&home.join("Calibre Library"));
        let config = write_config(
            home,
            &format!(r#"{{"library_path": {}}}"#, json_str(&configured)),
        );

        let hit = detect_from(Some(&config), home).unwrap();
        assert_eq!(hit.source, DetectionSource::CalibreConfig);
        assert_eq!(hit.path, configured.to_string_lossy());
    }

    #[test]
    fn detection_falls_back_when_configured_path_is_not_a_library() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let fallback = home.join("Calibre Library");
        make_library(&fallback);
        let config = write_config(
            home,
            &format!(
                r#"{{"library_path": {}}}"#,
                json_str(&home.join("gone-away"))
            ),
        );

        let hit = detect_from(Some(&config), home).unwrap();
        assert_eq!(hit.source, DetectionSource::DefaultFolder);
        assert_eq!(hit.path, fallback.to_string_lossy());
    }

    #[test]
    fn detection_falls_back_when_config_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        make_library(&home.join("Calibre Library"));

        let hit = detect_from(Some(&home.join("no-config.json")), home).unwrap();
        assert_eq!(hit.source, DetectionSource::DefaultFolder);
    }

    #[test]
    fn detection_returns_none_without_any_library() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(detect_from(None, tmp.path()), None);
    }

    #[test]
    fn detection_ignores_default_folder_without_metadata_db() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("Calibre Library")).unwrap();
        assert_eq!(detect_from(None, tmp.path()), None);
    }

    fn json_str(path: &Path) -> String {
        serde_json::to_string(&path.to_string_lossy()).unwrap()
    }

    // ---- per-OS config locations -------------------------------------------

    #[test]
    fn macos_config_lives_in_library_preferences() {
        assert_eq!(
            macos_calibre_config(Path::new("/Users/test")),
            Path::new("/Users/test/Library/Preferences/calibre/global.py.json")
        );
    }

    #[test]
    fn unix_config_defaults_to_dot_config() {
        assert_eq!(
            unix_calibre_config(Path::new("/home/test"), None),
            Path::new("/home/test/.config/calibre/global.py.json")
        );
    }

    #[test]
    fn unix_config_respects_xdg_config_home() {
        assert_eq!(
            unix_calibre_config(Path::new("/home/test"), Some(PathBuf::from("/xdg"))),
            Path::new("/xdg/calibre/global.py.json")
        );
    }

    #[test]
    fn unix_config_ignores_relative_xdg_config_home() {
        assert_eq!(
            unix_calibre_config(Path::new("/home/test"), Some(PathBuf::from("rel/config"))),
            Path::new("/home/test/.config/calibre/global.py.json")
        );
    }

    #[test]
    fn windows_config_requires_appdata() {
        assert_eq!(windows_calibre_config(None), None);
        // Component-wise comparison: the host separator differs when this
        // test runs on macOS/Linux.
        let appdata = PathBuf::from(r"C:\Users\test\AppData\Roaming");
        let config = windows_calibre_config(Some(appdata.clone())).unwrap();
        assert!(config.starts_with(&appdata));
        assert!(config.ends_with(Path::new("calibre").join("global.py.json")));
    }

    // ---- default_new_library_path ------------------------------------------

    #[test]
    fn default_new_library_is_home_citadel() {
        assert_eq!(
            default_new_library_path(Path::new("/Users/test")),
            "/Users/test/Citadel"
        );
    }

    // ---- path_sync_status ---------------------------------------------------

    fn provider_for(path: &str) -> Option<String> {
        path_sync_status(Path::new(path)).provider
    }

    #[test]
    fn sync_detects_icloud_mobile_documents() {
        assert_eq!(
            provider_for("/Users/test/Library/Mobile Documents/com~apple~CloudDocs/Books"),
            Some("iCloud Drive".to_string())
        );
    }

    #[test]
    fn sync_detects_cloud_storage_providers() {
        assert_eq!(
            provider_for("/Users/test/Library/CloudStorage/GoogleDrive-x@y.com/My Drive/Books"),
            Some("Google Drive".to_string())
        );
        assert_eq!(
            provider_for("/Users/test/Library/CloudStorage/OneDrive-Personal/Books"),
            Some("OneDrive".to_string())
        );
        assert_eq!(
            provider_for("/Users/test/Library/CloudStorage/Dropbox/Books"),
            Some("Dropbox".to_string())
        );
    }

    #[test]
    fn sync_reports_unknown_cloud_storage_roots_as_synced() {
        let status = path_sync_status(Path::new("/Users/test/Library/CloudStorage/Box-Box/Books"));
        assert!(status.synced);
        assert_eq!(status.provider, Some("Box".to_string()));
    }

    #[test]
    fn sync_detects_classic_folder_names() {
        assert_eq!(
            provider_for("/Users/test/Dropbox/Books"),
            Some("Dropbox".to_string())
        );
        assert_eq!(
            provider_for("/Users/test/OneDrive - Acme Corp/Books"),
            Some("OneDrive".to_string())
        );
        assert_eq!(
            provider_for("/Users/test/Google Drive/My Drive/Books"),
            Some("Google Drive".to_string())
        );
        assert_eq!(
            provider_for("/Volumes/GoogleDrive/My Drive/Books"),
            Some("Google Drive".to_string())
        );
    }

    #[test]
    fn sync_detects_dropbox_marker_in_ancestor() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Synced");
        let books = root.join("Books");
        fs::create_dir_all(&books).unwrap();
        fs::create_dir_all(root.join(".dropbox.cache")).unwrap();

        let status = path_sync_status(&books);
        assert!(status.synced);
        assert_eq!(status.provider, Some("Dropbox".to_string()));
    }

    #[test]
    fn sync_reports_unknown_providers_as_not_synced() {
        // Best-effort by design: Seafile and plain local paths report unsynced.
        assert!(!path_sync_status(Path::new("/Users/test/Seafile/Books")).synced);
        assert!(!path_sync_status(Path::new("/Users/test/Documents/Books")).synced);
    }

    // ---- create_target_blocker ----------------------------------------------

    #[test]
    fn create_target_accepts_missing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("new-library");
        assert_eq!(create_target_blocker(&target).unwrap(), None);
    }

    #[test]
    fn create_target_accepts_empty_folder() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(create_target_blocker(tmp.path()).unwrap(), None);
    }

    #[test]
    fn create_target_ignores_junk_files() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(".DS_Store"), b"").unwrap();
        fs::write(tmp.path().join("Thumbs.db"), b"").unwrap();
        assert_eq!(create_target_blocker(tmp.path()).unwrap(), None);
    }

    #[test]
    fn create_target_refuses_folder_with_content() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("notes.txt"), b"hi").unwrap();
        assert_eq!(
            create_target_blocker(tmp.path()).unwrap(),
            Some(CreateTargetBlocker::NotEmpty)
        );
    }

    #[test]
    fn create_target_flags_existing_library_distinctly() {
        let tmp = tempfile::tempdir().unwrap();
        make_library(tmp.path());
        assert_eq!(
            create_target_blocker(tmp.path()).unwrap(),
            Some(CreateTargetBlocker::AlreadyALibrary)
        );
    }

    #[test]
    fn create_target_refuses_file_target() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("plain-file");
        fs::write(&file, b"").unwrap();
        assert_eq!(
            create_target_blocker(&file).unwrap(),
            Some(CreateTargetBlocker::NotEmpty)
        );
    }
}
