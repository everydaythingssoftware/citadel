# Calibre Database Access Research

**Purpose:** Document which projects access Calibre databases, what technology stacks they use, and how they implement database access. This will inform deeper analysis of business logic and implementation patterns.

**Last Updated:** 2025-11-06

---

## Table of Contents

1. [Calibre Database Schema Overview](#calibre-database-schema-overview)
2. [Python Projects](#python-projects)
   - [Calibre Official Database API](#1-calibre-official-database-api)
   - [Calibre-Web](#2-calibre-web) - See also: [**Detailed Implementation Guide**](./CALIBRE_WEB_IMPLEMENTATION.md)
   - [calibrestekje](#3-calibrestekje)
   - [pycalibre](#4-pycalibre)
   - [kobuddy](#5-kobuddy)
3. [Key Findings & Patterns](#key-findings--patterns)
4. [Recommendations](#recommendations)

---

## Calibre Database Schema Overview

### Database Structure
- **Database File:** `metadata.db` (SQLite)
- **Schema Version:** 26 (tracked via `PRAGMA user_version`)
- **Location:** Root of Calibre library folder

### Core Tables

**Entity Tables:**
- `books` - Main book records (id, title, sort, timestamp, pubdate, series_index, author_sort, isbn, lccn, path, flags, uuid, has_cover, last_modified)
- `authors` - Author information (id, name, sort, link)
- `publishers` - Publisher data (id, name, sort, link)
- `series` - Series groupings (id, name, sort, link)
- `tags` - Categorical tags (id, name, link)
- `ratings` - Rating values (id, rating 0-10, link)
- `languages` - Language codes (id, lang_code, link)

**Linking Tables (Many-to-Many):**
- `books_authors_link` - Books ↔ Authors
- `books_publishers_link` - Books ↔ Publishers (one-to-one)
- `books_series_link` - Books ↔ Series (one-to-one)
- `books_tags_link` - Books ↔ Tags
- `books_ratings_link` - Books ↔ Ratings (one-to-one)
- `books_languages_link` - Books ↔ Languages

**Content Tables:**
- `data` - Book file formats (id, book, format, uncompressed_size, name)
- `comments` - Book descriptions (id, book, text)
- `identifiers` - ISBN and other identifiers (id, book, type, val)
- `conversion_options` - Format conversion settings
- `books_plugin_data` - Plugin metadata

**Custom Metadata:**
- `custom_columns` - User-defined metadata field definitions (id, label, name, datatype, mark_for_delete, editable, display, is_multiple, normalized)
- Dynamic custom column tables created at runtime

**Annotations System:**
- `annotations` - User highlights and notes (id, book, format, user_type, user, timestamp, annot_id, annot_type, annot_data, searchable_text)
- `annotations_fts` - Full-text search (unicode61 tokenizer)
- `annotations_fts_stemmed` - Stemmed full-text search (porter tokenizer)
- `last_read_positions` - Reading progress tracking

**Tracking Tables:**
- `metadata_dirtied` - Changed metadata tracking
- `annotations_dirtied` - Changed annotations tracking
- `preferences` - System settings
- `library_id` - Unique library identifier

### Views
- `meta` - Denormalized book view with all relationships
- `tag_browser_*` views - Filtered browsing with counts and ratings (10 variants)

### Triggers
- **Auto-maintenance:** Automatic sort calculation, UUID generation
- **Annotations FTS:** Maintains both regular and stemmed indexes
- **Cascade deletion:** Removes all related data when book deleted
- **Foreign key enforcement:** 40+ triggers validating referential integrity

### Key Schema Characteristics
- **No native foreign keys** - Calibre uses triggers to simulate foreign key constraints
- **Dynamic schema** - Custom columns create tables at runtime
- **Normalization** - Many-to-many relationships properly normalized
- **Full-text search** - Dual FTS indexes (regular + stemmed) for annotations
- **Case-insensitive** - Most string columns use NOCASE collation

---

## Python Projects

### 1. Calibre Official Database API

**Official Calibre Source:** https://github.com/kovidgoyal/calibre

#### Status
✅ **Actively Maintained** (Official project, continuous development)

#### Purpose
Core database API for Calibre application itself. Provides the definitive reference implementation for Calibre database access.

#### Tech Stack
- **Language:** Python 3
- **Database Wrapper:** APSW (Another Python SQLite Wrapper)
- **Architecture:** In-memory cache layer over SQLite

#### Database Access Implementation

**Backend Layer (`src/calibre/db/backend.py`):**
- Uses APSW for low-level SQLite access
- Busy timeout: 10,000ms for concurrent access handling
- Connection pragmas: foreign keys enabled, temp storage, cache size 5000 pages
- Custom SQLite functions: `title_sort`, `author_to_author_sort`, `uuid4`, `lower`
- Custom collations: `PYNOCASE`, `icucollate` (ICU for proper Unicode sorting)
- Isolation level: `SERIALIZABLE` for strict consistency
- `StaticPool` to prevent connection pooling issues with SQLite

**Cache Layer (`src/calibre/db/cache.py`):**
- In-memory cache of metadata.db maintaining normalized form
- Thread-safe with multiple reader, single writer locking scheme
- `safe_read_lock` property prevents deadlocks with composite columns
- Field-based abstraction system
- Lazy metadata loading via `get_proxy_metadata()`

**Tables Layer (`src/calibre/db/tables.py`):**
- Abstracts different table types and relationships
- Dynamic custom column support

#### Schema Coverage
**Complete coverage** of all Calibre tables including:
- Core entities (books, authors, tags, series, publishers, languages, ratings)
- All linking tables
- Content tables (data, comments, identifiers)
- Custom columns (dynamically discovered and modeled)
- Annotations system with full-text search
- Reading progress tracking
- Metadata tracking

#### Business Logic Beyond CRUD

**Metadata Management:**
- Automatic `title_sort`/`author_sort` generation
- Series handling with automatic index assignment
- Path management synchronized with title/author changes
- Format metadata with hashing and verification

**Search & Filtering:**
- Full-text search across multiple fields
- Search restriction caching for query optimization
- Virtual libraries (preference-based filtering)
- Dynamic user-defined categories

**Concurrency & Transactions:**
- Multiple reader, single writer locking
- Read/write lock pairs for operations
- Methods decorated with `@read_api` or `@write_api` for automatic locking
- `SafeReadLock` checks for existing write locks to prevent upgrade errors
- Explicit transaction control with `session.commit()`/`session.rollback()`
- `engine.begin()` context manager for atomic multi-statement operations

**Performance Optimizations:**
- Format metadata cache (per-book, per-format)
- Formatter template cache
- Composite field caches
- Search result caching
- Cached format metadata with optional filesystem verification
- Lazy evaluation in multisort operations
- "Dirty book" tracking avoids redundant writes
- `PRAGMA cache_size = 10000`

**Advanced Features:**
- Notes system with full-text search indexing
- Backup system with OPF metadata persistence
- Annotation merging and consolidation
- Background job queue for format indexing
- Extra files management

#### Error Handling
- `OperationalError` caught for database schema issues
- `IOError` recovery with database reopening (handles system suspension)
- Graceful fallback for missing custom columns
- Validation during load operations with try-catch blocks
- Windows file locking issue handling

#### Schema Management
- `SchemaUpgrade` class handles database evolution
- Automatic schema version tracking via `user_version` pragma
- Initialization from `resources/metadata_sqlite.sql`
- Migration of legacy preferences and custom columns
- Cleanup of orphaned custom columns marked for deletion
- Custom columns auto-discovered at startup via `SELECT id, datatype FROM custom_columns`
- `setup_db_cc_classes()` generates relationship classes dynamically
- Foreign key triggers enforce referential integrity during deletions

#### Testing Approach
- Test database available at `src/calibre/db/tests/metadata.db`
- Comprehensive test suite in official repository
- Production-tested in millions of installations

#### API Usage Example
```python
from calibre.library import db

# Standalone access
db = db('Path to library').new_api

# Plugin context
db = self.gui.current_db.new_api

# Thread-safe operations
with db.safe_read_lock:
    books = db.all_book_ids()
    metadata = db.get_metadata(book_id)

# Prefer copy_format_to() over format_abspath() for thread-safety
db.copy_format_to(book_id, fmt, dest_path)
```

#### Documentation
- **Database API:** https://manual.calibre-ebook.com/db_api.html
- **Source Code:** https://github.com/kovidgoyal/calibre/blob/master/src/calibre/db/
- **Development Guide:** https://manual.calibre-ebook.com/develop.html

---

### 2. Calibre-Web

**GitHub:** https://github.com/janeczku/calibre-web

**📖 Detailed Implementation Guide:** See [CALIBRE_WEB_IMPLEMENTATION.md](./CALIBRE_WEB_IMPLEMENTATION.md) for comprehensive business logic analysis with code examples and implementation patterns for libcalibre.

#### Status
✅ **Actively Maintained**
- Latest release: v0.6.25 (August 24, 2025)
- 4,555 commits, 249 contributors
- 360 open issues
- Active Discord community

#### Purpose
Web application for browsing, reading, and downloading eBooks stored in a Calibre database. Provides modern web UI with extensive features.

#### Tech Stack
- **Language:** Python 3.7+
- **Database Access:** SQLAlchemy ORM
- **Web Framework:** Flask
- **Frontend:** HTML/JavaScript with template engine

#### Database Access Implementation

**Dual Database Architecture:**
1. **Calibre Database** (`metadata.db`) - Read-only access to Calibre library
2. **Application Database** (`app_settings.db`) - User management and app state

**Database Models:**

**Calibre Database Models (`cps/db.py`):**
- `Books` - Central model with extensive relationships
- `Authors`, `Tags`, `Series`, `Ratings`, `Languages`, `Publishers`
- `Identifiers` - Book identifiers (ISBN, DOI, Amazon, Goodreads, etc.)
- `Comments` - Book descriptions
- `Data` - File format storage
- `CustomColumns` - Dynamic custom metadata
- `Library_Id`, `Metadata_Dirtied`

**Application Models (`cps/ub.py`):**
- `User` - Authentication and preferences (role-based access control)
- `Shelf` - User-created collections with Kobo sync
- `BookShelf` - Junction table with ordering
- `ReadBook` - Reading status tracking (unread/in-progress/finished)
- `Bookmark` - Per-format bookmarks
- `KoboReadingState`, `KoboBookmark`, `KoboStatistics` - Kobo device sync
- `Thumbnail` - Generated thumbnail cache
- `ArchivedBook` - Archive status
- `User_Sessions` - Multi-device session tracking
- `RemoteAuthToken` - OAuth integration
- `Downloads` - Usage tracking

#### Schema Coverage
**Calibre Database:**
- ✅ All core entity tables
- ✅ All linking tables
- ✅ Content tables (data, comments, identifiers)
- ✅ Custom columns (dynamically discovered)
- ⚠️ Annotations (limited support)

**Application Extensions:**
- User management with fine-grained permissions
- Reading progress tracking
- Kobo device synchronization
- OAuth authentication
- Thumbnail caching

#### Business Logic Beyond CRUD

**CalibreDB Session Management:**
- `get_book()`, `get_filtered_book()`, `get_book_by_uuid()` - Query helpers
- `get_book_read_archived()` - Complex join with optional custom columns
- `common_filters()` - Language, tag, and archived status filtering
- `fill_indexpage_with_archived_books()` - Pagination with random selection
- `order_authors()` - Reorders authors per Calibre conventions
- `search_query()` - Full-text search across fields
- `speaking_language()` - Translates language codes with usage counts
- `check_exists_book()` - Duplicate detection

**Identifiers Model:**
- `format_type()` - Converts identifier types to display labels
- `__repr__()` - Generates external URLs for 20+ identifier services

**CustomColumns Model:**
- `get_display_dict()` - Parses JSON display configuration
- `to_json()` - Serializes with metadata for client consumption

**User Features:**
- Content hiding based on categories and custom columns per user
- OPDS feed generation for reader apps
- Metadata download integration (extensible via plugins)
- eBook format conversion through Calibre binaries

**Kobo Integration:**
- Shelf synchronization with Kobo devices
- Reading state tracking and sync
- Bookmark preservation
- Archive status management
- Event listeners auto-update parent timestamps on child modifications

#### Concurrency Handling
- `scoped_session(sessionmaker())` for thread-local session scope
- Isolation level: `SERIALIZABLE` for strict consistency
- `StaticPool` configured to prevent pooling issues
- Flask `teardown_appcontext()` hook closes sessions
- Explicit `session.commit()` and `session.rollback()`

#### Error Handling
- `OperationalError` caught for database schema issues
- `sqliteOperationalError` caught in function creation
- Custom exception logging via `log.error_or_exception()`
- Graceful fallback when custom columns don't exist

#### Performance Optimizations
- `PRAGMA cache_size = 10000`
- `cc_classes` global dict caches custom column model classes
- User-defined SQL functions created once
- `unidecode.unidecode()` for case-insensitive comparisons

#### Schema Management
- `setup_db()` attaches both databases
- Custom columns auto-discovered at startup
- `setup_db_cc_classes()` generates relationship classes for 5 datatypes
- Schema exceptions handled for different custom column types
- `check_valid_db()` verifies accessibility
- Database migration support for schema evolution

#### Testing Approach
- Test library included at `calibre-web/library/metadata.db`
- Active issue tracking for bugs
- Community testing via Discord

#### JSON Serialization
`AlchemyEncoder` class provides custom encoding:
- Handles `InstrumentedList` (SQLAlchemy relationships)
- Datetime serialization to ISO 8601
- Filters sensitive fields (passwords)
- Prevents book relationship cycles

#### Usage Example
```python
from cps.db import CalibreDB

# Initialize database
CalibreDB.setup_db('/path/to/calibre/library')

# Query books
session = CalibreDB.session()
books = session.query(Books).filter(Books.has_cover == True).all()

# Access relationships
for book in books:
    authors = book.authors  # SQLAlchemy relationship
    tags = book.tags
```

#### Notable Features
- Fine-grained per-user permissions
- Kobo sync support
- OAuth integration
- Custom column support matching Calibre
- OPDS feed generation
- Format conversion integration

---

### 3. calibrestekje

**PyPI:** https://pypi.org/project/calibrestekje/
**Docs:** https://calibrestekje.readthedocs.io/ (currently unavailable - 503 errors)
**Source:** https://git.coopcloud.tech/decentral1se/calibrestekje (currently unavailable)

#### Status
⚠️ **Unmaintained** (Last release March 2020)
- Version: 0.0.3 (all versions released same day)
- No updates since 2020
- Documentation site experiencing issues

#### Purpose
Python library prototyping Calibre database access with SQLAlchemy at finer granularity than Calibre's native interface.

#### Tech Stack
- **Language:** Python ≥3.6
- **Database Access:** SQLAlchemy ORM
- **Optional:** Flask extension for web prototyping

#### Database Access Implementation
Uses SQLAlchemy declarative models with direct SQLite connection:
```python
from calibrestekje import init_session, Book, Tag

session = init_session("sqlite:///metadata.db")
```

#### Schema Coverage
**Known Models:**
- `Book` - Main book entity
- `Tag` - Categorical tags
- `Author` - Author information
- `Publisher` - Publisher data

**Coverage Unknown:**
- ⚠️ Series, ratings, languages, comments, identifiers, data (not documented)
- ⚠️ Custom columns support unclear
- ⚠️ Annotations support unclear

#### Business Logic Beyond CRUD
Based on limited documentation:
```python
# Filtering and querying
books = session.query(Book).filter(Book.publishers == None)

# Relationship manipulation
tag = Tag(name='radical')
book.tags.append(tag)
session.commit()

# Joining
books_with_authors = session.query(Book).join(Author)
```

#### Concurrency Handling
⚠️ **Not documented** - Likely relies on SQLAlchemy's default session management

#### Error Handling
⚠️ **Not documented**

#### Performance Optimizations
⚠️ **Not documented**

#### Schema Management
⚠️ **Not documented** - Unknown how Calibre schema changes are handled

#### Testing Approach
⚠️ **Not documented**

#### Open Questions
- What's the model completeness (all tables covered)?
- Do they provide higher-level APIs beyond raw SQLAlchemy?
- How do they handle Calibre schema changes?
- Is there any business logic or just models?
- What about custom columns?
- Concurrency handling approach?
- Error handling patterns?

#### Limitations
- Early version (0.0.3) suggests prototype stage
- No recent activity or maintenance
- Documentation incomplete/unavailable
- Source repository unavailable
- Unknown production readiness

---

### 4. pycalibre

**PyPI:** https://pypi.org/project/pycalibre/
**GitHub:** https://github.com/jgeldart/pycalibre

#### Status
⚠️ **Alpha Stage** (Development status: 3 - Alpha)
- Version: 0.1.0 (Released March 26, 2025)
- Requires Python ≥3.11, <4.0
- Personal project: "to help me write maintenance and analysis scripts"

#### Purpose
Python library for interacting with Calibre ebook libraries, facilitating management of books, metadata, and library structure.

#### Tech Stack
- **Language:** Python ≥3.11, <4.0
- **Database Access:** Unknown (not documented)
- **License:** MIT

#### Database Access Implementation
Uses context manager pattern:
```python
from pycalibre import Library

with Library("path/to/library") as library:
    # Operations here
    books = library.find_books(author="Smith")
```

**Implementation details not documented:**
- ⚠️ Unknown if using SQLAlchemy, direct SQLite, or Calibre API
- ⚠️ Unknown connection pooling strategy
- ⚠️ Unknown transaction management

#### Schema Coverage
**Known Classes:**
- `Library` - Context manager for library access
- `Book` - Individual ebook entity with metadata
- `Format` - Different file formats of books

**Features:**
- ✅ Standard Calibre metadata (authors, titles, tags)
- ✅ Custom columns as native properties
- ✅ Multiple ebook format files
- ⚠️ Unknown coverage of series, ratings, languages, etc.

#### Business Logic Beyond CRUD
- `find_books()` - Search with author filtering
- Metadata manipulation (titles, tags)
- Custom column access as native properties
- Format retrieval and file access
- Add/remove operations

#### Concurrency Handling
⚠️ **Not documented**

#### Error Handling
⚠️ **Not documented**

#### Performance Optimizations
⚠️ **Not documented**

#### Schema Management
⚠️ **Not documented** - No information on handling Calibre schema changes

#### Testing Approach
⚠️ **Not documented**

#### Limitations
- Alpha development stage
- Minimal documentation
- Personal project scope
- Unknown production readiness
- Technical implementation details not public

---

### 5. kobuddy

**GitHub:** https://github.com/karlicoss/kobuddy

#### Status
✅ **Maintained** (Moderate activity)
- Latest release: v0.4.20241020
- 167 stars, 113 commits
- Python 3.9+ (dropped 3.8 in latest release)

#### Purpose
**Different focus:** Backup and parse **Kobo device database**, not Calibre database. Extracts notes, highlights, reading progress from Kobo e-readers.

#### Tech Stack
- **Language:** Python 3.9+
- **Database Access:** Direct SQLite3
- **Target Database:** Kobo device `KoboReader.sqlite` (not Calibre's `metadata.db`)
- **Testing:** pytest, mypy, ruff

#### Database Access Implementation
Direct SQLite access to Kobo device database:
```python
# Automatic device detection via USB
kobuddy books

# Manual database path
kobuddy --db /path/to/KoboReader.sqlite books
```

#### Schema Coverage
**Kobo Device Schema (not Calibre):**
- ✅ Books from Kobo device
- ✅ Reading progress events
- ✅ Annotations (highlights, bookmarks, notes)
- ✅ Timestamps and completion percentages

**Reverse-engineered data structures:**
- `Book` objects - Titles and metadata
- `EventTbl` - Various event types
- `Annotation` structures - Bookmarks, highlights, comments
- Progress tracking with metrics

#### Business Logic Beyond CRUD
- Reading timeline reconstruction from discrete events
- Metrics calculation (e.g., "total time spent: 200 minutes")
- Event type reverse-engineering from Kobo format
- Progress percentage tracking

#### Error Handling
- `--errors {throw,return}` parameter
- "throw" mode: raises exceptions immediately
- "return" mode: defensive handling, continues when possible

#### Performance Optimizations
⚠️ **Not documented**

#### Concurrency Handling
⚠️ **Not applicable** - Single-user device backup tool

#### Schema Management
- Reverse-engineered Kobo device schema
- Community contributions welcomed for additional events

#### Testing Approach
- pytest-based testing (pytest.ini present)
- Type checking with mypy
- Linting with ruff
- Configuration files present (conftest.py)

#### Known Limitations
- Tested primarily on Kobo Aura One
- Compatibility with other Kobo models may vary
- Requires reverse-engineering for new event types

#### Note
**This project does NOT access Calibre databases** - it accesses Kobo e-reader device databases. Included here as it represents a related domain (ebook metadata) but different database schema.

---

## Key Findings & Patterns

### Database Access Approaches

**1. APSW (Calibre Official)**
- Low-level SQLite wrapper
- Direct control over connections, pragmas, custom functions
- Best for performance-critical operations
- Requires deep SQLite knowledge

**2. SQLAlchemy ORM (Calibre-Web, calibrestekje)**
- High-level abstraction
- Relationship management
- Query builder
- Easier development but less control

**3. Direct SQLite3 (kobuddy)**
- Python standard library
- Simple, no dependencies
- Manual query construction
- Good for read-only tools

**4. Unknown/Abstracted (pycalibre)**
- Implementation hidden
- Focus on ease of use
- May wrap Calibre API or use direct access

### Common Patterns

**Schema Discovery:**
- All projects must handle dynamic custom columns
- Custom columns discovered at runtime via queries
- SQLAlchemy projects generate model classes dynamically

**Concurrency Strategies:**
- SQLite busy timeout (10,000ms typical)
- Serializable isolation level
- Multiple reader, single writer locking
- Thread-local sessions (SQLAlchemy)

**Performance Optimizations:**
- In-memory caching (Calibre official)
- Increased cache_size pragma
- Custom SQLite functions for sorting
- Lazy loading strategies

**Business Logic Locations:**
1. **Calibre Official:** Deep integration, extensive logic in cache layer
2. **Calibre-Web:** User-facing features, read status, Kobo sync
3. **Libraries:** Minimal logic, mostly data access

### Schema Compatibility

**Challenges:**
- Custom columns create dynamic schema
- Schema version upgrades (currently v26)
- Trigger-based foreign key simulation
- Case-insensitive collations

**Approaches:**
1. **Calibre Official:** Schema migration system with version tracking
2. **Calibre-Web:** Runtime discovery, graceful degradation
3. **Libraries:** Unknown/minimal handling

### Testing Strategies

**Production-Tested:**
- Calibre Official (millions of users)
- Calibre-Web (active community)

**Limited Testing:**
- calibrestekje (unclear)
- pycalibre (undocumented)
- kobuddy (pytest suite)

---

## Recommendations

### For Citadel Development

**If Building Direct Database Access:**

1. **Reference Implementation Priority:**
   - Study Calibre's official `backend.py` and `cache.py`
   - This is the source of truth for schema and behavior

2. **Concurrency Requirements:**
   - Implement multiple reader, single writer locking if multi-threaded
   - Use SQLite busy timeout (10,000ms minimum)
   - Consider read-only mode for query-only operations

3. **Schema Handling:**
   - Query `custom_columns` table at startup
   - Generate models/types dynamically for custom columns
   - Plan for schema version changes (check `PRAGMA user_version`)

4. **Performance:**
   - Set `PRAGMA cache_size = 10000` minimum
   - Cache frequently accessed metadata
   - Use custom SQLite functions for sorting (title_sort, author_sort)
   - Consider in-memory cache layer like Calibre official

5. **Error Handling:**
   - Handle `OperationalError` for schema issues
   - Implement retry logic with backoff
   - Graceful degradation for missing custom columns

**If Using Existing Library:**

**Best Options:**
1. **Calibre Official API** (if Python interop possible)
   - Most complete, battle-tested
   - Full schema coverage including custom columns
   - Proper concurrency and performance
   - Risk: Python/Rust integration complexity

2. **Calibre-Web Models** (study for patterns)
   - SQLAlchemy implementation reference
   - Good coverage of core schema
   - Active maintenance
   - Can extract just the ORM models

3. **Direct SQLite Access** (if read-only)
   - Simplest approach
   - Full control
   - Use Calibre's schema SQL as reference
   - Implement only needed features

**Avoid:**
- calibrestekje (unmaintained, incomplete docs)
- pycalibre (alpha stage, undocumented internals)

### Architecture Considerations

**Read-Only vs. Read-Write:**
- **Read-Only:** Much simpler, fewer concurrency issues, can use direct SQLite
- **Read-Write:** Must handle locking, dirty tracking, potential corruption

**Custom Columns:**
- Essential feature for many users
- Complex to implement (5+ datatypes, dynamic tables)
- Consider priority: support later if starting fresh

**Annotations:**
- Newer feature (schema v26)
- Full-text search requirements
- May not be needed initially

**Performance Targets:**
- Large libraries can have 10,000+ books
- Custom columns add significant complexity
- Consider pagination for UI
- Lazy loading for metadata

### Testing Strategy

**Required Tests:**
1. Schema compatibility across Calibre versions
2. Custom column handling (all 5 datatypes)
3. Concurrent access (if multi-threaded)
4. Large library performance (10,000+ books)
5. Unicode handling (author names, titles)
6. Trigger behavior (foreign key simulation)

**Test Data:**
- Use Calibre's official test database
- Generate custom column scenarios
- Test with various schema versions

---

## Resources

### Documentation
- **Calibre Official API:** https://manual.calibre-ebook.com/db_api.html
- **Calibre Development:** https://manual.calibre-ebook.com/develop.html
- **Calibre GitHub:** https://github.com/kovidgoyal/calibre

### Schema Reference
- **Schema SQL:** https://github.com/kovidgoyal/calibre/blob/master/resources/metadata_sqlite.sql
- **Backend Implementation:** https://github.com/kovidgoyal/calibre/blob/master/src/calibre/db/backend.py
- **Cache Implementation:** https://github.com/kovidgoyal/calibre/blob/master/src/calibre/db/cache.py

### Active Projects
- **Calibre-Web:** https://github.com/janeczku/calibre-web
- **Calibre-Web DB Models:** https://github.com/janeczku/calibre-web/blob/master/cps/db.py

### Community
- **MobileRead Forums:** https://www.mobileread.com/forums/ (Calibre section)
- **Calibre-Web Discord:** Active community support

---

## Appendix: Follow-up Questions Answered

### calibrestekje

**Q: What's the model completeness (all tables covered)?**
A: ⚠️ Incomplete/Unknown - Only Book, Author, Tag, Publisher documented. Series, ratings, languages, comments, identifiers, data, custom columns not confirmed.

**Q: Do they provide higher-level APIs beyond raw SQLAlchemy?**
A: ⚠️ Unknown - Documentation suggests raw SQLAlchemy query patterns. No evidence of higher-level abstractions.

**Q: How do they handle Calibre schema changes?**
A: ⚠️ Unknown - No documentation found. Likely does not handle migrations.

**Q: Is there any business logic or just models?**
A: Appears to be just models - Example code shows basic CRUD and relationship manipulation.

### Calibre Official API

**Q: Complete schema coverage?**
A: ✅ Yes - All tables, including dynamic custom columns.

**Q: Business logic beyond CRUD?**
A: ✅ Extensive - Metadata standardization, search, caching, path management, notes, annotations, backups, virtual libraries.

**Q: Concurrency handling?**
A: ✅ Sophisticated - Multiple reader/single writer locking, safe_read_lock, automatic lock decoration, transaction control.

**Q: Performance optimizations?**
A: ✅ Extensive - Multi-layer caching, lazy evaluation, dirty tracking, increased pragmas, custom functions.

**Q: Error handling patterns?**
A: ✅ Comprehensive - OperationalError, IOError with recovery, validation, graceful fallbacks.

**Q: Testing approach?**
A: ✅ Production-tested in millions of installations, test database available.

**Q: How they handle Calibre schema changes?**
A: ✅ SchemaUpgrade class with version tracking, automatic migration, preference migration.

**Q: Notable bugs/limitations?**
A: Production-ready, but complexity high. Windows file locking edge cases handled.

### Calibre-Web

**Q: Complete schema coverage?**
A: ✅ Mostly - All core tables, custom columns. Limited annotations support.

**Q: Business logic beyond CRUD?**
A: ✅ Extensive - User permissions, reading status, Kobo sync, OPDS feeds, search, filtering, metadata download.

**Q: Concurrency handling?**
A: ✅ Good - Scoped sessions, serializable isolation, explicit transaction control.

**Q: Performance optimizations?**
A: ✅ Good - Caching (10000 cache size), function caching, unidecode for comparisons.

**Q: Error handling patterns?**
A: ✅ Good - OperationalError handling, custom logging, graceful fallbacks.

**Q: Testing approach?**
A: ✅ Active - Test library included, community testing, issue tracking.

**Q: How they handle Calibre schema changes?**
A: ✅ Runtime discovery, schema validation, migration support.

**Q: Notable bugs/limitations?**
A: Production-ready, 360 open issues tracked, active development.

---

**End of Research Document**
