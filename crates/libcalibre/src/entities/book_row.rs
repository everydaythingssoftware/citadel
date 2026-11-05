use chrono::NaiveDateTime;
use diesel::prelude::*;

use crate::schema::books;

#[derive(Clone, Debug, Queryable, Selectable, Identifiable, AsChangeset)]
#[diesel(table_name = books)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct BookRow {
    pub id: i32,
    pub uuid: Option<String>,
    pub title: String,
    pub sort: Option<String>,
    pub timestamp: Option<NaiveDateTime>,
    pub pubdate: Option<NaiveDateTime>,
    pub series_index: f32,
    pub author_sort: Option<String>,
    pub path: String,
    pub has_cover: Option<bool>,
    pub last_modified: NaiveDateTime,
}

#[derive(Insertable)]
#[diesel(table_name = books)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct NewBook {
    pub title: String,
    pub timestamp: Option<NaiveDateTime>,
    pub pubdate: Option<NaiveDateTime>,
    pub series_index: f32,
    pub has_cover: Option<bool>,
}

#[derive(AsChangeset, Default, Debug)]
#[diesel(table_name = books)]
pub struct UpdateBookData {
    pub author_sort: Option<String>,
    pub title: Option<String>,
    pub timestamp: Option<NaiveDateTime>,
    pub pubdate: Option<NaiveDateTime>,
    pub series_index: Option<f32>,
    pub path: Option<String>,
    pub has_cover: Option<bool>,
}
