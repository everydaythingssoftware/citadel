//! Time libcalibre's query paths against an existing Calibre library.
//!
//! Runs each scenario several times after warmup and prints a markdown table
//! of min/median/max wall-clock milliseconds, then dumps EXPLAIN QUERY PLAN
//! output and the schema's index inventory for the hot queries.
//!
//! Usage:
//!
//! ```sh
//! cargo run --release -p libcalibre --example bench_library_queries -- \
//!     --library /path/to/library [--runs 7] [--warmup 2] [--expect-total 5000]
//! ```
//!
//! Caveat: the real app's Authors/Books pages additionally stat one cover
//! file per book in src-tauri (book_cover_image); that filesystem cost is
//! outside libcalibre and is NOT measured here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use diesel::sql_types::{BigInt, Integer, Text};
use diesel::sqlite::Sqlite;
use diesel::{sql_query, RunQueryDsl, SqliteConnection};

use libcalibre::__internals::establish_connection;
use libcalibre::{
    AuthorId, BookQuery, BookSortOrder, CalibreError, CustomColumnKind, Library, SearchScope,
};

const PAGE_SIZE: i64 = 100;

struct Args {
    library: PathBuf,
    runs: usize,
    warmup: usize,
    expect_total: Option<u64>,
}

fn parse_args() -> Result<Args, String> {
    let mut library: Option<PathBuf> = None;
    let mut runs = 7;
    let mut warmup = 2;
    let mut expect_total = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--library" => {
                let value = args.next().ok_or("--library requires a path")?;
                library = Some(PathBuf::from(value));
            }
            "--runs" => {
                let value = args.next().ok_or("--runs requires a number")?;
                runs = value.parse().map_err(|_| "invalid --runs")?;
            }
            "--warmup" => {
                let value = args.next().ok_or("--warmup requires a number")?;
                warmup = value.parse().map_err(|_| "invalid --warmup")?;
            }
            "--expect-total" => {
                let value = args.next().ok_or("--expect-total requires a number")?;
                expect_total = Some(value.parse().map_err(|_| "invalid --expect-total")?);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        library: library.ok_or("--library <path> is required")?,
        runs: runs.max(1),
        warmup,
        expect_total,
    })
}

// =============================================================================
// Timing helpers
// =============================================================================

/// A query that the benchmark times.
struct Scenario {
    /// The name of the query in the report.
    name: String,
    /// The query.
    query: BookQuery,
    /// True when the query must find one or more books.
    must_find: bool,
}

/// A query whose plan the benchmark prints.
struct Plan {
    /// The name of the plan in the report.
    label: &'static str,
    /// The query.
    query: BookQuery,
    /// True when the plan must use a correlated subquery for a linked field.
    linked: bool,
}

struct Measurement {
    name: String,
    /// Sorted run times in milliseconds.
    times_ms: Vec<f64>,
    /// Result-size note printed alongside the scenario (e.g. rows returned).
    note: String,
}

impl Measurement {
    fn min(&self) -> f64 {
        *self.times_ms.first().unwrap_or(&0.0)
    }
    fn median(&self) -> f64 {
        let n = self.times_ms.len();
        if n == 0 {
            return 0.0;
        }
        if n % 2 == 1 {
            self.times_ms[n / 2]
        } else {
            (self.times_ms[n / 2 - 1] + self.times_ms[n / 2]) / 2.0
        }
    }
    fn max(&self) -> f64 {
        *self.times_ms.last().unwrap_or(&0.0)
    }
}

fn bench<F>(name: &str, runs: usize, warmup: usize, mut scenario: F) -> Measurement
where
    F: FnMut() -> String,
{
    let mut note = String::new();
    for _ in 0..warmup {
        note = scenario();
    }
    let mut times_ms = Vec::with_capacity(runs);
    for _ in 0..runs {
        let start = Instant::now();
        note = scenario();
        times_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    times_ms.sort_by(|a, b| a.partial_cmp(b).expect("non-NaN timing"));
    Measurement {
        name: name.to_string(),
        times_ms,
        note,
    }
}

// =============================================================================
// Raw-SQL helpers (token/author/series discovery, EXPLAIN, index listing)
// =============================================================================

#[derive(diesel::QueryableByName)]
struct TitleRow {
    #[diesel(sql_type = Text)]
    title: String,
}

#[derive(diesel::QueryableByName)]
struct NameRow {
    #[diesel(sql_type = Text)]
    name: String,
}

#[derive(diesel::QueryableByName)]
struct CountRow {
    #[diesel(sql_type = BigInt)]
    c: i64,
}

#[derive(diesel::QueryableByName)]
struct IdCountRow {
    #[diesel(sql_type = Integer)]
    id: i32,
    #[diesel(sql_type = BigInt)]
    c: i64,
}

#[derive(diesel::QueryableByName)]
struct ExplainRow {
    #[diesel(sql_type = Integer)]
    #[allow(dead_code)]
    id: i32,
    #[diesel(sql_type = Integer)]
    #[allow(dead_code)]
    parent: i32,
    #[diesel(sql_type = Integer)]
    #[allow(dead_code)]
    notused: i32,
    #[diesel(sql_type = Text)]
    detail: String,
}

#[derive(diesel::QueryableByName)]
struct IndexRow {
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Text)]
    tbl_name: String,
    #[diesel(sql_type = Text)]
    sql: String,
}

/// The search term `tags:"NAME"`. A backslash or a quote in the name has an
/// escape, by the rule of `Token::Quoted` in `src/search/lexer.rs`. The first
/// character always has an escape, so that a name such as `true` or `=x`
/// cannot select a search kind.
fn tag_term(name: &str) -> String {
    let mut term = String::from("tags:\"");
    for (index, ch) in name.chars().enumerate() {
        if index == 0 || matches!(ch, '\\' | '"') {
            term.push('\\');
        }
        term.push(ch);
    }
    term.push('"');
    term
}

/// The words that the search language reads as operators.
const OPERATOR_WORDS: [&str; 3] = ["and", "or", "not"];

/// Most/least frequent title tokens. Used to pick a "common" and a "rare"
/// search needle without hardcoding the generator's vocabulary. A token is in
/// ASCII lower case, because SQLite LIKE folds only ASCII letters.
fn pick_search_tokens(conn: &mut SqliteConnection) -> Result<(String, String), String> {
    let titles: Vec<TitleRow> = sql_query("SELECT title FROM books")
        .load(conn)
        .map_err(|e| format!("title query failed: {e}"))?;

    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in &titles {
        for token in row
            .title
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.len() >= 3)
            .map(str::to_ascii_lowercase)
            .filter(|t| !OPERATOR_WORDS.contains(&t.as_str()))
        {
            *counts.entry(token).or_default() += 1;
        }
    }

    let no_token = "no title has a word of three or more letters";
    let common = counts
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
        .map(|(token, _)| token.clone())
        .ok_or(no_token)?;
    let rare = counts
        .iter()
        .min_by(|a, b| a.1.cmp(b.1).then(a.0.cmp(b.0)))
        .map(|(token, _)| token.clone())
        .ok_or(no_token)?;

    println!(
        "Search needles: common='{common}' ({} title hits), rare='{rare}' ({} title hits)",
        counts.get(&common).copied().unwrap_or(0),
        counts.get(&rare).copied().unwrap_or(0)
    );
    Ok((common, rare))
}

/// The most linked value of a link table, with its book count. `None` when
/// the table has no rows.
fn most_linked(
    conn: &mut SqliteConnection,
    link_table: &str,
    column: &str,
) -> Result<Option<(i32, i64)>, String> {
    let rows: Vec<IdCountRow> = sql_query(format!(
        "SELECT {column} AS id, COUNT(*) AS c FROM {link_table} \
         GROUP BY {column} ORDER BY c DESC, id ASC LIMIT 1"
    ))
    .load(conn)
    .map_err(|e| format!("{link_table} query failed: {e}"))?;
    Ok(rows.first().map(|row| (row.id, row.c)))
}

/// The name of the tag `id`.
fn tag_name(conn: &mut SqliteConnection, id: i32) -> Result<String, String> {
    let rows: Vec<NameRow> = sql_query(format!("SELECT name FROM tags WHERE id = {id}"))
        .load(conn)
        .map_err(|e| format!("tag lookup failed: {e}"))?;
    rows.first()
        .map(|row| row.name.clone())
        .ok_or_else(|| "most linked tag has no name".to_string())
}

/// The number of books whose title, author names or series name contain a
/// literal `%`. It uses `instr`, so that the count does not depend on LIKE.
fn count_literal_percent(conn: &mut SqliteConnection) -> Result<u64, String> {
    let rows: Vec<CountRow> = sql_query(
        "SELECT COUNT(*) AS c FROM books WHERE instr(books.title, '%') > 0 \
         OR EXISTS (SELECT 1 FROM books_authors_link l JOIN authors a ON a.id = l.author \
                    WHERE l.book = books.id AND instr(a.name, '%') > 0) \
         OR EXISTS (SELECT 1 FROM books_series_link l JOIN series s ON s.id = l.series \
                    WHERE l.book = books.id AND instr(s.name, '%') > 0)",
    )
    .load(conn)
    .map_err(|e| format!("percent count failed: {e}"))?;
    rows.first()
        .map(|row| u64::try_from(row.c).unwrap_or(0))
        .ok_or_else(|| "percent count returned no row".to_string())
}

/// Print the plan of the SQL that `page_sql` or `count_sql` gives. An error
/// is a failure of the benchmark.
fn explain_query(
    conn: &mut SqliteConnection,
    label: &str,
    sql: Result<(String, Vec<String>), CalibreError>,
) -> Result<Vec<String>, String> {
    let (sql, binds) = sql.map_err(|e| format!("{label}: {e}"))?;
    explain(conn, label, &sql, &binds)
}

/// Print the plan of `sql`, and return the detail of each plan row.
fn explain(
    conn: &mut SqliteConnection,
    label: &str,
    sql: &str,
    binds: &[String],
) -> Result<Vec<String>, String> {
    println!("\n### EXPLAIN QUERY PLAN: {label}\n");
    println!("```sql\n{sql}\n```\n");

    let mut statement = sql_query(format!("EXPLAIN QUERY PLAN {sql}")).into_boxed::<Sqlite>();
    for value in binds {
        statement = statement.bind::<Text, _>(value.clone());
    }

    let details: Vec<String> = statement
        .load::<ExplainRow>(conn)
        .map_err(|e| format!("explain failed for '{label}': {e}"))?
        .into_iter()
        .map(|row| row.detail)
        .collect();
    for detail in &details {
        println!("- {detail}");
    }
    Ok(details)
}

/// Make sure that a plan reads a linked field through a correlated
/// subquery. ADR 0016 selects this form, because the page query can then
/// stop after 100 rows.
fn require_correlated(label: &str, details: &[String]) -> Result<(), String> {
    let correlated = details.iter().any(|detail| detail.contains("CORRELATED"));
    let list = details
        .iter()
        .any(|detail| detail.contains("LIST SUBQUERY"));
    if correlated && !list {
        Ok(())
    } else {
        Err(format!("{label}: the plan has no correlated subquery"))
    }
}

fn list_indexes(conn: &mut SqliteConnection) -> Result<(), String> {
    println!("\n### Indexes on books/authors/series/tags/link tables\n");
    let rows: Vec<IndexRow> = sql_query(
        "SELECT name, tbl_name, COALESCE(sql, '(implicit: UNIQUE/PK)') AS sql \
         FROM sqlite_master WHERE type = 'index' AND (\
           tbl_name IN ('books','authors','series','tags','identifiers','data',\
                        'books_authors_link','books_series_link','books_tags_link') \
           OR tbl_name LIKE 'custom_column%') \
         ORDER BY tbl_name, name",
    )
    .load(conn)
    .map_err(|e| format!("index query failed: {e}"))?;

    println!("| Table | Index | Definition |");
    println!("| --- | --- | --- |");
    for row in rows {
        println!("| {} | {} | `{}` |", row.tbl_name, row.name, row.sql);
    }
    Ok(())
}

// =============================================================================
// Queries
// =============================================================================

/// The default search scope.
const DEFAULT: SearchScope = SearchScope::TitlesAuthorsSeries;

/// The scope of the "All Fields" menu item.
const ALL: SearchScope = SearchScope::AllFields;

/// The first page of all books, sorted by title.
fn first_page_query() -> BookQuery {
    BookQuery {
        limit: Some(PAGE_SIZE),
        ..BookQuery::default()
    }
}

/// One page of all books in the given sort order.
fn page_query(offset: i64, sort: BookSortOrder) -> BookQuery {
    BookQuery {
        sort,
        offset,
        ..first_page_query()
    }
}

/// The first page of a search text in a scope.
fn search_query(text: String, scope: SearchScope) -> BookQuery {
    BookQuery {
        text: Some(text),
        search_scope: scope,
        ..first_page_query()
    }
}

/// Make sure that the search totals agree with each other and with an
/// independent count. A search regression that loses matches runs faster,
/// so the timing alone cannot find it.
fn check_search_totals(
    library: &mut Library,
    conn: &mut SqliteConnection,
    common: &str,
    rare: &str,
) -> Result<(), String> {
    let mut total = |text: &str, scope: SearchScope| -> Result<u64, String> {
        library
            .query_books(search_query(text.to_string(), scope))
            .map(|page| page.total)
            .map_err(|e| format!("query_books('{text}') failed: {e}"))
    };
    let mut default_totals = Vec::new();
    for token in [common, rare] {
        let default = total(token, DEFAULT)?;
        let all = total(token, ALL)?;
        if default == 0 {
            return Err(format!("'{token}' finds no books, but a title has it"));
        }
        if all < default {
            return Err(format!(
                "'{token}' finds {all} books in all fields but {default} in the default scope"
            ));
        }
        default_totals.push(default);
    }
    let either = total(&format!("{common} or {rare}"), DEFAULT)?;
    let most = default_totals.into_iter().max().unwrap_or(0);
    if either < most {
        return Err(format!(
            "'{common} or {rare}' finds {either} books, fewer than one operand ({most})"
        ));
    }
    let percent = total("%", DEFAULT)?;
    let expected = count_literal_percent(conn)?;
    if percent != expected {
        return Err(format!(
            "'%' finds {percent} books, but {expected} books contain a literal %"
        ));
    }
    println!("Search totals check passed");
    Ok(())
}

/// Time one page query. When `must_find` is true, the query must find one or
/// more books.
fn page_scenario(
    library: &mut Library,
    name: &str,
    query: BookQuery,
    must_find: bool,
    runs: usize,
    warmup: usize,
) -> Result<Measurement, String> {
    if must_find {
        let page = library
            .query_books(query.clone())
            .map_err(|e| format!("{name}: query_books failed: {e}"))?;
        if page.total == 0 {
            return Err(format!("{name}: the scenario finds no books"));
        }
    }
    Ok(bench(name, runs, warmup, || {
        let page = library
            .query_books(query.clone())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        format!("{} rows / total {}", page.items.len(), page.total)
    }))
}

// =============================================================================
// Main
// =============================================================================

fn main() {
    if let Err(message) = run() {
        eprintln!("error: {message}");
        eprintln!(
            "usage: bench_library_queries --library <path> [--runs N] [--warmup N] [--expect-total N]"
        );
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let library_str = args
        .library
        .to_str()
        .ok_or("library path is not valid UTF-8")?
        .to_string();

    let mut library =
        Library::open(&library_str).map_err(|e| format!("failed to open library: {e}"))?;

    // A second connection for raw-SQL discovery and EXPLAIN; it never runs
    // while a timed scenario is in flight.
    let db_path = args.library.join("metadata.db");
    let mut raw_conn = establish_connection(db_path.to_str().ok_or("non-UTF-8 db path")?)
        .map_err(|e| format!("failed to open raw connection: {e}"))?;

    // ---- Sanity check + scenario inputs --------------------------------
    let first_page = library
        .query_books(first_page_query())
        .map_err(|e| format!("query_books failed: {e}"))?;
    let total = first_page.total;
    println!(
        "Library: {library_str}\nTotal books: {total}; first page hydrated {} items",
        first_page.items.len()
    );
    if first_page.items.is_empty() {
        return Err("library is empty; nothing to measure".to_string());
    }
    if let Some(expected) = args.expect_total {
        if total != expected {
            return Err(format!("expected total {expected}, got {total}"));
        }
        let hydrated = &first_page.items[0];
        if hydrated.uuid.as_deref().is_none_or(str::is_empty) || hydrated.authors.is_empty() {
            return Err("first page items are not fully hydrated".to_string());
        }
        println!("Sanity check passed: total == {expected}, page is hydrated");
    }

    let (common_token, rare_token) = pick_search_tokens(&mut raw_conn)?;
    let (prolific_author, author_books) =
        most_linked(&mut raw_conn, "books_authors_link", "author")?
            .ok_or("no books_authors_link rows")?;
    let (busy_series, series_books) = most_linked(&mut raw_conn, "books_series_link", "series")?
        .ok_or("no books_series_link rows")?;
    let busy_tag = match most_linked(&mut raw_conn, "books_tags_link", "tag")? {
        Some((id, books)) => Some((tag_name(&mut raw_conn, id)?, books)),
        None => None,
    };
    let tag_note = match &busy_tag {
        Some((name, books)) => format!("tag '{name}' ({books} books)"),
        None => "no tags".to_string(),
    };
    println!(
        "Filters: author {prolific_author} ({author_books} books), series {busy_series} ({series_books} books), {tag_note}"
    );
    let busy_tag_term = busy_tag.map(|(name, _)| tag_term(&name));

    check_search_totals(&mut library, &mut raw_conn, &common_token, &rare_token)?;

    let total_i64 = i64::try_from(total).unwrap_or(i64::MAX);
    let middle_offset = (total_i64 / 2 / PAGE_SIZE) * PAGE_SIZE;
    let last_offset = ((total_i64 - 1).max(0) / PAGE_SIZE) * PAGE_SIZE;

    // ---- Scenarios ------------------------------------------------------
    let runs = args.runs;
    let warmup = args.warmup;
    let mut scenarios: Vec<Scenario> = vec![
        Scenario {
            name: "query_books: page 1 (offset 0, limit 100, title asc)".into(),
            query: page_query(0, BookSortOrder::TitleAsc),
            must_find: false,
        },
        Scenario {
            name: format!("query_books: middle page (offset {middle_offset})"),
            query: page_query(middle_offset, BookSortOrder::TitleAsc),
            must_find: false,
        },
        Scenario {
            name: format!("query_books: last page (offset {last_offset})"),
            query: page_query(last_offset, BookSortOrder::TitleAsc),
            must_find: false,
        },
        Scenario {
            name: "query_books: sort title desc".into(),
            query: page_query(0, BookSortOrder::TitleDesc),
            must_find: false,
        },
        Scenario {
            name: "query_books: sort author asc".into(),
            query: page_query(0, BookSortOrder::AuthorAsc),
            must_find: false,
        },
        Scenario {
            name: "query_books: sort author desc".into(),
            query: page_query(0, BookSortOrder::AuthorDesc),
            must_find: false,
        },
        Scenario {
            name: format!("query_books: text search common ('{common_token}')"),
            query: search_query(common_token.clone(), DEFAULT),
            must_find: true,
        },
        Scenario {
            name: format!("query_books: text search rare ('{rare_token}')"),
            query: search_query(rare_token.clone(), DEFAULT),
            must_find: true,
        },
        Scenario {
            name: format!("query_books: all fields common ('{common_token}')"),
            query: search_query(common_token.clone(), ALL),
            must_find: true,
        },
        Scenario {
            name: format!("query_books: all fields rare ('{rare_token}')"),
            query: search_query(rare_token.clone(), ALL),
            must_find: true,
        },
        Scenario {
            name: "query_books: text search literal '%'".into(),
            query: search_query("%".into(), DEFAULT),
            must_find: false,
        },
        Scenario {
            name: format!("query_books: author_id filter ({prolific_author})"),
            query: BookQuery {
                author_id: Some(AuthorId(prolific_author)),
                ..first_page_query()
            },
            must_find: false,
        },
        Scenario {
            name: format!("query_books: series_id filter ({busy_series})"),
            query: BookQuery {
                series_id: Some(busy_series),
                ..first_page_query()
            },
            must_find: false,
        },
    ];
    if let Some(term) = &busy_tag_term {
        scenarios.push(Scenario {
            name: format!("query_books: tag term ('{term}')"),
            query: search_query(term.clone(), DEFAULT),
            must_find: true,
        });
    }
    scenarios.extend([
        Scenario {
            name: "query_books: identifiers:false".into(),
            query: search_query("identifiers:false".into(), DEFAULT),
            must_find: false,
        },
        Scenario {
            name: format!("query_books: or group ('{common_token} or {rare_token}')"),
            query: search_query(format!("{common_token} or {rare_token}"), DEFAULT),
            must_find: true,
        },
        Scenario {
            name: "query_books: hide_read".into(),
            query: BookQuery {
                hide_read: true,
                ..first_page_query()
            },
            must_find: false,
        },
        Scenario {
            name: format!("query_books: text ('{common_token}') + hide_read"),
            query: BookQuery {
                hide_read: true,
                ..search_query(common_token.clone(), DEFAULT)
            },
            must_find: false,
        },
        Scenario {
            name: "query_books: count only (limit 0)".into(),
            query: BookQuery {
                limit: Some(0),
                ..BookQuery::default()
            },
            must_find: false,
        },
    ]);

    let mut results: Vec<Measurement> = Vec::new();
    for Scenario {
        name,
        query,
        must_find,
    } in scenarios
    {
        results.push(page_scenario(
            &mut library,
            &name,
            query,
            must_find,
            runs,
            warmup,
        )?);
    }

    results.push(bench(
        &format!("search_books('{common_token}') [unbounded hydration]"),
        runs,
        warmup,
        || {
            let books = library.search_books(&common_token).expect("search_books");
            format!("{} rows", books.len())
        },
    ));
    results.push(bench(
        &format!("find_by_author({prolific_author}) [unbounded hydration]"),
        runs,
        warmup,
        || {
            let books = library
                .find_by_author(AuthorId(prolific_author))
                .expect("find_by_author");
            format!("{} rows", books.len())
        },
    ));
    results.push(bench("list_series()", runs, warmup, || {
        let series = library.list_series().expect("list_series");
        format!("{} rows", series.len())
    }));
    results.push(bench(
        "books() [full hydration of every book — Authors page path]",
        runs,
        warmup,
        || {
            let books = library.books().expect("books()");
            format!("{} rows", books.len())
        },
    ));
    results.push(bench("authors() [startup-eager]", runs, warmup, || {
        let authors = library.authors().expect("authors()");
        format!("{} rows", authors.len())
    }));
    results.push(bench(
        "author_book_counts() [Authors page counts, one GROUP BY]",
        runs,
        warmup,
        || {
            let counts = library.author_book_counts().expect("author_book_counts()");
            format!("{} authors with books", counts.len())
        },
    ));

    print_report(&results, runs, warmup);
    explain_plans(&mut raw_conn, &mut library, busy_tag_term.as_deref())?;
    list_indexes(&mut raw_conn)
}

/// Print the table of the measurements.
fn print_report(results: &[Measurement], runs: usize, warmup: usize) {
    println!("\n## Benchmark results ({runs} runs after {warmup} warmup, ms)\n");
    println!("| Scenario | min | median | max | result |");
    println!("| --- | ---: | ---: | ---: | --- |");
    for m in results {
        println!(
            "| {} | {:.2} | {:.2} | {:.2} | {} |",
            m.name,
            m.min(),
            m.median(),
            m.max(),
            m.note
        );
    }

    println!(
        "\nNote: in the real app, hydrating books also costs one cover-file \
         stat per book in src-tauri (book_cover_image); that filesystem work \
         happens outside libcalibre and is not included in these numbers."
    );
}

/// Print the plans of the hot queries. The SQL comes from the library, so
/// that the plans show the queries that `query_books` runs. A search on a
/// linked field must use a correlated subquery.
fn explain_plans(
    conn: &mut SqliteConnection,
    library: &mut Library,
    busy_tag_term: Option<&str>,
) -> Result<(), String> {
    println!("\n## Query plans\n");
    let mut plans: Vec<Plan> = vec![
        Plan {
            label: "paged ids, no filter, ORDER BY title",
            query: first_page_query(),
            linked: false,
        },
        Plan {
            label: "paged ids, no filter, ORDER BY author sort",
            query: page_query(0, BookSortOrder::AuthorAsc),
            linked: false,
        },
        Plan {
            label: "paged ids, text filter, ORDER BY title",
            query: search_query("war".into(), DEFAULT),
            linked: true,
        },
        Plan {
            label: "paged ids, all fields filter, ORDER BY title",
            query: search_query("war".into(), ALL),
            linked: true,
        },
    ];
    if let Some(term) = busy_tag_term {
        plans.push(Plan {
            label: "paged ids, tag term, ORDER BY title",
            query: search_query(term.to_string(), DEFAULT),
            linked: true,
        });
    }
    for Plan {
        label,
        query,
        linked,
    } in plans
    {
        let details = explain_query(conn, label, library.page_sql(&query))?;
        if linked {
            require_correlated(label, &details)?;
        }
    }

    let label = "count, text filter";
    let count = library.count_sql(&search_query("war".into(), DEFAULT));
    let details = explain_query(conn, label, count)?;
    require_correlated(label, &details)?;

    let has_read_column = library
        .custom_columns()
        .map_err(|e| format!("custom column query failed: {e}"))?
        .into_iter()
        .any(|c| c.label == "read" && c.kind == CustomColumnKind::Bool);
    if has_read_column {
        let label = "paged ids, hide_read, ORDER BY title";
        let page = library.page_sql(&BookQuery {
            hide_read: true,
            ..first_page_query()
        });
        explain_query(conn, label, page)?;
    } else {
        println!("\n(no `read` bool custom column; skipping hide_read EXPLAIN)");
    }
    Ok(())
}
