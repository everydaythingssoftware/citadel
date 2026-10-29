use std::path::Path;

use chrono::NaiveDateTime;
use mobi::{headers::Language, Mobi};

use super::{non_empty, BookFileMetadata, MAX_COVER_BYTES};
use crate::mime_type::MIMETYPE;

fn language_to_string(lang: &Language) -> String {
    match lang {
        Language::Neutral => "Neutral".to_string(),
        Language::Afrikaans => "Afrikaans".to_string(),
        Language::Albanian => "Albanian".to_string(),
        Language::Arabic => "Arabic".to_string(),
        Language::Armenian => "Armenian".to_string(),
        Language::Assamese => "Assamese".to_string(),
        Language::Azeri => "Azeri".to_string(),
        Language::Basque => "Basque".to_string(),
        Language::Belarusian => "Belarusian".to_string(),
        Language::Bengali => "Bengali".to_string(),
        Language::Bulgarian => "Bulgarian".to_string(),
        Language::Catalan => "Catalan".to_string(),
        Language::Chinese => "Chinese".to_string(),
        Language::Czech => "Czech".to_string(),
        Language::Danish => "Danish".to_string(),
        Language::Dutch => "Dutch".to_string(),
        Language::English => "English".to_string(),
        Language::Estonian => "Estonian".to_string(),
        Language::Faeroese => "Faeroese".to_string(),
        Language::Farsi => "Farsi".to_string(),
        Language::Finnish => "Finnish".to_string(),
        Language::French => "French".to_string(),
        Language::Georgian => "Georgian".to_string(),
        Language::German => "German".to_string(),
        Language::Greek => "Greek".to_string(),
        Language::Gujarati => "Gujarati".to_string(),
        Language::Hebrew => "Hebrew".to_string(),
        Language::Hindi => "Hindi".to_string(),
        Language::Hungarian => "Hungarian".to_string(),
        Language::Icelandic => "Icelandic".to_string(),
        Language::Indonesian => "Indonesian".to_string(),
        Language::Italian => "Italian".to_string(),
        Language::Japanese => "Japanese".to_string(),
        Language::Kannada => "Kannada".to_string(),
        Language::Kazak => "Kazakh".to_string(),
        Language::Konkani => "Konkani".to_string(),
        Language::Korean => "Korean".to_string(),
        Language::Latvian => "Latvian".to_string(),
        Language::Lithuanian => "Lithuanian".to_string(),
        Language::Macedonian => "Macedonian".to_string(),
        Language::Malay => "Malay".to_string(),
        Language::Malayalam => "Malayalam".to_string(),
        Language::Maltese => "Maltese".to_string(),
        Language::Marathi => "Marathi".to_string(),
        Language::Nepali => "Nepali".to_string(),
        Language::Norwegian => "Norwegian".to_string(),
        Language::Oriya => "Oriya".to_string(),
        Language::Polish => "Polish".to_string(),
        Language::Portuguese => "Portuguese".to_string(),
        Language::Punjabi => "Punjabi".to_string(),
        Language::Rhaetoromanic => "Rhaetoromanic".to_string(),
        Language::Romanian => "Romanian".to_string(),
        Language::Russian => "Russian".to_string(),
        Language::Sami => "Sami".to_string(),
        Language::Sanskrit => "Sanskrit".to_string(),
        Language::Serbian => "Serbian".to_string(),
        Language::Slovak => "Slovak".to_string(),
        Language::Slovenian => "Slovenian".to_string(),
        Language::Sorbian => "Sorbian".to_string(),
        Language::Spanish => "Spanish".to_string(),
        Language::Sutu => "Sutu".to_string(),
        Language::Swahili => "Swahili".to_string(),
        Language::Swedish => "Swedish".to_string(),
        Language::Tamil => "Tamil".to_string(),
        Language::Tatar => "Tatar".to_string(),
        Language::Telugu => "Telugu".to_string(),
        Language::Thai => "Thai".to_string(),
        Language::Tsonga => "Tsonga".to_string(),
        Language::Tswana => "Tswana".to_string(),
        Language::Turkish => "Turkish".to_string(),
        Language::Ukrainian => "Ukrainian".to_string(),
        Language::Urdu => "Urdu".to_string(),
        Language::Uzbek => "Uzbek".to_string(),
        Language::Vietnamese => "Vietnamese".to_string(),
        Language::Xhosa => "Xhosa".to_string(),
        Language::Zulu => "Zulu".to_string(),
        Language::Unknown => "Unknown".to_string(),
    }
}

// TODO(CDL-52): `Mobi::from_path` reads the whole file into memory. Read only
// the header records (and the cover record) instead, or cap how much is read.
/// Runs `read` on the parsed file. The mobi crate panics on some malformed
/// files (e.g. record offsets past the end), so a panic counts as unreadable.
fn with_mobi<T>(path: &Path, read: impl FnOnce(&Mobi) -> Option<T>) -> Option<T> {
    let mobi = Mobi::from_path(path).ok()?;
    guarded(|| read(&mobi))
}

fn guarded<T>(read: impl FnOnce() -> Option<T>) -> Option<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(read))
        .ok()
        .flatten()
}

fn cover(mobi: &Mobi) -> Option<Vec<u8>> {
    let record = mobi.image_records().last()?.content;
    (!record.is_empty() && record.len() as u64 <= MAX_COVER_BYTES).then(|| record.to_vec())
}

pub(super) fn read_metadata(path: &Path, format: MIMETYPE) -> Option<BookFileMetadata> {
    with_mobi(path, |mobi| read_metadata_from(mobi, format))
}

fn read_metadata_from(mobi: &Mobi, format: MIMETYPE) -> Option<BookFileMetadata> {
    let publication_date = NaiveDateTime::parse_from_str(
        &mobi.metadata.publish_date().unwrap_or_default(),
        "%Y-%m-%dT%H:%M:%S%z",
    )
    .map(|date| date.date())
    .ok();

    Some(BookFileMetadata {
        format,
        title: non_empty(&mobi.title()),
        author_names: mobi
            .author()
            .as_deref()
            .and_then(non_empty)
            .into_iter()
            .collect(),
        identifier: mobi
            .isbn()
            .as_deref()
            .and_then(non_empty)
            .map(|isbn| format!("ISBN:{isbn}")),
        publisher: mobi.publisher().as_deref().and_then(non_empty),
        language: Some(language_to_string(&mobi.language())),
        tags: mobi
            .metadata
            .subjects()
            .unwrap_or_default()
            .iter()
            .filter_map(|subject| non_empty(subject))
            .collect(),
        publication_date,
        has_cover: guarded(|| cover(mobi)).is_some(),
    })
}

pub(super) fn cover_image_data(path: &Path) -> Option<Vec<u8>> {
    with_mobi(path, cover)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_files_have_no_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.azw3");
        std::fs::write(&path, b"not a mobi").unwrap();
        assert_eq!(read_metadata(&path, MIMETYPE::KF8), None);
        assert_eq!(cover_image_data(&path), None);
    }

    #[test]
    fn truncated_files_are_unreadable_instead_of_panicking() {
        // A PalmDB header whose single record starts past the end of the file.
        let mut data = vec![0u8; 78];
        data[0..4].copy_from_slice(b"Book");
        data[60..68].copy_from_slice(b"BOOKMOBI");
        data[76..78].copy_from_slice(&1u16.to_be_bytes());
        data.extend_from_slice(&10_000u32.to_be_bytes());
        data.extend_from_slice(&[0; 4]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("truncated.mobi");
        std::fs::write(&path, data).unwrap();
        assert_eq!(read_metadata(&path, MIMETYPE::MOBI), None);
        assert_eq!(cover_image_data(&path), None);
    }
}
