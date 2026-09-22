#!/usr/bin/env python3
"""Generate a large fake-but-valid Calibre 7 library for Citadel demo/testing.

Starts from the schema of the bundled empty Calibre library
(src-tauri/resources/empty_7_2_calibre_lib.zip) so table definitions,
triggers, views and library preferences match a real Calibre 7.2 database
exactly, then fills it with generated authors, series, books, and one
minimal EPUB per book on disk.

The Calibre schema's books_insert_trg / series_insert_trg triggers call
custom SQL functions (title_sort(), uuid4()) that real Calibre registers on
every connection; we register equivalent deterministic Python
implementations so inserts succeed and stay reproducible.

Usage:
    python3 tools/make-demo-calibre-library.py
    python3 tools/make-demo-calibre-library.py --books 500 --seed 7 \
        --output ~/demo-libraries/custom
"""

from __future__ import annotations

import argparse
import io
import random
import re
import shutil
import sqlite3
import sys
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_ZIP = REPO_ROOT / "src-tauri" / "resources" / "empty_7_2_calibre_lib.zip"

DEFAULT_OUTPUT = (
    Path("~") / "Library" / "Application Support" / "software.everydaythings.citadel.dev"
    / "demo-libraries" / "sizable"
)
DEFAULT_SEED = 42
DEFAULT_BOOKS = 450
DEFAULT_AUTHORS = 120
DEFAULT_SERIES = 30
# Fixed anchor (not "now") so the same seed reproduces the same library
# regardless of when the script is run. Override with --anchor-date.
DEFAULT_ANCHOR_DATE = "2026-09-21"
TIMESPAN_YEARS = 3

FORMAT_NAME = "EPUB"
DATA_NAME = "book"  # stored without extension; libcalibre appends ".epub"
SERIES_RATIO = 0.4
PATH_COMPONENT_LIMIT = 62  # Calibre truncates each path component to this
ILLEGAL_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
LEADING_ARTICLE = re.compile(r"^(A|The|An)\s+", re.IGNORECASE)

EPUB_MIMETYPE = "application/epub+zip"
EPUB_UUID = "urn:uuid:00000000-0000-4000-8000-000000000000"
EPUB_DATE_TIME = (1980, 1, 1, 0, 0, 0)

FIRST_NAMES = [
    "Alice", "Marcus", "Elena", "Viktor", "Priya", "Hana", "Diego", "Sofia",
    "Liam", "Aisha", "Tomas", "Ingrid", "Kofi", "Mei", "Rafael", "Noor",
    "Bram", "Celeste", "Owen", "Yuki", "Farid", "Greta", "Nikolai", "Amara",
    "Luca", "Sana", "Clara", "Jonas", "Zara", "Emile", "Rosa", "Dmitri",
    "Leila", "Hugo", "Anya", "Felix", "Carmen", "Ivan", "Tessa", "Marco",
    "Nia", "Oscar", "Paloma", "Quentin", "Ruth", "Sven", "Talia", "Umar",
    "Vera", "Wren", "Ximena", "Yusuf", "Zoe", "Arthur", "Bea", "Callum",
    "Delia", "Ezra", "Fiona", "Gideon", "Helena", "Idris", "June", "Kai",
]

LAST_NAMES = [
    "Ashcroft", "Blackwood", "Castellanos", "Duval", "Everhart", "Fontaine",
    "Galloway", "Hargrove", "Ishikawa", "Jansen", "Kowalski", "Lindqvist",
    "Marchetti", "Nakamura", "Okafor", "Petrov", "Quintana", "Reyes",
    "Sinclair", "Thorne", "Underwood", "Vasquez", "Whitfield", "Xiao",
    "Yamamoto", "Zabala", "Abernathy", "Bellweather", "Calloway", "Dunmore",
    "Eastwood", "Fairchild", "Grayson", "Holloway", "Ingram", "Jessup",
    "Kensington", "Larkspur", "Moreau", "Nightingale", "Orsini", "Pemberton",
    "Quill", "Ravensworth", "Sterling", "Townsend", "Upshaw", "Vance",
    "Winslow", "Xanthos", "Youngblood", "Zeller", "Mercer", "Carrow",
    "Fleming", "Grafton", "Halloran", "Ivers", "Jarvis", "Kirkwood",
    "Lockhart", "Maddox", "Norwood", "Ostrander", "Prescott", "Rutledge",
]

ADJECTIVES = [
    "Crimson", "Silent", "Broken", "Golden", "Hidden", "Shattered", "Distant",
    "Midnight", "Velvet", "Iron", "Winter", "Scarlet", "Hollow", "Forgotten",
    "Wandering", "Electric", "Salted", "Paper", "Amber", "Glass", "Ashen",
    "Ember", "Feral", "Gilded", "Luminous", "Misty", "Pale", "Quiet",
    "Radiant", "Sallow", "Tidal", "Umbral", "Vivid", "Withered", "Zealous",
    "Bitter", "Crooked", "Dreadful", "Empty", "Fractured", "Gentle",
    "Howling", "Impenetrable", "Jagged", "Leaden", "Mourning", "Narrow",
    "Obsidian", "Perilous", "Restless", "Sunken", "Threadbare", "Unquiet",
    "Veiled", "Windswept", "Yawning", "Zephyr", "Cobalt", "Drowned",
    "Emberlit", "Frostbitten",
]

NOUNS = [
    "Cathedral", "Orchard", "Lantern", "Meridian", "Almanac", "Compass",
    "Garden", "Harbor", "Inheritance", "Journal", "Kingdom", "Labyrinth",
    "Machine", "Nomad", "Oracle", "Paradox", "Quarry", "Reckoning",
    "Sanctuary", "Telescope", "Umbrella", "Voyage", "Whistle", "Zenith",
    "Atlas", "Bell", "Cipher", "Doorway", "Engine", "Foxglove", "Glacier",
    "Hourglass", "Island", "Jetty", "Kestrel", "Ledger", "Mirror", "Nexus",
    "Observatory", "Pavilion", "Quiver", "Rookery", "Spindle", "Thresher",
    "Vault", "Watchtower", "Anchor", "Briar", "Cartographer", "Doctrine",
    "Estuary", "Fathom", "Gable", "Heron", "Isthmus", "Junction", "Kettle",
    "Locksmith", "Monsoon", "Nebula", "Overture", "Prism", "Reverie",
    "Signal", "Threshold", "Undertow", "Vigil",
]

SERIES_EPITHETS = [
    "Chronicles", "Saga", "Cycle", "Files", "Wars", "Legacy", "Codex",
    "Quartet", "Tapes", "Archive",
]


def sanitize_path_component(value: str) -> str:
    cleaned = ILLEGAL_CHARS.sub("_", value).strip(" .")
    return cleaned[:PATH_COMPONENT_LIMIT]


def calibre_title_sort(title: str) -> str:
    return LEADING_ARTICLE.sub("", title).rstrip()


def make_uuid4(rng: random.Random) -> str:
    raw = bytes(rng.getrandbits(8) for _ in range(16))
    raw = raw[:6] + bytes([raw[6] & 0x0F | 0x40]) + raw[7:8] \
        + bytes([raw[8] & 0x3F | 0x80]) + raw[9:]
    return str(uuid.UUID(bytes=raw))


def make_title(rng: random.Random, seen: set[str]) -> str:
    while True:
        pattern = rng.randrange(4)
        adj = rng.choice(ADJECTIVES)
        noun = rng.choice(NOUNS)
        noun2 = rng.choice(NOUNS)
        if pattern == 0:
            title = f"The {adj} {noun}"
        elif pattern == 1:
            title = f"{noun} of the {adj} {noun2}"
        elif pattern == 2:
            title = f"The {noun}'s {noun2}"
        else:
            title = f"{noun} and the {noun2}"
        if title not in seen:
            seen.add(title)
            return title


def build_authors(rng: random.Random, count: int) -> list[dict]:
    authors = []
    seen = set()
    while len(authors) < count:
        first = rng.choice(FIRST_NAMES)
        last = rng.choice(LAST_NAMES)
        name = f"{first} {last}"
        if name in seen:
            continue
        seen.add(name)
        middle = f" {rng.choice('ABCDEFGHIJKLMNOPRSTVW')}." if rng.random() < 0.3 else ""
        authors.append({
            "name": name,
            "sort": f"{last}, {first}{middle}",
        })
    return authors


def build_series(rng: random.Random, count: int) -> list[str]:
    series = []
    seen = set()
    while len(series) < count:
        epithet = rng.choice(SERIES_EPITHETS)
        if rng.random() < 0.5:
            name = f"The {rng.choice(ADJECTIVES)} {rng.choice(NOUNS)} {epithet}"
        else:
            name = f"{rng.choice(NOUNS)} {epithet}"
        if name in seen:
            continue
        seen.add(name)
        series.append(name)
    return series


def plan_series_membership(rng: random.Random, book_count: int, series_count: int) -> list[int]:
    """Return a series id per series-assigned book, or None for standalones."""
    target = min(book_count, int(round(book_count * SERIES_RATIO)))
    if series_count == 0 or target == 0:
        return [None] * book_count

    chosen = sorted(rng.sample(range(book_count), target))
    members_per_series = max(1, target // series_count)
    leftovers = target - members_per_series * series_count

    plan = []
    cursor = 0
    for i in range(series_count):
        size = members_per_series + (1 if i < leftovers else 0)
        plan.extend([i] * size)
    plan = plan[:target]

    assignment = [None] * book_count
    for book_index, series_index in zip(chosen, plan):
        assignment[book_index] = series_index
    return assignment


def build_epub() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        def add(name: str, data: str, stored: bool = False) -> None:
            info = zipfile.ZipInfo(name, date_time=EPUB_DATE_TIME)
            info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
            archive.writestr(info, data)

        add("mimetype", EPUB_MIMETYPE, stored=True)
        add(
            "META-INF/container.xml",
            '<?xml version="1.0"?>\n'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
            '  <rootfiles>\n'
            '    <rootfile full-path="OEBPS/content.opf"'
            ' media-type="application/oebps-package+xml"/>\n'
            '  </rootfiles>\n'
            '</container>\n',
        )
        add(
            "OEBPS/content.opf",
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"'
            ' unique-identifier="bookid">\n'
            '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"'
            ' xmlns:opf="http://www.idpf.org/2007/opf">\n'
            '    <dc:title>Demo Book</dc:title>\n'
            '    <dc:creator opf:role="aut">Citadel Demo Generator</dc:creator>\n'
            f'    <dc:identifier id="bookid">{EPUB_UUID}</dc:identifier>\n'
            '    <dc:language>en</dc:language>\n'
            '    <dc:date>2026-01-01</dc:date>\n'
            '  </metadata>\n'
            '  <manifest>\n'
            '    <item id="page" href="page.xhtml" media-type="application/xhtml+xml"/>\n'
            '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n'
            '  </manifest>\n'
            '  <spine toc="ncx"><itemref idref="page"/></spine>\n'
            '</package>\n',
        )
        add(
            "OEBPS/page.xhtml",
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN"'
            ' "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n'
            '<html xmlns="http://www.w3.org/1999/xhtml">\n'
            '<head><title>Demo Book</title></head>\n'
            '<body><h1>Demo Book</h1>'
            '<p>Generated demo content for Citadel library testing.</p></body>\n'
            '</html>\n',
        )
        add(
            "OEBPS/toc.ncx",
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
            f'  <head><meta name="dtb:uid" content="{EPUB_UUID}"/></head>\n'
            '  <docTitle><text>Demo Book</text></docTitle>\n'
            '  <navMap>\n'
            '    <navPoint id="np1" playOrder="1">\n'
            '      <navLabel><text>Start</text></navLabel>\n'
            '      <content src="page.xhtml"/>\n'
            '    </navPoint>\n'
            '  </navMap>\n'
            '</ncx>\n',
        )
    return buffer.getvalue()


def format_timestamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%d %H:%M:%S+00:00")


def extract_template_db(output_dir: Path) -> None:
    with zipfile.ZipFile(TEMPLATE_ZIP) as archive:
        archive.extract("metadata.db", output_dir)
    output_dir.joinpath(".calnotes").mkdir(exist_ok=True)


def prepare_output_dir(output_dir: Path) -> None:
    if output_dir.exists() and any(output_dir.iterdir()):
        if (output_dir / "metadata.db").is_file():
            for child in output_dir.iterdir():
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
        else:
            sys.exit(
                f"error: {output_dir} exists, is not empty, and does not look like a "
                "generated demo library (no metadata.db); refusing to overwrite"
            )
    output_dir.mkdir(parents=True, exist_ok=True)


def connect(db_path: Path, rng: random.Random) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.create_function("title_sort", 1, calibre_title_sort, deterministic=True)
    conn.create_function("uuid4", 0, lambda: make_uuid4(rng))
    return conn


def populate(conn: sqlite3.Connection, spec: argparse.Namespace, rng: random.Random) -> None:
    anchor = datetime.strptime(spec.anchor_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    span_start = anchor - timedelta(days=365 * TIMESPAN_YEARS)
    span_seconds = int((anchor - span_start).total_seconds())

    authors = build_authors(rng, spec.authors)
    series = build_series(rng, spec.series)

    conn.execute("BEGIN")
    try:
        for author in authors:
            conn.execute(
                "INSERT INTO authors (name, sort, link) VALUES (?, ?, '')",
                (author["name"], author["sort"]),
            )

        for name in series:
            conn.execute("INSERT INTO series (name, sort, link) VALUES (?, NULL, '')", (name,))

        membership = plan_series_membership(rng, spec.books, spec.series)
        series_counters = [1.0] * spec.series

        seen_titles: set[str] = set()
        for book_index in range(spec.books):
            book_id = book_index + 1
            title = make_title(rng, seen_titles)

            author_count = 2 if rng.random() < 0.15 else 1
            author_indices = rng.sample(range(len(authors)), author_count)
            author_sort = " & ".join(authors[i]["sort"] for i in author_indices)

            timestamp = span_start + timedelta(seconds=rng.randrange(span_seconds))
            last_modified = timestamp + timedelta(seconds=rng.randrange(1, 3600 * 24 * 180))
            last_modified = min(last_modified, anchor)
            pubdate = timestamp - timedelta(days=rng.randrange(0, 365 * 30))

            series_index_value = 1.0
            if membership[book_index] is not None:
                series_pos = series_counters[membership[book_index]]
                series_index_value = series_pos
                step = 1.0 if rng.random() >= 0.15 else 0.5
                series_counters[membership[book_index]] = series_pos + step

            path_author = sanitize_path_component(authors[author_indices[0]]["sort"])
            path_title = sanitize_path_component(title)
            book_path = f"{path_author}/{path_title} ({book_id})"

            conn.execute(
                """INSERT INTO books
                       (title, timestamp, pubdate, series_index, author_sort,
                        path, flags, has_cover, last_modified)
                   VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)""",
                (
                    title,
                    format_timestamp(timestamp),
                    format_timestamp(pubdate),
                    series_index_value,
                    author_sort,
                    book_path,
                    format_timestamp(last_modified),
                ),
            )

            for author_index in author_indices:
                conn.execute(
                    "INSERT INTO books_authors_link (book, author) VALUES (?, ?)",
                    (book_id, author_index + 1),
                )

            if membership[book_index] is not None:
                conn.execute(
                    "INSERT INTO books_series_link (book, series) VALUES (?, ?)",
                    (book_id, membership[book_index] + 1),
                )

        epub = build_epub()
        library_root = Path(spec.output).expanduser()
        for row in conn.execute("SELECT id, path FROM books ORDER BY id"):
            book_id, book_path = row
            book_dir = library_root / book_path
            book_dir.mkdir(parents=True, exist_ok=True)
            (book_dir / f"{DATA_NAME}.{FORMAT_NAME.lower()}").write_bytes(epub)
            conn.execute(
                "INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, ?, ?)",
                (book_id, FORMAT_NAME, len(epub), DATA_NAME),
            )
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a large fake-but-valid Calibre library for Citadel demos/tests."
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="library directory to create (default: %(default)s)")
    parser.add_argument("--books", type=int, default=DEFAULT_BOOKS)
    parser.add_argument("--authors", type=int, default=DEFAULT_AUTHORS)
    parser.add_argument("--series", type=int, default=DEFAULT_SERIES)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--anchor-date", default=DEFAULT_ANCHOR_DATE,
                        help="timestamps spread over the years before this"
                             " YYYY-MM-DD date (default: %(default)s)")
    spec = parser.parse_args()

    if not TEMPLATE_ZIP.is_file():
        sys.exit(f"error: template library not found at {TEMPLATE_ZIP}")
    if spec.books < 1 or spec.authors < 1 or spec.series < 1:
        sys.exit("error: --books/--authors/--series must be >= 1")

    spec.output = str(spec.output.expanduser())
    output_dir = Path(spec.output)
    prepare_output_dir(output_dir)

    rng = random.Random(spec.seed)
    db_path = output_dir / "metadata.db"
    extract_template_db(output_dir)

    conn = connect(db_path, rng)
    try:
        populate(conn, spec, rng)
    finally:
        conn.close()

    with sqlite3.connect(db_path) as check:
        counts = check.execute(
            """SELECT
                   (SELECT COUNT(*) FROM books),
                   (SELECT COUNT(*) FROM authors),
                   (SELECT COUNT(*) FROM series),
                   (SELECT COUNT(*) FROM books_authors_link),
                   (SELECT COUNT(*) FROM books_series_link),
                   (SELECT COUNT(*) FROM data)"""
        ).fetchone()
    books, authors_n, series_n, bal, bsl, data = counts
    print(f"library: {output_dir}")
    print(f"books={books} authors={authors_n} series={series_n} "
          f"book_author_links={bal} book_series_links={bsl} formats={data}")


if __name__ == "__main__":
    main()
