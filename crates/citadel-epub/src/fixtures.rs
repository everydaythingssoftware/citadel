//! Builds EPUB archives in memory, for tests and fuzz seeds in this and
//! other crates (feature `fixtures`). Large entries are streamed through the
//! deflate writer, so a test never holds their uncompressed bytes.

use std::io::{Cursor, Write};

use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

type Stream = Box<dyn FnOnce(&mut dyn Write) -> std::io::Result<()>>;

enum Body {
    Bytes(Vec<u8>),
    Stream(Stream),
}

pub struct Builder {
    entries: Vec<(String, Body)>,
}

pub const PACKAGE_PATH: &str = "OEBPS/content.opf";

pub fn container(full_path: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="{full_path}" media-type="application/oebps-package+xml"/></rootfiles></container>"#
    )
}

pub fn package(version: &str, metadata: &str, manifest: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="{version}" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">{metadata}</metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>{manifest}</manifest><spine><itemref idref="text"/></spine></package>"#
    )
}

pub const METADATA: &str = r#"<dc:identifier id="id">urn:uuid:0d4b2c1e-0000-4000-8000-000000000000</dc:identifier><dc:title>A Hostile Book</dc:title><dc:language>en</dc:language>"#;

impl Builder {
    /// Only the `mimetype` entry.
    pub fn empty() -> Self {
        Self {
            entries: vec![(
                "mimetype".into(),
                Body::Bytes(b"application/epub+zip".to_vec()),
            )],
        }
    }

    /// A container naming `OEBPS/content.opf`, and that package document.
    pub fn with_package(document: impl Into<Vec<u8>>) -> Self {
        Self::empty()
            .entry("META-INF/container.xml", container(PACKAGE_PATH))
            .entry(PACKAGE_PATH, document)
            .entry(
                "OEBPS/text.xhtml",
                "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Text</p></body></html>",
            )
    }

    /// A book with `metadata` and extra manifest items.
    pub fn book(metadata: &str, manifest: &str) -> Self {
        Self::with_package(package("3.0", metadata, manifest))
    }

    pub fn entry(mut self, name: &str, bytes: impl Into<Vec<u8>>) -> Self {
        self.entries.push((name.into(), Body::Bytes(bytes.into())));
        self
    }

    pub fn stream(
        mut self,
        name: &str,
        write: impl FnOnce(&mut dyn Write) -> std::io::Result<()> + 'static,
    ) -> Self {
        self.entries
            .push((name.into(), Body::Stream(Box::new(write))));
        self
    }

    pub fn build(self) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in self.entries {
            let method = if name == "mimetype" {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            };
            let options = SimpleFileOptions::default()
                .compression_method(method)
                .large_file(false);
            zip.start_file(name, options).unwrap();
            match body {
                Body::Bytes(bytes) => zip.write_all(&bytes).unwrap(),
                Body::Stream(write) => write(&mut zip).unwrap(),
            }
        }
        zip.finish().unwrap().into_inner()
    }
}

/// Writes `repeat` copies of `unit` in large chunks.
pub fn repeat(out: &mut dyn Write, unit: &[u8], repeat: usize) -> std::io::Result<()> {
    let per_chunk = (64 * 1024 / unit.len().max(1)).max(1);
    let chunk = unit.repeat(per_chunk);
    let mut left = repeat;
    while left >= per_chunk {
        out.write_all(&chunk)?;
        left -= per_chunk;
    }
    out.write_all(&unit.repeat(left))
}

/// A package document whose metadata holds `depth` nested elements.
pub fn nested_package(depth: usize) -> Builder {
    Builder::empty()
        .entry("META-INF/container.xml", container(PACKAGE_PATH))
        .stream(PACKAGE_PATH, move |out| {
            write!(
                out,
                r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{METADATA}"#
            )?;
            repeat(out, b"<x>", depth)?;
            repeat(out, b"</x>", depth)?;
            write!(
                out,
                r#"</metadata><manifest/><spine/></package>"#
            )
        })
}

/// `bindings` namespace declarations, `per_element` on each nested element,
/// around `elements` metadata elements.
pub fn namespaced_package(bindings: usize, per_element: usize, elements: usize) -> Builder {
    Builder::empty()
        .entry("META-INF/container.xml", container(PACKAGE_PATH))
        .stream(PACKAGE_PATH, move |out| {
            write!(
                out,
                r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{METADATA}"#
            )?;
            let wrappers = bindings.div_ceil(per_element.max(1));
            for wrapper in 0..wrappers {
                write!(out, "<w")?;
                for binding in 0..per_element {
                    let n = wrapper * per_element + binding;
                    if n < bindings {
                        write!(out, r#" xmlns:p{n}="urn:x:{n}""#)?;
                    }
                }
                write!(out, ">")?;
            }
            repeat(out, b"<dc:subject>s</dc:subject>", elements)?;
            repeat(out, b"</w>", wrappers)?;
            write!(out, r#"</metadata><manifest/><spine/></package>"#)
        })
}

/// A package document padded with whitespace to `bytes`.
pub fn padded_package(bytes: usize) -> Builder {
    let document = package("3.0", METADATA, "");
    let (head, tail) = document.split_at(document.find("</package>").unwrap());
    let (head, tail) = (head.to_string(), tail.to_string());
    Builder::empty()
        .entry("META-INF/container.xml", container(PACKAGE_PATH))
        .stream(PACKAGE_PATH, move |out| {
            out.write_all(head.as_bytes())?;
            repeat(out, b" ", bytes.saturating_sub(head.len() + tail.len()))?;
            out.write_all(tail.as_bytes())
        })
}

/// A container document padded with whitespace to `bytes`.
pub fn padded_container(bytes: usize) -> Builder {
    let document = container(PACKAGE_PATH);
    let (head, tail) = document.split_at(document.find("</container>").unwrap());
    let (head, tail) = (head.to_string(), tail.to_string());
    Builder::empty()
        .stream("META-INF/container.xml", move |out| {
            out.write_all(head.as_bytes())?;
            repeat(out, b" ", bytes.saturating_sub(head.len() + tail.len()))?;
            out.write_all(tail.as_bytes())
        })
        .entry(PACKAGE_PATH, package("3.0", METADATA, ""))
}

/// A book whose container names `full_path`.
pub fn rootfile(full_path: &str) -> Builder {
    Builder::empty()
        .entry("META-INF/container.xml", container(full_path))
        .entry(PACKAGE_PATH, package("3.0", METADATA, ""))
}

/// A valid book whose end records claim `entries` central-directory
/// entries through a zip64 end record.
pub fn claimed_entries(entries: u64) -> Vec<u8> {
    let mut bytes = Builder::book(METADATA, "").build();
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .unwrap();
    let cd_size = u32::from_le_bytes(bytes[eocd + 12..eocd + 16].try_into().unwrap()) as u64;
    let cd_offset = u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as u64;
    bytes.truncate(eocd);
    let eocd64_at = bytes.len() as u64;
    bytes.extend_from_slice(b"PK\x06\x06");
    bytes.extend_from_slice(&44u64.to_le_bytes());
    bytes.extend_from_slice(&45u16.to_le_bytes());
    bytes.extend_from_slice(&45u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&entries.to_le_bytes());
    bytes.extend_from_slice(&entries.to_le_bytes());
    bytes.extend_from_slice(&cd_size.to_le_bytes());
    bytes.extend_from_slice(&cd_offset.to_le_bytes());
    bytes.extend_from_slice(b"PK\x06\x07");
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&eocd64_at.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(b"PK\x05\x06");
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&u16::MAX.to_le_bytes());
    bytes.extend_from_slice(&u16::MAX.to_le_bytes());
    bytes.extend_from_slice(&u32::MAX.to_le_bytes());
    bytes.extend_from_slice(&u32::MAX.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

/// A valid book ending in the zip64 end records `records`, one after
/// another: `(entries, extensible bytes)` each, the locator naming the one
/// at `declared`. Only the last ends at the locator, so only it is a record
/// the zip crate would accept.
pub fn zip64_end_records(records: &[(u64, u64)], declared: usize) -> Vec<u8> {
    let mut bytes = Builder::book(METADATA, "").build();
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .unwrap();
    let cd_size = u32::from_le_bytes(bytes[eocd + 12..eocd + 16].try_into().unwrap()) as u64;
    let cd_offset = u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as u64;
    bytes.truncate(eocd);
    let mut offsets = Vec::new();
    for (entries, extra) in records {
        offsets.push(bytes.len() as u64);
        bytes.extend_from_slice(b"PK\x06\x06");
        bytes.extend_from_slice(&(44 + extra).to_le_bytes());
        bytes.extend_from_slice(&45u16.to_le_bytes());
        bytes.extend_from_slice(&45u16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&entries.to_le_bytes());
        bytes.extend_from_slice(&entries.to_le_bytes());
        bytes.extend_from_slice(&cd_size.to_le_bytes());
        bytes.extend_from_slice(&cd_offset.to_le_bytes());
        bytes.resize(bytes.len() + *extra as usize, 0);
    }
    bytes.extend_from_slice(b"PK\x06\x07");
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&offsets[declared].to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(b"PK\x05\x06");
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&u16::MAX.to_le_bytes());
    bytes.extend_from_slice(&u16::MAX.to_le_bytes());
    bytes.extend_from_slice(&u32::MAX.to_le_bytes());
    bytes.extend_from_slice(&u32::MAX.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

/// `archive` with the entry `name` declaring 1,000 uncompressed bytes in
/// its local and central headers, whatever it holds.
pub fn understated(mut archive: Vec<u8>, name: &str) -> Vec<u8> {
    let mut at = 0;
    while let Some(found) = archive[at..]
        .windows(4)
        .position(|w| w == b"PK\x03\x04" || w == b"PK\x01\x02")
    {
        let header = at + found;
        let central = &archive[header..header + 4] == b"PK\x01\x02";
        let (size_at, name_len_at, name_at) = if central { (24, 28, 46) } else { (22, 26, 30) };
        let len = u16::from_le_bytes([
            archive[header + name_len_at],
            archive[header + name_len_at + 1],
        ]) as usize;
        if archive.get(header + name_at..header + name_at + len) == Some(name.as_bytes()) {
            archive[header + size_at..header + size_at + 4].copy_from_slice(&1000u32.to_le_bytes());
        }
        at = header + 4;
    }
    archive
}

/// Builds one fixture.
pub type Build = fn() -> Vec<u8>;

/// The hostile fixtures every reader of untrusted EPUBs must survive, by
/// name. Each should be refused.
pub fn hostile() -> Vec<(&'static str, Build)> {
    vec![
        ("opf-depth-70k", || nested_package(70_000).build()),
        ("xmlns-1000-on-one-element", || {
            namespaced_package(1_000, 1_000, 10_000).build()
        }),
        ("xmlns-1000-in-scope", || {
            namespaced_package(1_000, 8, 10_000).build()
        }),
        ("opf-9mib", || padded_package(9 * 1024 * 1024).build()),
        ("container-1mib", || padded_container(1024 * 1024).build()),
        ("cd-1m-entries", || claimed_entries(1_000_000)),
        ("rootfile-empty", || rootfile("").build()),
        ("rootfile-parent", || rootfile("../x.opf").build()),
    ]
}
