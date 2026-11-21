//! Reads every EPUB under the given directories and reports refusals and
//! unreadable files. Unpacked books (a folder holding
//! `META-INF/container.xml`) are zipped in memory first.
//!
//! cargo run -p citadel-epub --release --example scan -- <directory>...
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use citadel_epub::{Epub, EpubError};
use zip::{write::SimpleFileOptions, ZipWriter};

const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;

fn zipped(root: &Path) -> std::io::Result<Vec<u8>> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files.sort();
    for path in files {
        let name = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        zip.start_file(name, SimpleFileOptions::default())?;
        zip.write_all(&fs::read(&path)?)?;
    }
    Ok(zip.finish()?.into_inner())
}

enum Outcome {
    Read { has_cover: bool },
    Refused(String),
    Unreadable(String),
}

fn read(bytes: Vec<u8>) -> Outcome {
    let opened = Epub::open(Cursor::new(bytes)).and_then(|mut epub| {
        let cover = epub.cover(MAX_COVER_BYTES)?;
        Ok(cover.is_some())
    });
    match opened {
        Ok(has_cover) => Outcome::Read { has_cover },
        Err(EpubError::Refused(refusal)) => Outcome::Refused(refusal.to_string()),
        Err(EpubError::Unreadable(reason)) => Outcome::Unreadable(reason.to_string()),
    }
}

fn main() {
    let mut books: Vec<PathBuf> = Vec::new();
    let mut pending: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    while let Some(path) = pending.pop() {
        if path.is_dir() {
            if path.join("META-INF/container.xml").is_file() {
                books.push(path);
                continue;
            }
            if let Ok(entries) = fs::read_dir(&path) {
                pending.extend(entries.flatten().map(|entry| entry.path()));
            }
        } else if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
        {
            books.push(path);
        }
    }
    books.sort();

    let (mut read_count, mut covers, mut refused, mut unreadable) = (0, 0, Vec::new(), Vec::new());
    for book in &books {
        let bytes = if book.is_dir() {
            zipped(book)
        } else {
            fs::read(book)
        };
        let outcome = match bytes {
            Ok(bytes) => read(bytes),
            Err(error) => Outcome::Unreadable(format!("couldn't load: {error}")),
        };
        match outcome {
            Outcome::Read { has_cover } => {
                read_count += 1;
                covers += usize::from(has_cover);
            }
            Outcome::Refused(reason) => refused.push((book, reason)),
            Outcome::Unreadable(reason) => unreadable.push((book, reason)),
        }
    }
    println!(
        "{} books: {read_count} read ({covers} with a cover), {} refused, {} unreadable",
        books.len(),
        refused.len(),
        unreadable.len()
    );
    for (book, reason) in &refused {
        println!("refused    {}: {reason}", book.display());
    }
    for (book, reason) in &unreadable {
        println!("unreadable {}: {reason}", book.display());
    }
}
