//! The compiler of the search language: it changes a search expression into
//! SQL with bound values.

use super::parser::{Expr, Field, Matcher, Term, TextMatch};
use super::SearchScope;
use crate::queries::books::{like_pattern, SqlFragment};

/// The place that a field takes its values from.
enum Source {
    /// A text column of the outer table `books`.
    Column(&'static str),
    /// A value table that a correlated subquery reads.
    Subquery {
        /// The `FROM` clause, with the alias `v` for the value table.
        from: &'static str,
        /// The condition that ties the subquery to the outer table `books`.
        book: &'static str,
        /// The column that holds the value.
        column: &'static str,
        /// The condition on a row that counts as a value, or `None` when
        /// each row counts.
        present: Option<&'static str>,
    },
    /// The table `identifiers`, with a type and a value on each row.
    Identifiers,
}

/// The fields that a bare word searches in the `TitlesAuthorsSeries` scope.
const DEFAULT_BARE_FIELDS: [Field; 3] = [Field::Title, Field::Authors, Field::Series];

/// The fields that a bare word searches in the `AllFields` scope.
/// The identifiers field compares the value only.
const ALL_BARE_FIELDS: [Field; 6] = [
    Field::Title,
    Field::Authors,
    Field::Series,
    Field::Tags,
    Field::Publisher,
    Field::Identifiers,
];

/// Find the place that a field takes its values from.
fn source(field: Field) -> Source {
    let linked = |from, column| Source::Subquery {
        from,
        book: "l.book = books.id",
        column,
        present: None,
    };
    let owned = |from, column, present| Source::Subquery {
        from,
        book: "v.book = books.id",
        column,
        present,
    };
    match field {
        Field::Title => Source::Column("books.title"),
        Field::Identifiers => Source::Identifiers,
        Field::Authors => linked(
            "books_authors_link l JOIN authors v ON v.id = l.author",
            "v.name",
        ),
        Field::Series => linked(
            "books_series_link l JOIN series v ON v.id = l.series",
            "v.name",
        ),
        Field::Tags => linked("books_tags_link l JOIN tags v ON v.id = l.tag", "v.name"),
        Field::Publisher => linked(
            "books_publishers_link l JOIN publishers v ON v.id = l.publisher",
            "v.name",
        ),
        Field::Comments => owned("comments v", "v.text", Some("TRIM(v.text) <> ''")),
        Field::Formats => owned("data v", "v.format", None),
        Field::Languages => linked(
            "books_languages_link l JOIN languages v ON v.id = l.lang_code",
            "v.lang_code",
        ),
    }
}

/// Write the comparison of a column with a text. The value goes into the
/// binds.
fn compare(column: &str, text: &TextMatch) -> SqlFragment {
    match text {
        TextMatch::Contains(value) => SqlFragment::new(
            format!("{column} LIKE ? ESCAPE '\\'"),
            vec![like_pattern(value)],
        ),
        TextMatch::Equals(value) => {
            SqlFragment::new(format!("{column} = ? COLLATE NOCASE"), vec![value.clone()])
        }
    }
}

/// Write an `EXISTS` or `NOT EXISTS` test on a subquery. A `None` condition
/// means any row.
fn exists(from: &str, book: &str, condition: Option<SqlFragment>, present: bool) -> SqlFragment {
    let negation = if present { "" } else { "NOT " };
    let start = format!("{negation}EXISTS (SELECT 1 FROM {from} WHERE {book}");
    match condition {
        Some(condition) => condition.wrap(&format!("{start} AND "), ")"),
        None => SqlFragment::plain(format!("{start})")),
    }
}

/// Write the SQL of one condition on one field.
fn field_sql(field: Field, matcher: &Matcher) -> SqlFragment {
    match source(field) {
        Source::Column(column) => match matcher {
            Matcher::Text(text) => compare(column, text),
            Matcher::Present => SqlFragment::plain(format!("{column} <> ''")),
            Matcher::Absent => SqlFragment::plain(format!("{column} = ''")),
        },
        Source::Subquery {
            from,
            book,
            column,
            present,
        } => match matcher {
            Matcher::Text(text) => exists(from, book, Some(compare(column, text)), true),
            Matcher::Present => exists(from, book, present.map(SqlFragment::plain), true),
            Matcher::Absent => exists(from, book, present.map(SqlFragment::plain), false),
        },
        Source::Identifiers => identifier_sql(None, matcher),
    }
}

/// Write the SQL of one condition on the identifiers of the book. The type
/// and the value apply to the same identifier row.
fn identifier_sql(kind: Option<&TextMatch>, value: &Matcher) -> SqlFragment {
    let mut conditions = Vec::new();
    if let Some(kind) = kind {
        conditions.push(compare("v.type", kind));
    }
    let present = match value {
        Matcher::Text(text) => {
            conditions.push(compare("v.val", text));
            true
        }
        Matcher::Present => true,
        Matcher::Absent => false,
    };
    let condition = (!conditions.is_empty()).then(|| SqlFragment::join(conditions, " AND "));
    exists("identifiers v", "v.book = books.id", condition, present)
}

/// Write the SQL of a bare term: an `OR` of the bare-word fields of the
/// scope.
fn bare_sql(text: &TextMatch, scope: SearchScope) -> SqlFragment {
    let matcher = Matcher::Text(text.clone());
    let fields: &[Field] = match scope {
        SearchScope::TitlesAuthorsSeries => &DEFAULT_BARE_FIELDS,
        SearchScope::AllFields => &ALL_BARE_FIELDS,
    };
    SqlFragment::join(
        fields.iter().map(|field| field_sql(*field, &matcher)),
        " OR ",
    )
    .wrap("(", ")")
}

/// Write the SQL of one term.
fn term_sql(term: &Term, scope: SearchScope) -> SqlFragment {
    match term {
        Term::Bare(text) => bare_sql(text, scope),
        Term::Field { field, matcher } => field_sql(*field, matcher),
        Term::Identifier { kind, value } => identifier_sql(kind.as_ref(), value),
    }
}

/// Compile a search expression to a `WHERE` condition on the outer table
/// `books`.
///
/// A bare word searches `DEFAULT_BARE_FIELDS` in the `TitlesAuthorsSeries`
/// scope, or `ALL_BARE_FIELDS` in the `AllFields` scope. A field prefix works
/// the same in both scopes. Each value from the user goes into a `?`
/// placeholder.
pub(crate) fn to_sql(expr: &Expr, scope: SearchScope) -> SqlFragment {
    match expr {
        Expr::And(operands) => join_operands(operands, " AND ", scope),
        Expr::Or(operands) => join_operands(operands, " OR ", scope),
        Expr::Not(operand) => to_sql(operand, scope).wrap("NOT (", ")"),
        Expr::Term(term) => term_sql(term, scope),
    }
}

/// Write each operand in parentheses and join them with an operator.
/// [`Expr::all`] and [`Expr::any`] give two or more operands.
fn join_operands(operands: &[Expr], operator: &str, scope: SearchScope) -> SqlFragment {
    debug_assert!(
        operands.len() >= 2,
        "an And or an Or needs two or more operands"
    );
    SqlFragment::join(
        operands
            .iter()
            .map(|operand| to_sql(operand, scope).wrap("(", ")")),
        operator,
    )
}

#[cfg(test)]
mod tests {
    use super::{to_sql, Expr, Term, TextMatch};
    use crate::queries::books::SqlFragment;
    use crate::search::{compile, SearchScope};

    fn fragment(text: &str, scope: SearchScope) -> SqlFragment {
        compile(text, scope).unwrap().unwrap().fragment
    }

    fn scope(all_fields: bool) -> SearchScope {
        if all_fields {
            SearchScope::AllFields
        } else {
            SearchScope::TitlesAuthorsSeries
        }
    }

    #[test]
    fn bind_counts_follow_the_terms() {
        let default = SearchScope::TitlesAuthorsSeries;
        let all = SearchScope::AllFields;
        assert_eq!(fragment("x", default).binds(), vec!["%x%"; 3]);
        assert_eq!(fragment("x", all).binds(), vec!["%x%"; 6]);
        assert_eq!(fragment("x or y", default).binds().len(), 6);
        assert_eq!(fragment("x or y", all).binds().len(), 12);
        for scope in [default, all] {
            assert_eq!(fragment("tags:x", scope).binds(), ["%x%"]);
            assert_eq!(fragment("tags:=x", scope).binds(), ["x"]);
            assert!(fragment("tags:true", scope).binds().is_empty());
            assert_eq!(
                fragment("identifiers:=isbn:=1", scope).binds(),
                ["isbn", "1"]
            );
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "two or more operands")]
    fn an_and_of_one_operand_is_a_defect() {
        let one = vec![Expr::Term(Term::Bare(TextMatch::Contains("a".into())))];
        to_sql(&Expr::And(one), SearchScope::TitlesAuthorsSeries);
    }

    #[test]
    fn values_never_enter_sql() {
        let fragment = fragment("title:o'brien", SearchScope::TitlesAuthorsSeries);
        assert!(!fragment.sql().contains("brien"));
        assert_eq!(fragment.binds(), ["%o'brien%"]);
    }

    #[test]
    fn an_identifier_type_and_value_share_one_subquery() {
        let fragment = fragment("isbn:1", SearchScope::TitlesAuthorsSeries);
        assert_eq!(fragment.sql().matches("EXISTS").count(), 1);
        assert_eq!(fragment.binds(), ["isbn", "%1%"]);
    }

    proptest::proptest! {
        #[test]
        fn compiled_binds_match_placeholders(text in "\\PC{0,80}", all_fields in proptest::bool::ANY) {
            if let Ok(Some(compiled)) = compile(&text, scope(all_fields)) {
                proptest::prop_assert_eq!(compiled.fragment.sql().matches('?').count(), compiled.fragment.binds().len());
            }
        }

        #[test]
        fn syntax_heavy_text_never_panics(parts in proptest::collection::vec(proptest::prop_oneof![
            proptest::strategy::Just("tags:".to_string()), proptest::strategy::Just("\"".to_string()),
            proptest::strategy::Just("(".to_string()), proptest::strategy::Just(")".to_string()),
            proptest::strategy::Just(" or ".to_string()), proptest::strategy::Just("not ".to_string()),
            proptest::strategy::Just("=".to_string()), proptest::strategy::Just("\\".to_string()),
            proptest::strategy::Just("identifiers:".to_string()), "[a-zé:]{1,5}",
        ], 0..20), all_fields in proptest::bool::ANY) {
            let text = parts.concat();
            if let Ok(Some(compiled)) = compile(&text, scope(all_fields)) {
                proptest::prop_assert_eq!(compiled.fragment.sql().matches('?').count(), compiled.fragment.binds().len());
            }
        }
    }
}
