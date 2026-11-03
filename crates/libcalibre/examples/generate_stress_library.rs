//! Generate a large, deterministic Calibre library for performance testing.
//!
//! Bootstraps an empty library from the test fixture `metadata.db`, then
//! populates it exclusively through libcalibre's real write paths
//! (`Library::add_book`, `set_book_cover`, `set_book_read_state`,
//! `upsert_book_identifier`) so the result matches what the app produces.
//!
//! Usage:
//!
//! ```sh
//! cargo run --release -p libcalibre --example generate_stress_library -- \
//!     --dest /tmp/stress-library --books 5000 --seed 20260612
//! ```
//!
//! Output is deterministic for a given (--books, --seed) pair, except for
//! row timestamps and UUIDs which the database generates at insert time.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Instant;

use libcalibre::persistence::establish_connection;
use libcalibre::util::get_db_path;
use libcalibre::{BookAdd, Library};

const DEFAULT_BOOKS: usize = 5000;
const DEFAULT_SEED: u64 = 20260612;
const COVER_WIDTH: u32 = 150;
const COVER_HEIGHT: u32 = 230;
const COVER_TEMPLATE_COUNT: usize = 16;

struct Args {
    dest: PathBuf,
    books: usize,
    seed: u64,
}

fn parse_args() -> Result<Args, String> {
    let mut dest: Option<PathBuf> = None;
    let mut books = DEFAULT_BOOKS;
    let mut seed = DEFAULT_SEED;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dest" => {
                let value = args.next().ok_or("--dest requires a path")?;
                dest = Some(PathBuf::from(value));
            }
            "--books" => {
                let value = args.next().ok_or("--books requires a number")?;
                books = value
                    .parse()
                    .map_err(|_| format!("invalid --books value: {value}"))?;
            }
            "--seed" => {
                let value = args.next().ok_or("--seed requires a u64")?;
                seed = value
                    .parse()
                    .map_err(|_| format!("invalid --seed value: {value}"))?;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let dest = dest.ok_or("--dest <path> is required")?;
    if books == 0 {
        return Err("--books must be at least 1".to_string());
    }
    Ok(Args { dest, books, seed })
}

// =============================================================================
// Vocabulary
// =============================================================================

const FIRST_NAMES: &[&str] = &[
    "Ada", "Bram", "Clara", "Dmitri", "Elena", "Farid", "Greta", "Hideo", "Ingrid", "Jamal",
    "Keiko", "Lars", "Mona", "Nadia", "Otto", "Priya", "Quentin", "Rosa", "Sven", "Tomoko",
    "Ulrich", "Vera", "Wendell", "Ximena", "Yusuf", "Zora", "Anders", "Beatriz", "Cormac",
    "Daphne", "Emeka", "Frances", "Gustav", "Halima", "Ivar", "Jolene", "Kazimir", "Leona",
    "Marcus", "Noor",
];

const LAST_NAMES: &[&str] = &[
    "Aldercroft",
    "Bellweather",
    "Cardamine",
    "Dunmore",
    "Eastvale",
    "Fenwick",
    "Grimaldi",
    "Halloran",
    "Ivanenko",
    "Jankowski",
    "Kettleburn",
    "Larkspur",
    "Montrose",
    "Nightingale",
    "Okonkwo",
    "Pemberton",
    "Quayle",
    "Ravenscroft",
    "Silverthorne",
    "Thackeray",
    "Umarov",
    "Vandermeer",
    "Wexford",
    "Yarrow",
    "Zhukova",
    "Ashgrove",
    "Birchall",
    "Crowhurst",
    "Davenport",
    "Ellsworth",
    "Featherstone",
    "Galloway",
    "Hawthorne",
    "Ironwood",
    "Juniper",
    "Kingsley",
    "Lockridge",
    "Marlowe",
    "Northgate",
    "O'Malley",
    "Palewski",
    "Quintrell",
    "Redmane",
    "Strandberg",
    "Tanaka",
    "Underhill",
    "Voss",
    "Whitlock",
    "Xiang",
    "Yamamoto",
];

const TITLE_ADJECTIVES: &[&str] = &[
    "Silent",
    "Crimson",
    "Forgotten",
    "Last",
    "Hidden",
    "Burning",
    "Hollow",
    "Endless",
    "Iron",
    "Pale",
    "Wandering",
    "Shattered",
    "Gilded",
    "Restless",
    "Distant",
    "Broken",
    "Sleeping",
    "Wicked",
    "Quiet",
    "Golden",
];

const TITLE_NOUNS: &[&str] = &[
    "Shadow",
    "War",
    "Garden",
    "River",
    "Crown",
    "Empire",
    "Winter",
    "Mirror",
    "Voyage",
    "Cipher",
    "Harvest",
    "Lantern",
    "Archive",
    "Tempest",
    "Orchard",
    "Citadel",
    "Compass",
    "Reckoning",
    "Threshold",
    "Labyrinth",
    "Sparrow",
    "Ember",
    "Atlas",
    "Requiem",
    "Meridian",
];

const TITLE_TRAILERS: &[&str] = &[
    "A Novel",
    "Collected Stories",
    "The Complete Edition",
    "Book One",
    "An Oral History",
    "Notes from the Field",
];

/// Title fragments hostile to naive LIKE queries: literal `%`, `_`,
/// apostrophes, and non-ASCII text.
const HOSTILE_TITLES: &[&str] = &[
    "100% Doomed",
    "The 50% Solution",
    "snake_case and Other Disasters",
    "under_score: a programmer's lament",
    "O'Malley's Last % Stand",
    "L'Étranger Revisited",
    "Caffè Notturno",
    "Königskinder",
    "戦争と平和 (Annotated)",
    "Война и мир, Abridged",
    "Naïve Düsk",
    "It's 100%_certain",
];

const SERIES_PATTERNS: &[&str] = &[
    "{} Saga",
    "The {} Cycle",
    "{} Chronicles",
    "Tales of the {}",
];

const TAG_POOL: &[&str] = &[
    "science-fiction",
    "fantasy",
    "mystery",
    "thriller",
    "romance",
    "horror",
    "literary",
    "historical",
    "biography",
    "memoir",
    "philosophy",
    "poetry",
    "essays",
    "travel",
    "cooking",
    "science",
    "mathematics",
    "history",
    "politics",
    "economics",
    "psychology",
    "self-help",
    "young-adult",
    "children",
    "graphic-novel",
    "short-stories",
    "anthology",
    "translated",
    "award-winner",
    "book-club",
    "to-reread",
    "signed-copy",
    "first-edition",
    "library-loan",
    "gift",
    "beach-read",
    "winter-read",
    "comfort",
    "challenging",
    "abandoned-once",
    "five-stars",
    "australian",
    "japanese",
    "russian",
    "french",
    "nigerian",
    "canadian",
    "debut",
    "novella",
    "doorstopper",
];

// =============================================================================
// Deterministic content builders
// =============================================================================

fn build_author_pool(rng: &mut fastrand::Rng, size: usize) -> Vec<String> {
    let mut pool = Vec::with_capacity(size);
    let mut seen = HashSet::new();
    while pool.len() < size {
        let first = FIRST_NAMES[rng.usize(..FIRST_NAMES.len())];
        let last = LAST_NAMES[rng.usize(..LAST_NAMES.len())];
        let name = if pool.len() % 7 == 3 {
            // Sprinkle middle initials so name collisions stay rare.
            let initial = (b'A' + rng.u8(..26)) as char;
            format!("{first} {initial}. {last}")
        } else {
            format!("{first} {last}")
        };
        if seen.insert(name.clone()) {
            pool.push(name);
        }
    }
    pool
}

/// Weighted author pick: low indices are chosen far more often, so the pool
/// contains a handful of prolific authors and a long tail.
fn weighted_author_index(rng: &mut fastrand::Rng, pool_len: usize) -> usize {
    let r = rng.f64();
    ((pool_len as f64) * r.powf(2.5)) as usize % pool_len
}

fn build_title(rng: &mut fastrand::Rng) -> String {
    // ~4% of titles carry LIKE-hostile characters.
    if rng.f64() < 0.04 {
        return HOSTILE_TITLES[rng.usize(..HOSTILE_TITLES.len())].to_string();
    }

    let adjective = TITLE_ADJECTIVES[rng.usize(..TITLE_ADJECTIVES.len())];
    let noun = TITLE_NOUNS[rng.usize(..TITLE_NOUNS.len())];
    let second_noun = TITLE_NOUNS[rng.usize(..TITLE_NOUNS.len())];

    let base = match rng.usize(..5) {
        0 => format!("The {adjective} {noun}"),
        1 => format!("{adjective} {noun}"),
        2 => format!("{noun} of {second_noun}s"),
        3 => format!("A {noun} for the {adjective} {second_noun}"),
        _ => format!("The {noun} and the {second_noun}"),
    };

    if rng.f64() < 0.15 {
        let trailer = TITLE_TRAILERS[rng.usize(..TITLE_TRAILERS.len())];
        format!("{base}: {trailer}")
    } else {
        base
    }
}

#[derive(Clone)]
struct SeriesSlot {
    name: String,
    index: f32,
    author_index: usize,
}

/// Pre-plan series membership: ~30% of books belong to a series of 3-15
/// books. Each series has a dedicated primary author. Slots are shuffled so
/// series members are scattered across insertion order.
fn build_series_schedule(
    rng: &mut fastrand::Rng,
    book_count: usize,
    author_pool_len: usize,
) -> Vec<Option<SeriesSlot>> {
    let target = (book_count as f64 * 0.30) as usize;
    let mut slots: Vec<Option<SeriesSlot>> = vec![None; book_count];
    let mut covered = 0;
    let mut series_number = 0;

    while covered < target {
        series_number += 1;
        let size = rng.usize(3..=15).min(target - covered).max(1);
        let pattern = SERIES_PATTERNS[rng.usize(..SERIES_PATTERNS.len())];
        let noun = TITLE_NOUNS[rng.usize(..TITLE_NOUNS.len())];
        let name = format!("{} #{series_number}", pattern.replace("{}", noun));
        let author_index = weighted_author_index(rng, author_pool_len);

        for position in 0..size {
            slots[covered + position] = Some(SeriesSlot {
                name: name.clone(),
                index: (position + 1) as f32,
                author_index,
            });
        }
        covered += size;
    }

    rng.shuffle(&mut slots);
    slots
}

fn build_pubdate(rng: &mut fastrand::Rng) -> chrono::NaiveDate {
    let year = rng.i32(1950..=2024);
    let month = rng.u32(1..=12);
    let day = rng.u32(1..=28);
    chrono::NaiveDate::from_ymd_opt(year, month, day).expect("valid synthetic date")
}

fn build_isbn13(rng: &mut fastrand::Rng) -> String {
    let mut digits = vec![9u32, 7, 8];
    for _ in 0..9 {
        digits.push(rng.u32(..10));
    }
    let checksum: u32 = digits
        .iter()
        .enumerate()
        .map(|(i, d)| if i % 2 == 0 { *d } else { 3 * *d })
        .sum();
    digits.push((10 - (checksum % 10)) % 10);
    digits.into_iter().map(|d| d.to_string()).collect()
}

// =============================================================================
// Cover templates (small solid-color JPEGs)
// =============================================================================

fn build_cover_templates(rng: &mut fastrand::Rng) -> Vec<Vec<u8>> {
    (0..COVER_TEMPLATE_COUNT)
        .map(|_| {
            let pixel = image::Rgb([rng.u8(..), rng.u8(..), rng.u8(..)]);
            let img = image::RgbImage::from_pixel(COVER_WIDTH, COVER_HEIGHT, pixel);
            let mut bytes = Vec::new();
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut bytes), 70);
            img.write_with_encoder(encoder)
                .expect("encode solid-color JPEG cover");
            bytes
        })
        .collect()
}

// =============================================================================
// Stub EPUB (a valid stored ZIP, same bytes reused for every book)
// =============================================================================

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn build_stub_epub() -> Vec<u8> {
    const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

    const CONTENT_OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Stress Test Stub</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:00000000-0000-4000-8000-000000000000</dc:identifier>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>"#;

    let chapter_body = "The quick brown fox jumps over the lazy dog. ".repeat(48);
    let chapter = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>
<body><p>{chapter_body}</p></body></html>"#
    );

    let files: Vec<(&str, Vec<u8>)> = vec![
        ("mimetype", b"application/epub+zip".to_vec()),
        ("META-INF/container.xml", CONTAINER_XML.as_bytes().to_vec()),
        ("OEBPS/content.opf", CONTENT_OPF.as_bytes().to_vec()),
        ("OEBPS/chapter1.xhtml", chapter.into_bytes()),
    ];

    let mut out = Vec::new();
    let mut central = Vec::new();
    let mut entry_count = 0u16;

    let push_u16 = |buf: &mut Vec<u8>, v: u16| buf.extend_from_slice(&v.to_le_bytes());
    let push_u32 = |buf: &mut Vec<u8>, v: u32| buf.extend_from_slice(&v.to_le_bytes());

    for (name, data) in &files {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let size = data.len() as u32;

        // Local file header, method 0 (stored).
        push_u32(&mut out, 0x0403_4b50);
        push_u16(&mut out, 20); // version needed
        push_u16(&mut out, 0); // flags
        push_u16(&mut out, 0); // method: stored
        push_u16(&mut out, 0); // mod time
        push_u16(&mut out, 0x21); // mod date (1980-01-01)
        push_u32(&mut out, crc);
        push_u32(&mut out, size);
        push_u32(&mut out, size);
        push_u16(&mut out, name.len() as u16);
        push_u16(&mut out, 0); // extra len
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        // Central directory entry.
        push_u32(&mut central, 0x0201_4b50);
        push_u16(&mut central, 20); // version made by
        push_u16(&mut central, 20); // version needed
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0x21);
        push_u32(&mut central, crc);
        push_u32(&mut central, size);
        push_u32(&mut central, size);
        push_u16(&mut central, name.len() as u16);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0); // disk number
        push_u16(&mut central, 0); // internal attrs
        push_u32(&mut central, 0); // external attrs
        push_u32(&mut central, offset);
        central.extend_from_slice(name.as_bytes());
        entry_count += 1;
    }

    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);

    // End of central directory.
    push_u32(&mut out, 0x0605_4b50);
    push_u16(&mut out, 0);
    push_u16(&mut out, 0);
    push_u16(&mut out, entry_count);
    push_u16(&mut out, entry_count);
    push_u32(&mut out, central_size);
    push_u32(&mut out, central_offset);
    push_u16(&mut out, 0); // comment len

    out
}

// =============================================================================
// Bootstrapping and pragmas
// =============================================================================

#[derive(diesel::QueryableByName)]
struct JournalModeRow {
    #[diesel(sql_type = diesel::sql_types::Text)]
    #[allow(dead_code)]
    journal_mode: String,
}

fn set_journal_mode(db_path: &str, mode: &str) -> Result<(), String> {
    use diesel::RunQueryDsl;

    let mut conn = establish_connection(db_path)
        .map_err(|_| format!("failed to open connection to {db_path}"))?;
    let _: Vec<JournalModeRow> = diesel::sql_query(format!("PRAGMA journal_mode = {mode}"))
        .load(&mut conn)
        .map_err(|e| format!("failed to set journal_mode={mode}: {e}"))?;
    Ok(())
}

fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                total += dir_size_bytes(&entry_path);
            } else if let Ok(metadata) = entry.metadata() {
                total += metadata.len();
            }
        }
    }
    total
}

// =============================================================================
// Main
// =============================================================================

fn main() {
    if let Err(message) = run() {
        eprintln!("error: {message}");
        eprintln!("usage: generate_stress_library --dest <path> [--books <N>] [--seed <u64>]");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let started = Instant::now();
    let mut rng = fastrand::Rng::with_seed(args.seed);

    if args.dest.exists() && std::fs::read_dir(&args.dest).is_ok_and(|mut d| d.next().is_some()) {
        return Err(format!(
            "destination {} exists and is not empty; delete it first",
            args.dest.display()
        ));
    }
    std::fs::create_dir_all(&args.dest)
        .map_err(|e| format!("failed to create {}: {e}", args.dest.display()))?;

    drop(
        libcalibre::Library::create_library_at(
            args.dest.to_str().ok_or("destination path is not UTF-8")?,
        )
        .map_err(|e| format!("failed to create the library: {e}"))?,
    );

    let dest_str = args
        .dest
        .to_str()
        .ok_or("destination path is not valid UTF-8")?
        .to_string();
    let db_path_str = args
        .dest
        .join("metadata.db")
        .to_str()
        .ok_or("db path is not valid UTF-8")?
        .to_string();

    // WAL keeps per-statement commit fsyncs cheap while we bulk-insert; it is
    // restored to Calibre's default (DELETE) before the summary prints.
    set_journal_mode(&db_path_str, "WAL")?;

    let valid_path = get_db_path(&dest_str).ok_or("metadata.db missing after bootstrap")?;
    let mut library =
        Library::new(valid_path).map_err(|e| format!("failed to open library: {e}"))?;

    // Deterministic content pools.
    let author_pool = build_author_pool(&mut rng, (args.books / 8).max(1));
    let series_schedule = build_series_schedule(&mut rng, args.books, author_pool.len());
    let cover_templates = build_cover_templates(&mut rng);

    // The stub EPUB is written once to a scratch file inside dest (removed
    // at the end); add_book copies it into each book directory the same way
    // the app's import path does.
    let stub_epub = build_stub_epub();
    let stub_path = args.dest.join(".stress_stub_source.epub");
    std::fs::write(&stub_path, &stub_epub)
        .map_err(|e| format!("failed to write stub epub: {e}"))?;

    let mut authors_used: HashSet<usize> = HashSet::new();
    let mut series_used: HashSet<String> = HashSet::new();
    let mut tags_used: HashSet<&str> = HashSet::new();
    let mut read_count = 0usize;
    let mut isbn_count = 0usize;

    println!(
        "Generating {} books into {} (seed {})",
        args.books,
        args.dest.display(),
        args.seed
    );

    for (book_number, scheduled_slot) in series_schedule.iter().enumerate() {
        let series_slot = scheduled_slot.clone();

        // 1-3 authors; series books keep their series' dedicated primary author.
        let mut author_indices = Vec::new();
        let primary = match &series_slot {
            Some(slot) => slot.author_index,
            None => weighted_author_index(&mut rng, author_pool.len()),
        };
        author_indices.push(primary);
        let extra_authors = match rng.f64() {
            r if r < 0.70 => 0,
            r if r < 0.95 => 1,
            _ => 2,
        };
        while author_indices.len() < 1 + extra_authors {
            let candidate = weighted_author_index(&mut rng, author_pool.len());
            if !author_indices.contains(&candidate) {
                author_indices.push(candidate);
            }
        }
        authors_used.extend(author_indices.iter().copied());
        let author_names: Vec<String> = author_indices
            .iter()
            .map(|&i| author_pool[i].clone())
            .collect();

        let tag_count = rng.usize(0..=5);
        let mut tags = Vec::new();
        while tags.len() < tag_count {
            let tag = TAG_POOL[rng.usize(..TAG_POOL.len())];
            if !tags.contains(&tag.to_string()) {
                tags_used.insert(tag);
                tags.push(tag.to_string());
            }
        }

        if let Some(slot) = &series_slot {
            series_used.insert(slot.name.clone());
        }

        let book = BookAdd {
            title: build_title(&mut rng),
            author_names,
            tags: if tags.is_empty() { None } else { Some(tags) },
            series: series_slot.as_ref().map(|s| s.name.clone()),
            series_index: series_slot.as_ref().map(|s| s.index),
            publisher: None,
            publication_date: Some(build_pubdate(&mut rng)),
            rating: None,
            comments: None,
            identifiers: HashMap::new(),
            language: Some("eng".to_string()),
            file_paths: vec![stub_path.clone()],
        };

        let added = library
            .add_book(book)
            .map_err(|e| format!("add_book failed at book {book_number}: {e}"))?;
        let book_id = added.id;

        let cover = &cover_templates[rng.usize(..cover_templates.len())];
        library
            .set_book_cover(book_id, cover.clone())
            .map_err(|e| format!("set_book_cover failed at book {book_number}: {e}"))?;

        // ~40% read, ~15% explicitly unread, the rest left unset (Calibre's
        // tri-state "unknown").
        match rng.f64() {
            r if r < 0.40 => {
                library
                    .set_book_read_state(book_id, true)
                    .map_err(|e| format!("set_book_read_state failed: {e}"))?;
                read_count += 1;
            }
            r if r < 0.55 => {
                library
                    .set_book_read_state(book_id, false)
                    .map_err(|e| format!("set_book_read_state failed: {e}"))?;
            }
            _ => {}
        }

        if rng.f64() < 0.50 {
            let isbn = build_isbn13(&mut rng);
            library
                .upsert_book_identifier(book_id, "isbn".to_string(), isbn, None)
                .map_err(|e| format!("upsert_book_identifier failed: {e}"))?;
            isbn_count += 1;
        }

        let written = book_number + 1;
        if written % 500 == 0 || written == args.books {
            println!(
                "  {written}/{} books written ({:.1}s elapsed)",
                args.books,
                started.elapsed().as_secs_f64()
            );
        }
    }

    let _ = std::fs::remove_file(&stub_path);

    // Restore Calibre's default journal mode (checkpoints and removes -wal).
    drop(library);
    set_journal_mode(&db_path_str, "DELETE")?;

    let elapsed = started.elapsed();
    let size_bytes = dir_size_bytes(&args.dest);
    println!("\nDone.");
    println!("  Books written:    {}", args.books);
    println!(
        "  Authors used:     {} (pool of {})",
        authors_used.len(),
        author_pool.len()
    );
    println!("  Series created:   {}", series_used.len());
    println!(
        "  Tags used:        {} (pool of {})",
        tags_used.len(),
        TAG_POOL.len()
    );
    println!("  Marked read:      {read_count}");
    println!("  With ISBN:        {isbn_count}");
    println!("  Elapsed:          {:.1}s", elapsed.as_secs_f64());
    println!(
        "  Library size:     {:.1} MiB",
        size_bytes as f64 / (1024.0 * 1024.0)
    );
    println!("  Destination:      {}", args.dest.display());

    Ok(())
}
