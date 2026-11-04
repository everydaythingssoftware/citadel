//! Names the build: the release version (overridable for image builds, which
//! don't rewrite Cargo.toml) and the commit it came from.
use std::{path::Path, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=CITADEL_VERSION");
    println!("cargo:rerun-if-env-changed=CITADEL_BUILD_COMMIT");
    let version = std::env::var("CITADEL_VERSION")
        .ok()
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").expect("cargo sets the version"));
    let commit = std::env::var("CITADEL_BUILD_COMMIT")
        .ok()
        .filter(|commit| !commit.is_empty())
        .or_else(git_commit)
        .map(|commit| commit.chars().take(12).collect::<String>())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=CITADEL_VERSION={version}");
    println!("cargo:rustc-env=CITADEL_BUILD_COMMIT={commit}");
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|text| !text.is_empty())
}

/// The checked-out commit, rebuilding when it moves.
fn git_commit() -> Option<String> {
    for watched in [git(&["rev-parse", "--git-path", "HEAD"]), head_ref()]
        .into_iter()
        .flatten()
    {
        if Path::new(&watched).exists() {
            println!("cargo:rerun-if-changed={watched}");
        }
    }
    git(&["rev-parse", "HEAD"])
}

fn head_ref() -> Option<String> {
    let name = git(&["symbolic-ref", "-q", "HEAD"])?;
    git(&["rev-parse", "--git-path", &name])
}
