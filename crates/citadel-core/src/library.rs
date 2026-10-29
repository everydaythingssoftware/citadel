//! Application operations shared by IPC and HTTP. Hosts supply an open library
//! and asset URL policy; this module knows neither Tauri nor HTTP extractors.
use crate::{
    contracts::{
        custom_columns::{BookCustomValue, CustomColumnDef, CustomValueDto},
        AuthorUpdate, BookUpdate, LibraryBookPage, LibraryBookQuery, LibraryPublisher,
        LibrarySeries, LibraryTag, NewAuthor,
    },
    error::LibraryError,
    Actor, BookUrlBuilder, LibraryAuthor, LibraryBook,
};
use libcalibre::{BookId, Library};

mod delete;
pub use delete::{remove_permanently, DeletedBooks};

type Result<T> = std::result::Result<T, LibraryError>;

pub struct LibraryService<'a> {
    library: &'a mut Library,
    urls: &'a dyn BookUrlBuilder,
}

impl<'a> LibraryService<'a> {
    pub fn new(library: &'a mut Library, urls: &'a dyn BookUrlBuilder) -> Self {
        Self { library, urls }
    }

    pub fn query_books(&mut self, query: LibraryBookQuery) -> Result<LibraryBookPage> {
        let author_id = query
            .author_id
            .as_deref()
            .map(|raw| {
                raw.parse::<libcalibre::AuthorId>().map_err(|error| {
                    LibraryError::invalid(format!("Invalid author id '{raw}': {error}"))
                })
            })
            .transpose()?;
        let page = self.library.query_books(libcalibre::BookQuery {
            text: query.text,
            author_id,
            series_id: query.series_id,
            tag_id: query.tag_id,
            publisher_id: query.publisher_id,
            genre_id: None,
            hide_read: query.hide_read,
            sort: query.sort.into(),
            limit: query.limit.map(i64::from),
            offset: i64::from(query.offset),
        })?;
        Ok(LibraryBookPage {
            items: self.books(&page.items, false)?,
            total: count(page.total),
        })
    }

    pub fn get_book(&mut self, id: &str) -> Result<LibraryBook> {
        let book = self.library.get_book(book_id(id)?)?;
        self.books(&[book], true)?
            .pop()
            .ok_or_else(LibraryError::unavailable)
    }

    pub fn search_books(&mut self, query: &str) -> Result<Vec<LibraryBook>> {
        let books = self.library.search_books(query)?;
        self.books(&books, false)
    }

    fn books(
        &mut self,
        books: &[libcalibre::library::Book],
        cache_bust: bool,
    ) -> Result<Vec<LibraryBook>> {
        let counts = self.library.author_book_counts()?;
        Ok(books
            .iter()
            .map(|book| {
                LibraryBook::from_library_book(
                    book,
                    self.library.library_path(),
                    &counts,
                    self.urls,
                    cache_bust,
                )
            })
            .collect())
    }

    pub fn list_authors(&mut self) -> Result<Vec<LibraryAuthor>> {
        let counts = self.library.author_book_counts()?;
        Ok(self
            .library
            .authors()?
            .iter()
            .map(|author| LibraryAuthor::from_author(author, &counts))
            .collect())
    }

    pub fn list_series(&mut self) -> Result<Vec<LibrarySeries>> {
        Ok(self
            .library
            .list_series()?
            .into_iter()
            .map(|item| LibrarySeries {
                id: item.id,
                name: item.name,
                book_count: count(item.book_count),
            })
            .collect())
    }
    pub fn list_tags(&mut self) -> Result<Vec<LibraryTag>> {
        Ok(self
            .library
            .list_tags()?
            .into_iter()
            .map(|item| LibraryTag {
                id: item.id,
                name: item.name,
                book_count: count(item.book_count),
            })
            .collect())
    }
    pub fn list_publishers(&mut self) -> Result<Vec<LibraryPublisher>> {
        Ok(self
            .library
            .list_publishers()?
            .into_iter()
            .map(|item| LibraryPublisher {
                id: item.id,
                name: item.name,
                book_count: count(item.book_count),
            })
            .collect())
    }

    pub fn create_book(&mut self, _actor: &Actor, book: libcalibre::BookAdd) -> Result<String> {
        Ok(self.library.add_book(book)?.id.as_i32().to_string())
    }

    pub fn update_book(&mut self, _actor: &Actor, id: &str, updates: BookUpdate) -> Result<i32> {
        Ok(self
            .library
            .update_book(book_id(id)?, updates.to_library_update())?
            .id
            .as_i32())
    }
    pub fn update_author(
        &mut self,
        _actor: &Actor,
        id: &str,
        updates: AuthorUpdate,
    ) -> Result<i32> {
        let id = id
            .parse::<i32>()
            .map(libcalibre::AuthorId::from)
            .map_err(|error| LibraryError::invalid(error.to_string()))?;
        Ok(self
            .library
            .update_author(id, updates.to_library_update())?
            .id
            .as_i32())
    }
    /// Deletes books from the database in one transaction: nothing is deleted
    /// if any id is unknown. Their folders stay on disk until the host passes
    /// its removal strategy to [`DeletedBooks::remove_folders`], ideally after
    /// releasing the library.
    pub fn delete_books(&mut self, _actor: &Actor, ids: &[String]) -> Result<DeletedBooks> {
        let ids = ids
            .iter()
            .map(|id| book_id(id))
            .collect::<Result<Vec<_>>>()?;
        let library_root = std::path::Path::new(self.library.library_path())
            .canonicalize()
            .map_err(libcalibre::CalibreError::from)?;
        let folders = self.library.delete_books(&ids)?;
        Ok(DeletedBooks {
            library_root,
            folders,
        })
    }
    pub fn delete_author(&mut self, _actor: &Actor, id: &str) -> Result<()> {
        let id = id
            .parse::<i32>()
            .map(libcalibre::AuthorId::from)
            .map_err(|error| LibraryError::invalid(error.to_string()))?;
        self.library.remove_author(id)?;
        Ok(())
    }
    pub fn create_authors(
        &mut self,
        _actor: &Actor,
        authors: Vec<NewAuthor>,
    ) -> Result<Vec<LibraryAuthor>> {
        let counts = std::collections::HashMap::new();
        authors
            .into_iter()
            .map(|author| {
                let id = self.library.add_author(libcalibre::AuthorAdd {
                    name: author.name,
                    sort: author.sortable_name,
                    link: None,
                })?;
                Ok(LibraryAuthor::from_author(
                    &self.library.get_author(id)?,
                    &counts,
                ))
            })
            .collect()
    }
    pub fn upsert_identifier(
        &mut self,
        _actor: &Actor,
        id: &str,
        label: String,
        value: String,
        existing_id: Option<i32>,
    ) -> Result<()> {
        self.library
            .upsert_book_identifier(book_id(id)?, label, value, existing_id)?;
        Ok(())
    }
    pub fn delete_identifier(
        &mut self,
        _actor: &Actor,
        id: &str,
        identifier_id: i32,
    ) -> Result<()> {
        self.library
            .delete_book_identifier(book_id(id)?, identifier_id)?;
        Ok(())
    }
    pub fn list_custom_columns(&mut self) -> Result<Vec<CustomColumnDef>> {
        Ok(self
            .library
            .custom_columns()?
            .iter()
            .map(CustomColumnDef::from)
            .collect())
    }
    pub fn get_custom_values(&mut self, id: &str) -> Result<Vec<BookCustomValue>> {
        let values = self.library.get_custom_values_for_book(book_id(id)?)?;
        let mut values: Vec<_> = values
            .into_iter()
            .filter_map(|(column_id, value)| {
                CustomValueDto::try_from(value)
                    .ok()
                    .map(|value| BookCustomValue { column_id, value })
            })
            .collect();
        values.sort_by_key(|value| value.column_id);
        Ok(values)
    }
    pub fn set_custom_value(
        &mut self,
        _actor: &Actor,
        id: &str,
        column_id: i32,
        value: Option<CustomValueDto>,
    ) -> Result<()> {
        let value = value
            .map(libcalibre::CustomValue::try_from)
            .transpose()
            .map_err(LibraryError::invalid)?;
        self.library
            .set_custom_value(book_id(id)?, column_id, value)?;
        Ok(())
    }
    pub fn add_genres(&mut self, _actor: &Actor, id: &str, genres: Vec<String>) -> Result<()> {
        self.library.add_book_genres(book_id(id)?, genres)?;
        Ok(())
    }
    pub fn set_cover(&mut self, _actor: &Actor, id: &str, bytes: Vec<u8>) -> Result<()> {
        self.library.set_book_cover(book_id(id)?, bytes)?;
        Ok(())
    }
}

fn book_id(raw: &str) -> Result<BookId> {
    raw.parse::<i32>()
        .map(BookId::from)
        .map_err(|error| LibraryError::invalid(format!("Invalid book id '{raw}': {error}")))
}
fn count(value: impl TryInto<u32>) -> u32 {
    value.try_into().unwrap_or(u32::MAX)
}
