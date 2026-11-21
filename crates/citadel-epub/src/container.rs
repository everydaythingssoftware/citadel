//! `META-INF/container.xml` (EPUB 3.3 §4.2.6.3.1): which package document
//! to read.
use crate::{
    error::{EpubError, Part, Refusal, Unreadable},
    paths,
    xml::{self, Node, Reader, CONTAINER_NS},
};

pub(crate) const CONTAINER_PATH: &str = "META-INF/container.xml";
const PACKAGE_MEDIA_TYPE: &str = "application/oebps-package+xml";

/// The archive entry of the package document. Reading Systems use the first
/// `rootfile` that is a package document; a container whose rootfiles name
/// none falls back to its first rootfile.
pub(crate) fn package_path(
    document: &[u8],
    exists: impl Fn(&str) -> bool,
) -> Result<String, EpubError> {
    let text = xml::decode(document, Part::Container)?;
    let mut reader = Reader::new(&text, Part::Container);
    let mut first = None;
    let mut package = None;
    loop {
        match reader.next()? {
            Node::Start(element) => {
                let is_rootfile = element.local == "rootfile"
                    && matches!(element.namespace.as_deref(), Some(CONTAINER_NS) | None);
                if !is_rootfile || package.is_some() {
                    continue;
                }
                let Some(full_path) = element.attribute("full-path") else {
                    continue;
                };
                let is_package = element
                    .attribute("media-type")
                    .is_some_and(|media_type| media_type.trim() == PACKAGE_MEDIA_TYPE);
                if is_package {
                    package = Some(full_path.to_string());
                } else if first.is_none() {
                    first = Some(full_path.to_string());
                }
            }
            Node::End | Node::Text(_) => {}
            Node::Eof => break,
        }
    }
    let full_path = package.or(first).ok_or(Refusal::NoRootfile)?;
    paths::rootfile(full_path.trim(), exists)
        .map_err(|()| Refusal::InvalidRootfile)?
        .ok_or(EpubError::Unreadable(Unreadable::MissingPackage))
}
