use diesel::prelude::*;
use diesel::query_builder::AsChangeset;

use crate::schema::authors;
use crate::sorting;

#[derive(Clone, Debug, Queryable, Selectable, Identifiable, AsChangeset)]
#[diesel(table_name = authors)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct Author {
    pub id: i32,
    pub name: String,
    pub sort: Option<String>,
    pub link: String,
}
impl Author {
    /// Generate a sortable name for this author.
    pub fn sortable_name(&self) -> String {
        sorting::sort_author_name_apa(&self.name)
    }
}

#[derive(Insertable)]
#[diesel(table_name = authors)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct NewAuthor {
    pub name: String,
    pub sort: Option<String>,
    pub link: Option<String>,
}

#[derive(AsChangeset, Default, Debug)]
#[diesel(table_name = authors)]
pub struct UpdateAuthorData {
    pub(crate) name: Option<String>,
    pub(crate) sort: Option<String>,
    pub(crate) link: Option<String>,
}
