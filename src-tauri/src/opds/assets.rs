use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Take},
    path::Path,
};

use libcalibre::ResolvedBookAsset;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetMethod {
    Get,
    Head,
}

#[derive(Debug, Eq, PartialEq)]
pub struct AssetHeaders {
    pub accept_ranges: &'static str,
    pub content_disposition: String,
    pub content_length: u64,
    pub content_range: Option<String>,
    pub content_type: &'static str,
}

/// A bounded synchronous file stream. CDL-23 can move reads onto its HTTP
/// runtime's blocking adapter without coupling asset resolution to a framework.
pub struct AssetBody {
    reader: Take<File>,
}

impl Read for AssetBody {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.reader.read(buffer)
    }
}

pub struct AssetResponse {
    pub status: u16,
    pub headers: AssetHeaders,
    pub body: Option<AssetBody>,
}

#[derive(Debug)]
pub enum AssetResponseError {
    Io(io::Error),
    RangeNotSatisfiable { length: u64 },
}

impl std::fmt::Display for AssetResponseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Could not open asset: {error}"),
            Self::RangeNotSatisfiable { length } => {
                write!(
                    formatter,
                    "Range is not satisfiable for a {length}-byte asset"
                )
            }
        }
    }
}

impl std::error::Error for AssetResponseError {}

impl AssetResponseError {
    pub fn status(&self) -> u16 {
        match self {
            Self::Io(_) => 500,
            Self::RangeNotSatisfiable { .. } => 416,
        }
    }

    pub fn content_range(&self) -> Option<String> {
        match self {
            Self::RangeNotSatisfiable { length } => Some(format!("bytes */{length}")),
            Self::Io(_) => None,
        }
    }
}

impl From<io::Error> for AssetResponseError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SelectedRange {
    start: u64,
    end: u64,
}

impl SelectedRange {
    fn length(self) -> u64 {
        self.end - self.start + 1
    }
}

pub fn prepare(
    asset: &ResolvedBookAsset,
    method: AssetMethod,
    range_header: Option<&str>,
) -> Result<AssetResponse, AssetResponseError> {
    prepare_path(
        asset.canonical_path(),
        asset.download_name(),
        asset.format(),
        method,
        range_header,
    )
}

fn prepare_path(
    path: &Path,
    download_name: &str,
    format: &str,
    method: AssetMethod,
    range_header: Option<&str>,
) -> Result<AssetResponse, AssetResponseError> {
    let mut file = File::open(path)?;
    let full_length = file.metadata()?.len();
    let selected = match range_header {
        Some(header) => Some(parse_range(header, full_length)?),
        None => None,
    };
    let (status, start, content_length, content_range) = match selected {
        Some(range) => (
            206,
            range.start,
            range.length(),
            Some(format!(
                "bytes {}-{}/{}",
                range.start, range.end, full_length
            )),
        ),
        None => (200, 0, full_length, None),
    };

    let body = if method == AssetMethod::Get {
        file.seek(SeekFrom::Start(start))?;
        Some(AssetBody {
            reader: file.take(content_length),
        })
    } else {
        None
    };

    Ok(AssetResponse {
        status,
        headers: AssetHeaders {
            accept_ranges: "bytes",
            content_disposition: content_disposition(download_name),
            content_length,
            content_range,
            content_type: mime_type(format),
        },
        body,
    })
}

fn parse_range(header: &str, length: u64) -> Result<SelectedRange, AssetResponseError> {
    let invalid = || AssetResponseError::RangeNotSatisfiable { length };
    let value = header
        .strip_prefix("bytes=")
        .filter(|value| !value.contains(','))
        .ok_or_else(invalid)?;
    let (start, end) = value.split_once('-').ok_or_else(invalid)?;
    if length == 0 {
        return Err(invalid());
    }

    match (start.is_empty(), end.is_empty()) {
        (false, false) => {
            let start = start.parse::<u64>().map_err(|_| invalid())?;
            let requested_end = end.parse::<u64>().map_err(|_| invalid())?;
            if start >= length || start > requested_end {
                return Err(invalid());
            }
            Ok(SelectedRange {
                start,
                end: requested_end.min(length - 1),
            })
        }
        (false, true) => {
            let start = start.parse::<u64>().map_err(|_| invalid())?;
            if start >= length {
                return Err(invalid());
            }
            Ok(SelectedRange {
                start,
                end: length - 1,
            })
        }
        (true, false) => {
            let suffix = end.parse::<u64>().map_err(|_| invalid())?;
            if suffix == 0 {
                return Err(invalid());
            }
            Ok(SelectedRange {
                start: length.saturating_sub(suffix),
                end: length - 1,
            })
        }
        (true, true) => Err(invalid()),
    }
}

pub fn mime_type(format: &str) -> &'static str {
    match format.to_ascii_lowercase().as_str() {
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

fn content_disposition(filename: &str) -> String {
    let fallback: String = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || matches!(character, ' ' | '.' | '-' | '_' | '(' | ')')
            {
                character
            } else {
                '_'
            }
        })
        .collect();
    let encoded = percent_encode(filename.as_bytes());
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

fn percent_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(bytes.len());
    for &byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    fn file(bytes: &[u8]) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), bytes).unwrap();
        file
    }

    #[test]
    fn get_streams_the_complete_file_with_download_headers() {
        let file = file(b"0123456789");
        let mut response =
            prepare_path(file.path(), "A Book.epub", "EPUB", AssetMethod::Get, None).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.headers.content_length, 10);
        assert_eq!(response.headers.content_type, "application/epub+zip");
        assert_eq!(response.headers.accept_ranges, "bytes");
        assert_eq!(response.headers.content_range, None);
        let mut bytes = Vec::new();
        response
            .body
            .as_mut()
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"0123456789");
    }

    #[test]
    fn head_has_get_headers_and_no_body() {
        let file = file(b"0123456789");
        let response =
            prepare_path(file.path(), "A Book.pdf", "PDF", AssetMethod::Head, None).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.headers.content_length, 10);
        assert_eq!(response.headers.content_type, "application/pdf");
        assert!(response.body.is_none());
    }

    #[test]
    fn streams_closed_open_and_suffix_ranges() {
        let cases = [
            ("bytes=2-5", "bytes 2-5/10", b"2345".as_slice()),
            ("bytes=7-", "bytes 7-9/10", b"789".as_slice()),
            ("bytes=-3", "bytes 7-9/10", b"789".as_slice()),
            ("bytes=8-99", "bytes 8-9/10", b"89".as_slice()),
        ];
        for (header, expected_range, expected_bytes) in cases {
            let file = file(b"0123456789");
            let mut response = prepare_path(
                file.path(),
                "book.epub",
                "epub",
                AssetMethod::Get,
                Some(header),
            )
            .unwrap();
            assert_eq!(response.status, 206);
            assert_eq!(
                response.headers.content_range.as_deref(),
                Some(expected_range)
            );
            assert_eq!(response.headers.content_length, expected_bytes.len() as u64);
            let mut bytes = Vec::new();
            response
                .body
                .as_mut()
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            assert_eq!(bytes, expected_bytes);
        }
    }

    #[test]
    fn head_honors_ranges_without_opening_a_body() {
        let file = file(b"0123456789");
        let response = prepare_path(
            file.path(),
            "book.epub",
            "epub",
            AssetMethod::Head,
            Some("bytes=2-5"),
        )
        .unwrap();
        assert_eq!(response.status, 206);
        assert_eq!(response.headers.content_length, 4);
        assert_eq!(
            response.headers.content_range.as_deref(),
            Some("bytes 2-5/10")
        );
        assert!(response.body.is_none());
    }

    #[test]
    fn rejects_invalid_unsatisfiable_and_multiple_ranges_as_416() {
        for header in [
            "items=0-1",
            "bytes=",
            "bytes=20-30",
            "bytes=7-2",
            "bytes=-0",
            "bytes=0-1,4-5",
        ] {
            let file = file(b"0123456789");
            let error = prepare_path(file.path(), "book", "bin", AssetMethod::Get, Some(header))
                .err()
                .unwrap();
            assert!(matches!(
                &error,
                AssetResponseError::RangeNotSatisfiable { length: 10 }
            ));
            assert_eq!(error.status(), 416);
            assert_eq!(error.content_range().as_deref(), Some("bytes */10"));
        }
    }

    #[test]
    fn empty_assets_reject_ranges_but_support_full_get() {
        let file = file(b"");
        let response = prepare_path(file.path(), "empty", "bin", AssetMethod::Get, None).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.headers.content_length, 0);
        assert!(matches!(
            prepare_path(
                file.path(),
                "empty",
                "bin",
                AssetMethod::Get,
                Some("bytes=0-")
            ),
            Err(AssetResponseError::RangeNotSatisfiable { length: 0 })
        ));
    }

    #[test]
    fn content_disposition_cannot_inject_headers_and_preserves_unicode() {
        let header = content_disposition("Résumé\"\r\nX-Evil: yes.epub");
        assert!(!header.contains('\r'));
        assert!(!header.contains('\n'));
        assert!(header.contains("filename=\"R_sum____X-Evil_ yes.epub\""));
        assert!(header.contains("filename*=UTF-8''R%C3%A9sum%C3%A9%22%0D%0AX-Evil%3A%20yes.epub"));
    }

    #[test]
    fn maps_known_types_and_falls_back_for_unknown_formats() {
        assert_eq!(mime_type("AZW3"), "application/vnd.amazon.ebook-kf8");
        assert_eq!(mime_type("cbz"), "application/vnd.comicbook+zip");
        assert_eq!(mime_type("unexpected"), "application/octet-stream");
    }

    #[test]
    fn cover_assets_flow_through_the_same_response_preparation() {
        let file = file(b"jpeg");
        let response =
            prepare_path(file.path(), "cover.jpg", "JPG", AssetMethod::Get, None).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.headers.content_type, "image/jpeg");
        assert!(response
            .headers
            .content_disposition
            .contains("filename=\"cover.jpg\""));
    }

    #[test]
    fn large_file_body_is_a_bounded_stream_not_an_allocated_payload() {
        let file = file(b"");
        file.as_file().set_len(64 * 1024 * 1024).unwrap();
        let mut response =
            prepare_path(file.path(), "large.epub", "epub", AssetMethod::Get, None).unwrap();
        assert_eq!(response.headers.content_length, 64 * 1024 * 1024);

        let mut first_chunk = [0_u8; 1024];
        let read = response
            .body
            .as_mut()
            .unwrap()
            .read(&mut first_chunk)
            .unwrap();
        assert_eq!(read, first_chunk.len());
    }
}
