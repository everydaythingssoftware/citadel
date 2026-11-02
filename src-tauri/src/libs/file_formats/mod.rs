use libcalibre::mime_type::MIMETYPE;
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::imports::ImportableFile;
use crate::imports::{ImportableBookMetadata, ImportableBookType};

#[derive(Serialize, Clone, Copy, specta::Type)]
pub enum SupportedFormats {
    EPUB,
    MOBI,
    PDF,
    KF7, // Kindle Format 7 — AZW files
    KF8, // Kindle Format 8 — AZW3 files
    TXT,
    UNKNOWN,
}

impl SupportedFormats {
    fn variants() -> &'static [SupportedFormats] {
        &[
            SupportedFormats::EPUB,
            SupportedFormats::MOBI,
            SupportedFormats::PDF,
            SupportedFormats::KF7,
            SupportedFormats::KF8,
            SupportedFormats::TXT,
            SupportedFormats::UNKNOWN,
        ]
    }

    pub fn list_all() -> Vec<(SupportedFormats, &'static str)> {
        SupportedFormats::variants()
            .iter()
            .map(|v| (*v, v.to_file_extension()))
            .collect()
    }

    pub fn is_supported(ext: &str) -> bool {
        Self::from_file_extension(ext).is_some()
    }

    pub fn to_file_extension(&self) -> &'static str {
        match *self {
            Self::EPUB => "epub",
            Self::MOBI => "mobi",
            Self::PDF => "pdf",
            Self::KF7 => "azw",
            Self::KF8 => "azw3",
            Self::TXT => "txt",
            Self::UNKNOWN => "",
        }
    }

    pub fn from_file_extension(extension: &str) -> Option<Self> {
        match extension.to_lowercase().as_str() {
            "epub" => Some(Self::EPUB),
            "mobi" => Some(Self::MOBI),
            "pdf" => Some(Self::PDF),
            "azw" => Some(Self::KF7),
            "azw3" => Some(Self::KF8),
            "txt" => Some(Self::TXT),
            _ => None,
        }
    }
}

/// Validate if a file at some path is importable.
/// Ensures the file exists and has a supported file extension.
pub fn validate_file_importable(path: &Path) -> Option<ImportableFile> {
    if !&path.exists() {
        return None;
    }
    let ext = &path.extension().and_then(|s| s.to_str()).unwrap_or("");

    match SupportedFormats::from_file_extension(ext) {
        Some(_) => Some(ImportableFile {
            path: PathBuf::from(path),
        }),
        _ => None,
    }
}

pub fn get_importable_file_metadata(file: ImportableFile) -> Option<ImportableBookMetadata> {
    let metadata = libcalibre::book_file::read_metadata(&file.path)?;
    let file_type = match metadata.format {
        MIMETYPE::EPUB => ImportableBookType::Epub,
        MIMETYPE::MOBI | MIMETYPE::KF7 | MIMETYPE::KF8 => ImportableBookType::Mobi,
        MIMETYPE::PDF => ImportableBookType::Pdf,
        MIMETYPE::TXT => ImportableBookType::Text,
        MIMETYPE::UNKNOWN => return None,
    };
    Some(ImportableBookMetadata {
        file_type,
        title: metadata.title.unwrap_or_default(),
        author_names: (!metadata.author_names.is_empty()).then_some(metadata.author_names),
        identifier: metadata.identifier,
        publisher: metadata.publisher,
        language: metadata.language,
        tags: metadata.tags,
        path: file.path,
        publication_date: metadata.publication_date,
        file_contains_cover: metadata.has_cover,
    })
}
