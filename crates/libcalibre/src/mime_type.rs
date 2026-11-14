/// A book file format that can be imported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum MimeType {
    /// EPUB (`.epub`).
    EPUB,
    /// Mobipocket (`.mobi`).
    MOBI,
    /// PDF (`.pdf`).
    PDF,
    /// Kindle Format 7 (`.azw`).
    KF7,
    /// Kindle Format 8 (`.azw3`).
    KF8,
    /// Plain text (`.txt`).
    TXT,
    /// Any other format; `application/octet-stream` with no extension.
    UNKNOWN,
}

impl MimeType {
    /// The format's MIME type. KF8's `application/vnd.amazon.ebook-kf8` is
    /// unregistered.
    pub fn as_str(&self) -> &'static str {
        match *self {
            MimeType::EPUB => "application/epub+zip",
            MimeType::MOBI => "application/x-mobipocket-ebook",
            MimeType::PDF => "application/pdf",
            MimeType::KF7 => "application/vnd.amazon.ebook",
            MimeType::KF8 => "application/vnd.amazon.ebook-kf8", // Not a real MIME type, Amazon hasn't registered it
            MimeType::TXT => "text/plain",
            MimeType::UNKNOWN => "application/octet-stream",
        }
    }

    /// The format with MIME type `mimetype`, matched exactly. `None` for
    /// anything else, including KF8's unregistered type.
    pub fn from_mime_type(mimetype: &str) -> Option<Self> {
        match mimetype {
            "application/epub+zip" => Some(MimeType::EPUB),
            "application/x-mobipocket-ebook" => Some(MimeType::MOBI),
            "application/vnd.amazon.ebook" => Some(MimeType::KF7),
            "application/pdf" => Some(MimeType::PDF),
            "application/octet-stream" => Some(MimeType::UNKNOWN),
            "text/plain" => Some(MimeType::TXT),
            _ => None,
        }
    }

    /// The format's file extension, without the dot; empty for
    /// [`MimeType::UNKNOWN`].
    pub fn to_file_extension(&self) -> &'static str {
        match *self {
            MimeType::EPUB => "epub",
            MimeType::MOBI => "mobi",
            MimeType::PDF => "pdf",
            MimeType::KF7 => "azw",
            MimeType::KF8 => "azw3",
            MimeType::TXT => "txt",
            MimeType::UNKNOWN => "",
        }
    }

    /// The format with file extension `extension` (without the dot,
    /// case-insensitive). `None` when it isn't one of the known formats.
    pub fn from_file_extension(extension: &str) -> Option<Self> {
        match extension.to_lowercase().as_str() {
            "epub" => Some(MimeType::EPUB),
            "mobi" => Some(MimeType::MOBI),
            "pdf" => Some(MimeType::PDF),
            "azw" => Some(MimeType::KF7),
            "azw3" => Some(MimeType::KF8),
            "txt" => Some(MimeType::TXT),
            _ => None,
        }
    }
}

/// Authoritative extension → MIME mapping for every format Citadel serves,
/// shared by book downloads and OPDS asset responses. [`MimeType`] covers the
/// formats Citadel imports; the remaining entries exist because adopted
/// Calibre libraries can hold those book formats (served as-is) and because
/// cover files are images. `txt` carries a charset here for HTTP responses;
/// [`MimeType::as_str`] stays bare for non-HTTP use.
pub fn mime_type_from_extension(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "epub" => "application/epub+zip",
        "mobi" => "application/x-mobipocket-ebook",
        "azw" => "application/vnd.amazon.ebook",
        "azw3" => "application/vnd.amazon.ebook-kf8",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "cbz" => "application/vnd.comicbook+zip",
        "cbr" => "application/vnd.comicbook-rar",
        "fb2" => "application/x-fictionbook+xml",
        "djvu" | "djv" => "image/vnd.djvu",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "odt" => "application/vnd.oasis.opendocument.text",
        "rtf" => "application/rtf",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_importable_cover_and_unknown_extensions() {
        assert_eq!(mime_type_from_extension("EPUB"), "application/epub+zip");
        assert_eq!(
            mime_type_from_extension("Azw3"),
            "application/vnd.amazon.ebook-kf8"
        );
        assert_eq!(mime_type_from_extension("jpg"), "image/jpeg");
        assert_eq!(
            mime_type_from_extension("unexpected"),
            "application/octet-stream"
        );
    }
}
