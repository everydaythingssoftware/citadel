//! What this build is: its release version and the commit it was built from.

/// The release version, such as `0.8.0` or `0.8.0-nightly.20261104.42`.
pub const VERSION: &str = env!("CITADEL_VERSION");
/// The commit the build came from, abbreviated; `unknown` outside git.
pub const COMMIT: &str = env!("CITADEL_BUILD_COMMIT");
/// Version and commit together. Two builds of the same version from
/// different commits (nightlies, development) still differ.
pub const BUILD: &str = concat!(env!("CITADEL_VERSION"), "+", env!("CITADEL_BUILD_COMMIT"));

/// What `--version` prints.
pub fn describe() -> String {
    format!("citadel-server {VERSION} ({COMMIT})")
}
