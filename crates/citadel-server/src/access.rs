//! Why the server can't read or write a folder, in terms that say how to
//! fix it. Containers make this the most common first-run problem: the
//! server's user isn't the one that owns the mounted folder.
use std::path::Path;

/// What the server process may do with a folder.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Access {
    ReadWrite,
    /// Readable; writes are refused because of ownership or mode.
    ReadOnly,
    /// Readable; the filesystem itself is mounted read-only.
    ReadOnlyMount,
    /// Not even readable.
    Denied,
    Missing,
}

#[cfg(unix)]
fn check(path: &Path, mode: libc::c_int) -> Result<(), std::io::Error> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: `path` is a valid NUL-terminated string for the call's duration.
    if unsafe { libc::access(path.as_ptr(), mode) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// What this process may do with `path`, a folder (which it must also be
/// able to enter) or a file.
#[cfg(unix)]
pub fn of(path: &Path) -> Access {
    let enter = if path.is_dir() { libc::X_OK } else { 0 };
    match check(path, libc::R_OK | enter) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Access::Missing,
        Err(_) => return Access::Denied,
        Ok(()) => {}
    }
    match check(path, libc::W_OK | enter) {
        Ok(()) => Access::ReadWrite,
        Err(error) if error.raw_os_error() == Some(libc::EROFS) => Access::ReadOnlyMount,
        Err(_) => Access::ReadOnly,
    }
}

#[cfg(not(unix))]
pub fn of(path: &Path) -> Access {
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Access::Missing,
        Err(_) => Access::Denied,
        Ok(metadata) if metadata.permissions().readonly() => Access::ReadOnly,
        Ok(_) => Access::ReadWrite,
    }
}

/// The user and group this process runs as, and who owns `path`.
#[cfg(unix)]
fn identities(path: &Path) -> Option<((u32, u32), (u32, u32))> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    // SAFETY: these calls can't fail and have no preconditions.
    let process = unsafe { (libc::geteuid(), libc::getegid()) };
    Some((process, (metadata.uid(), metadata.gid())))
}

/// How to let the server read (or with `write`, also change) `path`, when
/// it can't. None when it already can, or there's nothing to suggest.
pub fn explain(path: &Path, write: bool) -> Option<String> {
    let access = of(path);
    let shown = path.display();
    match access {
        Access::ReadWrite | Access::Missing => None,
        Access::ReadOnly | Access::ReadOnlyMount if !write => None,
        Access::ReadOnlyMount => Some(format!(
            "{shown} is mounted read-only. Citadel can serve it read-only; to add and edit \
             books, mount it without :ro."
        )),
        Access::ReadOnly | Access::Denied => Some(ownership_hint(path, access == Access::Denied)),
    }
}

#[cfg(unix)]
fn ownership_hint(path: &Path, denied: bool) -> String {
    let shown = path.display();
    let verb = if denied { "read" } else { "change" };
    match identities(path) {
        // Running Citadel as root to fix this would be worse than the problem.
        Some(((uid, gid), (0, _))) if uid != 0 => format!(
            "{shown} belongs to root, so Citadel, running as user {uid} (group {gid}), can't \
             {verb} it. Give user {uid} access to the folder on the host, for example with \
             chown -R {uid}:{gid} on the folder you mounted."
        ),
        Some(((uid, gid), (owner, group))) if uid != owner => format!(
            "Citadel runs as user {uid} (group {gid}), but {shown} belongs to user {owner} \
             (group {group}), so Citadel can't {verb} it. Run Citadel as that user (with \
             Docker, set PUID={owner} and PGID={group}), or give user {uid} access to the folder."
        ),
        Some(((uid, _), _)) => format!(
            "Citadel runs as user {uid}, which owns {shown} but isn't allowed to {verb} it. \
             Check the folder's permissions."
        ),
        None => format!("Citadel can't {verb} {shown}."),
    }
}

#[cfg(not(unix))]
fn ownership_hint(path: &Path, denied: bool) -> String {
    let verb = if denied { "read" } else { "change" };
    format!("Citadel can't {verb} {}.", path.display())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn running_as_root() -> bool {
        // SAFETY: no preconditions.
        unsafe { libc::geteuid() == 0 }
    }

    #[test]
    fn a_writable_folder_needs_no_explanation() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(of(directory.path()), Access::ReadWrite);
        assert_eq!(explain(directory.path(), true), None);
        assert_eq!(of(&directory.path().join("missing")), Access::Missing);
    }

    #[test]
    fn a_folder_the_server_cant_change_says_who_it_runs_as() {
        if running_as_root() {
            // Root ignores mode bits, so there is nothing to observe.
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("books");
        std::fs::create_dir(&folder).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(of(&folder), Access::ReadOnly);
        assert_eq!(explain(&folder, false), None, "reading is fine");
        let message = explain(&folder, true).unwrap();
        assert!(message.contains("isn't allowed to change it"), "{message}");
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(of(&folder), Access::Denied);
        let message = explain(&folder, false).unwrap();
        assert!(message.contains("isn't allowed to read it"), "{message}");
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
