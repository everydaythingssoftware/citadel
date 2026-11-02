use std::{collections::HashMap, path::PathBuf};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub struct ImportableFile {
    pub(crate) path: PathBuf,
}

#[derive(Serialize, Deserialize, specta::Type)]
pub enum ImportableBookType {
    Epub = 0,
    Pdf = 1,
    Mobi = 2,
    Text = 3,
}

impl std::fmt::Display for ImportableBookType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportableBookType::Epub => write!(f, "EPUB"),
            ImportableBookType::Pdf => write!(f, "PDF"),
            ImportableBookType::Mobi => write!(f, "MOBI"),
            ImportableBookType::Text => write!(f, "TXT"),
        }
    }
}

/// Represents metadata for pre-import books, which have a very loose structure.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct ImportableBookMetadata {
    pub file_type: ImportableBookType,
    /// The title of the book, if one is available, or the name of the file to import.
    pub title: String,
    /// The list of authors of the book, if available. Some books may not be formatted correctly,
    /// and will have no authors, or all author names will be one string separated by "," or ";".
    pub author_names: Option<Vec<String>>,
    pub identifier: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub tags: Vec<String>,
    /// Path of the file to import.
    pub path: PathBuf,
    pub publication_date: Option<NaiveDate>,
    /// True if a cover image can be extracted from the file at `path`.
    pub file_contains_cover: bool,
}

impl ImportableBookMetadata {
    pub fn to_book_add(&self) -> libcalibre::BookAdd {
        libcalibre::BookAdd {
            title: self.title.clone(),
            author_names: self.author_names.clone().unwrap_or_default(),
            tags: if self.tags.is_empty() {
                None
            } else {
                Some(self.tags.clone())
            },
            series: None,
            series_index: None,
            publisher: self.publisher.clone(),
            publication_date: self.publication_date,
            rating: None,
            comments: None,
            language: self.language.clone(),
            identifiers: self
                .identifier
                .as_deref()
                .and_then(libcalibre::book_file::isbn)
                .map(|isbn| HashMap::from([("isbn".to_string(), isbn)]))
                .unwrap_or_default(),
            file_paths: vec![self.path.clone()],
        }
    }
}
