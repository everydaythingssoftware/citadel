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
use diesel::{sql_query, RunQueryDsl, SqliteConnection};

use libcalibre::persistence::establish_connection;
use libcalibre::util::get_db_path;
use libcalibre::{AuthorId, BookQuery, BookSortOrder, CustomColumnKind, Library};

const PAGE_SIZE: i64 = 100;

struct Args {
    library: PathBuf,
    runs: usize,
    warmup: usize,
    expect_total: Option<i64>,
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

/// Most/least frequent title tokens. Used to pick a "common" and a "rare"
/// search needle without hardcoding the generator's vocabulary.
fn pick_search_tokens(conn: &mut SqliteConnection) -> (String, String) {
    let titles: Vec<TitleRow> = sql_query("SELECT title FROM books")
        .load(conn)
        .unwrap_or_default();

    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in &titles {
        for token in row
            .title
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.len() >= 3)
        {
            *counts.entry(token.to_lowercase()).or_default() += 1;
        }
    }

    let common = counts
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
        .map(|(token, _)| token.clone())
        .unwrap_or_else(|| "the".to_string());
    let rare = counts
        .iter()
        .min_by(|a, b| a.1.cmp(b.1).then(a.0.cmp(b.0)))
        .map(|(token, _)| token.clone())
        .unwrap_or_else(|| "zzzunmatched".to_string());

    println!(
        "Search needles: common='{common}' ({} title hits), rare='{rare}' ({} title hits)",
        counts.get(&common).copied().unwrap_or(0),
        counts.get(&rare).copied().unwrap_or(0)
    );
    (common, rare)
}

fn most_linked(conn: &mut SqliteConnection, link_table: &str, column: &str) -> Option<(i32, i64)> {
    let rows: Vec<IdCountRow> = sql_query(format!(
        "SELECT {column} AS id, COUNT(*) AS c FROM {link_table} \
         GROUP BY {column} ORDER BY c DESC, id ASC LIMIT 1"
    ))
    .load(conn)
    .ok()?;
    rows.first().map(|row| (row.id, row.c))
}

fn explain(conn: &mut SqliteConnection, label: &str, sql: &str, text_binds: usize) {
    println!("\n### EXPLAIN QUERY PLAN: {label}\n");
    println!("```sql\n{sql}\n```\n");

    let explain_sql = format!("EXPLAIN QUERY PLAN {sql}");
    let result: Result<Vec<ExplainRow>, _> = match text_binds {
        0 => sql_query(explain_sql).load(conn),
        3 => sql_query(explain_sql)
            .bind::<Text, _>("%war%")
            .bind::<Text, _>("%war%")
            .bind::<Text, _>("%war%")
            .load(conn),
        n => {
            println!("(unsupported bind count {n})");
            return;
        }
    };

    match result {
        Ok(rows) => {
            for row in rows {
                println!("- {}", row.detail);
            }
        }
        Err(e) => println!("(explain failed: {e})"),
    }
}

fn list_indexes(conn: &mut SqliteConnection) {
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
    .unwrap_or_default();

    println!("| Table | Index | Definition |");
    println!("| --- | --- | --- |");
    for row in rows {
        println!("| {} | {} | `{}` |", row.tbl_name, row.name, row.sql);
    }
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

    let valid_path = get_db_path(&library_str)
        .ok_or_else(|| format!("no metadata.db found under {library_str}"))?;
    let mut library =
        Library::new(valid_path).map_err(|e| format!("failed to open library: {e}"))?;

    // A second connection for raw-SQL discovery and EXPLAIN; it never runs
    // while a timed scenario is in flight.
    let db_path = args.library.join("metadata.db");
    let mut raw_conn = establish_connection(db_path.to_str().ok_or("non-UTF-8 db path")?)
        .map_err(|_| "failed to open raw connection".to_string())?;

    // ---- Sanity check + scenario inputs --------------------------------
    let first_page = library
        .query_books(BookQuery {
            limit: Some(PAGE_SIZE),
            ..BookQuery::default()
        })
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

    let (common_token, rare_token) = pick_search_tokens(&mut raw_conn);
    let (prolific_author, author_books) =
        most_linked(&mut raw_conn, "books_authors_link", "author")
            .ok_or("no books_authors_link rows")?;
    let (busy_series, series_books) = most_linked(&mut raw_conn, "books_series_link", "series")
        .ok_or("no books_series_link rows")?;
    println!(
        "Filters: author {prolific_author} ({author_books} books), series {busy_series} ({series_books} books)"
    );

    let middle_offset = (total / 2 / PAGE_SIZE) * PAGE_SIZE;
    let last_offset = ((total - 1).max(0) / PAGE_SIZE) * PAGE_SIZE;

    let page_query = |offset: i64, sort: BookSortOrder| BookQuery {
        sort,
        limit: Some(PAGE_SIZE),
        offset,
        ..BookQuery::default()
    };

    // ---- Scenarios ------------------------------------------------------
    let mut results: Vec<Measurement> = Vec::new();
    let runs = args.runs;
    let warmup = args.warmup;

    {
        let mut page_scenario = |name: &str, query: BookQuery| {
            let library = &mut library;
            let q = query;
            bench(name, runs, warmup, move || {
                let page = library.query_books(q.clone()).expect("query_books");
                format!("{} rows / total {}", page.items.len(), page.total)
            })
        };

        results.push(page_scenario(
            "query_books: page 1 (offset 0, limit 100, title asc)",
            page_query(0, BookSortOrder::TitleAsc),
        ));
        results.push(page_scenario(
            &format!("query_books: middle page (offset {middle_offset})"),
            page_query(middle_offset, BookSortOrder::TitleAsc),
        ));
        results.push(page_scenario(
            &format!("query_books: last page (offset {last_offset})"),
            page_query(last_offset, BookSortOrder::TitleAsc),
        ));
        results.push(page_scenario(
            "query_books: sort title desc",
            page_query(0, BookSortOrder::TitleDesc),
        ));
        results.push(page_scenario(
            "query_books: sort author asc",
            page_query(0, BookSortOrder::AuthorAsc),
        ));
        results.push(page_scenario(
            "query_books: sort author desc",
            page_query(0, BookSortOrder::AuthorDesc),
        ));
        results.push(page_scenario(
            &format!("query_books: text search common ('{common_token}')"),
            BookQuery {
                text: Some(common_token.clone()),
                limit: Some(PAGE_SIZE),
                ..BookQuery::default()
            },
        ));
        results.push(page_scenario(
            &format!("query_books: text search rare ('{rare_token}')"),
            BookQuery {
                text: Some(rare_token.clone()),
                limit: Some(PAGE_SIZE),
                ..BookQuery::default()
            },
        ));
        results.push(page_scenario(
            "query_books: text search literal '%'",
            BookQuery {
                text: Some("%".to_string()),
                limit: Some(PAGE_SIZE),
                ..BookQuery::default()
            },
        ));
        results.push(page_scenario(
            &format!("query_books: author_id filter ({prolific_author})"),
            BookQuery {
                author_id: Some(AuthorId(prolific_author)),
                limit: Some(PAGE_SIZE),
                ..BookQuery::default()
            },
        ));
        results.push(page_scenario(
            &format!("query_books: series_id filter ({busy_series})"),
            BookQuery {
                series_id: Some(busy_series),
                limit: Some(PAGE_SIZE),
                ..BookQuery::default()
            },
        ));
        results.push(page_scenario(
            "query_books: hide_read",
            BookQuery {
                hide_read: true,
                limit: Some(PAGE_SIZE),
                ..BookQuery::default()
            },
        ));
        results.push(page_scenario(
            &format!("query_books: text ('{common_token}') + hide_read"),
            BookQuery {
                text: Some(common_token.clone()),
                hide_read: true,
                limit: Some(PAGE_SIZE),
                ..BookQuery::default()
            },
        ));
        results.push(page_scenario(
            "query_books: count only (limit 0)",
            BookQuery {
                limit: Some(0),
                ..BookQuery::default()
            },
        ));
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

    // ---- Report ----------------------------------------------------------
    println!("\n## Benchmark results ({runs} runs after {warmup} warmup, ms)\n");
    println!("| Scenario | min | median | max | result |");
    println!("| --- | ---: | ---: | ---: | --- |");
    for m in &results {
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

    // ---- EXPLAIN QUERY PLAN ----------------------------------------------
    // These SQL strings mirror what queries/books.rs::filter_where_sql /
    // order_by_sql generate; keep them in sync when the crate changes.
    let author_sort_expr = "(SELECT a.sort FROM books_authors_link bal \
         JOIN authors a ON a.id = bal.author \
         WHERE bal.book = books.id ORDER BY bal.id LIMIT 1)";
    let text_where = "(books.title LIKE ? ESCAPE '\\' \
              OR EXISTS (SELECT 1 FROM books_authors_link bal \
                         JOIN authors a ON a.id = bal.author \
                         WHERE bal.book = books.id AND a.name LIKE ? ESCAPE '\\') \
              OR EXISTS (SELECT 1 FROM books_series_link bsl \
                         JOIN series s ON s.id = bsl.series \
                         WHERE bsl.book = books.id AND s.name LIKE ? ESCAPE '\\'))";

    println!("\n## Query plans\n");
    explain(
        &mut raw_conn,
        "paged ids, no filter, ORDER BY title",
        "SELECT books.id FROM books WHERE 1=1 \
         ORDER BY books.sort ASC, books.id ASC LIMIT 100 OFFSET 0",
        0,
    );
    explain(
        &mut raw_conn,
        "paged ids, no filter, ORDER BY author sort",
        &format!(
            "SELECT books.id FROM books WHERE 1=1 \
             ORDER BY {author_sort_expr} ASC, books.id ASC LIMIT 100 OFFSET 0"
        ),
        0,
    );
    explain(
        &mut raw_conn,
        "paged ids, text filter, ORDER BY title",
        &format!(
            "SELECT books.id FROM books WHERE 1=1 AND {text_where} \
             ORDER BY books.sort ASC, books.id ASC LIMIT 100 OFFSET 0"
        ),
        3,
    );
    explain(
        &mut raw_conn,
        "count, text filter",
        &format!("SELECT COUNT(*) AS total FROM books WHERE 1=1 AND {text_where}"),
        3,
    );

    let read_column = library.custom_columns().ok().and_then(|columns| {
        columns
            .into_iter()
            .find(|c| c.label == "read" && c.kind == CustomColumnKind::Bool)
    });
    if let Some(column) = read_column {
        explain(
            &mut raw_conn,
            "paged ids, hide_read, ORDER BY title",
            &format!(
                "SELECT books.id FROM books WHERE 1=1 AND \
                 NOT EXISTS (SELECT 1 FROM custom_column_{} cc \
                 WHERE cc.book = books.id AND cc.value != 0) \
                 ORDER BY books.sort ASC, books.id ASC LIMIT 100 OFFSET 0",
                column.id
            ),
            0,
        );
    } else {
        println!("\n(no `read` bool custom column; skipping hide_read EXPLAIN)");
    }

    list_indexes(&mut raw_conn);

    Ok(())
}
