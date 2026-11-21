//! The limits a file must stay within to be read. Breaking any of them
//! refuses the file; nothing is truncated. Each is far above what real books
//! need: across 287 real and test EPUBs the deepest package document nests
//! four elements.

/// `META-INF/container.xml`, as read, whatever size the archive declares.
pub const MAX_CONTAINER_BYTES: u64 = 64 * 1024;
/// The package document, as read, whatever size the archive declares.
pub const MAX_PACKAGE_BYTES: u64 = 8 * 1024 * 1024;
/// Elements open at once, in the container or the package document.
pub const MAX_DEPTH: usize = 256;
/// Elements in one document.
pub const MAX_ELEMENTS: usize = 250_000;
/// Attributes on one element, namespace declarations included.
pub const MAX_ATTRIBUTES: usize = 128;
/// Namespace prefixes bound at once.
pub const MAX_NAMESPACE_BINDINGS: usize = 256;
/// `dc:*` and `meta` elements in the package metadata.
pub const MAX_METADATA_ITEMS: usize = 4_096;
/// Bytes of one text value or attribute value.
pub const MAX_VALUE_BYTES: usize = 64 * 1024;
/// Entries the archive's central directory may declare.
pub const MAX_ARCHIVE_ENTRIES: u64 = 20_000;
/// Bytes the archive's central directory may declare.
pub const MAX_CENTRAL_DIRECTORY_BYTES: u64 = 4 * 1024 * 1024;
