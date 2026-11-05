//! Citadel's genres: a multiple-value text custom column, `#citadel_genres`,
//! that Calibre shows as "Genres". libcalibre only knows it as a custom
//! column; the label, its definition and how genre names are normalized live
//! here. See `docs/adr/0006-canonical-book-genres.md`.
use libcalibre::{
    BookId, CalibreError, CatalogFacetKind, CustomColumn, CustomColumnKind, CustomColumnSpec,
    CustomValue, CustomValueFilter, Library,
};

pub const GENRES_COLUMN: &str = "citadel_genres";

/// The catalog facet listing genres.
pub fn facet() -> CatalogFacetKind {
    CatalogFacetKind::CustomColumn(GENRES_COLUMN.to_string())
}

/// A [`libcalibre::BookQuery::custom_value`] matching books in one genre.
pub fn filter(genre_id: i32) -> CustomValueFilter {
    CustomValueFilter {
        column_label: GENRES_COLUMN.to_string(),
        value_id: genre_id,
    }
}

/// Replace a book's genres. Creates the column on the first non-empty set.
pub fn set_book_genres(
    library: &mut Library,
    book_id: BookId,
    genres: Vec<String>,
) -> Result<(), CalibreError> {
    let genres = normalize(genres);
    let column = match genres_column(library)? {
        Some(column) => column,
        None if genres.is_empty() => return Ok(()),
        None => create_genres_column(library)?,
    };
    library.set_custom_value(book_id, column.id, Some(CustomValue::TextMultiple(genres)))
}

/// Add genres to a book's existing ones, skipping case-insensitive repeats.
pub fn add_book_genres(
    library: &mut Library,
    book_id: BookId,
    genres: Vec<String>,
) -> Result<(), CalibreError> {
    let additions = normalize(genres);
    if additions.is_empty() {
        return Ok(());
    }
    let mut merged = match genres_column(library)? {
        Some(column) => match library.get_custom_value(book_id, column.id)? {
            Some(CustomValue::TextMultiple(values)) => values,
            None => Vec::new(),
            Some(_) => unreachable!("genre column compatibility is checked"),
        },
        None => Vec::new(),
    };
    merged.extend(additions);
    set_book_genres(library, book_id, merged)
}

fn genres_column(library: &mut Library) -> Result<Option<CustomColumn>, CalibreError> {
    let Some(column) = library.custom_column(GENRES_COLUMN)? else {
        return Ok(None);
    };
    if column.kind != CustomColumnKind::Text || !column.is_multiple {
        return Err(CalibreError::InvalidCustomColumn(format!(
            "#{GENRES_COLUMN} must be a multiple-value text column"
        )));
    }
    Ok(Some(column))
}

fn create_genres_column(library: &mut Library) -> Result<CustomColumn, CalibreError> {
    library.create_custom_column(CustomColumnSpec {
        label: GENRES_COLUMN.to_string(),
        name: "Genres".to_string(),
        kind: CustomColumnKind::Text,
        is_multiple: true,
        enum_values: Vec::new(),
        display: None,
    })
}

/// Collapse whitespace and drop empty and case-insensitively repeated names,
/// keeping the first spelling.
fn normalize(genres: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::<String>::new();
    for genre in genres {
        let genre = genre.split_whitespace().collect::<Vec<_>>().join(" ");
        if !genre.is_empty()
            && !normalized
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&genre))
        {
            normalized.push(genre);
        }
    }
    normalized
}
