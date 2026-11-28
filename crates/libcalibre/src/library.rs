use std::{collections::HashMap, path::Path, path::PathBuf};

use chrono::{NaiveDate, NaiveDateTime};
use diesel::{prelude::*, sql_query, OptionalExtension, RunQueryDsl, SqliteConnection};
use sanitise_file_name::sanitise;

const UNKNOWN_AUTHOR: &str = "Unknown";

/// The most possible duplicates [`Library::find_duplicates`] lists for one
/// candidate.
pub const MAX_DUPLICATES: usize = 5;

use crate::{
    book_file::cover_image_data,
    custom_columns::{self, CustomColumn, CustomColumnKind, CustomColumnSpec, CustomValue},
    entities::book_file::NewBookFile,
    matching::{Candidate, DuplicateMatch, MatchProfile},
    operations,
    persistence::{establish_connection, establish_read_only_connection},
    queries::{authors as author_queries, book_files, books as book_queries},
    schema_versions::{self, SchemaUpgrade},
    sorting,
    types::{AuthorId, BookId},
    util::ValidDbPath,
    CalibreError, NewBook, UpdateBookData,
};

/// An open Calibre library: a connection to its `metadata.db` plus the
/// folder holding its books. Get one from [`Library::open`],
/// [`Library::open_read_only`] or [`Library::create_library_at`].
pub struct Library {
    db_path: ValidDbPath,
    conn: SqliteConnection,
    read_only: bool,
    read_column: Option<String>,
}

/// The label of the bool custom column that read state uses unless
/// [`Library::with_read_column`] or [`Library::without_read_column`] says
/// otherwise. `#read` is the common Calibre convention.
pub const DEFAULT_READ_COLUMN: &str = "read";

/// A book with its metadata, authors, files and read state, as returned by
/// [`Library::get_book`], [`Library::query_books`] and the other book reads.
#[derive(Clone, Debug)]
pub struct Book {
    /// Identifier unique only within this library
    pub id: BookId,
    /// Cross-library identifier
    pub uuid: Option<String>,
    /// The book's title.
    pub title: String,
    /// Calibre's title sort (`books.sort`), e.g. `Hobbit, The`.
    pub sortable_title: Option<String>,
    /// The book's authors.
    pub authors: Vec<Author>,
    /// Names of the book's tags.
    pub tags: Vec<String>,
    /// Series name; `Some` iff the book is linked to a series.
    pub series: Option<String>,
    /// Position within the series; `Some` iff the book is linked to a series.
    pub series_index: Option<f32>,
    /// Calibre's "comments": the book's description, usually HTML. `None`
    /// when there is none.
    pub description: Option<String>,
    /// The book's publisher, if any.
    pub publisher: Option<String>,
    /// 1 to 10, in half stars (10 is five stars); `None` when unrated.
    pub rating: Option<i32>,
    /// `None` when the library holds Calibre's "undefined" date.
    pub publication_date: Option<NaiveDate>,
    /// Canonical Calibre language codes (ISO 639-2/3, e.g. `eng`, `fra`),
    /// ordered by `books_languages_link.item_order`. Empty when the book has
    /// no language metadata.
    pub language_codes: Vec<String>,
    /// External identifiers such as ISBNs.
    pub identifiers: Vec<BookIdentifier>,
    /// Whether the library records a `cover.jpg` for the book
    /// (`books.has_cover`).
    pub has_cover: bool,
    /// Whether the read column marks the book read. `false` when unset or
    /// when the library tracks no read state.
    pub is_read: bool,
    /// The book's files, one per format.
    pub files: Vec<BookFileInfo>,
    /// Calibre calls this `timestamp`. Set when book is first added.
    pub created_at: NaiveDateTime,
    /// Calibre calls this `last_modified`. Updated when book metadata changes.
    pub updated_at: NaiveDateTime,
    /// Relative to library root, what folder contains this book's files & cover
    pub book_dir_path: String,
}

/// One of a book's files, as recorded in Calibre's `data` table.
#[derive(Clone, Debug)]
pub struct BookFileInfo {
    /// The `data` row's id.
    pub id: i32,
    /// The format as Calibre stores it, normally the uppercase extension
    /// (`EPUB`).
    pub format: String,
    /// File name without extension, inside [`Book::book_dir_path`]; the file
    /// on disk is `{name}.{format, lowercased}`.
    pub name: String,
    /// Size in bytes, as recorded when the file was added.
    pub uncompressed_size: i32,
}

pub use crate::operations::assets::ResolvedBookAsset;

/// An external identifier of a book, such as an ISBN.
#[derive(Clone, Debug)]
pub struct BookIdentifier {
    /// The `identifiers` row's id, as taken by
    /// [`Library::upsert_book_identifier`] and
    /// [`Library::delete_book_identifier`].
    pub id: i32,
    /// The identifier's type, e.g. `isbn` (Calibre's `identifiers.type`).
    pub label: String,
    /// The identifier itself.
    pub value: String,
}

/// A book to add with [`Library::add_book`].
#[derive(Clone, Debug)]
pub struct BookAdd {
    /// The book's title.
    pub title: String,
    /// Author names, trimmed; blank names are dropped. Authors not yet in the
    /// library are created. With no names left the book is filed under
    /// `Unknown`.
    pub author_names: Vec<String>,
    /// Tag names, deduplicated case-insensitively. Tags not yet in the
    /// library are created.
    pub tags: Option<Vec<String>>,
    /// Series to link the book to, created if it does not exist.
    pub series: Option<String>,
    /// Position within the series; `None` stores 1.
    pub series_index: Option<f32>,
    /// The book's publisher, created if it does not exist. Blank or `None`
    /// adds no publisher.
    pub publisher: Option<String>,
    /// `None` stores Calibre's "undefined" date.
    pub publication_date: Option<NaiveDate>,
    /// 0 to 10, in half stars; 0 or `None` leaves the book unrated.
    pub rating: Option<i32>,
    /// Calibre's "comments": the book's description, usually HTML.
    pub description: Option<String>,
    /// Identifiers keyed by type (`isbn`, ...); types are stored lowercase.
    pub identifiers: HashMap<String, String>,
    /// Language code for the book (any ISO 639-1/2/3 form; canonicalized on
    /// write). `None` adds the book with no language metadata.
    pub language: Option<String>,
    /// Book files to copy into the book's folder, named
    /// `{title} - {first author}.{extension}`. The first file's embedded cover,
    /// if any, becomes `cover.jpg`. A path that does not exist is still
    /// recorded as a format, with size 0, but nothing is copied.
    pub file_paths: Vec<PathBuf>,
}

/// Changes to make with [`Library::update_book`]. Fields left `None` are
/// unchanged.
#[derive(Clone, Debug, Default)]
pub struct BookUpdate {
    /// Replaces the title.
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

    /// Replaces the description (Calibre's "comments"), creating one if the
    /// book has none.
    pub description: Option<String>,
    /// Sets read state in the read column; see
    /// [`Library::set_book_read_state`].
    pub is_read: Option<bool>,

    /// Replaces the book's tags with these names (deduplicated
    /// case-insensitively). An empty list removes all tags, and any
    /// now-unused tags will be deleted. A name that is not yet in the library
    /// becomes a new tag.
    pub tags: Option<Vec<String>>,
    /// If provided, links the book to the named series (created if it does
    /// not exist), replacing any existing series. An empty (or whitespace)
    /// name unlinks the book from its series, and a now-unused series will
    /// be deleted. `None` leaves it unchanged.
    pub series: Option<String>,
    /// Sets the book's position within its series.
    pub series_index: Option<f32>,
    /// If provided, replaces the book's language links with the given codes
    /// (canonicalized to Calibre's ISO 639-2/3 form, deduped, order preserved).
    /// An empty list clears all language links; `None` leaves them unchanged.
    pub language_codes: Option<Vec<String>>,
    /// Links the book to the named publisher, replacing any other. An empty
    /// (or whitespace) name unlinks it, and a now-unused publisher will be
    /// deleted.
    pub publisher: Option<String>,
    /// Replaces the publication date. It cannot be cleared back to
    /// Calibre's "undefined" date.
    pub publication_date: Option<NaiveDate>,
    /// 0 to 10, in half stars; `Some(0)` clears the rating.
    pub rating: Option<i32>,
    /// Replaces all of the book's identifiers (labels are stored
    /// lowercase). An empty map removes them.
    pub identifiers: Option<HashMap<String, String>>,
}

/// An author in the library.
#[derive(Clone, Debug)]
pub struct Author {
    /// The author's id.
    pub id: AuthorId,
    /// The author's name, e.g. `Ursula K. Le Guin`.
    pub name: String,
    /// The name as sorted, e.g. `Le Guin, Ursula K.`; empty when none is
    /// stored.
    pub sort: String,
    /// A URL for the author; `None` when empty.
    pub link: Option<String>,
}

/// An author to add with [`Library::add_author`].
#[derive(Clone, Debug)]
pub struct AuthorAdd {
    /// The author's name. Calibre's schema keeps names unique,
    /// case-insensitively, so an existing name fails.
    pub name: String,
    /// The name as sorted; `None` stores none, and [`Author::sort`] then
    /// reads empty.
    pub sort: Option<String>,
    /// A URL for the author; `None` stores none.
    pub link: Option<String>,
}

/// Changes to make with [`Library::update_author`]. Fields left `None` are
/// unchanged.
#[derive(Clone, Debug, Default)]
pub struct AuthorUpdate {
    /// Replaces the name.
    pub name: Option<String>,
    /// Replaces the sort name.
    pub sort: Option<String>,
    /// Replaces the link.
    pub link: Option<String>,
}

/// Sort order for [`Library::query_books`]. Orders by Calibre's precomputed
/// sort columns (`books.sort` for titles, the primary linked author's
/// `authors.sort` for authors), with `books.id` as a stable tiebreak.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum BookSortOrder {
    /// By title sort, A to Z. The default.
    #[default]
    TitleAsc,
    /// By title sort, Z to A.
    TitleDesc,
    /// By the primary author's sort name, A to Z.
    AuthorAsc,
    /// By the primary author's sort name, Z to A.
    AuthorDesc,
    /// Most recently added (`timestamp`) first.
    AddedDesc,
    /// Oldest added (`timestamp`) first.
    AddedAsc,
    /// Most recently modified (`last_modified`) first.
    UpdatedDesc,
    /// By series index, lowest first, then by title sort.
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
    /// Only books linked to this publisher.
    pub publisher_id: Option<i32>,
    /// Only books linked to one value of a text, series or enumeration
    /// custom column. A column that doesn't exist matches no books.
    pub custom_value: Option<CustomValueFilter>,
    /// Exclude books marked read in the library's read column (filtered in
    /// SQL, so paging and totals stay correct). Ignored when there is no read
    /// column.
    pub hide_read: bool,
    /// The order of the results.
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
    pub total: u64,
}

/// One series in the library, with its linked-book count. Returned by
/// [`Library::list_series`]; series ids are what [`BookQuery::series_id`]
/// filters on.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct SeriesSummary {
    /// The series' id.
    pub id: i32,
    /// The series' name.
    pub name: String,
    /// Number of books linked to the series.
    pub book_count: i64,
}

/// One tag in the library. Returned by [`Library::list_tags`]; the full
/// vocabulary feeds tag autocomplete in clients.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct TagSummary {
    /// The tag's id, as taken by [`BookQuery::tag_id`].
    pub id: i32,
    /// The tag's name.
    pub name: String,
    /// Number of books linked to the tag; 0 for unused tags.
    pub book_count: i64,
}

/// One publisher in the library, with its linked-book count. Returned by
/// [`Library::list_publishers`]; publisher ids are what
/// [`BookQuery::publisher_id`] filters on.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct PublisherSummary {
    /// The publisher's id.
    pub id: i32,
    /// The publisher's name.
    pub name: String,
    /// Number of books linked to the publisher.
    pub book_count: i64,
}

/// Books linked to value `value_id` of the custom column labelled
/// `column_label` (without the `#`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CustomValueFilter {
    /// The custom column's label, without the `#`.
    pub column_label: String,
    /// The value's id, from [`Library::list_custom_column_values`].
    pub value_id: i32,
}

/// One value of a text, series or enumeration custom column, with its
/// linked-book count. Returned by [`Library::list_custom_column_values`].
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct CustomValueSummary {
    /// The value's id, as taken by [`CustomValueFilter::value_id`].
    pub id: i32,
    /// The value itself.
    pub name: String,
    /// Number of books linked to the value.
    pub book_count: i64,
}

impl Library {
    /// Opens the library rooted at `library_root` (the folder holding
    /// `metadata.db`) for writing. Its schema must be at least
    /// [`MINIMUM_SCHEMA_VERSION`](crate::MINIMUM_SCHEMA_VERSION); nothing is
    /// upgraded here.
    ///
    /// Opening for writing switches the database to WAL mode and installs
    /// Calibre's triggers. Use [`Library::open_read_only`] to only read.
    pub fn open(library_root: impl AsRef<Path>) -> Result<Self, CalibreError> {
        let db_path = ValidDbPath::locate(library_root.as_ref())?;
        let mut conn = establish_connection(&db_path.database_path)?;
        schema_versions::supported_version(&mut conn)?;
        Ok(Self {
            db_path,
            conn,
            read_only: false,
            read_column: Some(DEFAULT_READ_COLUMN.to_string()),
        })
    }

    /// Opens the library rooted at `library_root` for reading only. The
    /// database is never changed: not its journal mode, triggers or schema.
    /// Writes fail, and it is safe to read while Calibre has the library
    /// open.
    pub fn open_read_only(library_root: impl AsRef<Path>) -> Result<Self, CalibreError> {
        let db_path = ValidDbPath::locate(library_root.as_ref())?;
        let mut conn = establish_read_only_connection(&db_path.database_path)?;
        schema_versions::supported_version(&mut conn)?;
        Ok(Self {
            db_path,
            conn,
            read_only: true,
            read_column: Some(DEFAULT_READ_COLUMN.to_string()),
        })
    }

    /// Track read state in the bool custom column labelled `label` (without
    /// the `#`). It is created on the first [`Library::set_book_read_state`].
    pub fn with_read_column(mut self, label: impl Into<String>) -> Self {
        self.read_column = Some(label.into());
        self
    }

    /// Don't track read state: every book reads as unread,
    /// [`BookQuery::hide_read`] is ignored and
    /// [`Library::set_book_read_state`] fails.
    pub fn without_read_column(mut self) -> Self {
        self.read_column = None;
        self
    }

    /// The database's Calibre schema version (`PRAGMA user_version`).
    pub fn schema_version(&mut self) -> Result<i32, CalibreError> {
        Ok(schema_versions::schema_version(&mut self.conn)?)
    }

    /// True when [`Library::upgrade`] has steps to run.
    pub fn upgrade_available(&mut self) -> Result<bool, CalibreError> {
        Ok(self.schema_version()? < schema_versions::SCHEMA_VERSION)
    }

    /// Brings the library up to [`schema_versions::SCHEMA_VERSION`] in one
    /// transaction, after writing a backup beside `metadata.db`. `None` when it is already current. Refused on a
    /// read-only handle before anything is written.
    pub fn upgrade(&mut self) -> Result<Option<SchemaUpgrade>, CalibreError> {
        if self.read_only {
            return Err(CalibreError::ReadOnlyLibrary);
        }
        schema_versions::upgrade(&mut self.conn, Path::new(&self.db_path.database_path))
    }

    /// The library's root folder.
    pub fn library_path(&self) -> &Path {
        Path::new(&self.db_path.library_path)
    }

    /// The library's `metadata.db`.
    pub fn database_path(&self) -> &Path {
        Path::new(&self.db_path.database_path)
    }

    /// The library's UUID, from its `library_id` table. Fails with
    /// [`CalibreError::DatabaseIntegrity`] when that table has no row.
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

    /// When the catalogue last changed: the latest of every book's
    /// `last_modified` and the modification times of `metadata.db` and its
    /// `-wal` file, in UTC. `None` only when there are no books and neither
    /// file time can be read.
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

    /// Adds a book: its records, a `{author}/{title} ({id})` folder holding
    /// copies of its files, and a `cover.jpg` taken from the first file when
    /// it embeds one. Returns the new book. The book is queued in
    /// `metadata_dirtied`, so Calibre writes its `metadata.opf` backup.
    ///
    /// A rating above 10 is refused with [`CalibreError::InvalidRating`]
    /// before anything is written. The other steps are not one transaction:
    /// if a later step fails (a failed copy gives
    /// [`CalibreError::FileSystem`]), the records written so far remain.
    /// Cover extraction is best-effort and never fails the add.
    pub fn add_book(&mut self, book: BookAdd) -> Result<Book, CalibreError> {
        if let Some(rating) = book.rating.filter(|rating| !(0..=10).contains(rating)) {
            return Err(CalibreError::InvalidRating(rating));
        }
        // 1. Create/find authors. Like Calibre, a book with no author is filed
        // under "Unknown", so its folder is never at the library root.
        let mut author_names: Vec<&str> = book
            .author_names
            .iter()
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
            .collect();
        if author_names.is_empty() {
            author_names.push(UNKNOWN_AUTHOR);
        }
        let created_authors: Vec<crate::entities::author::Author> = author_names
            .into_iter()
            .map(|name| author_queries::create_if_not_exists(&mut self.conn, name))
            .collect::<Result<Vec<_>, _>>()?;

        // 2. Create book record
        let new_book = NewBook {
            title: book.title.clone(),
            timestamp: None,
            pubdate: Some(
                book.publication_date
                    .and_then(|date| date.and_hms_opt(0, 0, 0))
                    .unwrap_or_else(crate::queries::book_details::undefined_date),
            ),
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

        if let Some(publisher) = book.publisher.as_deref().map(str::trim) {
            if !publisher.is_empty() {
                crate::queries::publishers::set_for_book(
                    &mut self.conn,
                    BookId(book_row.id),
                    publisher,
                )?;
            }
        }

        if let Some(description) = book.description.as_ref().filter(|c| !c.trim().is_empty()) {
            crate::queries::book_descriptions::create(
                &mut self.conn,
                BookId(book_row.id),
                description.clone(),
            )?;
        }

        if let Some(rating) = book.rating {
            crate::queries::book_details::set_rating(&mut self.conn, BookId(book_row.id), rating)?;
        }

        let mut identifiers: Vec<_> = book.identifiers.iter().collect();
        identifiers.sort();
        for (label, value) in identifiers {
            self.upsert_book_identifier(BookId(book_row.id), label.clone(), value.clone(), None)?;
        }

        // 4. Create directories
        let primary_author = created_authors
            .first()
            .map(|a| a.name.clone())
            .unwrap_or_default();
        let author_dir_name = sanitise(&primary_author);
        let book_dir_name = sanitise(&format!("{} ({})", book.title, book_row.id));
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
            let file_stem = sanitise(&format!("{} - {}", book.title, primary_author));
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
            if let Some(cover_data) = cover_image_data(primary_file) {
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

        book_queries::touch(&mut self.conn, BookId(book_row.id))?;

        self.get_book(BookId(book_row.id))
    }

    /// Every book in the library, fully hydrated, in no particular order.
    /// [`Library::query_books`] pages and sorts instead.
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

    /// One book. Fails with [`CalibreError::BookNotFound`] when there is no
    /// book with that id.
    pub fn get_book(&mut self, book_id: BookId) -> Result<Book, CalibreError> {
        let mut book = operations::books::get_book(&mut self.conn, book_id)?;
        book.is_read = self.get_book_read_state(book_id)?;
        Ok(book)
    }

    /// Applies `update` in one transaction, sets the book's `last_modified`
    /// (even when nothing else changed), queues it in `metadata_dirtied` and
    /// returns the updated book.
    ///
    /// Setting both [`BookUpdate::author_names`] and
    /// [`BookUpdate::author_ids`] fails with
    /// [`CalibreError::BannedFunctionInvocation`] before anything is written.
    /// [`BookUpdate::is_read`] is written after that transaction commits, so
    /// a read-state failure (such as [`CalibreError::NoReadColumn`]) leaves
    /// the other changes in place.
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

        self.get_book(book_id)
    }

    /// Delete books from the library database, all-or-nothing in one
    /// transaction: each `books` row, its links, per-book data and
    /// custom-column values. Files on disk are NOT touched; the returned
    /// absolute directories (one per deleted book, in input order) are left
    /// for the caller to dispose of, e.g. by moving them to the system
    /// trash. Fails with [`CalibreError::BookNotFound`] if any id is missing,
    /// in which case nothing is deleted. Every folder is validated before
    /// records are removed: paths must be relative author/book directories
    /// within the library (or, for a book without an author, a root folder
    /// ending in the book's own ` (id)`), without symlinks or inaccessible
    /// ancestors.
    pub fn delete_books(&mut self, book_ids: &[BookId]) -> Result<Vec<PathBuf>, CalibreError> {
        let library_root = PathBuf::from(&self.db_path.library_path);
        self.conn.transaction(|conn| {
            let mut dirs = Vec::with_capacity(book_ids.len());
            for &book_id in book_ids {
                let book =
                    book_queries::get(conn, book_id)?.ok_or(CalibreError::BookNotFound(book_id))?;
                dirs.push(operations::assets::validated_book_delete_dir(
                    &library_root,
                    book_id,
                    &book.path,
                )?);
            }
            for &book_id in book_ids {
                operations::assets::delete_book_records(conn, book_id)?;
            }
            Ok(dirs)
        })
    }

    /// For each candidate, the books in the library that may be the same
    /// book, strongest match first (see [`crate::matching`]), at most
    /// [`MAX_DUPLICATES`] each. Reads the library once for all candidates,
    /// without hydrating books.
    pub fn find_duplicates(
        &mut self,
        candidates: &[Candidate],
    ) -> Result<Vec<Vec<DuplicateMatch>>, CalibreError> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let mut existing: Vec<(BookId, MatchProfile)> =
            crate::queries::matching::book_facts(&mut self.conn)?
                .into_iter()
                .map(|(id, facts)| {
                    let profile = MatchProfile::new(
                        &facts.title,
                        &facts.author_names,
                        facts.isbns,
                        &facts.languages,
                    );
                    (id, profile)
                })
                .collect();
        existing.sort_by_key(|(id, _)| id.as_i32());
        Ok(candidates
            .iter()
            .map(|candidate| {
                let candidate = MatchProfile::of(candidate);
                let mut matches: Vec<DuplicateMatch> = existing
                    .iter()
                    .filter_map(|(book_id, profile)| {
                        candidate.reason(profile).map(|reason| DuplicateMatch {
                            book_id: *book_id,
                            reason,
                        })
                    })
                    .collect();
                matches.sort_by_key(|found| found.reason);
                matches.truncate(MAX_DUPLICATES);
                matches
            })
            .collect())
    }

    /// Adds files to an existing book as further formats, copied into its
    /// folder and named like [`Library::add_book`] names them. A format the
    /// book already has is replaced: its old file is deleted and its record
    /// updated. Returns the updated book, which is queued in
    /// `metadata_dirtied`.
    ///
    /// Fails with [`CalibreError::BookNotFound`] for an unknown book and
    /// [`CalibreError::FileSystem`] when a file can't be read or copied;
    /// every file is checked before anything is written, but files copied
    /// before a later failure remain.
    pub fn add_book_files(
        &mut self,
        book_id: BookId,
        file_paths: Vec<PathBuf>,
    ) -> Result<Book, CalibreError> {
        let book = self.get_book(book_id)?;
        let sizes = file_paths
            .iter()
            .map(|path| {
                std::fs::metadata(path)
                    .ok()
                    .filter(|metadata| metadata.is_file())
                    .map(|metadata| metadata.len() as i32)
                    .ok_or_else(|| {
                        CalibreError::FileSystem(format!("Can't read {}", path.display()))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let primary_author = book
            .authors
            .first()
            .map(|author| author.name.as_str())
            .unwrap_or(UNKNOWN_AUTHOR);
        let file_stem = sanitise(&format!("{} - {}", book.title, primary_author));
        let book_dir = Path::new(&self.db_path.library_path).join(&book.book_dir_path);
        std::fs::create_dir_all(&book_dir).map_err(|e| CalibreError::FileSystem(e.to_string()))?;

        for (file_path, size) in file_paths.iter().zip(sizes) {
            let extension = file_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_uppercase();
            let file_name = |stem: &str| {
                if extension.is_empty() {
                    stem.to_string()
                } else {
                    format!("{}.{}", stem, extension.to_lowercase())
                }
            };
            let dest_path = book_dir.join(file_name(&file_stem));
            std::fs::copy(file_path, &dest_path)
                .map_err(|e| CalibreError::FileSystem(e.to_string()))?;
            match book_files::find_by_book_and_format(&mut self.conn, book_id, extension.clone())? {
                Some(existing) => {
                    if existing.name != file_stem {
                        let _ = std::fs::remove_file(book_dir.join(file_name(&existing.name)));
                    }
                    book_files::update(&mut self.conn, existing.id, &file_stem, size)?;
                }
                None => book_files::create(
                    &mut self.conn,
                    NewBookFile {
                        book: book_id.as_i32(),
                        format: extension.clone(),
                        uncompressed_size: size,
                        name: file_stem.clone(),
                    },
                )?,
            }
        }

        book_queries::touch(&mut self.conn, book_id)?;
        self.get_book(book_id)
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

    /// The bytes of the book's `cover.jpg`. Fails with
    /// [`CalibreError::BookNotFound`], [`CalibreError::BookCoverNotFound`]
    /// when the book records no cover, or, as for
    /// [`Library::resolve_book_cover`], when the file is missing or outside
    /// the library.
    pub fn get_book_cover(&mut self, book_id: BookId) -> Result<Vec<u8>, CalibreError> {
        operations::assets::get_book_cover(&self.db_path.library_path, &mut self.conn, book_id)
    }

    /// Writes `cover_data` as the book's `cover.jpg`, unconverted, marks the
    /// book as having a cover and sets its `last_modified`. Fails with
    /// [`CalibreError::BookNotFound`], or [`CalibreError::FileSystem`] when
    /// the file can't be written.
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

    /// The bytes of the book's file in `file_format`, resolved as by
    /// [`Library::resolve_book_file`] and failing the same ways.
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

    /// Locates the book's file in `format` (case-insensitive, a leading `.`
    /// allowed) without reading it. Fails with
    /// [`CalibreError::BookNotFound`], [`CalibreError::InvalidBookFormat`],
    /// [`CalibreError::BookFileNotFound`] when the book has no such format,
    /// [`CalibreError::AssetFileMissing`] when the file is absent from disk,
    /// or [`CalibreError::AssetOutsideLibrary`] when its path leads outside
    /// the library folder.
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

    /// Locates the book's `cover.jpg` without reading it. Fails with
    /// [`CalibreError::BookNotFound`], [`CalibreError::BookCoverNotFound`]
    /// when the book records no cover, [`CalibreError::AssetFileMissing`] or
    /// [`CalibreError::AssetOutsideLibrary`].
    pub fn resolve_book_cover(&mut self, id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
        operations::assets::resolve_book_cover(&self.db_path.library_path, &mut self.conn, id)
    }

    // =========================================================================
    // Authors
    // =========================================================================

    /// Adds an author and returns its id. Fails with
    /// [`CalibreError::Database`] when the name is already taken.
    pub fn add_author(&mut self, author: AuthorAdd) -> Result<AuthorId, CalibreError> {
        let new_author = operations::authors::add(&mut self.conn, author)?;
        Ok(new_author.id)
    }

    /// Every author in the library, in no particular order.
    pub fn authors(&mut self) -> Result<Vec<Author>, CalibreError> {
        operations::authors::all(&mut self.conn)
    }

    /// Linked-book count per author, computed in one GROUP BY pass over
    /// `books_authors_link` (no per-author scans). Authors with no linked
    /// books are absent from the map — treat a missing entry as 0.
    pub fn author_book_counts(&mut self) -> Result<HashMap<AuthorId, i64>, CalibreError> {
        author_queries::book_counts(&mut self.conn)
    }

    /// One author. Fails with [`CalibreError::AuthorNotFound`] when there is
    /// no author with that id.
    pub fn get_author(&mut self, author_id: AuthorId) -> Result<Author, CalibreError> {
        operations::authors::get(&mut self.conn, author_id)
    }

    /// Applies `update` to the author, sets `last_modified` on each of their
    /// books and returns the updated author. The books' own author sort
    /// (`books.author_sort`) is not recomputed.
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

    /// Deletes an author who has no books and returns their id. Fails with
    /// [`CalibreError::AuthorHasAssociatedBooks`] while any book is linked to
    /// them. An id with no author deletes nothing and succeeds.
    pub fn remove_author(&mut self, author_id: AuthorId) -> Result<AuthorId, CalibreError> {
        operations::authors::remove(&mut self.conn, author_id)?;
        Ok(author_id)
    }

    // =========================================================================
    // Identifiers
    // =========================================================================

    /// Adds or changes one of the book's identifiers and returns its id, in
    /// one transaction that also sets the book's `last_modified`.
    ///
    /// With `existing_id`, that identifier's label and value are replaced
    /// (the label as given); it fails with [`CalibreError::Database`] when the
    /// book has no identifier with that id. Without, a new identifier is
    /// added with its label lowercased; it fails with
    /// [`CalibreError::Database`] when the book already has one with that
    /// label.
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

    /// Removes the book's identifier with id `identifier_id`, if it has one,
    /// and sets the book's `last_modified` either way.
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
        self.conn
            .transaction(|conn| set_custom_value_and_touch(conn, &column, book_id, value))
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
    // Read state (a bool custom column, `#read` by default)
    // =========================================================================

    /// The read column's label, if read state is tracked.
    pub fn read_column(&self) -> Option<&str> {
        self.read_column.as_deref()
    }

    fn find_read_column(&mut self) -> Result<Option<CustomColumn>, CalibreError> {
        let Some(label) = self.read_column.as_deref() else {
            return Ok(None);
        };
        custom_columns::find_by_label_and_kind(&mut self.conn, label, &CustomColumnKind::Bool)
    }

    fn get_or_create_read_state_column(&mut self) -> Result<CustomColumn, CalibreError> {
        let Some(label) = self.read_column.clone() else {
            return Err(CalibreError::NoReadColumn);
        };
        if let Some(column) = self.find_read_column()? {
            return Ok(column);
        }
        let mut name = label.replace('_', " ");
        if let Some(first) = name.get_mut(..1) {
            first.make_ascii_uppercase();
        }
        custom_columns::create(
            &mut self.conn,
            &CustomColumnSpec {
                label,
                name,
                kind: CustomColumnKind::Bool,
                is_multiple: false,
                enum_values: vec![],
                display: None,
            },
        )
    }

    /// Whether the read column marks the book read. `false` when the value is
    /// unset, when the column doesn't exist yet, or when the library tracks
    /// no read state.
    pub fn get_book_read_state(&mut self, book_id: BookId) -> Result<bool, CalibreError> {
        let Some(column) = self.find_read_column()? else {
            return Ok(false);
        };
        let value = custom_columns::get_value(&mut self.conn, &column, book_id)?;
        Ok(matches!(value, Some(CustomValue::Bool(true))))
    }

    /// Marks the book read or unread in the read column, creating the column
    /// (a bool column named after its label) on first use. Sets the book's
    /// `last_modified` only when the stored value changes. Fails with
    /// [`CalibreError::NoReadColumn`] after [`Library::without_read_column`].
    pub fn set_book_read_state(
        &mut self,
        book_id: BookId,
        is_read: bool,
    ) -> Result<(), CalibreError> {
        let column = self.get_or_create_read_state_column()?;
        self.conn.transaction(|conn| {
            set_custom_value_and_touch(conn, &column, book_id, Some(CustomValue::Bool(is_read)))
        })
    }

    /// Read state for many books at once. Only books with a stored value
    /// appear; treat a missing entry as unread. Empty when the library tracks
    /// no read state or the read column doesn't exist yet.
    pub fn batch_get_read_states(
        &mut self,
        book_ids: &[BookId],
    ) -> Result<HashMap<BookId, bool>, CalibreError> {
        if book_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let Some(column) = self.find_read_column()? else {
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

    /// Replaces the library's UUID with a new random one. Also sets
    /// `last_modified` on the book with the lowest id, so
    /// [`Library::catalog_updated_at`] moves.
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
        let Some(filters) = self.page_filters(&query)? else {
            return Ok(BookPage {
                items: Vec::new(),
                total: 0,
            });
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
        let Some(filters) = self.page_filters(&query)? else {
            return Ok(BookPage {
                items: Vec::new(),
                total: 0,
            });
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
        let total = u64::try_from(resolvable_ids.len()).expect("usize fits in u64");
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

    /// List every tag in the library (the whole vocabulary, including tags
    /// no longer linked to any book), sorted case-insensitively by name.
    pub fn list_tags(&mut self) -> Result<Vec<TagSummary>, CalibreError> {
        crate::queries::tags::list_all(&mut self.conn)
    }

    /// List every publisher with its linked-book count, sorted by name. The
    /// returned ids feed [`BookQuery::publisher_id`].
    pub fn list_publishers(&mut self) -> Result<Vec<PublisherSummary>, CalibreError> {
        crate::queries::publishers::list_with_book_counts(&mut self.conn)
    }

    /// The custom column labelled `label` (without the `#`), if any. Unlike
    /// [`Library::custom_columns`], this also finds a column marked for
    /// deletion.
    pub fn custom_column(&mut self, label: &str) -> Result<Option<CustomColumn>, CalibreError> {
        custom_columns::find_by_label(&mut self.conn, label)
    }

    /// Every value of the text, series or enumeration custom column
    /// labelled `label`, with its linked-book count, sorted by value. Empty
    /// when the column doesn't exist. The ids feed
    /// [`BookQuery::custom_value`].
    pub fn list_custom_column_values(
        &mut self,
        label: &str,
    ) -> Result<Vec<CustomValueSummary>, CalibreError> {
        let Some(column) = self.value_column(label)? else {
            return Ok(Vec::new());
        };
        crate::queries::custom_values::list_with_book_counts(&mut self.conn, column.id)
    }

    /// A text, series or enumeration column: one whose values live in their
    /// own table, so books can be filtered and faceted by value id.
    fn value_column(&mut self, label: &str) -> Result<Option<CustomColumn>, CalibreError> {
        let Some(column) = custom_columns::find_by_label(&mut self.conn, label)? else {
            return Ok(None);
        };
        if !matches!(
            column.kind,
            CustomColumnKind::Text | CustomColumnKind::Series | CustomColumnKind::Enumeration
        ) {
            return Err(CalibreError::UnsupportedCustomColumn(format!(
                "#{label} is a {} column; only text, series and enumeration columns have values to list",
                column.kind.datatype()
            )));
        }
        Ok(Some(column))
    }

    /// `None` when the query can match no books (its custom column is
    /// missing).
    fn page_filters<'q>(
        &mut self,
        query: &'q BookQuery,
    ) -> Result<Option<book_queries::BookPageFilters<'q>>, CalibreError> {
        // Without a read column, no book has been marked read, so there is
        // nothing to hide.
        let hide_read_column = if query.hide_read {
            self.find_read_column()?.map(|column| column.id)
        } else {
            None
        };
        let custom_value = match &query.custom_value {
            Some(filter) => match self.value_column(&filter.column_label)? {
                Some(column) => Some((column.id, filter.value_id)),
                None => return Ok(None),
            },
            None => None,
        };
        Ok(Some(book_queries::BookPageFilters {
            text: query
                .text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty()),
            author_id: query.author_id,
            series_id: query.series_id,
            tag_id: query.tag_id,
            publisher_id: query.publisher_id,
            custom_value,
            hide_read_column,
        }))
    }

    /// Every book whose title, author names or series name contains `query`
    /// (trimmed), case-insensitively, sorted by title. An empty or blank
    /// query returns no books; see [`BookQuery::text`].
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

    /// Every book linked to the author, sorted by title. Empty when the
    /// author has no books or doesn't exist.
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

/// Compares the stored value before and after the write, so no-op edits and
/// values `set_value` normalises to what's already stored leave
/// `last_modified` alone, as Calibre does.
fn set_custom_value_and_touch(
    conn: &mut SqliteConnection,
    column: &CustomColumn,
    book_id: BookId,
    value: Option<CustomValue>,
) -> Result<(), CalibreError> {
    let before = custom_columns::get_value(conn, column, book_id)?;
    custom_columns::set_value(conn, column, book_id, value)?;
    if custom_columns::get_value(conn, column, book_id)? != before {
        book_queries::touch(conn, book_id)?;
    }
    Ok(())
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

/// Which facet [`Library::catalog_facets`] counts.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum CatalogFacetKind {
    /// Authors.
    Authors,
    /// Series.
    Series,
    /// Tags.
    Tags,
    /// Values of the text, series or enumeration custom column with this
    /// label (without the `#`). Empty when the column doesn't exist.
    CustomColumn(String),
}

/// One facet value and how many acquirable books are linked to it.
/// Returned by [`Library::catalog_facets`].
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct CatalogFacetSummary {
    /// The author, series, tag or custom-column value's id.
    pub id: i32,
    /// Its name.
    pub name: String,
    /// Number of linked books with at least one file that resolves inside
    /// the library.
    pub book_count: i64,
}

impl Library {
    /// Count only safely downloadable books, using lightweight candidate/link rows.
    /// This scans library candidates; it never hydrates the whole book collection.
    pub fn catalog_facets(
        &mut self,
        kind: CatalogFacetKind,
    ) -> Result<Vec<CatalogFacetSummary>, CalibreError> {
        use diesel::sql_types::{Integer, Text};
        #[derive(QueryableByName)]
        struct Link {
            #[diesel(sql_type = Integer)]
            id: i32,
            #[diesel(sql_type = Text)]
            name: String,
            #[diesel(sql_type = Integer)]
            book: i32,
        }
        let (table, links, value) = match &kind {
            CatalogFacetKind::Authors => (
                "authors".to_string(),
                "books_authors_link".to_string(),
                "author",
            ),
            CatalogFacetKind::Series => (
                "series".to_string(),
                "books_series_link".to_string(),
                "series",
            ),
            CatalogFacetKind::Tags => ("tags".to_string(), "books_tags_link".to_string(), "tag"),
            CatalogFacetKind::CustomColumn(label) => {
                let Some(column) = self.value_column(label)? else {
                    return Ok(Vec::new());
                };
                (
                    format!("custom_column_{}", column.id),
                    format!("books_custom_column_{}_link", column.id),
                    "value",
                )
            }
        };
        let name = if matches!(kind, CatalogFacetKind::CustomColumn(_)) {
            "value"
        } else {
            "name"
        };
        let rows: Vec<Link> = sql_query(format!("SELECT f.id AS id, f.{name} AS name, l.book AS book FROM {table} f JOIN {links} l ON l.{value} = f.id ORDER BY f.{name} COLLATE NOCASE, f.{name}, f.id")).load(&mut self.conn)?;
        let filters = book_queries::BookPageFilters {
            text: None,
            author_id: None,
            series_id: None,
            tag_id: None,
            publisher_id: None,
            custom_value: None,
            hide_read_column: None,
        };
        let mut eligible = std::collections::HashSet::new();
        for candidate in
            book_queries::acquisition_candidates(&mut self.conn, &filters, BookSortOrder::TitleAsc)?
        {
            if !eligible.contains(&candidate.book_id)
                && operations::assets::is_resolvable_book_file(
                    &self.db_path.library_path,
                    &candidate.book_path,
                    &candidate.name,
                    &candidate.format,
                )
            {
                eligible.insert(candidate.book_id);
            }
        }
        let mut facets = Vec::<CatalogFacetSummary>::new();
        let mut positions = HashMap::new();
        let mut counted = std::collections::HashSet::new();
        for row in rows {
            if !eligible.contains(&row.book) || !counted.insert((row.id, row.book)) {
                continue;
            }
            let index = *positions.entry(row.id).or_insert_with(|| {
                facets.push(CatalogFacetSummary {
                    id: row.id,
                    name: row.name,
                    book_count: 0,
                });
                facets.len() - 1
            });
            facets[index].book_count += 1;
        }
        Ok(facets)
    }
}
