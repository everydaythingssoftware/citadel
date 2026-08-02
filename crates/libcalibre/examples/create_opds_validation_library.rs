use std::{collections::HashMap, env, fs, path::PathBuf};

use chrono::NaiveDate;
use libcalibre::{util::get_db_path, BookAdd, BookUpdate, Library};

const ACQUIRABLE_BOOKS: usize = 105;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let target = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: create_opds_validation_library TARGET SOURCE_EPUB")?;
    let source_epub = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: create_opds_validation_library TARGET SOURCE_EPUB")?;
    if arguments.next().is_some() {
        return Err("usage: create_opds_validation_library TARGET SOURCE_EPUB".into());
    }
    if target.exists() && fs::read_dir(&target)?.next().is_some() {
        return Err(format!("target is not empty: {}", target.display()).into());
    }
    if source_epub.extension().and_then(|value| value.to_str()) != Some("epub") {
        return Err("SOURCE_EPUB must use the .epub extension".into());
    }

    fs::create_dir_all(&target)?;
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/empty_library/metadata.db");
    fs::copy(fixture, target.join("metadata.db"))?;
    let database = get_db_path(target.to_str().ok_or("target path is not UTF-8")?)
        .ok_or("target is not a Calibre library")?;
    let mut library = Library::new(database)?;
    let large_source = target.join(".validation-large.txt");
    let coverless_source = target.join(".validation-coverless.txt");
    fs::write(&large_source, vec![b'L'; 8 * 1024 * 1024])?;
    fs::write(&coverless_source, b"Coverless validation fixture\n")?;

    for index in 0..=ACQUIRABLE_BOOKS {
        let is_fileless = index == ACQUIRABLE_BOOKS;
        let title = if index == 0 {
            "A & B <C> — 東京".to_string()
        } else {
            format!("Validation Book {index:03}")
        };
        let authors = if index == 0 {
            vec!["Zoë & Co.".to_string(), "李 小龍".to_string()]
        } else {
            vec![format!("Author {:03}", index % 61)]
        };
        let series = (index % 2 == 0).then(|| format!("Series {:02}", index % 7));
        let tags = match index % 3 {
            0 => vec!["Science Fiction".to_string(), "Tag & <unsafe>".to_string()],
            1 => vec!["Mystery".to_string()],
            _ => Vec::new(),
        };
        let book = library.add_book(BookAdd {
            title,
            author_names: authors,
            tags: Some(tags),
            series,
            series_index: Some(index as f32 / 2.0 + 0.5),
            publisher: None,
            publication_date: Some(NaiveDate::from_ymd_opt(2020, 1, 1).unwrap()),
            rating: None,
            comments: None,
            identifiers: HashMap::new(),
            language: Some(if index % 2 == 0 { "en" } else { "fr" }.to_string()),
            file_paths: if is_fileless {
                Vec::new()
            } else if index == 0 {
                vec![large_source.clone(), source_epub.clone()]
            } else if index % 2 == 1 {
                vec![coverless_source.clone(), source_epub.clone()]
            } else {
                vec![source_epub.clone()]
            },
        })?;

        library.upsert_book_identifier(
            book.id,
            "isbn".to_string(),
            format!("9780000{index:06}"),
            None,
        )?;

        library.update_book(
            book.id,
            BookUpdate {
                title: None,
                author_names: None,
                author_ids: None,
                description: (index % 4 != 0)
                    .then(|| "Escaped <summary> & Unicode café 東京".to_string()),
                is_read: Some(index % 3 == 0),
                tags: None,
                series: None,
                series_index: None,
                language_codes: None,
                publisher: (index % 5 != 0).then(|| "Fixture Press".to_string()),
                publication_date: None,
                rating: None,
                comments: None,
                identifiers: None,
            },
        )?;

        if index % 3 != 2 {
            library.add_book_genres(
                book.id,
                vec![
                    if index % 2 == 0 {
                        "Speculative Fiction"
                    } else {
                        "Mystery"
                    }
                    .to_string(),
                    "Fixture Genre".to_string(),
                ],
            )?;
        }
    }

    drop(library);
    fs::remove_file(large_source)?;
    fs::remove_file(coverless_source)?;
    println!("{}", target.display());
    Ok(())
}
