# P1-01: Implement Schema Versioning and Migration System

**Priority:** P1 (Important)
**Estimated Effort:** 1 week
**Dependencies:** P0-01 (Database Triggers)
**Labels:** `database`, `migrations`, `compatibility`

---

## Problem Statement

libcalibre cannot handle existing Calibre databases with different schema
versions. Calibre tracks schema version via `PRAGMA user_version` and
incrementally upgrades from version 0 to 18+. Without this:

1. **Can't open older Calibre databases** - Schema differences cause errors
2. **Can't track libcalibre changes** - No way to know if triggers/tables are current
3. **Idempotence issues** - May try to create triggers/tables that already exist
4. **Incompatible with Calibre upgrades** - Calibre may upgrade schema unexpectedly

Currently, `libcalibre` assumes a particular database schema. Identify the current
expected version, document it, and add support for the same migrations as Calibre, starting
at the n-2 current version (to allow users who have not upgraded to upgrade, and
to test our migration system). Ensure we can track which migrations have run,
presumably similar to how calibre does it. test & validate they work correctly.

Determine some way to track libcalibre version separate from calibre version.
libcalibre versions may map many-to-one to a calibre schema, in the instance we
write buggy schema.

Ensure that these migrations are appropriately logged, however possible.

## Current State

Progress (CDL-66, 2026-11-03): `crates/libcalibre/src/schema_versions.rs`
reads `PRAGMA user_version`, creates new libraries at version 28 from a ported
copy of Calibre's `metadata_sqlite.sql`, ports `upgrade_version_25`, `_26` and
`_27`, and refuses libraries older than 25 with advice to open them in Calibre
once. `Library::upgrade` runs the pending steps in one exclusive transaction
after writing `metadata.db.backup-<version>-<unix time>` beside the database
(newest three kept); nothing upgrades on open. Still open: a libcalibre
version separate from Calibre's (to live on the `libraries` row in
`citadel.db`, not inside `metadata.db`), older migrations, and logging.

- ✅ Schema version read on open; minimum enforced
- ✅ Forward migrations 25→28 on explicit request, with backup
- ❌ No libcalibre-specific version tracking
- ⚠️ P0-01 registers triggers without checking version

---

## Research Phase

### Study Calibre's Schema Versioning

**Source:** [`src/calibre/db/schema_upgrades.py`](https://github.com/kovidgoyal/calibre/blob/master/src/calibre/db/schema_upgrades.py)

#### Schema Version System (Lines 15-39)

```python
class SchemaUpgrade:
    def __init__(self, db, library_path, field_metadata):
        db.execute('BEGIN EXCLUSIVE TRANSACTION')
        try:
            while True:
                uv = next(db.execute('pragma user_version'))[0]
                meth = getattr(self, f'upgrade_version_{uv}', None)
                if meth is None:
                    break
                else:
                    prints(f'Upgrading database to version {uv + 1}...')
                    meth()
                    db.execute(f'pragma user_version={uv + 1}')
        except Exception:
            db.execute('ROLLBACK')
            raise
        else:
            db.execute('COMMIT')
```

**How It Works:**
1. Check current `PRAGMA user_version`
2. Look for `upgrade_version_N()` method
3. Execute upgrade
4. Increment version
5. Repeat until no more upgrades
6. All wrapped in transaction

#### Current Schema Version

**Calibre v7.20.0:** Schema version **~30+** (exact number varies by version)

**Version History:**
- v0: Initial schema
- v1-17: Various upgrades (see `schema_upgrades.py`)
- v18+: Modern schema with identifiers, languages, etc.

### Migration Examples

#### Version 7: Add UUID Column (Lines 201-241)

```python
def upgrade_version_7(self):
    'Add uuid column'
    self.db.execute('''
        ALTER TABLE books ADD COLUMN uuid TEXT;
        DROP TRIGGER IF EXISTS books_insert_trg;
        DROP TRIGGER IF EXISTS books_update_trg;
        UPDATE books SET uuid=uuid4();
        -- Recreate triggers with uuid support
        CREATE TRIGGER books_insert_trg ...
    ''')
```

#### Version 18: Add Languages and Identifiers (Lines 477-514)

```python
def upgrade_version_18(self):
    '''
    Add a library UUID.
    Add an identifiers table.
    Add a languages table.
    NOTE: You cannot downgrade after this update
    '''
    self.db.execute('''
        CREATE TABLE library_id ...
        CREATE TABLE identifiers ...
        CREATE TABLE languages ...
        CREATE TABLE books_languages_link ...
        -- Migrate ISBN from books table to identifiers table
        INSERT INTO identifiers (book, type, val)
        SELECT id, 'isbn', isbn FROM books WHERE isbn IS NOT NULL;
    ''')
```

---

## Planning Phase

### Design Decisions

#### 1. Minimum Schema Version to Support

Two versons behind latest schema verions.

#### 2. libcalibre Version Tracking

Consider options for tracking libcalibre version, including other PRAGMA or
using user version but at a higher number. E.g., Use higher version numbers to track libcalibre changes

- Calibre: versions 0-30
- libcalibre: versions 100+ (to avoid conflicts)

**Example:**
- v100: libcalibre initial version (assumes Calibre v18+ base)
- v101: Added custom features
- v102: Schema changes for Rust-specific needs

#### 3. Migration System Design

**Structure:**
```rust
pub struct SchemaUpgrade {
    db: Connection,
    library_path: PathBuf,
}

impl SchemaUpgrade {
    pub fn upgrade(&mut self) -> Result<()> {
        loop {
            let version = get_user_version(&self.db)?;

            if version < MIN_CALIBRE_VERSION {
                return Err("Database too old, upgrade with Calibre first");
            }

            let upgraded = match version {
                18..=99 => {
                    // Calibre version - verify and pass through
                    verify_calibre_schema(&self.db)?;
                    set_user_version(&self.db, 100)?; // Jump to libcalibre versioning
                    true
                }
                100 => upgrade_to_101(&mut self.db)?,
                101 => upgrade_to_102(&mut self.db)?,
                // ... future versions
                _ => break, // No more upgrades
            };

            if !upgraded { break; }
        }
        Ok(())
    }
}
```

#### 4. When to Run Migrations

**Options:**
- On `establish_connection()` - Always check/upgrade
- On `CalibreClient::new()` - Before client initialization
- Manual trigger - User calls `migrate()`

**Recommendation:** On `establish_connection()` - automatic and safe

---

## Development Phase

### Example tasks

- Define Minimum Version

- Create Verification Function

**Purpose:** Verify Calibre database has expected schema

**Checks:**
- All required tables exist
- Required columns present
- Basic data integrity

**Tables to Verify:**
- books, authors, data, comments, identifiers
- tags, series, publishers, ratings, languages
- All link tables
- library_id, preferences, metadata_dirtied

#### Create First libcalibre Migration (v100)

**Purpose:** Establish libcalibre as schema manager

**Changes:**
- Verify all Calibre tables present
- Add libcalibre metadata table (optional)
- Set version to 100

#### Error Handling

**Scenarios:**
- Database too old → Clear error with upgrade instructions
- Corrupt database → Clear error with recovery instructions (which??)
- Migration fails → Rollback transaction, return error

#### 8. Testing Strategy

**Unit Tests:**
- Test get/set user_version
- Test each migration in isolation
- Test rollback on error

**Integration Tests:**
- Create old supported database, verify upgrades to v100
- Create up-to-date database (modern Calibre), verify works
- Create old, unsupported database, verify error

**Compatibility Tests:**
- Test with real Calibre databases (may require human input: set up space for
human to provide DB)
- Verify Calibre can still open after libcalibre modifications

---

## Acceptance Criteria

- [ ] Schema version tracking via PRAGMA user_version
- [ ] Minimum version check (v18+)
- [ ] Clear error for databases too old
- [ ] Migration runs automatically on connection
- [ ] All upgrades wrapped in transaction
- [ ] Rollback on migration failure
- [ ] Verification of Calibre schema structure
- [ ] Compatible with existing Calibre databases (v18+)
- [ ] All tests pass
- [ ] Clear documentation for users with old databases

---

## Testing Instructions

### Create Test Databases

**Using Calibre:**
```bash
# Create v18 database (Calibre 3.x)
calibre --with-library=/tmp/test-v18 --version 3.0

# Create modern database (Calibre 7.x)
calibre --with-library=/tmp/test-v7 --version 7.0
```

### Test Migration

```bash
cd src-tauri/libcalibre
cargo test test_schema_upgrade

# Manual test
cargo run --example test_migration -- /path/to/calibre/library
```

### Verify Calibre Compatibility

```bash
# After libcalibre opens and modifies
calibre --with-library=/tmp/test-v18

# Verify Calibre can still:
- Open library
- Read books
- Add books
- No schema errors
```

---

## References

- [Calibre Schema Upgrades](https://github.com/kovidgoyal/calibre/blob/master/src/calibre/db/schema_upgrades.py)
- [SQLite PRAGMA user_version](https://www.sqlite.org/pragma.html#pragma_user_version)
- [Diesel Migrations](https://docs.diesel.rs/master/diesel_migrations/index.html)

---

## Follow-up Issues

- [ ] P1-02: Add libcalibre version to metadata (track which version last modified)
- [ ] P2-18: Backup database before migrations
- [ ] P2-19: Migration logging and diagnostics
