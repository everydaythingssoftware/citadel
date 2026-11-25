//! PDF covers are rendered by hayro in a short-lived child process: a hostile
//! file can abort on allocation or spin for minutes, which no `catch_unwind`
//! stops. The child is the host's own executable, started with
//! [`WORKER_FLAG`], once the host has opted in through
//! [`super::run_pdf_cover_worker`].
use std::{
    collections::VecDeque,
    ffi::OsStr,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime},
};

use hayro::{
    hayro_interpret::InterpreterSettings,
    hayro_syntax::{page::Page, Pdf},
    vello_cpu::color::palette::css::WHITE,
    PixmapSettings, RenderCache, RenderSettings,
};
use image::{codecs::jpeg::JpegEncoder, ExtendedColorType};

use super::{guarded, BookFileMetadata, MAX_COVER_BYTES};
use crate::mime_type::MimeType;

const WORKER_FLAG: &str = "--libcalibre-pdf-cover";

/// A worker still running after this is killed and the PDF gets no cover.
const WORKER_TIMEOUT: Duration = Duration::from_secs(10);

/// The most memory a worker may commit; past it, allocation fails and the
/// worker aborts.
const WORKER_MEMORY_BYTES: u64 = 1024 * 1024 * 1024;

/// CPU time a worker may use, so it dies even if its parent does first.
const WORKER_CPU_SECONDS: u64 = 30;

/// hayro parses a PDF from memory, so the whole file is read inside the
/// worker's memory ceiling. Larger files get no cover.
const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;

/// The cover's longer side in pixels, whatever the page's own size.
const COVER_LONG_SIDE: f32 = 1600.0;

const JPEG_QUALITY: u8 = 85;

/// Adding a book reads its metadata and then its cover, often minutes apart
/// for a staged book; recent results spare a second render.
const RECENT_COVERS: usize = 8;

static WORKER: OnceLock<PathBuf> = OnceLock::new();

static RECENT: Mutex<VecDeque<(Stamp, Option<Vec<u8>>)>> = Mutex::new(VecDeque::new());

pub(super) fn run_worker() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(WORKER_FLAG)) {
        if let Ok(executable) = std::env::current_exe() {
            let _ = WORKER.set(executable);
        }
        return;
    }
    let rendered = args
        .next()
        .filter(|_| limit_self())
        .and_then(|path| guarded(|| render_file(Path::new(&path))));
    let written = rendered.is_some_and(|jpeg| {
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(&jpeg)
            .and_then(|()| stdout.flush())
            .is_ok()
    });
    std::process::exit(if written { 0 } else { 1 });
}

#[cfg(windows)]
fn limit_self() -> bool {
    use windows_sys::Win32::System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_LIMIT_PROCESS_TIME,
        },
        Threading::GetCurrentProcess,
    };

    // SAFETY: plain Win32 calls on a zeroed, correctly sized structure. The
    // job handle stays open until the process exits.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return false;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_PROCESS_TIME;
        limits.BasicLimitInformation.PerProcessUserTimeLimit =
            (WORKER_CPU_SECONDS * 10_000_000) as i64;
        limits.ProcessMemoryLimit = WORKER_MEMORY_BYTES as usize;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0
            && AssignProcessToJobObject(job, GetCurrentProcess()) != 0
    }
}

#[cfg(unix)]
fn limit_self() -> bool {
    let limit = |resource, value: u64| {
        let limit = libc::rlimit {
            rlim_cur: value as libc::rlim_t,
            rlim_max: value as libc::rlim_t,
        };
        // SAFETY: setrlimit only reads the structure it is given.
        unsafe { libc::setrlimit(resource, &limit) == 0 }
    };
    let memory = limit(libc::RLIMIT_AS, WORKER_MEMORY_BYTES);
    // macOS accepts RLIMIT_AS without reliably enforcing it, so there the
    // parent's timeout is the only guard against a worker that balloons.
    (memory || cfg!(target_os = "macos")) && limit(libc::RLIMIT_CPU, WORKER_CPU_SECONDS)
}

#[cfg(not(any(windows, unix)))]
fn limit_self() -> bool {
    false
}

/// Identifies a file's contents well enough to reuse its cover.
#[derive(Clone, PartialEq)]
struct Stamp {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    fn of(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            path: path.to_path_buf(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

fn recent() -> std::sync::MutexGuard<'static, VecDeque<(Stamp, Option<Vec<u8>>)>> {
    RECENT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The cover a worker renders for `path`. `None` when no worker is enabled.
fn cover(path: &Path) -> Option<Vec<u8>> {
    let worker = WORKER.get()?;
    let stamp = Stamp::of(path)?;
    if stamp.len > MAX_PDF_BYTES {
        return None;
    }
    if let Some((_, cover)) = recent().iter().find(|(seen, _)| *seen == stamp) {
        return cover.clone();
    }
    let mut command = Command::new(worker);
    command.arg(WORKER_FLAG).arg(path);
    let cover = collect(command, WORKER_TIMEOUT);
    let mut recent = recent();
    if recent.len() == RECENT_COVERS {
        recent.pop_front();
    }
    recent.push_back((stamp, cover.clone()));
    cover
}

/// Runs `command` and returns what it wrote to stdout, if it exited
/// successfully within `timeout` having written something no larger than
/// [`MAX_COVER_BYTES`].
fn collect(mut command: Command, timeout: Duration) -> Option<Vec<u8>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let reader = child.stdout.take().map(|stdout| {
        // Dropping the pipe past the limit makes the worker's write fail.
        thread::spawn(move || {
            let mut output = Vec::new();
            stdout
                .take(MAX_COVER_BYTES + 1)
                .read_to_end(&mut output)
                .ok()
                .map(|_| output)
        })
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let output = reader?.join().ok().flatten()?;
    (status?.success() && !output.is_empty() && output.len() as u64 <= MAX_COVER_BYTES)
        .then_some(output)
}

fn read_file(path: &Path) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_PDF_BYTES {
        return None;
    }
    let mut data = Vec::new();
    file.take(MAX_PDF_BYTES + 1).read_to_end(&mut data).ok()?;
    (data.len() as u64 <= MAX_PDF_BYTES).then_some(data)
}

/// Renders the first page of the PDF at `path` as a JPEG, in this process.
fn render_file(path: &Path) -> Option<Vec<u8>> {
    let pdf = Pdf::new(read_file(path)?).ok()?;
    render_cover(pdf.pages().first()?)
}

/// The factor that brings the page's longer side to [`COVER_LONG_SIDE`], or
/// `None` when the page has no area to render.
fn cover_scale(page: &Page) -> Option<f32> {
    let (width, height) = page.render_dimensions();
    let scale = COVER_LONG_SIDE / width.max(height);
    let renders = |side: f32| side.is_finite() && side * scale >= 1.0;
    (scale.is_finite() && scale > 0.0 && renders(width) && renders(height)).then_some(scale)
}

fn render_cover(page: &Page) -> Option<Vec<u8>> {
    let scale = cover_scale(page)?;
    let pixmap = hayro::render(
        page,
        &RenderCache::new(),
        &InterpreterSettings::default(),
        &RenderSettings::default(),
        &PixmapSettings {
            x_scale: scale,
            y_scale: scale,
            bg_color: WHITE,
        },
    );
    // Premultiplied pixels over white, in case anything is left translucent.
    let rgb: Vec<u8> = pixmap
        .data()
        .iter()
        .flat_map(|pixel| {
            let backdrop = 255 - pixel.a;
            [pixel.r, pixel.g, pixel.b].map(|channel| channel.saturating_add(backdrop))
        })
        .collect();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode(
            &rgb,
            pixmap.width().into(),
            pixmap.height().into(),
            ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(jpeg)
}

pub(super) fn read_metadata(path: &Path, format: MimeType) -> Option<BookFileMetadata> {
    let mut metadata = BookFileMetadata::titled_from_file_name(format, path)?;
    metadata.has_cover = cover(path).is_some();
    Some(metadata)
}

pub(super) fn cover_image_data(path: &Path) -> Option<Vec<u8>> {
    cover(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-page PDF, 200 by 400 points, with a red rectangle in the middle
    /// of an otherwise unpainted page.
    fn one_page_pdf() -> Vec<u8> {
        let content = "1 0 0 rg 50 100 100 200 re f";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 400] /Contents 4 0 R >>".to_string(),
            format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ),
        ];
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
        }
        let xref = pdf.len();
        pdf.push_str(&format!(
            "xref\n0 {}\n0000000000 65535 f \n",
            objects.len() + 1
        ));
        for offset in offsets {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        ));
        pdf.into_bytes()
    }

    #[test]
    fn first_page_renders_as_a_jpeg_on_white() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("The Odyssey.pdf");
        std::fs::write(&path, one_page_pdf()).unwrap();

        let cover = render_file(&path).unwrap();
        assert!(cover.starts_with(b"\xFF\xD8\xFF"));
        let image = image::load_from_memory(&cover).unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (800, 1600));
        let [r, g, b] = image.get_pixel(400, 800).0;
        assert!(r > 200 && g < 60 && b < 60, "centre is {r},{g},{b}");
        let [r, g, b] = image.get_pixel(10, 10).0;
        assert!(r > 240 && g > 240 && b > 240, "corner is {r},{g},{b}");
    }

    #[test]
    fn unreadable_files_do_not_render() {
        let dir = tempfile::tempdir().unwrap();
        for content in [&b"not a pdf"[..], b"%PDF-1.7\n1 0 obj\n<< /Type", b""] {
            let path = dir.path().join("broken.pdf");
            std::fs::write(&path, content).unwrap();
            assert_eq!(render_file(&path), None);
        }
    }

    #[test]
    fn documents_without_pages_do_not_render() {
        let pdf = String::from_utf8(one_page_pdf())
            .unwrap()
            .replace("/Kids [3 0 R] /Count 1", "/Kids [       ] /Count 0");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.pdf");
        std::fs::write(&path, pdf).unwrap();
        assert_eq!(render_file(&path), None);
    }

    /// Nothing in this test binary opts in, so no worker is ever started.
    #[test]
    fn without_a_worker_a_pdf_keeps_its_title_and_has_no_cover() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("The Odyssey.pdf");
        std::fs::write(&path, one_page_pdf()).unwrap();

        let metadata = read_metadata(&path, MimeType::PDF).unwrap();
        assert_eq!(metadata.title.as_deref(), Some("The Odyssey"));
        assert!(!metadata.has_cover);
        assert_eq!(cover_image_data(&path), None);
    }

    /// Runs one of the ignored stand-ins below in a copy of this test binary.
    fn stand_in(name: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([name, "--ignored", "--nocapture", "--test-threads=1"]);
        command
    }

    #[test]
    #[ignore = "a worker stand-in, run by collect tests"]
    fn stand_in_that_succeeds() {
        std::io::stdout().write_all(b"rendered").unwrap();
    }

    #[test]
    #[ignore = "a worker stand-in, run by collect tests"]
    fn stand_in_that_panics() {
        std::io::stdout().write_all(b"partial").unwrap();
        panic!("the parser gave up");
    }

    #[test]
    #[ignore = "a worker stand-in, run by collect tests"]
    fn stand_in_that_hangs() {
        std::io::stdout().write_all(b"partial").unwrap();
        thread::sleep(Duration::from_secs(120));
    }

    #[test]
    #[ignore = "a worker stand-in, run by collect tests"]
    fn stand_in_that_floods() {
        let chunk = vec![b'x'; 1024 * 1024];
        let mut stdout = std::io::stdout().lock();
        for _ in 0..=MAX_COVER_BYTES / chunk.len() as u64 {
            if stdout.write_all(&chunk).is_err() {
                return;
            }
        }
    }

    #[test]
    fn collect_keeps_the_output_of_a_worker_that_succeeds() {
        let output = collect(stand_in("stand_in_that_succeeds"), WORKER_TIMEOUT).unwrap();
        assert!(output.windows(8).any(|window| window == b"rendered"));
    }

    #[test]
    fn collect_discards_the_output_of_a_worker_that_fails() {
        assert_eq!(
            collect(stand_in("stand_in_that_panics"), WORKER_TIMEOUT),
            None
        );
    }

    #[test]
    fn collect_kills_a_worker_that_runs_past_the_timeout() {
        let start = Instant::now();
        assert_eq!(
            collect(stand_in("stand_in_that_hangs"), Duration::from_millis(500)),
            None
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{:?}",
            start.elapsed()
        );
    }

    #[test]
    fn collect_refuses_output_past_the_cover_limit() {
        let start = Instant::now();
        assert_eq!(
            collect(stand_in("stand_in_that_floods"), WORKER_TIMEOUT),
            None
        );
        assert!(start.elapsed() < WORKER_TIMEOUT, "{:?}", start.elapsed());
    }
}
