use std::fmt;

/// Why an EPUB couldn't be read.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EpubError {
    /// The file breaks a limit or names its package document unsafely; it
    /// should be rejected, not read.
    #[error(transparent)]
    Refused(Refusal),
    /// The file is damaged or isn't an EPUB; callers may still accept it
    /// without metadata.
    #[error(transparent)]
    Unreadable(Unreadable),
}

impl EpubError {
    pub(crate) fn malformed(part: Part) -> Self {
        Self::Unreadable(Unreadable::Malformed(part))
    }
}

impl From<Refusal> for EpubError {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

/// The two documents Citadel reads from an EPUB.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    /// `META-INF/container.xml`.
    Container,
    /// The package document (`.opf`) the container names.
    Package,
}

impl fmt::Display for Part {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Part::Container => "container file",
            Part::Package => "package file",
        })
    }
}

/// A limit the file breaks, worded for the person who chose it.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("This EPUB's {part} is larger than {}.", size(*.limit))]
    TooLarge { part: Part, limit: u64 },
    #[error("This EPUB's {part} nests elements more than {limit} deep.")]
    TooDeep { part: Part, limit: usize },
    #[error("This EPUB's {part} has more than {limit} elements.")]
    TooManyElements { part: Part, limit: usize },
    #[error("This EPUB's {part} has an element with more than {limit} attributes.")]
    TooManyAttributes { part: Part, limit: usize },
    #[error("This EPUB's {part} declares more than {limit} namespaces at once.")]
    TooManyNamespaces { part: Part, limit: usize },
    #[error("This EPUB's package file has more than {limit} metadata entries.")]
    TooManyMetadataItems { limit: usize },
    #[error("This EPUB's {part} has a value longer than {}.", size(*.limit as u64))]
    ValueTooLong { part: Part, limit: usize },
    #[error("This EPUB holds more than {limit} files.")]
    TooManyEntries { limit: u64 },
    #[error("This EPUB's file list is larger than {}.", size(*.limit))]
    CentralDirectoryTooLarge { limit: u64 },
    #[error("This EPUB's container file names no package file.")]
    NoRootfile,
    #[error("This EPUB's container file names its package file with a path outside the book.")]
    InvalidRootfile,
}

/// Why a file that isn't refused still has no readable metadata.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Unreadable {
    #[error("This file isn't a ZIP archive.")]
    NotAZip,
    #[error("This EPUB has no container file.")]
    MissingContainer,
    #[error("This EPUB's package file is missing.")]
    MissingPackage,
    #[error("This EPUB's package file has no spine.")]
    MissingSpine,
    #[error("This EPUB's {0} isn't well-formed XML.")]
    Malformed(Part),
    #[error("This EPUB couldn't be read.")]
    Io,
}

fn size(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    if bytes >= MIB && bytes.is_multiple_of(MIB) {
        format!("{} MiB", bytes / MIB)
    } else if bytes >= KIB && bytes.is_multiple_of(KIB) {
        format!("{} KiB", bytes / KIB)
    } else {
        format!("{bytes} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_read_as_plain_reasons() {
        let refusal = Refusal::TooLarge {
            part: Part::Package,
            limit: crate::limits::MAX_PACKAGE_BYTES,
        };
        assert_eq!(
            refusal.to_string(),
            "This EPUB's package file is larger than 8 MiB."
        );
        assert_eq!(
            Refusal::TooLarge {
                part: Part::Container,
                limit: crate::limits::MAX_CONTAINER_BYTES
            }
            .to_string(),
            "This EPUB's container file is larger than 64 KiB."
        );
    }
}
