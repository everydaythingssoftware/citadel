pub enum MIMETYPE {
    EPUB,
    MOBI,
    PDF,
    KF7, // Kindle Format 7 — AZW files
    KF8, // Kindle Format 8 — AZW3 files
    TXT,
    UNKNOWN,
}

impl MIMETYPE {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match *self {
            MIMETYPE::EPUB => "application/epub+zip",
            MIMETYPE::MOBI => "application/x-mobipocket-ebook",
            MIMETYPE::PDF => "application/pdf",
            MIMETYPE::KF7 => "application/vnd.amazon.ebook",
            MIMETYPE::KF8 => "application/vnd.amazon.ebook-kf8", // Not a real MIME type, Amazon hasn't registered it
            MIMETYPE::TXT => "text/plain",
            MIMETYPE::UNKNOWN => "application/octet-stream",
        }
    }

    #[allow(dead_code)]
    pub fn from_str(mimetype: &str) -> Option<Self> {
        match mimetype {
            "application/epub+zip" => Some(MIMETYPE::EPUB),
            "application/x-mobipocket-ebook" => Some(MIMETYPE::MOBI),
            "application/vnd.amazon.ebook" => Some(MIMETYPE::KF7),
            "application/pdf" => Some(MIMETYPE::PDF),
            "application/octet-stream" => Some(MIMETYPE::UNKNOWN),
            "text/plain" => Some(MIMETYPE::TXT),
            _ => None,
        }
    }

    pub fn to_file_extension(&self) -> &'static str {
        match *self {
            MIMETYPE::EPUB => "epub",
            MIMETYPE::MOBI => "mobi",
            MIMETYPE::PDF => "pdf",
            MIMETYPE::KF7 => "azw",
            MIMETYPE::KF8 => "azw3",
            MIMETYPE::TXT => "txt",
            MIMETYPE::UNKNOWN => "",
        }
    }

    pub fn from_file_extension(extension: &str) -> Option<Self> {
        match extension.to_lowercase().as_str() {
            "epub" => Some(MIMETYPE::EPUB),
            "mobi" => Some(MIMETYPE::MOBI),
            "pdf" => Some(MIMETYPE::PDF),
            "azw" => Some(MIMETYPE::KF7),
            "azw3" => Some(MIMETYPE::KF8),
            "txt" => Some(MIMETYPE::TXT),
            _ => None,
        }
    }
}

/// Authoritative extension → MIME mapping for every format Citadel serves,
/// shared by book downloads and OPDS asset responses. [`MIMETYPE`] covers the
/// formats Citadel imports; the remaining entries exist because adopted
/// Calibre libraries can hold those book formats (served as-is) and because
/// cover files are images. `txt` carries a charset here for HTTP responses;
/// [`MIMETYPE::as_str`] stays bare for non-HTTP use.
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

impl PartialEq for MIMETYPE {
    fn eq(&self, other: &Self) -> bool {
        matches!(
            (self, other),
            (MIMETYPE::EPUB, MIMETYPE::EPUB)
                | (MIMETYPE::MOBI, MIMETYPE::MOBI)
                | (MIMETYPE::PDF, MIMETYPE::PDF)
                | (MIMETYPE::KF7, MIMETYPE::KF7)
                | (MIMETYPE::KF8, MIMETYPE::KF8)
                | (MIMETYPE::TXT, MIMETYPE::TXT)
                | (MIMETYPE::UNKNOWN, MIMETYPE::UNKNOWN)
        )
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
