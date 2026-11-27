//! A PDF's first page, rendered by poppler's `pdftoppm` in its own process.
//! PDFs are untrusted, so the renderer runs under a timeout and, where the
//! system enforces one, a memory ceiling. Without `pdftoppm` on `PATH`, PDFs
//! have no cover.
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use super::MAX_COVER_BYTES;

/// A render still running after this is killed and the PDF gets no cover.
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(3);

/// The address space a render may use, where the system enforces it (Linux
/// and the BSDs; macOS accepts the limit without enforcing it).
const RENDER_MEMORY_BYTES: u64 = 1024 * 1024 * 1024;

/// CPU time a render may use, so it dies even if this process dies first.
const RENDER_CPU_SECONDS: u64 = 10;

/// The cover's longer side in pixels, whatever the page's own size.
const COVER_LONG_SIDE: &str = "1600";

const PROGRAM: &str = if cfg!(windows) {
    "pdftoppm.exe"
} else {
    "pdftoppm"
};

/// Where `pdftoppm` is on `PATH`, if it is.
pub fn pdftoppm() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join(PROGRAM))
        .find(|candidate| candidate.is_file())
}

/// The first page of the PDF at `path` as a JPEG, at most 1600 pixels on its
/// longer side.
pub fn render_cover(path: &Path) -> Option<Vec<u8>> {
    let mut command = Command::new(pdftoppm()?);
    command
        .args(["-f", "1", "-l", "1", "-singlefile", "-jpeg"])
        .args(["-jpegopt", "quality=85", "-scale-to", COVER_LONG_SIDE])
        .arg(file_argument(path));
    limit(&mut command);
    output(command, RENDER_TIMEOUT)
}

/// A relative path starting with `-` would read as an option.
fn file_argument(path: &Path) -> OsString {
    if path.is_absolute() {
        path.into()
    } else {
        Path::new(".").join(path).into()
    }
}

#[cfg(unix)]
fn limit(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: the closure runs in the child between fork and exec and only
    // calls setrlimit, which is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            for (resource, value) in [
                (libc::RLIMIT_AS, RENDER_MEMORY_BYTES),
                (libc::RLIMIT_CPU, RENDER_CPU_SECONDS),
            ] {
                let limit = libc::rlimit {
                    rlim_cur: value as libc::rlim_t,
                    rlim_max: value as libc::rlim_t,
                };
                libc::setrlimit(resource, &limit);
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn limit(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// What `command` writes to stdout, if it exits successfully within
/// `timeout` having written something no larger than [`MAX_COVER_BYTES`].
fn output(mut command: Command, timeout: Duration) -> Option<Vec<u8>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    // Dropping the pipe past the limit makes the renderer's write fail.
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout
            .take(MAX_COVER_BYTES + 1)
            .read_to_end(&mut output)
            .ok()
            .map(|_| output)
    });
    let succeeded = wait(&mut child, timeout);
    let output = reader.join().ok().flatten()?;
    (succeeded && !output.is_empty() && output.len() as u64 <= MAX_COVER_BYTES).then_some(output)
}

/// Whether `child` exits successfully within `timeout`; past it, the child
/// is killed.
fn wait(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-page PDF, 300 by 150 points, painted blue.
    const BLUE_PAGE: &str = "%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Contents 4 0 R >> endobj
4 0 obj << /Length 24 >> stream
0 0 1 rg 0 0 300 150 re f
endstream endobj
trailer << /Root 1 0 R >>
%%EOF
";

    #[test]
    fn first_page_renders_as_a_jpeg() {
        if pdftoppm().is_none() {
            eprintln!("skipped: pdftoppm isn't installed");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.pdf");
        std::fs::write(&path, BLUE_PAGE).unwrap();

        let cover = render_cover(&path).unwrap();
        assert!(cover.starts_with(b"\xFF\xD8\xFF"));
        assert_eq!(render_cover(&dir.path().join("missing.pdf")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_render_past_the_timeout_is_killed() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf partial; exec sleep 30"]);
        let start = Instant::now();
        assert_eq!(output(command, Duration::from_millis(200)), None);
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
