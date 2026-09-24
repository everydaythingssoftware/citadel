//! Generic support for Calibre custom columns.
//!
//! Calibre stores user-defined metadata in "custom columns". Each column has a
//! row in the `custom_columns` table describing it, plus one or two dynamic
//! tables holding the per-book values:
//!
//! - Non-normalized datatypes (bool, int, float, datetime, comments,
//!   composite) use a single `custom_column_{n}` table with `(book, value)`
//!   rows.
//! - Normalized datatypes (text, series, enumeration, rating) use a
//!   `custom_column_{n}` value table plus a `books_custom_column_{n}_link`
//!   link table.
//!
//! The DDL emitted by [`create`] matches Calibre's `create_custom_column`
//! (src/calibre/db/backend.py) exactly, including its triggers and views.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Double, Integer, Text as SqlText};

use crate::{types::BookId, CalibreError};

// =============================================================================
// Public types
// =============================================================================

/// The datatype of a Calibre custom column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CustomColumnKind {
    Bool,
    Int,
    Float,
    Text,
    Comments,
    Datetime,
    Enumeration,
    Series,
    Rating,
    Composite,
    /// A datatype this crate does not know about.
    Other(String),
}

impl CustomColumnKind {
    /// Parse a Calibre `custom_columns.datatype` string.
    pub fn from_datatype(datatype: &str) -> Self {
        match datatype {
            "bool" => Self::Bool,
            "int" => Self::Int,
            "float" => Self::Float,
            "text" => Self::Text,
            "comments" => Self::Comments,
            "datetime" => Self::Datetime,
            "enumeration" => Self::Enumeration,
            "series" => Self::Series,
            "rating" => Self::Rating,
            "composite" => Self::Composite,
            other => Self::Other(other.to_string()),
        }
    }

    /// The string Calibre stores in `custom_columns.datatype`.
    pub fn datatype(&self) -> &str {
        match self {
            Self::Bool => "bool",
            Self::Int => "int",
            Self::Float => "float",
            Self::Text => "text",
            Self::Comments => "comments",
            Self::Datetime => "datetime",
            Self::Enumeration => "enumeration",
            Self::Series => "series",
            Self::Rating => "rating",
            Self::Composite => "composite",
            Self::Other(other) => other,
        }
    }

    /// Whether Calibre stores this datatype in a value table + link table
    /// (normalized) rather than one `(book, value)` table.
    pub fn is_normalized(&self) -> bool {
        matches!(
            self,
            Self::Text | Self::Series | Self::Enumeration | Self::Rating
        )
    }

    /// Whether this crate supports reading and writing values of this kind.
    pub fn supports_value_io(&self) -> bool {
        matches!(
            self,
            Self::Bool
                | Self::Int
                | Self::Float
                | Self::Text
                | Self::Comments
                | Self::Datetime
                | Self::Enumeration
        )
    }

    /// SQL type of the `value` column in the column's table, per Calibre.
    fn sql_value_type(&self) -> Option<&'static str> {
        match self {
            Self::Rating | Self::Int => Some("INT"),
            Self::Text | Self::Comments | Self::Series | Self::Composite | Self::Enumeration => {
                Some("TEXT")
            }
            Self::Float => Some("REAL"),
            Self::Datetime => Some("timestamp"),
            Self::Bool => Some("BOOL"),
            Self::Other(_) => None,
        }
    }
}

/// A custom column definition, as stored in Calibre's `custom_columns` table.
#[derive(Clone, Debug)]
pub struct CustomColumn {
    pub id: i32,
    /// Lookup name, e.g. `read` (Calibre exposes it as `#read`).
    pub label: String,
    /// Human-readable heading, e.g. `Read`.
    pub name: String,
    pub kind: CustomColumnKind,
    pub is_multiple: bool,
    pub editable: bool,
    pub normalized: bool,
    /// Allowed values for enumeration columns (parsed from `display` JSON).
    /// Empty for other kinds.
    pub enum_values: Vec<String>,
    /// Raw `display` JSON.
    pub display: String,
}

/// A value of a custom column for one book.
#[derive(Clone, Debug, PartialEq)]
pub enum CustomValue {
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    TextMultiple(Vec<String>),
    Datetime(DateTime<Utc>),
    Enumeration(String),
}

impl CustomValue {
    fn type_name(&self) -> &'static str {
        match self {
            Self::Bool(_) => "Bool",
            Self::Int(_) => "Int",
            Self::Float(_) => "Float",
            Self::Text(_) => "Text",
            Self::TextMultiple(_) => "TextMultiple",
            Self::Datetime(_) => "Datetime",
            Self::Enumeration(_) => "Enumeration",
        }
    }
}

/// Description of a custom column to create.
#[derive(Clone, Debug)]
pub struct CustomColumnSpec {
    /// Lookup name. Lowercased and validated against `^[a-z][a-z0-9_]*$`.
    pub label: String,
    /// Human-readable heading.
    pub name: String,
    pub kind: CustomColumnKind,
    /// Only allowed for `CustomColumnKind::Text`.
    pub is_multiple: bool,
    /// Allowed values for enumeration columns. Ignored for other kinds
    /// unless `display` is provided.
    pub enum_values: Vec<String>,
    /// Raw `display` JSON override. When `None`, a default is generated
    /// (`{"enum_values": [...], "enum_colors": []}` for enumerations, `{}`
    /// otherwise).
    pub display: Option<String>,
}

// =============================================================================
// Row mapping
// =============================================================================

#[derive(Queryable)]
struct CustomColumnRow {
    id: i32,
    label: String,
    name: String,
    datatype: String,
    #[allow(dead_code)]
    mark_for_delete: bool,
    editable: bool,
    display: String,
    is_multiple: bool,
    normalized: bool,
}

impl CustomColumnRow {
    fn into_column(self) -> CustomColumn {
        let kind = CustomColumnKind::from_datatype(&self.datatype);
        let enum_values = parse_enum_values(&self.display);
        CustomColumn {
            id: self.id,
            label: self.label,
            name: self.name,
            kind,
            is_multiple: self.is_multiple,
            editable: self.editable,
            normalized: self.normalized,
            enum_values,
            display: self.display,
        }
    }
}

fn parse_enum_values(display_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(display_json)
        .ok()
        .and_then(|value| value.get("enum_values").cloned())
        .and_then(|values| serde_json::from_value::<Vec<String>>(values).ok())
        .unwrap_or_default()
}

// =============================================================================
// Column queries
// =============================================================================

/// All custom columns not marked for deletion, ordered by id.
pub(crate) fn list(conn: &mut SqliteConnection) -> Result<Vec<CustomColumn>, CalibreError> {
    use crate::schema::custom_columns::dsl::*;

    custom_columns
        .filter(mark_for_delete.eq(false))
        .order(id.asc())
        .load::<CustomColumnRow>(conn)
        .map(|rows| rows.into_iter().map(CustomColumnRow::into_column).collect())
        .map_err(CalibreError::from)
}

/// Fetch one custom column by id.
pub(crate) fn get_column(
    conn: &mut SqliteConnection,
    column_id: i32,
) -> Result<CustomColumn, CalibreError> {
    use crate::schema::custom_columns::dsl::*;

    custom_columns
        .filter(id.eq(column_id))
        .first::<CustomColumnRow>(conn)
        .optional()
        .map_err(CalibreError::from)?
        .map(CustomColumnRow::into_column)
        .ok_or(CalibreError::CustomColumnNotFound(column_id))
}

/// Find a custom column by its label and datatype.
pub(crate) fn find_by_label_and_kind(
    conn: &mut SqliteConnection,
    column_label: &str,
    kind: &CustomColumnKind,
) -> Result<Option<CustomColumn>, CalibreError> {
    use crate::schema::custom_columns::dsl::*;

    custom_columns
        .filter(label.eq(column_label))
        .filter(datatype.eq(kind.datatype()))
        .first::<CustomColumnRow>(conn)
        .optional()
        .map(|row| row.map(CustomColumnRow::into_column))
        .map_err(CalibreError::from)
}

pub(crate) fn find_by_label(
    conn: &mut SqliteConnection,
    column_label: &str,
) -> Result<Option<CustomColumn>, CalibreError> {
    use crate::schema::custom_columns::dsl::*;

    custom_columns
        .filter(label.eq(column_label))
        .first::<CustomColumnRow>(conn)
        .optional()
        .map(|row| row.map(CustomColumnRow::into_column))
        .map_err(CalibreError::from)
}

// =============================================================================
// Column creation
// =============================================================================

fn is_valid_label(label: &str) -> bool {
    let mut chars = label.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Create a custom column: inserts the `custom_columns` row and creates the
/// value/link tables, indexes, triggers, and (for normalized columns) views,
/// exactly as Calibre's `create_custom_column` does.
pub(crate) fn create(
    conn: &mut SqliteConnection,
    spec: &CustomColumnSpec,
) -> Result<CustomColumn, CalibreError> {
    use crate::schema::custom_columns::dsl::*;

    let value_type = spec.kind.sql_value_type().ok_or_else(|| {
        CalibreError::UnsupportedCustomColumn(format!(
            "cannot create a custom column with unknown datatype '{}'",
            spec.kind.datatype()
        ))
    })?;

    let column_label = spec.label.to_lowercase();
    if !is_valid_label(&column_label) {
        return Err(CalibreError::InvalidCustomColumn(format!(
            "invalid custom column label '{}': must match ^[a-z][a-z0-9_]*$",
            spec.label
        )));
    }

    if spec.is_multiple && spec.kind != CustomColumnKind::Text {
        return Err(CalibreError::InvalidCustomColumn(format!(
            "is_multiple is only supported for text columns, not '{}'",
            spec.kind.datatype()
        )));
    }

    let display_json = match &spec.display {
        Some(json) => json.clone(),
        None if spec.kind == CustomColumnKind::Enumeration => serde_json::json!({
            "enum_values": spec.enum_values,
            "enum_colors": [],
        })
        .to_string(),
        None => "{}".to_string(),
    };

    let column_normalized = spec.kind.is_normalized();

    let new_id = conn.transaction::<_, CalibreError, _>(|conn| {
        let new_id = diesel::insert_into(custom_columns)
            .values((
                label.eq(&column_label),
                name.eq(&spec.name),
                datatype.eq(spec.kind.datatype()),
                mark_for_delete.eq(false),
                editable.eq(true),
                is_multiple.eq(spec.is_multiple),
                normalized.eq(column_normalized),
                display.eq(&display_json),
            ))
            .returning(id)
            .get_result::<i32>(conn)
            .map_err(CalibreError::from)?;

        let collate = if value_type == "TEXT" {
            "COLLATE NOCASE"
        } else {
            ""
        };
        let ddl = if column_normalized {
            normalized_table_ddl(new_id, value_type, collate, &spec.kind)
        } else {
            non_normalized_table_ddl(new_id, value_type, collate)
        };
        conn.batch_execute(&ddl).map_err(CalibreError::from)?;

        Ok(new_id)
    })?;

    get_column(conn, new_id)
}

/// DDL for non-normalized datatypes (bool, int, float, datetime, comments,
/// composite). Verbatim from Calibre's `create_custom_column`.
fn non_normalized_table_ddl(n: i32, dt: &str, collate: &str) -> String {
    format!(
        r#"CREATE TABLE custom_column_{n}(
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    book  INTEGER,
    value {dt} NOT NULL {collate},
    UNIQUE(book));
CREATE INDEX custom_column_{n}_idx ON custom_column_{n} (book);
CREATE TRIGGER fkc_insert_custom_column_{n}
        BEFORE INSERT ON custom_column_{n}
        BEGIN
            SELECT CASE
                WHEN (SELECT id from books WHERE id=NEW.book) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: book not in books')
            END;
        END;
CREATE TRIGGER fkc_update_custom_column_{n}
        BEFORE UPDATE OF book ON custom_column_{n}
        BEGIN
            SELECT CASE
                WHEN (SELECT id from books WHERE id=NEW.book) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: book not in books')
            END;
        END;
"#
    )
}

/// DDL for normalized datatypes (text, series, enumeration, rating).
/// Verbatim from Calibre's `create_custom_column`, including the `UPDATE OF
/// author` oddity in the `_b` trigger.
fn normalized_table_ddl(n: i32, dt: &str, collate: &str, kind: &CustomColumnKind) -> String {
    let s_index = if *kind == CustomColumnKind::Series {
        "extra REAL,"
    } else {
        ""
    };
    format!(
        r#"CREATE TABLE custom_column_{n}(
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    value {dt} NOT NULL {collate},
    link TEXT NOT NULL DEFAULT "",
    UNIQUE(value));
CREATE INDEX custom_column_{n}_idx ON custom_column_{n} (value {collate});
CREATE TABLE books_custom_column_{n}_link(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book INTEGER NOT NULL,
    value INTEGER NOT NULL,
    {s_index}
    UNIQUE(book, value)
    );
CREATE INDEX books_custom_column_{n}_link_aidx ON books_custom_column_{n}_link (value);
CREATE INDEX books_custom_column_{n}_link_bidx ON books_custom_column_{n}_link (book);
CREATE TRIGGER fkc_update_books_custom_column_{n}_link_a
        BEFORE UPDATE OF book ON books_custom_column_{n}_link
        BEGIN
            SELECT CASE
                WHEN (SELECT id from books WHERE id=NEW.book) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: book not in books')
            END;
        END;
CREATE TRIGGER fkc_update_books_custom_column_{n}_link_b
        BEFORE UPDATE OF author ON books_custom_column_{n}_link
        BEGIN
            SELECT CASE
                WHEN (SELECT id from custom_column_{n} WHERE id=NEW.value) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: value not in custom_column_{n}')
            END;
        END;
CREATE TRIGGER fkc_insert_books_custom_column_{n}_link
        BEFORE INSERT ON books_custom_column_{n}_link
        BEGIN
            SELECT CASE
                WHEN (SELECT id from books WHERE id=NEW.book) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: book not in books')
                WHEN (SELECT id from custom_column_{n} WHERE id=NEW.value) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: value not in custom_column_{n}')
            END;
        END;
CREATE TRIGGER fkc_delete_books_custom_column_{n}_link
        AFTER DELETE ON custom_column_{n}
        BEGIN
            DELETE FROM books_custom_column_{n}_link WHERE value=OLD.id;
        END;
CREATE VIEW tag_browser_custom_column_{n} AS SELECT
    id,
    value,
    (SELECT COUNT(id) FROM books_custom_column_{n}_link WHERE value=custom_column_{n}.id) count,
    (SELECT AVG(r.rating)
     FROM books_custom_column_{n}_link,
          books_ratings_link as bl,
          ratings as r
     WHERE books_custom_column_{n}_link.value=custom_column_{n}.id and bl.book=books_custom_column_{n}_link.book and
           r.id = bl.rating and r.rating <> 0) avg_rating,
    value AS sort
FROM custom_column_{n};
CREATE VIEW tag_browser_filtered_custom_column_{n} AS SELECT
    id,
    value,
    (SELECT COUNT(books_custom_column_{n}_link.id) FROM books_custom_column_{n}_link WHERE value=custom_column_{n}.id AND
    books_list_filter(book)) count,
    (SELECT AVG(r.rating)
     FROM books_custom_column_{n}_link,
          books_ratings_link as bl,
          ratings as r
     WHERE books_custom_column_{n}_link.value=custom_column_{n}.id AND bl.book=books_custom_column_{n}_link.book AND
           r.id = bl.rating AND r.rating <> 0 AND
           books_list_filter(bl.book)) avg_rating,
    value AS sort
FROM custom_column_{n};
"#
    )
}

// =============================================================================
// Value reads
// =============================================================================

#[derive(QueryableByName)]
struct IdRow {
    #[diesel(sql_type = Integer)]
    id: i32,
}

#[derive(QueryableByName)]
struct I64ValueRow {
    #[diesel(sql_type = BigInt)]
    value: i64,
}

#[derive(QueryableByName)]
struct F64ValueRow {
    #[diesel(sql_type = Double)]
    value: f64,
}

#[derive(QueryableByName)]
struct TextValueRow {
    #[diesel(sql_type = SqlText)]
    value: String,
}

#[derive(QueryableByName)]
struct BookI64Row {
    #[diesel(sql_type = Integer)]
    book: i32,
    #[diesel(sql_type = BigInt)]
    value: i64,
}

#[derive(QueryableByName)]
struct BookF64Row {
    #[diesel(sql_type = Integer)]
    book: i32,
    #[diesel(sql_type = Double)]
    value: f64,
}

#[derive(QueryableByName)]
struct BookTextRow {
    #[diesel(sql_type = Integer)]
    book: i32,
    #[diesel(sql_type = SqlText)]
    value: String,
}

fn unsupported(column: &CustomColumn) -> CalibreError {
    CalibreError::UnsupportedCustomColumn(format!(
        "values of datatype '{}' (column '{}') are not supported",
        column.kind.datatype(),
        column.label
    ))
}

/// Read one book's value for a custom column. `None` means no value stored.
pub(crate) fn get_value(
    conn: &mut SqliteConnection,
    column: &CustomColumn,
    book_id: BookId,
) -> Result<Option<CustomValue>, CalibreError> {
    let n = column.id;
    match &column.kind {
        CustomColumnKind::Bool => {
            Ok(get_non_normalized_i64(conn, n, book_id)?.map(|v| CustomValue::Bool(v != 0)))
        }
        CustomColumnKind::Int => {
            Ok(get_non_normalized_i64(conn, n, book_id)?.map(CustomValue::Int))
        }
        CustomColumnKind::Float => {
            Ok(get_non_normalized_f64(conn, n, book_id)?.map(CustomValue::Float))
        }
        CustomColumnKind::Comments => {
            Ok(get_non_normalized_text(conn, n, book_id)?.map(CustomValue::Text))
        }
        CustomColumnKind::Datetime => match get_non_normalized_text(conn, n, book_id)? {
            None => Ok(None),
            Some(raw) => parse_calibre_datetime(&raw)
                .map(|dt| Some(CustomValue::Datetime(dt)))
                .ok_or_else(|| {
                    CalibreError::InvalidCustomValue(format!(
                        "could not parse datetime value '{raw}' in column '{}'",
                        column.label
                    ))
                }),
        },
        CustomColumnKind::Text if column.is_multiple => {
            let values = get_normalized_texts(conn, n, book_id)?;
            if values.is_empty() {
                Ok(None)
            } else {
                Ok(Some(CustomValue::TextMultiple(values)))
            }
        }
        CustomColumnKind::Text => Ok(get_normalized_texts(conn, n, book_id)?
            .into_iter()
            .next()
            .map(CustomValue::Text)),
        CustomColumnKind::Enumeration => Ok(get_normalized_texts(conn, n, book_id)?
            .into_iter()
            .next()
            .map(CustomValue::Enumeration)),
        _ => Err(unsupported(column)),
    }
}

/// Read one column's values for many books at once. Books with no value are
/// absent from the result.
pub(crate) fn batch_get_values(
    conn: &mut SqliteConnection,
    column: &CustomColumn,
    book_ids: &[BookId],
) -> Result<HashMap<BookId, CustomValue>, CalibreError> {
    if book_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let n = column.id;
    // Interpolating IDs is safe: BookId wraps an i32.
    let ids = book_ids
        .iter()
        .map(|book_id| book_id.as_i32().to_string())
        .collect::<Vec<_>>()
        .join(",");

    match &column.kind {
        CustomColumnKind::Bool | CustomColumnKind::Int => {
            let rows: Vec<BookI64Row> = sql_query(format!(
                "SELECT book, value FROM custom_column_{n} WHERE book IN ({ids})"
            ))
            .load(conn)
            .map_err(CalibreError::from)?;

            Ok(rows
                .into_iter()
                .map(|row| {
                    let value = if column.kind == CustomColumnKind::Bool {
                        CustomValue::Bool(row.value != 0)
                    } else {
                        CustomValue::Int(row.value)
                    };
                    (BookId(row.book), value)
                })
                .collect())
        }
        CustomColumnKind::Float => {
            let rows: Vec<BookF64Row> = sql_query(format!(
                "SELECT book, value FROM custom_column_{n} WHERE book IN ({ids})"
            ))
            .load(conn)
            .map_err(CalibreError::from)?;

            Ok(rows
                .into_iter()
                .map(|row| (BookId(row.book), CustomValue::Float(row.value)))
                .collect())
        }
        CustomColumnKind::Comments | CustomColumnKind::Datetime => {
            let rows: Vec<BookTextRow> = sql_query(format!(
                "SELECT book, value FROM custom_column_{n} WHERE book IN ({ids})"
            ))
            .load(conn)
            .map_err(CalibreError::from)?;

            let mut values = HashMap::new();
            for row in rows {
                let value = if column.kind == CustomColumnKind::Datetime {
                    let parsed = parse_calibre_datetime(&row.value).ok_or_else(|| {
                        CalibreError::InvalidCustomValue(format!(
                            "could not parse datetime value '{}' in column '{}'",
                            row.value, column.label
                        ))
                    })?;
                    CustomValue::Datetime(parsed)
                } else {
                    CustomValue::Text(row.value)
                };
                values.insert(BookId(row.book), value);
            }
            Ok(values)
        }
        CustomColumnKind::Text | CustomColumnKind::Enumeration => {
            let rows: Vec<BookTextRow> = sql_query(format!(
                "SELECT l.book AS book, cc.value AS value
                 FROM books_custom_column_{n}_link l
                 INNER JOIN custom_column_{n} cc ON cc.id = l.value
                 WHERE l.book IN ({ids})
                 ORDER BY l.book, l.id"
            ))
            .load(conn)
            .map_err(CalibreError::from)?;

            if column.kind == CustomColumnKind::Enumeration {
                Ok(rows
                    .into_iter()
                    .map(|row| (BookId(row.book), CustomValue::Enumeration(row.value)))
                    .collect())
            } else if column.is_multiple {
                let mut grouped: HashMap<BookId, Vec<String>> = HashMap::new();
                for row in rows {
                    grouped.entry(BookId(row.book)).or_default().push(row.value);
                }
                Ok(grouped
                    .into_iter()
                    .map(|(book_id, values)| (book_id, CustomValue::TextMultiple(values)))
                    .collect())
            } else {
                Ok(rows
                    .into_iter()
                    .map(|row| (BookId(row.book), CustomValue::Text(row.value)))
                    .collect())
            }
        }
        _ => Err(unsupported(column)),
    }
}

fn get_non_normalized_i64(
    conn: &mut SqliteConnection,
    n: i32,
    book_id: BookId,
) -> Result<Option<i64>, CalibreError> {
    sql_query(format!(
        "SELECT value FROM custom_column_{n} WHERE book = ?"
    ))
    .bind::<Integer, _>(book_id.as_i32())
    .get_result::<I64ValueRow>(conn)
    .optional()
    .map(|row| row.map(|r| r.value))
    .map_err(CalibreError::from)
}

fn get_non_normalized_f64(
    conn: &mut SqliteConnection,
    n: i32,
    book_id: BookId,
) -> Result<Option<f64>, CalibreError> {
    sql_query(format!(
        "SELECT value FROM custom_column_{n} WHERE book = ?"
    ))
    .bind::<Integer, _>(book_id.as_i32())
    .get_result::<F64ValueRow>(conn)
    .optional()
    .map(|row| row.map(|r| r.value))
    .map_err(CalibreError::from)
}

fn get_non_normalized_text(
    conn: &mut SqliteConnection,
    n: i32,
    book_id: BookId,
) -> Result<Option<String>, CalibreError> {
    sql_query(format!(
        "SELECT value FROM custom_column_{n} WHERE book = ?"
    ))
    .bind::<Integer, _>(book_id.as_i32())
    .get_result::<TextValueRow>(conn)
    .optional()
    .map(|row| row.map(|r| r.value))
    .map_err(CalibreError::from)
}

fn get_normalized_texts(
    conn: &mut SqliteConnection,
    n: i32,
    book_id: BookId,
) -> Result<Vec<String>, CalibreError> {
    sql_query(format!(
        "SELECT cc.value AS value
         FROM books_custom_column_{n}_link l
         INNER JOIN custom_column_{n} cc ON cc.id = l.value
         WHERE l.book = ?
         ORDER BY l.id"
    ))
    .bind::<Integer, _>(book_id.as_i32())
    .load::<TextValueRow>(conn)
    .map(|rows| rows.into_iter().map(|r| r.value).collect())
    .map_err(CalibreError::from)
}

// =============================================================================
// Value writes
// =============================================================================

/// Write (or clear, with `None`) one book's value for a custom column.
///
/// The value must match the column's datatype; mismatches return
/// `CalibreError::InvalidCustomValue`. Enumeration values are validated
/// against the column's `enum_values`; an empty enumeration string clears.
pub(crate) fn set_value(
    conn: &mut SqliteConnection,
    column: &CustomColumn,
    book_id: BookId,
    value: Option<CustomValue>,
) -> Result<(), CalibreError> {
    if !column.kind.supports_value_io() {
        return Err(unsupported(column));
    }

    let n = column.id;
    let Some(value) = value else {
        return clear_value(conn, column, book_id);
    };

    match (&column.kind, value) {
        (CustomColumnKind::Bool, CustomValue::Bool(b)) => {
            upsert_non_normalized_i64(conn, n, book_id, if b { 1 } else { 0 })
        }
        (CustomColumnKind::Int, CustomValue::Int(i)) => {
            upsert_non_normalized_i64(conn, n, book_id, i)
        }
        (CustomColumnKind::Float, CustomValue::Float(f)) => {
            upsert_non_normalized_f64(conn, n, book_id, f)
        }
        // Calibre never stores empty text values: an empty string clears.
        (CustomColumnKind::Comments, CustomValue::Text(s)) => {
            if s.is_empty() {
                clear_value(conn, column, book_id)
            } else {
                upsert_non_normalized_text(conn, n, book_id, &s)
            }
        }
        (CustomColumnKind::Datetime, CustomValue::Datetime(dt)) => {
            upsert_non_normalized_text(conn, n, book_id, &format_calibre_datetime(&dt))
        }
        (CustomColumnKind::Text, CustomValue::Text(s)) if !column.is_multiple => {
            if s.is_empty() {
                clear_value(conn, column, book_id)
            } else {
                set_normalized_values(conn, n, book_id, std::slice::from_ref(&s))
            }
        }
        (CustomColumnKind::Text, CustomValue::TextMultiple(values)) if column.is_multiple => {
            let values: Vec<String> = values.into_iter().filter(|v| !v.is_empty()).collect();
            if values.is_empty() {
                clear_value(conn, column, book_id)
            } else {
                set_normalized_values(conn, n, book_id, &values)
            }
        }
        (CustomColumnKind::Enumeration, CustomValue::Enumeration(s)) => {
            if s.is_empty() {
                return clear_value(conn, column, book_id);
            }
            if !column.enum_values.contains(&s) {
                return Err(CalibreError::InvalidCustomValue(format!(
                    "'{s}' is not an allowed value for enumeration column '{}' (allowed: {:?})",
                    column.label, column.enum_values
                )));
            }
            set_normalized_values(conn, n, book_id, std::slice::from_ref(&s))
        }
        (_, other) => Err(CalibreError::InvalidCustomValue(format!(
            "value of type {} does not match column '{}' with datatype '{}'{}",
            other.type_name(),
            column.label,
            column.kind.datatype(),
            if column.is_multiple {
                " (is_multiple)"
            } else {
                ""
            }
        ))),
    }
}

fn clear_value(
    conn: &mut SqliteConnection,
    column: &CustomColumn,
    book_id: BookId,
) -> Result<(), CalibreError> {
    let n = column.id;
    if matches!(
        column.kind,
        CustomColumnKind::Text | CustomColumnKind::Enumeration
    ) {
        conn.transaction::<_, CalibreError, _>(|conn| {
            delete_links(conn, n, book_id)?;
            prune_orphaned_values(conn, n)
        })
    } else {
        sql_query(format!("DELETE FROM custom_column_{n} WHERE book = ?"))
            .bind::<Integer, _>(book_id.as_i32())
            .execute(conn)
            .map(|_| ())
            .map_err(CalibreError::from)
    }
}

fn upsert_non_normalized_i64(
    conn: &mut SqliteConnection,
    n: i32,
    book_id: BookId,
    value: i64,
) -> Result<(), CalibreError> {
    sql_query(format!(
        "INSERT OR REPLACE INTO custom_column_{n} (book, value) VALUES (?, ?)"
    ))
    .bind::<Integer, _>(book_id.as_i32())
    .bind::<BigInt, _>(value)
    .execute(conn)
    .map(|_| ())
    .map_err(CalibreError::from)
}

fn upsert_non_normalized_f64(
    conn: &mut SqliteConnection,
    n: i32,
    book_id: BookId,
    value: f64,
) -> Result<(), CalibreError> {
    sql_query(format!(
        "INSERT OR REPLACE INTO custom_column_{n} (book, value) VALUES (?, ?)"
    ))
    .bind::<Integer, _>(book_id.as_i32())
    .bind::<Double, _>(value)
    .execute(conn)
    .map(|_| ())
    .map_err(CalibreError::from)
}

fn upsert_non_normalized_text(
    conn: &mut SqliteConnection,
    n: i32,
    book_id: BookId,
    value: &str,
) -> Result<(), CalibreError> {
    sql_query(format!(
        "INSERT OR REPLACE INTO custom_column_{n} (book, value) VALUES (?, ?)"
    ))
    .bind::<Integer, _>(book_id.as_i32())
    .bind::<SqlText, _>(value)
    .execute(conn)
    .map(|_| ())
    .map_err(CalibreError::from)
}

/// Replace the book's links for a normalized column with the given values,
/// creating value rows as needed (case-insensitive match, mirroring the
/// `COLLATE NOCASE` UNIQUE constraint) and pruning orphaned value rows.
fn set_normalized_values(
    conn: &mut SqliteConnection,
    n: i32,
    book_id: BookId,
    values: &[String],
) -> Result<(), CalibreError> {
    conn.transaction::<_, CalibreError, _>(|conn| {
        delete_links(conn, n, book_id)?;

        for value in values {
            let existing = sql_query(format!(
                "SELECT id FROM custom_column_{n} WHERE value = ? COLLATE NOCASE LIMIT 1"
            ))
            .bind::<SqlText, _>(value)
            .get_result::<IdRow>(conn)
            .optional()
            .map_err(CalibreError::from)?;

            let value_id = match existing {
                Some(row) => row.id,
                // Older Calibre value tables lack the `link` column, so only
                // mention `value` here.
                None => {
                    sql_query(format!(
                        "INSERT INTO custom_column_{n} (value) VALUES (?) RETURNING id"
                    ))
                    .bind::<SqlText, _>(value)
                    .get_result::<IdRow>(conn)
                    .map_err(CalibreError::from)?
                    .id
                }
            };

            // OR IGNORE: duplicate input values (incl. case-insensitive
            // duplicates) map to the same value row.
            sql_query(format!(
                "INSERT OR IGNORE INTO books_custom_column_{n}_link (book, value) VALUES (?, ?)"
            ))
            .bind::<Integer, _>(book_id.as_i32())
            .bind::<Integer, _>(value_id)
            .execute(conn)
            .map_err(CalibreError::from)?;
        }

        prune_orphaned_values(conn, n)
    })
}

fn delete_links(conn: &mut SqliteConnection, n: i32, book_id: BookId) -> Result<(), CalibreError> {
    sql_query(format!(
        "DELETE FROM books_custom_column_{n}_link WHERE book = ?"
    ))
    .bind::<Integer, _>(book_id.as_i32())
    .execute(conn)
    .map(|_| ())
    .map_err(CalibreError::from)
}

fn prune_orphaned_values(conn: &mut SqliteConnection, n: i32) -> Result<(), CalibreError> {
    sql_query(format!(
        "DELETE FROM custom_column_{n} WHERE id NOT IN \
         (SELECT DISTINCT value FROM books_custom_column_{n}_link)"
    ))
    .execute(conn)
    .map(|_| ())
    .map_err(CalibreError::from)
}

// =============================================================================
// Datetime handling
// =============================================================================

/// Format a datetime the way Calibre stores them: `2024-01-15 10:30:00+00:00`.
fn format_calibre_datetime(dt: &DateTime<Utc>) -> String {
    dt.format("%Y-%m-%d %H:%M:%S%:z").to_string()
}

/// Parse the ISO-ish datetime strings Calibre writes. Lenient: accepts space
/// or `T` separators, optional fractional seconds, optional UTC offset
/// (naive values are assumed UTC), and bare dates.
fn parse_calibre_datetime(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();

    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }

    for format in [
        "%Y-%m-%d %H:%M:%S%.f%:z",
        "%Y-%m-%dT%H:%M:%S%.f%:z",
        "%Y-%m-%d %H:%M:%S%:z",
        "%Y-%m-%d %H:%M:%S%z",
    ] {
        if let Ok(dt) = DateTime::parse_from_str(raw, format) {
            return Some(dt.with_timezone(&Utc));
        }
    }

    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, format) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }

    if let Ok(date) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return Some(Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0)?));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_calibre_datetime_variants() {
        let expected = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
        for raw in [
            "2024-01-15 10:30:00+00:00",
            "2024-01-15T10:30:00+00:00",
            "2024-01-15 10:30:00",
            "2024-01-15T10:30:00",
            "2024-01-15 11:30:00+01:00",
        ] {
            assert_eq!(parse_calibre_datetime(raw), Some(expected), "raw: {raw}");
        }

        assert_eq!(
            parse_calibre_datetime("2024-01-15 10:30:00.123456+00:00"),
            Some(
                Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap()
                    + chrono::Duration::microseconds(123456)
            )
        );

        assert_eq!(
            parse_calibre_datetime("2024-01-15"),
            Some(Utc.with_ymd_and_hms(2024, 1, 15, 0, 0, 0).unwrap())
        );

        assert_eq!(parse_calibre_datetime("not a date"), None);
    }

    #[test]
    fn formats_calibre_datetime() {
        let dt = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
        assert_eq!(format_calibre_datetime(&dt), "2024-01-15 10:30:00+00:00");
    }

    #[test]
    fn validates_labels() {
        assert!(is_valid_label("read"));
        assert!(is_valid_label("a1_b2"));
        assert!(!is_valid_label(""));
        assert!(!is_valid_label("1read"));
        assert!(!is_valid_label("_read"));
        assert!(!is_valid_label("Read"));
        assert!(!is_valid_label("re-ad"));
        assert!(!is_valid_label("re ad"));
    }
}
