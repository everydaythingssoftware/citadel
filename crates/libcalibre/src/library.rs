use std::{collections::HashMap, path::Path, path::PathBuf};

use chrono::{NaiveDate, NaiveDateTime};
use diesel::{prelude::*, sql_query, OptionalExtension, RunQueryDsl, SqliteConnection};
use sanitise_file_name::sanitise;

use crate::{
    cover_image::cover_image_data_from_path,
    custom_columns::{self, CustomColumn, CustomColumnKind, CustomColumnSpec, CustomValue},
    entities::book_file::NewBookFile,
    operations,
    persistence::establish_connection,
    queries::{authors as author_queries, book_files, books as book_queries},
    sorting,
    types::{AuthorId, BookId},
    util::ValidDbPath,
    CalibreError, NewBook, UpdateBookData,
};

pub struct Library {
    db_path: ValidDbPath,
    conn: SqliteConnection,
}

#[derive(Clone, Debug)]
pub struct Book {
    /// Identifier unique only within this library
    pub id: BookId,
    /// Cross-library identifier
    pub uuid: Option<String>,
    pub title: String,
    pub sortable_title: Option<String>,
    pub authors: Vec<Author>,
    pub tags: Vec<String>,
    /// Series name; `Some` iff the book is linked to a series.
    pub series: Option<String>,
    /// Position within the series; `Some` iff the book is linked to a series.
    pub series_index: Option<f32>,
    pub description: Option<String>,
    /// Canonical Calibre language codes (ISO 639-2/3, e.g. `eng`, `fra`),
    /// ordered by `books_languages_link.item_order`. Empty when the book has
    /// no language metadata.
    pub language_codes: Vec<String>,
    pub identifiers: Vec<BookIdentifier>,
    pub has_cover: bool,
    pub is_read: bool,
    pub files: Vec<BookFileInfo>,
    /// Calibre calls this `timestamp`. Set when book is first added.
    pub created_at: NaiveDateTime,
    /// Calibre calls this `last_modified`. Updated when book metadata changes.
    pub updated_at: NaiveDateTime,
    /// Relative to library root, what folder contains this book's files & cover
    pub book_dir_path: String,
}

#[derive(Clone, Debug)]
pub struct BookFileInfo {
    pub id: i32,
    pub format: String,
    pub name: String,
    pub uncompressed_size: i32,
}

pub use crate::operations::assets::ResolvedBookAsset;

#[derive(Clone, Debug)]
pub struct BookIdentifier {
    pub id: i32,
    pub label: String,
    pub value: String,
}

pub struct BookAdd {
    pub title: String,
    pub author_names: Vec<String>,
    pub tags: Option<Vec<String>>,
    pub series: Option<String>,
    pub series_index: Option<f32>,
    pub publisher: Option<String>,
    pub publication_date: Option<NaiveDate>,
    pub rating: Option<i32>,
    pub comments: Option<String>,
    pub identifiers: HashMap<String, String>,
    /// Language code for the book (any ISO 639-1/2/3 form; canonicalized on
    /// write). `None` adds the book with no language metadata.
    pub language: Option<String>,
    pub file_paths: Vec<PathBuf>,
}

pub struct BookUpdate {
    pub title: Option<String>,

    /// If provided, replaces all authors with the provided list. Authors
    /// not already in the database will be created. Removes any author not
    /// included in the list.
    /// **Do not use both `author_names` and `author_ids` at the same time.**
    pub author_names: Option<Vec<String>>,
    /// If provided, replaces all authors with the provided list of IDs. Authors
    /// not already in the database will cause an error. Removes any author not
    /// included in the list.
    /// **Do not use both `author_names` and `author_ids` at the same time.**
    pub author_ids: Option<Vec<AuthorId>>,

    pub description: Option<String>,
    pub is_read: Option<bool>,

    pub tags: Option<Vec<String>>,
    /// If provided, links the book to the named series (created if it does
    /// not exist), replacing any existing series. An empty (or whitespace)
    /// name unlinks the book from its series. `None` leaves it unchanged.
    pub series: Option<String>,
    pub series_index: Option<f32>,
    /// If provided, replaces the book's language links with the given codes
    /// (canonicalized to Calibre's ISO 639-2/3 form, deduped, order preserved).
    /// An empty list clears all language links; `None` leaves them unchanged.
    pub language_codes: Option<Vec<String>>,
    pub publisher: Option<String>,
    pub publication_date: Option<NaiveDate>,
    pub rating: Option<i32>,
    pub comments: Option<String>,
    pub identifiers: Option<HashMap<String, String>>,
}

#[derive(Clone, Debug)]
pub struct Author {
    pub id: AuthorId,
    pub name: String,
    pub sort: String,
    pub link: Option<String>,
}

pub struct AuthorAdd {
    pub name: String,
    pub sort: Option<String>,
    pub link: Option<String>,
}

pub struct AuthorUpdate {
    pub name: Option<String>,
    pub sort: Option<String>,
    pub link: Option<String>,
}

/// Sort order for [`Library::query_books`]. Orders by Calibre's precomputed
/// sort columns (`books.sort` for titles, the primary linked author's
/// `authors.sort` for authors), with `books.id` as a stable tiebreak.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BookSortOrder {
    #[default]
    TitleAsc,
    TitleDesc,
    AuthorAsc,
    AuthorDesc,
    /// Most recently modified first, with book id as a stable tiebreaker.
    UpdatedDesc,
    /// Calibre series position first, then title and id for deterministic ties.
    SeriesIndexAsc,
}

/// A paged, sorted, filtered book query. All filters compose (AND).
#[derive(Clone, Debug, Default)]
pub struct BookQuery {
    /// Case-insensitive substring match across the book title, linked author
    /// names, and linked series names, with LIKE wildcards escaped — the
    /// same semantics as [`Library::search_books`], EXCEPT that `None` or
    /// empty/whitespace text matches ALL books (where `search_books` returns
    /// no books).
    pub text: Option<String>,
    /// Only books linked to this author.
    pub author_id: Option<AuthorId>,
    /// Only books linked to this series.
    pub series_id: Option<i32>,
    /// Only books linked to this tag.
    pub tag_id: Option<i32>,
    /// Only books linked to this resolved Citadel genre value.
    pub genre_id: Option<i32>,
    /// Exclude books marked read (filtered in SQL, so paging and totals stay
    /// correct).
    pub hide_read: bool,
    /// Only books with at least one Calibre `data` row.
    pub require_file: bool,
    pub sort: BookSortOrder,
    /// Maximum number of books to return. `None` returns all matches.
    pub limit: Option<i64>,
    /// Number of matching books to skip before the page starts.
    pub offset: i64,
}

/// One page of results from [`Library::query_books`].
#[derive(Clone, Debug)]
pub struct BookPage {
    /// The fully hydrated books in this page, in sorted order.
    pub items: Vec<Book>,
    /// Total number of books matching the query's filters, ignoring
    /// limit/offset.
    pub total: i64,
}

/// One series in the library, with its linked-book count. Returned by
/// [`Library::list_series`]; series ids are what [`BookQuery::series_id`]
/// filters on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeriesSummary {
    pub id: i32,
    pub name: String,
    pub book_count: i64,
}

/// One author in the library with its linked-book count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorSummary {
    pub id: AuthorId,
    pub name: String,
    pub book_count: i64,
}

/// One tag in the library. Returned by [`Library::list_tags`]; the full
/// vocabulary feeds tag autocomplete in clients.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagSummary {
    pub id: i32,
    pub name: String,
    pub book_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenreSummary {
    pub id: i32,
    pub name: String,
    pub book_count: i64,
}

impl Library {
    pub fn new(db_path: ValidDbPath) -> Result<Self, CalibreError> {
        let conn = establish_connection(&db_path.database_path)?;

        Ok(Self { db_path, conn })
    }

    /// Create a new Calibre library in the provided folder.
    pub fn create_library_at(_path: &str) -> Result<Library, CalibreError> {
        todo!()
    }

    pub fn library_path(&self) -> &str {
        &self.db_path.library_path
    }

    pub fn database_path(&self) -> &str {
        &self.db_path.database_path
    }

    pub fn library_uuid(&mut self) -> Result<String, CalibreError> {
        use crate::schema::library_id::dsl::{library_id, uuid};

        library_id
            .select(uuid)
            .first::<String>(&mut self.conn)
            .optional()?
            .ok_or_else(|| {
                CalibreError::DatabaseIntegrity("library_id has no identity row".to_string())
            })
    }

    pub fn catalog_updated_at(&mut self) -> Result<Option<NaiveDateTime>, CalibreError> {
        use crate::schema::books::dsl::{books, last_modified};
        use diesel::dsl::max;

        let books_updated_at = books
            .select(max(last_modified))
            .first::<Option<NaiveDateTime>>(&mut self.conn)
            .map_err(CalibreError::from)?;
        let database_updated_at = [
            PathBuf::from(&self.db_path.database_path),
            PathBuf::from(format!("{}-wal", self.db_path.database_path)),
        ]
        .into_iter()
        .filter_map(|path| std::fs::metadata(path).ok()?.modified().ok())
        .map(|modified| chrono::DateTime::<chrono::Utc>::from(modified).naive_utc())
        .max();

        Ok(books_updated_at
            .into_iter()
            .chain(database_updated_at)
            .max())
    }

    // =========================================================================
    // Books
    // =========================================================================

    pub fn add_book(&mut self, book: BookAdd) -> Result<Book, CalibreError> {
        // 1. Create/find authors
        let created_authors: Vec<crate::entities::author::Author> = book
            .author_names
            .iter()
            .map(|name| author_queries::create_if_not_exists(&mut self.conn, name))
            .collect::<Result<Vec<_>, _>>()?;

        // 2. Create book record
        let new_book = NewBook {
            title: book.title.clone(),
            timestamp: None,
            pubdate: book
                .publication_date
                .map(|d| NaiveDateTime::new(d, chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap())),
            series_index: book.series_index.unwrap_or(1.0),
            has_cover: None,
        };
        let book_row = book_queries::create(&mut self.conn, new_book)?;

        // Re-fetch to get trigger-generated uuid and sort
        let book_row = book_queries::get(&mut self.conn, BookId(book_row.id))?
            .ok_or(CalibreError::BookNotFound(BookId(book_row.id)))?;

        // 3. Set author_sort and link authors
        let combined_sort = created_authors
            .iter()
            .map(|a| sorting::sort_author_name_apa(&a.name))
            .collect::<Vec<String>>()
            .join(" & ");
        let _ = book_queries::update(
            &mut self.conn,
            BookId(book_row.id),
            UpdateBookData {
                author_sort: Some(combined_sort),
                ..Default::default()
            },
        );

        for author in &created_authors {
            author_queries::link_book(&mut self.conn, AuthorId(author.id), BookId(book_row.id))?;
        }

        if let Some(tags) = &book.tags {
            for tag_name in unique_tag_names(tags) {
                let tag = crate::queries::tags::create_if_not_exists(&mut self.conn, tag_name)?;
                crate::queries::tags::link_book(&mut self.conn, tag.id, BookId(book_row.id))?;
            }
        }

        if let Some(series_name) = &book.series {
            let series = crate::queries::series::create_if_not_exists(&mut self.conn, series_name)?;
            crate::queries::series::link_book(&mut self.conn, series.id, BookId(book_row.id))?;
        }

        if let Some(language) = &book.language {
            crate::queries::languages::set_for_book(
                &mut self.conn,
                BookId(book_row.id),
                std::slice::from_ref(language),
            )?;
        }

        // 4. Create directories
        let primary_author = created_authors
            .first()
            .map(|a| a.name.clone())
            .unwrap_or_default();
        let author_dir_name = primary_author.clone();
        let book_dir_name = sanitise(&format!("{} ({})", &book.title, book_row.id));
        let book_dir_relative = Path::new(&author_dir_name).join(&book_dir_name);
        let library_root = Path::new(&self.db_path.library_path);

        std::fs::create_dir_all(library_root.join(&book_dir_relative))
            .map_err(|e| CalibreError::FileSystem(e.to_string()))?;

        // Update book with relative path
        let _ = book_queries::update(
            &mut self.conn,
            BookId(book_row.id),
            UpdateBookData {
                path: Some(book_dir_relative.to_str().unwrap().to_string()),
                ..Default::default()
            },
        );

        // 5. Copy book files
        let mut created_files = Vec::new();
        for file_path in &book.file_paths {
            let extension = file_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_uppercase();
            let file_stem = sanitise(&format!("{} - {}", &book.title, &primary_author));
            let file_size = std::fs::metadata(file_path)
                .map(|m| m.len() as i32)
                .unwrap_or(0);

            let new_file = NewBookFile {
                book: book_row.id,
                format: extension.clone(),
                uncompressed_size: file_size,
                name: file_stem.clone(),
            };
            book_files::create(&mut self.conn, new_file)?;

            // Copy file to library
            let dest_filename = if extension.is_empty() {
                file_stem.clone()
            } else {
                format!("{}.{}", file_stem, extension.to_lowercase())
            };
            let dest_path = library_root.join(&book_dir_relative).join(&dest_filename);
            if file_path.exists() {
                std::fs::copy(file_path, &dest_path)
                    .map_err(|e| CalibreError::FileSystem(e.to_string()))?;
            }

            created_files.push(crate::entities::book_file::BookFile {
                id: 0, // We don't have the ID from create, but it's fine for now
                book: book_row.id,
                format: extension,
                uncompressed_size: file_size,
                name: file_stem,
            });
        }

        // 6. Extract cover image
        if let Some(primary_file) = book.file_paths.first() {
            if let Ok(Some(cover_data)) = cover_image_data_from_path(primary_file) {
                let cover_path = library_root.join(&book_dir_relative).join("cover.jpg");
                let _ = std::fs::write(&cover_path, &cover_data);
                let _ = book_queries::update(
                    &mut self.conn,
                    BookId(book_row.id),
                    UpdateBookData {
                        has_cover: Some(true),
                        ..Default::default()
                    },
                );
            }
        }

        // 7. Generate metadata.opf from the freshly written DB state.
        book_queries::touch(&mut self.conn, BookId(book_row.id))?;
        let _ = self.regenerate_metadata_opf(BookId(book_row.id));

        self.get_book(BookId(book_row.id))
    }

    pub fn books(&mut self) -> Result<Vec<Book>, CalibreError> {
        let mut books = operations::books::all(&mut self.conn)?;

        // Fill in read states
        let book_ids: Vec<BookId> = books.iter().map(|b| b.id).collect();
        let read_states = self.batch_get_read_states(&book_ids)?;
        for book in &mut books {
            book.is_read = read_states.get(&book.id).copied().unwrap_or(false);
        }

        Ok(books)
    }

    pub fn get_book(&mut self, book_id: BookId) -> Result<Book, CalibreError> {
        let mut book = operations::books::get_book(&mut self.conn, book_id)?;
        book.is_read = self.get_book_read_state(book_id)?;
        Ok(book)
    }

    pub fn update_book(
        &mut self,
        book_id: BookId,
        update: BookUpdate,
    ) -> Result<Book, CalibreError> {
        // Handle is_read separately since it uses custom columns
        let is_read_update = update.is_read;

        operations::books::update_book(&mut self.conn, book_id, update)?;

        if let Some(is_read) = is_read_update {
            self.set_book_read_state(book_id, is_read)?;
        }

        // Keep the on-disk metadata.opf faithful to the DB. Best-effort: a
        // metadata write failure must not fail the (already committed) update.
        let _ = self.regenerate_metadata_opf(book_id);

        self.get_book(book_id)
    }

    /// Rewrite a book's `metadata.opf` from current DB state (title, authors,
    /// language codes, …). Called after both add and update so the derived
    /// file never drifts from the database. Missing files/dirs are surfaced as
    /// `Err`, but callers treat OPF writes as best-effort.
    fn regenerate_metadata_opf(&mut self, book_id: BookId) -> Result<(), CalibreError> {
        let book_row = book_queries::get(&mut self.conn, book_id)?
            .ok_or(CalibreError::BookNotFound(book_id))?;
        let author_ids = book_queries::find_authors(&mut self.conn, book_id)?;
        let authors = author_queries::get_many(&mut self.conn, author_ids)?;
        let language_codes =
            crate::queries::languages::find_codes_for_book(&mut self.conn, book_id)?;

        let contents = format_metadata_opf(&book_row, &authors, &language_codes)
            .map_err(|_| CalibreError::DatabaseIntegrity("Failed to render metadata.opf".into()))?;

        let opf_path = Path::new(&self.db_path.library_path)
            .join(&book_row.path)
            .join("metadata.opf");
        std::fs::write(&opf_path, contents.as_bytes())
            .map_err(|e| CalibreError::FileSystem(e.to_string()))
    }

    pub fn remove_books(&mut self, book_ids: Vec<BookId>) -> Result<Vec<BookId>, CalibreError> {
        let mut removed = Vec::new();
        for book_id in book_ids {
            let book = book_queries::get(&mut self.conn, book_id)?
                .ok_or(CalibreError::BookNotFound(book_id))?;
            operations::assets::delete_entire_book(
                &self.db_path.library_path,
                &mut self.conn,
                book_id,
                &book.path,
            )?;
            removed.push(book_id);
        }
        Ok(removed)
    }

    /// `(id, book_dir_path)` for every book with a cover, read straight from
    /// the `books` table with no hydration of authors/tags/series/files/
    /// read-state. Feeds the cover-thumbnail warm path, where only the cover's
    /// folder is needed. A NULL `has_cover` is treated as false.
    pub fn cover_sources(&mut self) -> Result<Vec<(BookId, String)>, CalibreError> {
        operations::books::cover_sources(&mut self.conn)
    }

    /// Like [`Library::cover_sources`], but restricted to `ids`. Returns only
    /// the ids that exist AND have a cover, so callers keep the same
    /// has-cover filtering they would get from per-book hydration.
    pub fn cover_sources_for(
        &mut self,
        ids: &[BookId],
    ) -> Result<Vec<(BookId, String)>, CalibreError> {
        operations::books::cover_sources_for(&mut self.conn, ids)
    }

    // =========================================================================
    // Assets (covers, book files)
    // =========================================================================

    pub fn get_book_cover(&mut self, book_id: BookId) -> Result<Vec<u8>, CalibreError> {
        operations::assets::get_book_cover(&self.db_path.library_path, &mut self.conn, book_id)
    }

    pub fn set_book_cover(
        &mut self,
        book_id: BookId,
        cover_data: Vec<u8>,
    ) -> Result<(), CalibreError> {
        operations::assets::set_book_cover(
            &self.db_path.library_path,
            &mut self.conn,
            book_id,
            cover_data,
        )
    }

    pub fn remove_book_cover(&mut self, _book_id: BookId) -> Result<(), CalibreError> {
        todo!()
    }

    pub fn get_book_file(
        &mut self,
        book_id: BookId,
        file_format: &str,
    ) -> Result<Vec<u8>, CalibreError> {
        operations::assets::get_book_file(
            &self.db_path.library_path,
            &mut self.conn,
            book_id,
            file_format,
        )
    }

    pub fn get_book_file_path(
        &mut self,
        id: BookId,
        format: &str,
    ) -> Result<PathBuf, CalibreError> {
        operations::assets::get_book_file_path(
            &self.db_path.library_path,
            &mut self.conn,
            id,
            format,
        )
    }

    pub fn resolve_book_file(
        &mut self,
        id: BookId,
        format: &str,
    ) -> Result<ResolvedBookAsset, CalibreError> {
        operations::assets::resolve_book_file(
            &self.db_path.library_path,
            &mut self.conn,
            id,
            format,
        )
    }

    pub fn resolve_book_cover(&mut self, id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
        operations::assets::resolve_book_cover(&self.db_path.library_path, &mut self.conn, id)
    }

    pub fn remove_book_file(&mut self, book_id: BookId, format: &str) -> Result<(), CalibreError> {
        operations::assets::remove_book_file(
            &self.db_path.library_path,
            &mut self.conn,
            book_id,
            format,
        )
    }

    pub fn add_book_file_from_bytes(
        &mut self,
        book_id: BookId,
        file_format: String,
        file_data: Vec<u8>,
    ) -> Result<(), CalibreError> {
        operations::assets::add_book_file_from_bytes(
            &self.db_path.library_path,
            &mut self.conn,
            book_id,
            file_format,
            file_data,
        )
    }

    pub fn add_book_file_from_path(
        &mut self,
        book_id: BookId,
        file_format: String,
        file_path: String,
    ) -> Result<(), CalibreError> {
        operations::assets::add_book_file_from_path(
            &self.db_path.library_path,
            &mut self.conn,
            book_id,
            file_format,
            file_path,
        )
    }

    // =========================================================================
    // Authors
    // =========================================================================

    pub fn add_author(&mut self, author: AuthorAdd) -> Result<AuthorId, CalibreError> {
        let new_author = operations::authors::add(&mut self.conn, author)?;
        Ok(new_author.id)
    }

    pub fn authors(&mut self) -> Result<Vec<Author>, CalibreError> {
        operations::authors::all(&mut self.conn)
    }

    /// Linked-book count per author, computed in one GROUP BY pass over
    /// `books_authors_link` (no per-author scans). Authors with no linked
    /// books are absent from the map — treat a missing entry as 0.
    pub fn author_book_counts(&mut self) -> Result<HashMap<AuthorId, i64>, CalibreError> {
        author_queries::book_counts(&mut self.conn)
    }

    pub fn get_author(&mut self, author_id: AuthorId) -> Result<Author, CalibreError> {
        operations::authors::get(&mut self.conn, author_id)
    }

    pub fn update_author(
        &mut self,
        author_id: AuthorId,
        update: AuthorUpdate,
    ) -> Result<Author, CalibreError> {
        let book_ids = author_queries::find_books(&mut self.conn, author_id)?;
        let author = operations::authors::update(&mut self.conn, author_id, update)?;
        book_queries::touch_many(&mut self.conn, &book_ids)?;
        Ok(author)
    }

    pub fn remove_author(&mut self, author_id: AuthorId) -> Result<AuthorId, CalibreError> {
        operations::authors::remove(&mut self.conn, author_id)?;
        Ok(author_id)
    }

    // =========================================================================
    // Identifiers
    // =========================================================================

    pub fn upsert_book_identifier(
        &mut self,
        book_id: BookId,
        label: String,
        value: String,
        existing_id: Option<i32>,
    ) -> Result<i32, CalibreError> {
        use crate::schema::identifiers::dsl;

        self.conn.transaction(|conn| {
            let identifier_id = match existing_id {
                Some(identifier_id) => diesel::update(
                    dsl::identifiers
                        .filter(dsl::id.eq(identifier_id))
                        .filter(dsl::book.eq(book_id.as_i32())),
                )
                .set((dsl::type_.eq(&label), dsl::val.eq(&value)))
                .returning(dsl::id)
                .get_result::<i32>(conn)
                .map_err(CalibreError::from),
                None => {
                    let lowercased_label = label.to_lowercase();
                    diesel::insert_into(dsl::identifiers)
                        .values((
                            dsl::book.eq(book_id.as_i32()),
                            dsl::type_.eq(lowercased_label),
                            dsl::val.eq(&value),
                        ))
                        .returning(dsl::id)
                        .get_result::<i32>(conn)
                        .map_err(CalibreError::from)
                }
            }?;
            book_queries::touch(conn, book_id)?;
            Ok(identifier_id)
        })
    }

    pub fn delete_book_identifier(
        &mut self,
        book_id: BookId,
        identifier_id: i32,
    ) -> Result<(), CalibreError> {
        use crate::schema::identifiers::dsl;

        diesel::delete(
            dsl::identifiers
                .filter(dsl::book.eq(book_id.as_i32()))
                .filter(dsl::id.eq(identifier_id)),
        )
        .execute(&mut self.conn)
        .map_err(CalibreError::from)?;
        book_queries::touch(&mut self.conn, book_id)?;
        Ok(())
    }

    // =========================================================================
    // Custom columns
    // =========================================================================

    /// All custom columns in the library, excluding columns marked for
    /// deletion.
    pub fn custom_columns(&mut self) -> Result<Vec<CustomColumn>, CalibreError> {
        custom_columns::list(&mut self.conn)
    }

    /// Create a custom column, including its value tables, indexes, triggers,
    /// and views, exactly as Calibre would.
    pub fn create_custom_column(
        &mut self,
        spec: CustomColumnSpec,
    ) -> Result<CustomColumn, CalibreError> {
        custom_columns::create(&mut self.conn, &spec)
    }

    /// One book's value for a custom column. `None` when no value is stored
    /// (for bool columns this is Calibre's tri-state "unknown").
    pub fn get_custom_value(
        &mut self,
        book_id: BookId,
        column_id: i32,
    ) -> Result<Option<CustomValue>, CalibreError> {
        let column = custom_columns::get_column(&mut self.conn, column_id)?;
        custom_columns::get_value(&mut self.conn, &column, book_id)
    }

    /// All stored custom-column values for a book, keyed by column id.
    /// Columns with unsupported datatypes (series, rating, composite, ...)
    /// are skipped.
    pub fn get_custom_values_for_book(
        &mut self,
        book_id: BookId,
    ) -> Result<HashMap<i32, CustomValue>, CalibreError> {
        let columns = custom_columns::list(&mut self.conn)?;
        let mut values = HashMap::new();
        for column in columns {
            if !column.kind.supports_value_io() {
                continue;
            }
            if let Some(value) = custom_columns::get_value(&mut self.conn, &column, book_id)? {
                values.insert(column.id, value);
            }
        }
        Ok(values)
    }

    /// Set (or clear, with `None`) one book's value for a custom column.
    /// The value must match the column's datatype.
    pub fn set_custom_value(
        &mut self,
        book_id: BookId,
        column_id: i32,
        value: Option<CustomValue>,
    ) -> Result<(), CalibreError> {
        let column = custom_columns::get_column(&mut self.conn, column_id)?;
        custom_columns::set_value(&mut self.conn, &column, book_id, value)
    }

    /// One column's values for many books at once. Books with no stored
    /// value are absent from the result.
    pub fn batch_get_custom_values(
        &mut self,
        column_id: i32,
        book_ids: &[BookId],
    ) -> Result<HashMap<BookId, CustomValue>, CalibreError> {
        let column = custom_columns::get_column(&mut self.conn, column_id)?;
        custom_columns::batch_get_values(&mut self.conn, &column, book_ids)
    }

    // =========================================================================
    // Read state (the `read` bool custom column)
    // =========================================================================

    pub(crate) fn get_or_create_read_state_column(&mut self) -> Result<CustomColumn, CalibreError> {
        if let Some(column) =
            custom_columns::find_by_label_and_kind(&mut self.conn, "read", &CustomColumnKind::Bool)?
        {
            return Ok(column);
        }

        custom_columns::create(
            &mut self.conn,
            &CustomColumnSpec {
                label: "read".to_string(),
                name: "Read".to_string(),
                kind: CustomColumnKind::Bool,
                is_multiple: false,
                enum_values: vec![],
                display: None,
            },
        )
    }

    pub fn get_book_read_state(&mut self, book_id: BookId) -> Result<bool, CalibreError> {
        let Some(column) = custom_columns::find_by_label_and_kind(
            &mut self.conn,
            "read",
            &CustomColumnKind::Bool,
        )?
        else {
            return Ok(false);
        };
        let value = custom_columns::get_value(&mut self.conn, &column, book_id)?;
        Ok(matches!(value, Some(CustomValue::Bool(true))))
    }

    pub fn set_book_read_state(
        &mut self,
        book_id: BookId,
        is_read: bool,
    ) -> Result<(), CalibreError> {
        let column = self.get_or_create_read_state_column()?;
        custom_columns::set_value(
            &mut self.conn,
            &column,
            book_id,
            Some(CustomValue::Bool(is_read)),
        )
    }

    pub fn batch_get_read_states(
        &mut self,
        book_ids: &[BookId],
    ) -> Result<HashMap<BookId, bool>, CalibreError> {
        if book_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let Some(column) = custom_columns::find_by_label_and_kind(
            &mut self.conn,
            "read",
            &CustomColumnKind::Bool,
        )?
        else {
            return Ok(HashMap::new());
        };
        let values = custom_columns::batch_get_values(&mut self.conn, &column, book_ids)?;

        Ok(values
            .into_iter()
            .map(|(book_id, value)| (book_id, matches!(value, CustomValue::Bool(true))))
            .collect())
    }

    // =========================================================================
    // Library management
    // =========================================================================

    pub fn randomize_library_uuid(&mut self) -> Result<(), CalibreError> {
        sql_query("UPDATE library_id SET uuid = uuid4()")
            .execute(&mut self.conn)
            .map_err(CalibreError::from)?;
        book_queries::touch_catalog(&mut self.conn)?;
        Ok(())
    }

    // =========================================================================
    // Search
    // =========================================================================

    /// Run a paged, sorted, filtered book query. Returns one page of
    /// hydrated books plus the total match count (ignoring limit/offset).
    pub fn query_books(&mut self, query: BookQuery) -> Result<BookPage, CalibreError> {
        // The read state lives in the `read` bool custom column. When the
        // column does not exist yet, no book has been marked read, so there
        // is nothing to hide.
        let hide_read_column = if query.hide_read {
            custom_columns::find_by_label_and_kind(&mut self.conn, "read", &CustomColumnKind::Bool)?
                .map(|column| column.id)
        } else {
            None
        };
        let genre_column = match query.genre_id {
            Some(genre_id) => match self.genres_column(false)? {
                Some(column) => Some((column.id, genre_id)),
                None => {
                    return Ok(BookPage {
                        items: Vec::new(),
                        total: 0,
                    })
                }
            },
            None => None,
        };

        let filters = book_queries::BookPageFilters {
            text: query
                .text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty()),
            author_id: query.author_id,
            series_id: query.series_id,
            tag_id: query.tag_id,
            genre_column,
            hide_read_column,
            require_file: query.require_file,
        };

        let total = book_queries::query_count(&mut self.conn, &filters)?;
        let book_ids = book_queries::query_page(
            &mut self.conn,
            &filters,
            query.sort,
            query.limit,
            query.offset,
        )?;
        let items = self.get_books_with_read_states(book_ids)?;

        Ok(BookPage { items, total })
    }

    /// Query books that have at least one safely resolvable acquisition file.
    /// Candidate rows are scanned before paging so missing or escaping backing
    /// files cannot create dead-only entries or pagination holes.
    pub fn query_acquirable_books(
        &mut self,
        limit: i64,
        offset: i64,
    ) -> Result<BookPage, CalibreError> {
        self.query_acquirable_books_with(BookQuery {
            limit: Some(limit),
            offset,
            ..BookQuery::default()
        })
    }

    /// Run a filtered, sorted catalog query while excluding books whose file
    /// records cannot be resolved safely beneath the library root. Candidate
    /// rows are scanned without hydrating books; only the selected page is
    /// hydrated.
    pub fn query_acquirable_books_with(
        &mut self,
        query: BookQuery,
    ) -> Result<BookPage, CalibreError> {
        let hide_read_column = if query.hide_read {
            custom_columns::find_by_label_and_kind(&mut self.conn, "read", &CustomColumnKind::Bool)?
                .map(|column| column.id)
        } else {
            None
        };
        let genre_column = match query.genre_id {
            Some(genre_id) => match self.genres_column(false)? {
                Some(column) => Some((column.id, genre_id)),
                None => {
                    return Ok(BookPage {
                        items: Vec::new(),
                        total: 0,
                    })
                }
            },
            None => None,
        };
        let filters = book_queries::BookPageFilters {
            text: query
                .text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty()),
            author_id: query.author_id,
            series_id: query.series_id,
            tag_id: query.tag_id,
            genre_column,
            hide_read_column,
            require_file: true,
        };
        let mut resolvable_ids = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for candidate in book_queries::acquisition_candidates(&mut self.conn, &filters, query.sort)?
        {
            let book_id = BookId(candidate.book_id);
            if seen.contains(&book_id) {
                continue;
            }
            if operations::assets::is_resolvable_book_file(
                &self.db_path.library_path,
                &candidate.book_path,
                &candidate.name,
                &candidate.format,
            ) {
                seen.insert(book_id);
                resolvable_ids.push(book_id);
            }
        }
        let total = i64::try_from(resolvable_ids.len()).unwrap_or(i64::MAX);
        let start = usize::try_from(query.offset.max(0)).unwrap_or(usize::MAX);
        let page_len = query
            .limit
            .map(|limit| usize::try_from(limit.max(0)).unwrap_or(usize::MAX))
            .unwrap_or(usize::MAX);
        let book_ids = resolvable_ids
            .into_iter()
            .skip(start)
            .take(page_len)
            .collect();
        let mut items = self.get_books_with_read_states(book_ids)?;
        for book in &mut items {
            book.files.retain(|file| {
                operations::assets::is_resolvable_book_file(
                    &self.db_path.library_path,
                    &book.book_dir_path,
                    &file.name,
                    &file.format,
                )
            });
            book.has_cover = book.has_cover
                && operations::assets::is_resolvable_book_cover(
                    &self.db_path.library_path,
                    &book.book_dir_path,
                );
        }
        Ok(BookPage { items, total })
    }

    /// List every series in the library with its linked-book count, sorted
    /// by name. The returned ids feed [`BookQuery::series_id`].
    pub fn list_series(&mut self) -> Result<Vec<SeriesSummary>, CalibreError> {
        crate::queries::series::list_with_book_counts(&mut self.conn)
    }

    /// List authors with linked-book counts, sorted case-insensitively.
    pub fn list_authors(&mut self) -> Result<Vec<AuthorSummary>, CalibreError> {
        author_queries::list_with_book_counts(&mut self.conn)
    }

    /// List every tag in the library (the whole vocabulary, including tags
    /// no longer linked to any book), sorted case-insensitively by name.
    pub fn list_tags(&mut self) -> Result<Vec<TagSummary>, CalibreError> {
        crate::queries::tags::list_all(&mut self.conn)
    }

    pub fn list_genres(&mut self) -> Result<Vec<GenreSummary>, CalibreError> {
        let Some(column) = self.genres_column(false)? else {
            return Ok(Vec::new());
        };
        crate::queries::genres::list_with_book_counts(&mut self.conn, column.id)
    }

    pub fn set_book_genres(
        &mut self,
        book_id: BookId,
        genres: Vec<String>,
    ) -> Result<(), CalibreError> {
        let genres = normalize_genre_names(genres);
        if genres.is_empty() && self.genres_column(false)?.is_none() {
            return Ok(());
        }
        let column = self
            .genres_column(true)?
            .expect("genre column is created when requested");
        custom_columns::set_value(
            &mut self.conn,
            &column,
            book_id,
            Some(CustomValue::TextMultiple(genres)),
        )?;
        book_queries::touch(&mut self.conn, book_id).map(|_| ())
    }

    pub fn add_book_genres(
        &mut self,
        book_id: BookId,
        genres: Vec<String>,
    ) -> Result<(), CalibreError> {
        let additions = normalize_genre_names(genres);
        if additions.is_empty() {
            return Ok(());
        }
        let mut merged = match self.genres_column(false)? {
            Some(column) => match custom_columns::get_value(&mut self.conn, &column, book_id)? {
                Some(CustomValue::TextMultiple(values)) => values,
                None => Vec::new(),
                Some(_) => unreachable!("genre column compatibility is checked"),
            },
            None => Vec::new(),
        };
        for addition in additions {
            if !merged
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&addition))
            {
                merged.push(addition);
            }
        }
        self.set_book_genres(book_id, merged)
    }

    fn genres_column(&mut self, create: bool) -> Result<Option<CustomColumn>, CalibreError> {
        const LABEL: &str = "citadel_genres";
        if let Some(column) = custom_columns::find_by_label(&mut self.conn, LABEL)? {
            if column.kind != CustomColumnKind::Text || !column.is_multiple {
                return Err(CalibreError::InvalidCustomColumn(format!(
                    "#{LABEL} must be a multiple-value text column"
                )));
            }
            return Ok(Some(column));
        }
        if !create {
            return Ok(None);
        }
        custom_columns::create(
            &mut self.conn,
            &CustomColumnSpec {
                label: LABEL.to_string(),
                name: "Genres".to_string(),
                kind: CustomColumnKind::Text,
                is_multiple: true,
                enum_values: Vec::new(),
                display: None,
            },
        )
        .map(Some)
    }

    pub fn search_books(&mut self, query: &str) -> Result<Vec<Book>, CalibreError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(vec![]);
        }

        self.query_books(BookQuery {
            text: Some(query.to_string()),
            ..BookQuery::default()
        })
        .map(|page| page.items)
    }

    pub fn find_by_author(&mut self, author_id: AuthorId) -> Result<Vec<Book>, CalibreError> {
        self.query_books(BookQuery {
            author_id: Some(author_id),
            ..BookQuery::default()
        })
        .map(|page| page.items)
    }

    fn get_books_with_read_states(
        &mut self,
        book_ids: Vec<BookId>,
    ) -> Result<Vec<Book>, CalibreError> {
        let mut books = operations::books::get_many(&mut self.conn, book_ids)?;

        let book_ids: Vec<BookId> = books.iter().map(|b| b.id).collect();
        let read_states = self.batch_get_read_states(&book_ids)?;
        for book in &mut books {
            book.is_read = read_states.get(&book.id).copied().unwrap_or(false);
        }

        Ok(books)
    }
}

fn normalize_genre_names(genres: Vec<String>) -> Vec<String> {
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

// =============================================================================
// Metadata OPF generation (ported from calibre_client.rs)
// =============================================================================

fn format_metadata_opf(
    book: &crate::entities::book_row::BookRow,
    authors: &[crate::entities::author::Author],
    language_codes: &[String],
) -> Result<String, ()> {
    let author_sort = book.author_sort.clone().unwrap_or_else(|| {
        authors
            .iter()
            .map(|a| a.name.clone())
            .collect::<Vec<String>>()
            .join(", ")
    });

    let authors_string: String = authors
        .iter()
        .map(|author| {
            format!(
                "<dc:creator opf:file-as=\"{sortable}\" opf:role=\"aut\">{author}</dc:creator>",
                sortable = author_sort,
                author = author.name
            )
        })
        .collect();

    // Calibre emits one <dc:language> per linked language code, falling back to
    // "und" (undetermined) when the book has none.
    let languages_string: String = if language_codes.is_empty() {
        "<dc:language>und</dc:language>".to_string()
    } else {
        language_codes
            .iter()
            .map(|code| format!("<dc:language>{code}</dc:language>"))
            .collect()
    };

    Ok(format!(
        r#"<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier opf:scheme="calibre" id="calibre_id">{calibre_id}</dc:identifier>
    <dc:identifier opf:scheme="uuid" id="uuid_id">{calibre_uuid}</dc:identifier>
    <dc:title>{book_title}</dc:title>
    {authors}
    <dc:contributor opf:file-as="calibre" opf:role="bkp">citadel (1.0.0) [https://github.com/every-day-things/citadel]</dc:contributor>
    <dc:date>{pub_date}</dc:date>
    {languages}
    <meta name="calibre:timestamp" content="{now}"/>
    <meta name="calibre:title_sort" content="{book_title_sortable}"/>
  </metadata>
  <guide>
    <reference type="cover" title="Cover" href="cover.jpg"/>
  </guide>
</package>"#,
        calibre_id = book.id,
        calibre_uuid = book.uuid.as_deref().unwrap_or(""),
        book_title = book.title,
        authors = authors_string,
        languages = languages_string,
        pub_date = book
            .pubdate
            .unwrap_or(chrono::DateTime::UNIX_EPOCH.naive_utc())
            .to_string(),
        now = chrono::Utc::now().to_string(),
        book_title_sortable = book.sort.as_deref().unwrap_or("")
    ))
}

fn unique_tag_names<'a>(tag_names: &'a [String]) -> Vec<&'a str> {
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
