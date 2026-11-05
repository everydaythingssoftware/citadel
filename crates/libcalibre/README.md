# libcalibre

Rust crate for reading and writing [Calibre](https://calibre-ebook.com) ebook libraries: a folder holding `metadata.db` (SQLite) plus one folder per author, each with a folder per book containing its files and cover. Typed access to books, authors, series, tags, publishers, custom columns, files and covers.

Developed as part of [Citadel](https://github.com/everydaythingssoftware/citadel). Not affiliated with or endorsed by the Calibre project.

## Installation

```toml
[dependencies]
libcalibre = "0.1"
```

| Feature | Default | What it does |
| --- | --- | --- |
| `epub` | on | Reads metadata and covers from EPUB files. |
| `mobi` | on | Reads metadata and covers from MOBI, AZW and AZW3 files. |
| `bundled-sqlite` | off | Compiles SQLite into your binary instead of linking the system library. |

Database only, no ebook parsing:

```toml
libcalibre = { version = "0.1", default-features = false }
```

## Opening a library

`Library::open_read_only` takes the folder containing `metadata.db`. A read-only handle never writes: no journal mode change, no triggers, no schema upgrade. Safe while Calibre has the same library open.

```rust,no_run
use libcalibre::{CalibreError, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    println!("library {}", library.library_uuid()?);
    Ok(())
}
```

Every method takes `&mut self`; a `Library` wraps one SQLite connection. Share across threads behind a `Mutex`.

`is_library` only checks for `metadata.db`. Opening a non-library yields `CalibreError::NotALibrary`; a schema older than `MINIMUM_SCHEMA_VERSION` yields `CalibreError::UnsupportedSchema` (opening the library in Calibre once upgrades it).

```rust,no_run
use libcalibre::{is_library, peek_schema_version, CalibreError, Library, MINIMUM_SCHEMA_VERSION};

fn main() -> Result<(), CalibreError> {
    let root = "/Users/me/Calibre Library";
    if !is_library(root) {
        return Ok(());
    }
    if peek_schema_version(root)? < MINIMUM_SCHEMA_VERSION {
        eprintln!("open this library in Calibre once to upgrade it");
        return Ok(());
    }
    let _library = Library::open_read_only(root)?;
    Ok(())
}
```

`library_stats` runs two cheap queries without opening a `Library`.

```rust,no_run
use libcalibre::{library_stats, CalibreError};

fn main() -> Result<(), CalibreError> {
    let stats = library_stats("/Users/me/Calibre Library")?;
    println!("{} books by {} authors", stats.book_count, stats.author_count);
    Ok(())
}
```

## Reading books

`books()` loads every book with its authors, tags, series, identifiers, languages and files.

```rust,no_run
use libcalibre::{CalibreError, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    for book in library.books()? {
        let authors: Vec<&str> = book.authors.iter().map(|a| a.name.as_str()).collect();
        println!("{} — {}", book.title, authors.join(" & "));
        if let (Some(series), Some(index)) = (&book.series, book.series_index) {
            println!("  {series} #{index}");
        }
        for file in &book.files {
            println!("  {} ({} bytes)", file.format, file.uncompressed_size);
        }
    }
    Ok(())
}
```

Ids are unique within one library only; `book.uuid` is stable across libraries.

```rust,no_run
use libcalibre::{BookId, CalibreError, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    let book = library.get_book(BookId(42))?;
    println!("{:?}", book.uuid);
    for identifier in &book.identifiers {
        println!("{}: {}", identifier.label, identifier.value);
    }
    Ok(())
}
```

## Querying books

`query_books` searches, filters, sorts and pages in SQL, returning one page plus the total match count. `text` is a case-insensitive substring match over titles, author names and series names. Filters combine with AND.

```rust,no_run
use libcalibre::{BookQuery, BookSortOrder, CalibreError, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    let page = library.query_books(BookQuery {
        text: Some("tolkien".into()),
        sort: BookSortOrder::UpdatedDesc,
        limit: Some(20),
        offset: 0,
        ..BookQuery::default()
    })?;
    println!("showing {} of {}", page.items.len(), page.total);
    Ok(())
}
```

`author_id`, `series_id`, `tag_id` and `publisher_id` take ids from `authors()`, `list_series()`, `list_tags()` and `list_publishers()`, which also carry book counts. `author_book_counts` returns a map keyed by author id.

```rust,no_run
use libcalibre::{BookQuery, BookSortOrder, CalibreError, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    for series in library.list_series()? {
        println!("{} ({} books)", series.name, series.book_count);
    }
    let Some(discworld) = library.list_series()?.into_iter().find(|s| s.name == "Discworld") else {
        return Ok(());
    };
    let in_order = library.query_books(BookQuery {
        series_id: Some(discworld.id),
        sort: BookSortOrder::SeriesIndexAsc,
        ..BookQuery::default()
    })?;
    for book in in_order.items {
        println!("{:?} {}", book.series_index, book.title);
    }
    Ok(())
}
```

## Custom columns

Each custom column has a label (`#label` in Calibre), a display name and a datatype. `get_custom_values_for_book` returns one book's values keyed by column id.

```rust,no_run
use libcalibre::{BookId, CalibreError, CustomValue, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    let columns = library.custom_columns()?;
    let values = library.get_custom_values_for_book(BookId(42))?;
    for column in &columns {
        match values.get(&column.id) {
            Some(CustomValue::Text(text)) => println!("#{}: {text}", column.label),
            Some(CustomValue::TextMultiple(items)) => println!("#{}: {}", column.label, items.join(", ")),
            Some(other) => println!("#{}: {other:?}", column.label),
            None => {}
        }
    }
    Ok(())
}
```

One column for many books: `batch_get_custom_values` instead of `get_custom_value` per book.

```rust,no_run
use libcalibre::{BookId, CalibreError, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    let Some(column) = library.custom_column("shelf")? else {
        return Ok(());
    };
    let ids: Vec<BookId> = library.books()?.iter().map(|book| book.id).collect();
    let values = library.batch_get_custom_values(column.id, &ids)?;
    println!("{} books have a #shelf", values.len());
    Ok(())
}
```

Text, series and enumeration columns store values in their own table. Only those support `list_custom_column_values` and the `custom_value` filter.

```rust,no_run
use libcalibre::{BookQuery, CalibreError, CustomValueFilter, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    for value in library.list_custom_column_values("genre")? {
        println!("{} ({})", value.name, value.book_count);
    }
    let fantasy = library.list_custom_column_values("genre")?.into_iter().find(|v| v.name == "Fantasy");
    if let Some(fantasy) = fantasy {
        let page = library.query_books(BookQuery {
            custom_value: Some(CustomValueFilter {
                column_label: "genre".into(),
                value_id: fantasy.id,
            }),
            ..BookQuery::default()
        })?;
        println!("{} fantasy books", page.total);
    }
    Ok(())
}
```

## Read state

Calibre has no built-in read flag. By default `book.is_read` and `BookQuery::hide_read` use a yes/no custom column labelled `#read`. The column can be changed or read tracking turned off.

```rust,no_run
use libcalibre::{BookQuery, CalibreError, Library};

fn main() -> Result<(), CalibreError> {
    let library = Library::open_read_only("/Users/me/Calibre Library")?;
    let mut library = library.with_read_column("finished");
    // or: let mut library = library.without_read_column();
    let unread = library.books()?.into_iter().filter(|book| !book.is_read).count();
    println!("{unread} unread");
    let page = library.query_books(BookQuery {
        hide_read: true,
        ..BookQuery::default()
    })?;
    println!("{} unread (query)", page.total);
    Ok(())
}
```

## Files and covers

`book.book_dir_path` is relative to the library root. `resolve_book_file` and `resolve_book_cover` return the canonical path and refuse paths that escape the library folder or do not exist, guarding against a corrupted or malicious database. `get_book_file` and `get_book_cover` return the bytes.

```rust,no_run
use libcalibre::{BookId, CalibreError, Library};

fn main() -> Result<(), CalibreError> {
    let mut library = Library::open_read_only("/Users/me/Calibre Library")?;
    let epub = library.resolve_book_file(BookId(42), "EPUB")?;
    println!("{} -> {}", epub.download_name(), epub.canonical_path().display());

    let cover = library.resolve_book_cover(BookId(42))?;
    println!("cover at {}", cover.canonical_path().display());

    let bytes: Vec<u8> = library.get_book_cover(BookId(42))?;
    println!("cover is {} bytes", bytes.len());
    Ok(())
}
```

## Reading ebook files directly

`book_file` reads embedded metadata from EPUB and MOBI files without a library (with the matching features enabled). Other formats yield the title from the file name.

```rust,no_run
use std::path::Path;

fn main() {
    let path = Path::new("/Users/me/Downloads/book.epub");
    if let Some(metadata) = libcalibre::book_file::read_metadata(path) {
        println!("{:?} by {:?}", metadata.title, metadata.author_names);
        println!("isbn {:?}", metadata.identifier.as_deref().and_then(libcalibre::book_file::isbn));
    }
    let _cover: Option<Vec<u8>> = libcalibre::book_file::cover_image_data(path);
}
```

## Writing

`Library::open` gives a writable handle: `add_book`, `update_book`, `set_custom_value`, `delete_books`. Opening for writing switches the database to WAL mode and installs Calibre's triggers. Nothing enforces a single writer; do not write while Calibre has the library open.

## Supported versions

Schema versions from `MINIMUM_SCHEMA_VERSION` to `SCHEMA_VERSION` open. Nothing upgrades on open. A writable handle can upgrade with `Library::upgrade`, which first writes a backup next to `metadata.db`.
