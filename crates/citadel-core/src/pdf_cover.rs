//! A PDF's first page as its cover. PDFs embed no cover, so each host brings
//! a renderer: the operating system's where it has one, otherwise poppler's
//! `pdftoppm`. However many books are read at once, only a few renders run
//! together, since each is CPU-bound and may use up to a gigabyte.
use std::{
    path::Path,
    sync::{Condvar, Mutex, OnceLock},
};

/// Renders the first page of the PDF at a path as a JPEG at most 1600
/// pixels on its longer side, or `None`. A renderer gives up after
/// [`RENDER_TIMEOUT`], counted from when it starts.
pub type RenderPdfCover = fn(&Path) -> Option<Vec<u8>>;

pub use libcalibre::book_file::PDF_RENDER_TIMEOUT as RENDER_TIMEOUT;

/// Renders with `pdftoppm` from `PATH`; no cover without it.
pub fn pdftoppm(path: &Path) -> Option<Vec<u8>> {
    libcalibre::book_file::render_pdf_cover(path)
}

/// Whether [`pdftoppm`] can render, for hosts to report.
pub fn pdftoppm_installed() -> bool {
    libcalibre::book_file::pdftoppm().is_some()
}

/// Runs `render` on `path` once a render slot is free.
pub fn render(render: RenderPdfCover, path: &Path) -> Option<Vec<u8>> {
    let _slot = Slot::acquire();
    render(path)
}

struct Slots {
    free: Mutex<usize>,
    released: Condvar,
}

fn slots() -> &'static Slots {
    static SLOTS: OnceLock<Slots> = OnceLock::new();
    SLOTS.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(1, usize::from);
        Slots {
            free: Mutex::new((cores / 2).clamp(1, 4)),
            released: Condvar::new(),
        }
    })
}

struct Slot;

impl Slot {
    fn acquire() -> Self {
        let slots = slots();
        let mut free = slots
            .free
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *free == 0 {
            free = slots
                .released
                .wait(free)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        *free -= 1;
        Slot
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let slots = slots();
        *slots
            .free
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
        slots.released.notify_one();
    }
}
