use std::collections::HashMap;

use chrono::NaiveDateTime;
use diesel::{Connection, SqliteConnection};

use crate::{
    library::{Book, BookFileInfo, BookIdentifier, BookUpdate},
    queries::{
        authors, book_descriptions, book_files, book_identifiers, books, languages, series, tags,
    },
    types::{AuthorId, BookId},
    BookRow, CalibreError, UpdateBookData,
};

pub fn update_book(
    conn: &mut SqliteConnection,
    book_id: BookId,
    update: BookUpdate,
) -> Result<(), CalibreError> {
    if update.author_names.is_some() && update.author_ids.is_some() {
        return Err(CalibreError::BannedFunctionInvocation(
            "Cannot provide both author_names and author_ids".to_string(),
        ));
    }

    conn.transaction::<(), CalibreError, _>(|conn| {
        // Only update the book row if there are actual book-row field changes
        let has_book_row_changes = update.title.is_some()
            || update.publication_date.is_some()
            || update.series_index.is_some();

        if has_book_row_changes {
            let book_update = UpdateBookData {
                title: update.title,
                pubdate: update.publication_date.map(NaiveDateTime::from),
                series_index: update.series_index,

                author_sort: None,
                has_cover: None,
                timestamp: None,
                path: None,
            };

            books::update(conn, book_id, book_update)?;
        }

        if let Some(series_name) = update.series {
            let series_name = series_name.trim();
            if series_name.is_empty() {
                series::unlink_book(conn, book_id)?;
            } else {
                let book_series = series::create_if_not_exists(conn, series_name)?;
                series::set_book_series(conn, book_series.id, book_id)?;
            }
        }

        if let Some(codes) = update.language_codes {
            languages::set_for_book(conn, book_id, &codes)?;
        }

        if let Some(description) = update.description {
            let existing = book_descriptions::get(conn, book_id)?;
            if existing.is_some() {
                book_descriptions::update(conn, book_id, description)?;
            } else {
                book_descriptions::create(conn, book_id, description)?;
            }
        }

        if let Some(author_names) = update.author_names {
            let existing = books::find_authors(conn, book_id)?;
            let existing_authors = authors::get_many(conn, existing)?;

            let to_unlink: Vec<AuthorId> = existing_authors
                .iter()
                .filter(|a| !author_names.contains(&a.name))
                .map(|a| AuthorId(a.id))
                .collect();

            for author_id in to_unlink {
                authors::unlink_book(conn, author_id, book_id)?;
            }

            let to_link: Vec<String> = author_names
                .iter()
                .filter(|name| !existing_authors.iter().any(|a| &a.name == *name))
                .cloned()
                .collect();

            for author_name in to_link {
                let author = authors::create_if_not_exists(conn, author_name.as_str())?;
                authors::link_book(conn, AuthorId(author.id), book_id)?;
            }
        }

        if let Some(author_ids) = update.author_ids {
            let existing = books::find_authors(conn, book_id)?;
            let existing_authors = authors::get_many(conn, existing)?;

            let to_unlink: Vec<AuthorId> = existing_authors
                .iter()
                .filter(|a| !author_ids.contains(&AuthorId(a.id)))
                .map(|a| AuthorId(a.id))
                .collect();

            for author_id in to_unlink {
                authors::unlink_book(conn, author_id, book_id)?;
            }

            let to_link: Vec<AuthorId> = author_ids
                .iter()
                .filter(|id| !existing_authors.iter().any(|a| &AuthorId(a.id) == *id))
                .cloned()
                .collect();

            for author_id in to_link {
                authors::link_book(conn, author_id, book_id)?;
            }
        }

        if let Some(tag_names) = update.tags {
            let tag_names = unique_tag_names(&tag_names);
            let existing_tags = tags::find_for_book(conn, book_id)?;

            let to_unlink: Vec<i32> = existing_tags
                .iter()
                .filter(|tag| {
                    !tag_names
                        .iter()
                        .any(|name| name.eq_ignore_ascii_case(&tag.name))
                })
                .map(|tag| tag.id)
                .collect();

            for tag_id in to_unlink {
                tags::unlink_book(conn, tag_id, book_id)?;
            }

            let to_link: Vec<String> = tag_names
                .iter()
                .filter(|name| {
                    !existing_tags
                        .iter()
                        .any(|tag| name.eq_ignore_ascii_case(&tag.name))
                })
                .map(|name| (*name).to_string())
                .collect();

            for tag_name in to_link {
                let tag = tags::create_if_not_exists(conn, &tag_name)?;
                tags::link_book(conn, tag.id, book_id)?;
            }
        }

        books::touch(conn, book_id)?;
        Ok(())
    })
}

fn unique_tag_names(tag_names: &[String]) -> Vec<&str> {
    let mut unique = Vec::new();

    for tag_name in tag_names {
        if !unique
            .iter()
            .any(|existing: &&str| existing.eq_ignore_ascii_case(tag_name))
        {
            unique.push(tag_name.as_str());
        }
    }

    unique
}

pub fn get_book(conn: &mut SqliteConnection, book_id: BookId) -> Result<Book, CalibreError> {
    let book = books::get(conn, book_id)?.ok_or(CalibreError::BookNotFound(book_id))?;
    let book_desc = book_descriptions::get(conn, book_id)?;
    let author_ids = books::find_authors(conn, book_id)?;
    let author_models = authors::get_many(conn, author_ids)?;
    let tags = tags::find_for_book(conn, book_id)?;
    let series_name = series::find_series_name_for_book(conn, book_id)?;
    let language_codes = languages::find_codes_for_book(conn, book_id)?;
    let identifier_models = book_identifiers::get(conn, book_id)?;
    let file_models = book_files::find_by_book_id(conn, book_id)?;

    let book_authors = to_library_authors(author_models);

    let identifiers: Vec<BookIdentifier> = identifier_models
        .into_iter()
        .map(|id| BookIdentifier {
            id: id.id,
            label: id.type_,
            value: id.val,
        })
        .collect();

    let files: Vec<BookFileInfo> = file_models
        .into_iter()
        .map(|f| BookFileInfo {
            id: f.id,
            format: f.format,
            name: f.name,
            uncompressed_size: f.uncompressed_size,
        })
        .collect();

    Ok(Book {
        id: BookId(book.id),
        // Legacy or externally-edited Calibre libraries can contain NULL here.
        // Keep the book readable; identity consumers provide deterministic
        // fallbacks when the UUID is absent or malformed.
        uuid: book.uuid,
        title: book.title,
        sortable_title: book.sort,
        authors: book_authors,
        tags: tags.into_iter().map(|tag| tag.name).collect(),
        series_index: series_name.as_ref().map(|_| book.series_index),
        series: series_name,
        identifiers,
        description: book_desc,
        language_codes,
        has_cover: book.has_cover.unwrap_or(false),
        is_read: false, // Populated by Library via read state queries
        files,
        created_at: book
            .timestamp
            .unwrap_or(chrono::DateTime::UNIX_EPOCH.naive_utc()),
        updated_at: book.last_modified,
        book_dir_path: book.path,
    })
}

pub fn all(conn: &mut SqliteConnection) -> Result<Vec<Book>, CalibreError> {
    let book_rows = books::all(conn)?;
    hydrate(conn, book_rows)
}

pub fn get_many(
    conn: &mut SqliteConnection,
    book_ids: Vec<BookId>,
) -> Result<Vec<Book>, CalibreError> {
    let mut book_rows = books::get_by_ids(conn, book_ids.clone())?;

    let positions: HashMap<i32, usize> = book_ids
        .iter()
        .enumerate()
        .map(|(position, id)| (id.as_i32(), position))
        .collect();
    book_rows.sort_by_key(|row| positions.get(&row.id).copied().unwrap_or(usize::MAX));

    hydrate(conn, book_rows)
}

/// `(id, book_dir_path)` for every book with a cover, without hydration.
/// Backs the cover-thumbnail warm path.
pub fn cover_sources(conn: &mut SqliteConnection) -> Result<Vec<(BookId, String)>, CalibreError> {
    books::cover_sources(conn)
}

/// `(id, book_dir_path)` for the given ids that exist and have a cover,
/// without hydration. Backs the cover-thumbnail ensure path.
pub fn cover_sources_for(
    conn: &mut SqliteConnection,
    book_ids: &[BookId],
) -> Result<Vec<(BookId, String)>, CalibreError> {
    books::cover_sources_for(conn, book_ids)
}

fn hydrate(
    conn: &mut SqliteConnection,
    book_rows: Vec<BookRow>,
) -> Result<Vec<Book>, CalibreError> {
    let book_ids: Vec<BookId> = book_rows.iter().map(|b| BookId(b.id)).collect();

    let author_ids_by_book = authors::find_author_ids_by_book_ids(conn, book_ids.clone())?;
    let descriptions_map = book_descriptions::find_many_by_book_ids(conn, book_ids.clone())?;
    let identifiers_map = book_identifiers::find_many_by_book_ids(conn, book_ids.clone())?;
    let tags_map = tags::find_tag_names_by_book_ids(conn, book_ids.clone())?;
    let series_map = series::find_series_names_by_book_ids(conn, book_ids.clone())?;
    let languages_map = languages::find_codes_by_book_ids(conn, book_ids.clone())?;
    let files_map = book_files::find_many_by_book_ids(conn, book_ids)?;

    let unique_author_ids: Vec<AuthorId> = author_ids_by_book
        .values()
        .flatten()
        .cloned()
        .collect::<std::collections::HashSet<AuthorId>>()
        .into_iter()
        .collect();

    let authors_by_id = get_authors_map(conn, unique_author_ids)?;

    let mut book_list = Vec::with_capacity(book_rows.len());

    for book_row in book_rows {
        let book_id = BookId(book_row.id);

        let book_authors = match author_ids_by_book.get(&book_id) {
            Some(ids) => ids
                .iter()
                .filter_map(|author_id| authors_by_id.get(author_id).cloned())
                .collect(),
            None => Vec::new(),
        };

        let book_description = descriptions_map.get(&book_id).cloned();
        let book_tags = tags_map.get(&book_id).cloned().unwrap_or_default();
        let book_series = series_map.get(&book_id).cloned();
        let book_languages = languages_map.get(&book_id).cloned().unwrap_or_default();
        let raw_files = files_map.get(&book_id).cloned().unwrap_or_default();

        let book_identifiers = identifiers_map
            .get(&book_id)
            .map(|ids| {
                ids.iter()
                    .map(|id| BookIdentifier {
                        id: id.id,
                        label: id.type_.clone(),
                        value: id.val.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let files: Vec<BookFileInfo> = raw_files
            .into_iter()
            .map(|f| BookFileInfo {
                id: f.id,
                format: f.format,
                name: f.name,
                uncompressed_size: f.uncompressed_size,
            })
            .collect();

        let book_model = Book {
            id: book_id,
            uuid: book_row.uuid,
            title: book_row.title,
            sortable_title: book_row.sort,
            authors: book_authors,
            tags: book_tags,
            series_index: book_series.as_ref().map(|_| book_row.series_index),
            series: book_series,
            identifiers: book_identifiers,
            description: book_description,
            language_codes: book_languages,
            has_cover: book_row.has_cover.unwrap_or(false),
            is_read: false, // Populated by Library via read state queries
            files,
            created_at: book_row
                .timestamp
                .unwrap_or(chrono::DateTime::UNIX_EPOCH.naive_utc()),
            updated_at: book_row.last_modified,
            book_dir_path: book_row.path,
        };

        book_list.push(book_model);
    }

    Ok(book_list)
}

fn to_library_authors(author_models: Vec<crate::Author>) -> Vec<crate::library::Author> {
    author_models
        .into_iter()
        .map(|a| crate::library::Author {
            id: AuthorId(a.id),
            name: a.name,
            sort: a.sort.unwrap_or_default(),
            link: if a.link.is_empty() {
                None
            } else {
                Some(a.link)
            },
        })
        .collect()
}

fn get_authors_map(
    conn: &mut SqliteConnection,
    author_ids: Vec<AuthorId>,
) -> Result<HashMap<AuthorId, crate::library::Author>, CalibreError> {
    let authors = authors::get_many(conn, author_ids)?;

    Ok(authors
        .into_iter()
        .map(|a| {
            (
                AuthorId(a.id),
                crate::library::Author {
                    id: AuthorId(a.id),
                    name: a.name,
                    sort: a.sort.unwrap_or_default(),
                    link: if a.link.is_empty() {
                        None
                    } else {
                        Some(a.link)
                    },
                },
            )
        })
        .collect())
}
