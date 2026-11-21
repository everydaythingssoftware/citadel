//! Deeply nested EPUBs, read through the public API on a 2 MiB stack in a
//! child process: the XML reader EPUBs used to go through recursed once per
//! level and aborted the whole process on these files.
use std::{io::Write, path::Path, process::Command};

use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const CASE: &str = "LIBCALIBRE_HOSTILE_EPUB_CASE";

fn repeat(out: &mut impl Write, unit: &str, times: usize) {
    out.write_all(unit.repeat(times).as_bytes()).unwrap();
}

/// An EPUB whose package metadata nests `opf_depth` elements and whose NCX
/// nests `ncx_depth` navPoints.
fn write_epub(path: &Path, opf_depth: usize, ncx_depth: usize) {
    let mut zip = ZipWriter::new(std::fs::File::create(path).unwrap());
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(
        "mimetype",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    zip.start_file("META-INF/container.xml", deflated).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
    zip.start_file("content.opf", deflated).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>Deep</dc:title>"#).unwrap();
    repeat(&mut zip, "<x>", opf_depth);
    repeat(&mut zip, "</x>", opf_depth);
    zip.write_all(br#"</metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="t" href="t.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="t"/></spine></package>"#).unwrap();
    zip.start_file("toc.ncx", deflated).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>"#).unwrap();
    repeat(
        &mut zip,
        r#"<navPoint id="n"><navLabel><text>x</text></navLabel><content src="t.xhtml"/>"#,
        ncx_depth,
    );
    repeat(&mut zip, "</navPoint>", ncx_depth);
    zip.write_all(b"</navMap></ncx>").unwrap();
    zip.start_file("t.xhtml", deflated).unwrap();
    zip.write_all(b"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body/></html>")
        .unwrap();
    zip.finish().unwrap();
}

fn run_case(name: &str) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deep.epub");
    let expected_title = match name {
        "opf-40k" => {
            write_epub(&path, 40_000, 1);
            None
        }
        "ncx-10k" => {
            write_epub(&path, 1, 10_000);
            Some("Deep".to_string())
        }
        other => panic!("no case {other}"),
    };
    let title = std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || libcalibre::book_file::read_metadata(&path).and_then(|m| m.title))
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(title, expected_title);
    println!("case {name} ok");
}

#[test]
fn child() {
    if let Ok(name) = std::env::var(CASE) {
        run_case(&name);
    }
}

#[test]
fn deeply_nested_epubs_do_not_abort_the_process() {
    let exe = std::env::current_exe().unwrap();
    for name in ["opf-40k", "ncx-10k"] {
        let output = Command::new(&exe)
            .args(["child", "--exact", "--nocapture", "--test-threads=1"])
            .env(CASE, name)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains(&format!("case {name} ok")),
            "{name}: {:?}\n{stdout}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
