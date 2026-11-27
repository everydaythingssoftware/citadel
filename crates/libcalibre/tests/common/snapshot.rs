use regex::Regex;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

/// A complete snapshot of a SQLite database including schema and all data.
#[derive(Debug, Serialize, PartialEq)]
pub struct DatabaseSnapshot {
    /// Database schema for all tables
    pub schema: Vec<TableSchema>,
    /// All data from all tables (table_name -> rows)
    /// Using BTreeMap for deterministic ordering
    pub data: BTreeMap<String, Vec<Row>>,
}

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub primary_key: bool,
}

/// A database row represented as column_name -> value
pub type Row = BTreeMap<String, SqlValue>;

#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(untagged)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl DatabaseSnapshot {
    /// Capture a complete snapshot of the database at the given path
    pub fn capture(db_path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(db_path)?;

        let tables = Self::get_all_tables(&conn)?;

        let mut schema = Vec::new();
        let mut data = BTreeMap::new();

        for table_name in tables {
            let table_schema = Self::get_table_schema(&conn, &table_name)?;
            let table_data = Self::dump_table_data(&conn, &table_name)?;

            schema.push(table_schema);
            data.insert(table_name, table_data);
        }

        schema.sort_by(|a, b| a.name.cmp(&b.name));

        Ok(Self { schema, data })
    }

    /// Normalize the snapshot to remove non-deterministic values (timestamps, UUIDs, etc.)
    pub fn normalize(mut self) -> Self {
        // Patterns for values to normalize
        let uuid_pattern =
            Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap();
        let timestamp_pattern = Regex::new(r"^\d{4}-\d{2}-\d{2}").unwrap();

        for rows in self.data.values_mut() {
            for row in rows.iter_mut() {
                for (col_name, value) in row.iter_mut() {
                    let col_lower = col_name.to_lowercase();

                    // Normalize UUIDs
                    if col_lower.contains("uuid") {
                        if let SqlValue::Text(ref s) = value {
                            if uuid_pattern.is_match(s) {
                                *value = SqlValue::Text("<UUID>".to_string());
                            }
                        }
                    }

                    // Normalize timestamps
                    if col_lower.contains("timestamp")
                        || col_lower.contains("last_modified")
                        || col_lower.contains("pubdate")
                        || col_lower.contains("date")
                    {
                        if let SqlValue::Text(ref s) = value {
                            if timestamp_pattern.is_match(s) {
                                *value = SqlValue::Text("<TIMESTAMP>".to_string());
                            }
                        }
                    }

                    // Normalize floating point timestamps
                    if (col_lower == "timestamp"
                        || col_lower == "last_modified"
                        || col_lower == "pubdate")
                        && matches!(value, SqlValue::Real(_))
                    {
                        *value = SqlValue::Text("<TIMESTAMP>".to_string());
                    }
                }
            }

            // Sort rows by first column for deterministic ordering
            rows.sort_by(|a, b| {
                // Try to sort by 'id' column if it exists
                match (a.get("id"), b.get("id")) {
                    (Some(SqlValue::Integer(a_id)), Some(SqlValue::Integer(b_id))) => {
                        a_id.cmp(b_id)
                    }
                    _ => std::cmp::Ordering::Equal,
                }
            });
        }

        self
    }

    /// Get all non-system table names from the database
    fn get_all_tables(conn: &Connection) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master
             WHERE type='table'
             AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )?;

        let tables = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;

        Ok(tables)
    }

    /// Get schema information for a table
    fn get_table_schema(
        conn: &Connection,
        table_name: &str,
    ) -> Result<TableSchema, rusqlite::Error> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table_name))?;

        let columns = stmt
            .query_map([], |row| {
                Ok(ColumnInfo {
                    name: row.get(1)?,
                    type_name: row.get(2)?,
                    nullable: row.get::<_, i32>(3)? == 0,
                    primary_key: row.get::<_, i32>(5)? > 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(TableSchema {
            name: table_name.to_string(),
            columns,
        })
    }

    /// Dump all data from a table
    fn dump_table_data(conn: &Connection, table_name: &str) -> Result<Vec<Row>, rusqlite::Error> {
        let mut stmt = conn.prepare(&format!("SELECT * FROM {}", table_name))?;

        let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

        let rows = stmt
            .query_map([], |row| {
                let mut map = BTreeMap::new();
                for (i, col_name) in column_names.iter().enumerate() {
                    let value = Self::extract_value(row, i)?;
                    map.insert(col_name.clone(), value);
                }
                Ok(map)
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// Extract a value from a SQLite row
    fn extract_value(row: &rusqlite::Row, index: usize) -> Result<SqlValue, rusqlite::Error> {
        use rusqlite::types::ValueRef;

        match row.get_ref(index)? {
            ValueRef::Null => Ok(SqlValue::Null),
            ValueRef::Integer(i) => Ok(SqlValue::Integer(i)),
            ValueRef::Real(f) => Ok(SqlValue::Real(f)),
            ValueRef::Text(s) => {
                let text = std::str::from_utf8(s).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        index,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(SqlValue::Text(text.to_string()))
            }
            ValueRef::Blob(b) => Ok(SqlValue::Blob(b.to_vec())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capture_empty_database() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("test.db");

        // Create an empty database
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)",
            [],
        )
        .unwrap();
        drop(conn);

        let snapshot = DatabaseSnapshot::capture(&db_path).unwrap();

        assert_eq!(snapshot.schema.len(), 1);
        assert_eq!(snapshot.schema[0].name, "test_table");
        assert_eq!(snapshot.data.get("test_table").unwrap().len(), 0);
    }

    #[test]
    fn test_normalize_uuids() {
        let mut snapshot = DatabaseSnapshot {
            schema: vec![],
            data: {
                let mut data = BTreeMap::new();
                let mut row = BTreeMap::new();
                row.insert(
                    "uuid".to_string(),
                    SqlValue::Text("550e8400-e29b-41d4-a716-446655440000".to_string()),
                );
                data.insert("books".to_string(), vec![row]);
                data
            },
        };

        snapshot = snapshot.normalize();

        let books_data = snapshot.data.get("books").unwrap();
        assert_eq!(
            books_data[0].get("uuid"),
            Some(&SqlValue::Text("<UUID>".to_string()))
        );
    }
}
