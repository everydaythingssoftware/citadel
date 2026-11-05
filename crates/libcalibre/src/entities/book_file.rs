use diesel::prelude::*;
use diesel::query_builder::AsChangeset;

use crate::mime_type::MimeType;
use crate::schema::data;

#[derive(Clone, Debug, Queryable, Selectable, Identifiable, AsChangeset)]
#[diesel(table_name = data)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct BookFile {
    pub id: i32,
    pub book: i32,
    pub format: String,
    pub uncompressed_size: i32,
    pub name: String,
}

impl BookFile {
    pub fn as_filename(&self) -> String {
        let mimetype = MimeType::from_file_extension(&self.format).unwrap_or(MimeType::UNKNOWN);
        let ext = mimetype.to_file_extension();

        if ext.is_empty() {
            format!("{}", self.name)
        } else {
            format!("{}.{}", self.name, ext)
        }
    }
}

#[derive(Insertable)]
#[diesel(table_name = data)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct NewBookFile {
    pub book: i32,
    pub format: String,
    pub uncompressed_size: i32,
    pub name: String,
}

#[derive(AsChangeset, Default, Debug)]
#[diesel(table_name = data)]
pub struct UpdateBookFile {
    pub(crate) book: Option<i32>,
    pub(crate) format: Option<String>,
    pub(crate) uncompressed_size: Option<i32>,
    pub(crate) name: Option<String>,
}
