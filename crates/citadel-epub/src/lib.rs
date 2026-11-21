//! Reads what an EPUB says about itself: the package document's metadata and
//! its cover image, following EPUB 3.3 (§4 the OCF container, §5 the package
//! document) and Readium's mapping of package metadata.
//!
//! Only `META-INF/container.xml` and the package document are parsed; the
//! navigation document, NCX and content documents are never opened. Both are
//! read as a stream of events without recursing on their structure, and every
//! dimension a hostile file could inflate has a limit in [`limits`]. A file
//! past a limit is [refused](EpubError::Refused) rather than read in part.
//!
//! ```no_run
//! let file = std::fs::File::open("book.epub")?;
//! let mut epub = citadel_epub::Epub::open(file)?;
//! println!("{:?}", epub.package().title);
//! let cover = epub.cover(16 * 1024 * 1024)?;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
use std::io::{Read, Seek};

mod container;
mod error;
#[cfg(feature = "fixtures")]
pub mod fixtures;
pub mod limits;
mod package;
mod paths;
mod xml;
mod zip_guard;

pub use error::{EpubError, Part, Refusal, Unreadable};
pub use package::{Contributor, Package, Resource};

/// An opened EPUB: its archive, read once, and its package metadata.
pub struct Epub<R: Read + Seek> {
    archive: zip::ZipArchive<R>,
    package: Package,
}

impl<R: Read + Seek> Epub<R> {
    /// Checks the archive's central directory, then reads the container and
    /// the package document it names.
    pub fn open(mut reader: R) -> Result<Self, EpubError> {
        zip_guard::check(&mut reader)?;
        let mut archive =
            zip::ZipArchive::new(reader).map_err(|_| EpubError::Unreadable(Unreadable::NotAZip))?;
        let container = read_entry(
            &mut archive,
            container::CONTAINER_PATH,
            limits::MAX_CONTAINER_BYTES,
            Part::Container,
        )?
        .ok_or(EpubError::Unreadable(Unreadable::MissingContainer))?;
        let package_path =
            container::package_path(&container, |name| archive.index_for_name(name).is_some())?;
        let document = read_entry(
            &mut archive,
            &package_path,
            limits::MAX_PACKAGE_BYTES,
            Part::Package,
        )?
        .ok_or(EpubError::Unreadable(Unreadable::MissingPackage))?;
        let package = package::parse(&document, package_path, |name| {
            archive.index_for_name(name).is_some()
        })?;
        Ok(Self { archive, package })
    }

    /// The package document's metadata.
    pub fn package(&self) -> &Package {
        &self.package
    }

    /// The cover image's bytes, or `None` when the package names no cover,
    /// its entry is missing, or it is larger than `max_bytes`.
    pub fn cover(&mut self, max_bytes: u64) -> Result<Option<Vec<u8>>, EpubError> {
        let Some(cover) = &self.package.cover else {
            return Ok(None);
        };
        let path = cover.path.clone();
        let Ok(entry) = self.archive.by_name(&path) else {
            return Ok(None);
        };
        if entry.size() > max_bytes {
            return Ok(None);
        }
        let mut data = Vec::new();
        // Declared sizes can lie; never read more than the cap allows.
        entry
            .take(max_bytes + 1)
            .read_to_end(&mut data)
            .map_err(|_| EpubError::Unreadable(Unreadable::Io))?;
        Ok((!data.is_empty() && data.len() as u64 <= max_bytes).then_some(data))
    }
}

/// Reads the package metadata of the EPUB in `reader`.
pub fn read<R: Read + Seek>(reader: R) -> Result<Package, EpubError> {
    Epub::open(reader).map(|epub| epub.package)
}

/// The entry `name`, refused when it is larger than `cap` whatever size it
/// declares; `None` when the archive has no such entry.
fn read_entry<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
    cap: u64,
    part: Part,
) -> Result<Option<Vec<u8>>, EpubError> {
    let entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(_) => return Err(EpubError::Unreadable(Unreadable::Io)),
    };
    let too_large = || EpubError::Refused(Refusal::TooLarge { part, limit: cap });
    if entry.size() > cap {
        return Err(too_large());
    }
    let mut data = Vec::with_capacity(entry.size() as usize);
    entry
        .take(cap + 1)
        .read_to_end(&mut data)
        .map_err(|_| EpubError::Unreadable(Unreadable::Io))?;
    if data.len() as u64 > cap {
        return Err(too_large());
    }
    Ok(Some(data))
}
