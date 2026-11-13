# Calibre-Web Business Logic Analysis
**Reference Implementation for `libcalibre` Updates**

---

## Executive Summary

This document analyzes Calibre-Web's database access patterns and business logic to inform updates to `libcalibre`. Calibre-Web is the most popular open-source Calibre library manager (13k+ GitHub stars) and represents industry best practices for Calibre database interaction.

**Key Finding:** Calibre-Web uses **direct SQLite access via SQLAlchemy ORM** with extensive business logic for data consistency, validation, and file management.

---

## 1. Database Architecture

### 1.1 Connection Strategy

**Pattern: In-Memory SQLite with Attached Databases**

```python
# db.py:690-698
engine = create_engine('sqlite://',  # In-memory connection
                      echo=False,
                      isolation_level="SERIALIZABLE",
                      connect_args={'check_same_thread': False},
                      poolclass=StaticPool)

connection.execute(text("attach database '{}' as calibre;".format(dbpath)))
connection.execute(text("attach database '{}' as app_settings;".format(app_db_path)))
```

**Business Logic:**
- ✅ Uses `SERIALIZABLE` isolation level for data integrity
- ✅ Two databases: `metadata.db` (Calibre) + `app.db` (user settings)
- ✅ Static pool for connection reuse
- ✅ Thread-safe via `scoped_session`

**Recommendation for libcalibre:**
- Consider supporting `SERIALIZABLE` transactions
- Document concurrent access patterns

---

### 1.2 Schema Mapping

**Complete Table Coverage:**

| Table | Model | Relationship Type | Junction Table |
|-------|-------|-------------------|----------------|
| `books` | `Books` | Core entity | N/A |
| `authors` | `Authors` | Many-to-Many | `books_authors_link` |
| `tags` | `Tags` | Many-to-Many | `books_tags_link` |
| `series` | `Series` | Many-to-Many | `books_series_link` |
| `ratings` | `Ratings` | Many-to-Many | `books_ratings_link` |
| `languages` | `Languages` | Many-to-Many | `books_languages_link` |
| `publishers` | `Publishers` | Many-to-Many | `books_publishers_link` |
| `data` | `Data` | One-to-Many | Foreign key |
| `comments` | `Comments` | One-to-One | Foreign key |
| `identifiers` | `Identifiers` | One-to-Many | Foreign key |
| `custom_columns` | `CustomColumns` | Dynamic | Dynamic |

**Key Implementation Details:**

#### Books Table (db.py:403-448)
```python
class Books(Base):
    DEFAULT_PUBDATE = datetime(101, 1, 1, 0, 0, 0, 0)  # Year 101 sentinel value

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(collation='NOCASE'), nullable=False, default='Unknown')
    sort = Column(String(collation='NOCASE'))          # Title sort string
    author_sort = Column(String(collation='NOCASE'))    # Computed from authors
    timestamp = Column(TIMESTAMP, default=lambda: datetime.now(timezone.utc))
    pubdate = Column(TIMESTAMP, default=DEFAULT_PUBDATE)
    series_index = Column(String, nullable=False, default="1.0")  # STRING, not number!
    last_modified = Column(TIMESTAMP, default=lambda: datetime.now(timezone.utc))
    path = Column(String, default="", nullable=False)   # Relative: "Author/Title (ID)"
    has_cover = Column(Integer, default=0)              # Boolean as int
    uuid = Column(String)
    isbn = Column(String(collation='NOCASE'), default="")
    flags = Column(Integer, nullable=False, default=1)
```

**Critical Business Rules:**
1. **Default Pubdate:** Year `101` (not NULL, not Year 1)
2. **Series Index:** Stored as STRING (e.g., "1.0", "2.5") for decimal support
3. **Collation:** All text fields use `NOCASE` for case-insensitive queries
4. **Path Format:** `"Author Name/Title (BookID)"` - **relative to library root**
5. **has_cover:** Integer 0/1, not boolean
6. **Timestamps:** Always UTC timezone

---

## 2. Critical Business Logic Patterns

### 2.1 Author Handling

**Pattern: Bidirectional Name ↔ Sort Conversion with Rename Cascade**

#### Author Name Processing (editbooks.py:796-848)
```python
def prepare_authors(authr):
    # Split by '&' and convert commas to pipes
    input_authors = authr.split('&')
    input_authors = [it.strip().replace(',', '|') for it in input_authors]

    # Check for case-insensitive author renames
    for in_aut in input_authors:
        renamed_author = session.query(Authors).filter(
            func.lower(Authors.name).ilike(in_aut)
        ).first()

        if renamed_author and in_aut != renamed_author.name:
            # CASCADE: Update ALL books with this author
            all_books = session.query(Books).filter(
                Books.authors.any(Authors.name == renamed_author.name)
            ).all()

            for book in all_books:
                # Update author_sort field
                book.author_sort = book.author_sort.replace(
                    old_sorted_author, new_sorted_author
                )

                # If first author: rename directory AND files
                if author_index == 0:
                    rename_author_path(...)
                    rename_all_files_on_change(...)
```

**Business Rules:**
1. **Input Format:** Authors separated by `&`, with commas converted to `|`
   - Input: `"King, Stephen & Straub, Peter"`
   - Stored: `["King| Stephen", "Straub| Peter"]`

2. **Sort Generation:** Uses `get_sorted_author()` (helper.py:279-303)
   ```python
   def get_sorted_author(value):
       if ',' not in value:
           # "Stephen King" → "King, Stephen"
           # Handles suffixes: Jr., Sr., I, II, III, IV
           if value[-1] in ["JR", "SR", "I", "II", "III", "IV"]:
               # "Martin Luther King Jr" → "King, Martin Luther Jr"
               return value[-2] + ", " + " ".join(value[:-2]) + " " + value[-1]
           else:
               # "Stephen King" → "King, Stephen"
               return value[-1] + ", " + " ".join(value[:-1])
       return value  # Already in "Last, First" format
   ```

3. **Case-Insensitive Uniqueness:** Calibre treats `"Stephen King"` and `"stephen king"` as the same author
   - Uses `func.lower().ilike()` for lookups
   - Rename triggers cascade update across ALL books

4. **Directory Renaming:** When first author renamed, **entire book directory moves**
   - Old: `calibre_library/King, Stephen/Pet Sematary (123)/`
   - New: `calibre_library/King| Stephen/Pet Sematary (123)/`

**Recommendation for libcalibre:**
- ✅ Implement `get_sorted_author()` with suffix handling
- ✅ Add author rename with cascade update
- ⚠️ Consider file system operations impact
- ⚠️ Handle concurrent renames (what if two processes rename same author?)

---

### 2.2 Title Handling

**Pattern: Automatic Sort Field with Configurable Prefix Stripping**

#### Title Sort Generation (db.py:1061-1068)
```python
def _title_sort(title):
    # Uses user-configured regex (e.g., "^(The|A|An)\s+")
    title_pat = re.compile(config.config_title_regex, re.IGNORECASE)
    match = title_pat.search(title)
    if match:
        prep = match.group(1)
        title = title[len(prep):] + ', ' + prep  # "The Shining" → "Shining, The"
    return strip_whitespaces(title)

# Registered as SQLite function
conn.create_function("title_sort", 1, _title_sort)
```

**Business Rules:**
1. **Automatic Sort:** Title sort auto-generated unless overridden
   - `"The Stand"` → Sort: `"Stand, The"`
   - `"A Tale of Two Cities"` → Sort: `"Tale of Two Cities, A"`

2. **Configurable Prefixes:** User can set regex (default: `^(The|A|An)\s+`)
   - Multi-language support: French `"Le|La|Les"`, German `"Der|Die|Das"`, etc.

3. **Whitespace Normalization:** Always strips leading/trailing/multiple spaces

4. **Title-Author Filename Format:** (helper.py:476-477)
   ```python
   filename = get_valid_filename(title, chars=42) + ' - ' + \
              get_valid_filename(author, chars=42)
   # "Pet Sematary - King, Stephen.epub"
   ```

**Recommendation for libcalibre:**
- ✅ Add configurable title prefix stripping
- ✅ Support international prefixes (multi-language)
- ✅ Document filename generation rules

---

### 2.3 Path and Filename Generation

**Pattern: Author/Title (ID) Directory Structure with Sanitization**

#### Directory Structure (editbooks.py:886-890)
```python
def create_book_on_upload(meta):
    title_dir = get_valid_filename(title, chars=96)
    author_dir = get_valid_filename(author.name, chars=96)

    # "Calibre_Library/King, Stephen/Pet Sematary (123)/"
    path = os.path.join(author_dir, title_dir).replace('\\', '/')
```

#### Filename Sanitization (helper.py:240-260)
```python
def get_valid_filename(value, replace_whitespace=True, chars=128, force_unidecode=False):
    # Remove trailing periods
    if value[-1:] == '.':
        value = value[:-1] + '_'

    # Replace filesystem special chars
    value = value.replace("/", "_").replace(":", "_").strip('\0')

    # Optional: transliterate unicode
    if config_unicode_filename or force_unidecode:
        value = unidecode.unidecode(value)  # "Müller" → "Muller"

    if replace_whitespace:
        value = re.sub(r'[*+:\\\"/<>?]+', '_', value)  # *+:\"/<>? → _
        value = re.sub(r'[|]+', ',', value)            # | → ,

    # Truncate to char limit (UTF-8 aware)
    value = value.encode('utf-8')[:chars].decode('utf-8', errors='ignore')

    if not value:
        raise ValueError("Filename cannot be empty")
    return value
```

**Business Rules:**
1. **Character Limits:**
   - Directory names: 96 characters
   - Filenames: 42 characters (title) + 42 (author) + extension

2. **Reserved Characters:** Replaced with underscore
   - Windows: `*+:\\\"/<>?`
   - Pipe `|` → comma `,`

3. **Unicode Handling:**
   - **Default:** Preserve UTF-8 (e.g., "Müller")
   - **Optional:** Transliterate (e.g., "Muller") for compatibility

4. **Trailing Periods:** Windows doesn't allow, so `"Book." → "Book_"`

5. **Path Format Examples:**
   ```
   Normal:  "King, Stephen/Pet Sematary (123)/Pet Sematary - King, Stephen.epub"
   Special: "Müller, Hans/Böse Träume (456)/Böse Träume - Müller, Hans.pdf"
   Unicode: "村上春樹/1Q84 (789)/1Q84 - 村上春樹.epub"
   ```

**Recommendation for libcalibre:**
- ✅ Match filename sanitization rules exactly
- ✅ Support configurable Unicode transliteration
- ✅ Add path validation before file operations
- ⚠️ Test with international characters

---

### 2.4 Custom Columns (Dynamic Schema)

**Pattern: Runtime Schema Generation with Type-Specific Relationships**

#### Custom Column Discovery (db.py:560-628)
```python
@classmethod
def setup_db_cc_classes(cls, cc):
    # Query custom_columns table at runtime
    for row in cc:
        if row.datatype == 'series':
            # Series type: needs extra column for series_index
            dicttable = {
                '__tablename__': 'books_custom_column_' + str(row.id) + '_link',
                'book': Column(Integer, ForeignKey('books.id')),
                'map_value': Column('value', Integer, ForeignKey(...)),
                'extra': Column(Float),  # Series index!
                'value': association_proxy('asoc', 'value')
            }
            books_custom_column_links[row.id] = type(
                'books_custom_column_' + str(row.id) + '_link',
                (Base,), dicttable
            )

        elif row.datatype in ['rating', 'text', 'enumeration']:
            # Many-to-many junction table
            books_custom_column_links[row.id] = Table(
                'books_custom_column_' + str(row.id) + '_link',
                Column('book', Integer, ForeignKey('books.id')),
                Column('value', Integer, ForeignKey(...))
            )

        # Create value table
        ccdict = {'__tablename__': 'custom_column_' + str(row.id)}
        if row.datatype == 'float':
            ccdict['value'] = Column(Float)
        elif row.datatype == 'datetime':
            ccdict['value'] = Column(TIMESTAMP)
        elif row.datatype == 'bool':
            ccdict['value'] = Column(Boolean)
        # ... etc

        cc_classes[row.id] = type('custom_column_' + str(row.id), (Base,), ccdict)

        # Attach to Books model dynamically
        setattr(Books, 'custom_column_' + str(row.id),
                relationship(cc_classes[row.id], ...))
```

**Custom Column Types:**

| Calibre Type | SQLite Type | Junction Table? | Notes |
|--------------|-------------|----------------|-------|
| `text` | String | Yes | Tags, categories |
| `comments` | String | No | HTML/Markdown |
| `series` | String | Yes + `extra` | `extra` = series_index |
| `enumeration` | String | Yes | Dropdown values |
| `rating` | Integer | Yes | Scale: 0-10 (half stars * 2) |
| `int` | Integer | No | Direct column |
| `float` | Float | No | Direct column |
| `bool` | Boolean | No | 0/1 |
| `datetime` | TIMESTAMP | No | UTC timezone |

**Business Rules:**
1. **Series Custom Columns:** Have `extra` Float column for ordering (like built-in series)
2. **Rating Scale:** 0-10 (half-star increments: 5 stars = 10)
3. **Is_Multiple:** Determines if junction table needed
4. **Dynamic Access:**
   ```python
   # Access custom column ID 5
   book.custom_column_5  # Returns list or single value
   ```

5. **Ignored Datatypes:** `'composite'`, `'series'` (handled separately)

**Recommendation for libcalibre:**
- ✅ Add runtime custom column discovery
- ✅ Support all 9 datatypes
- ✅ Handle `is_multiple` flag correctly
- ⚠️ Series custom columns need `extra` field support

---

### 2.5 Metadata Modification Tracking

**Pattern: `metadata_dirtied` Table + Automatic Timestamping**

#### Dirty Metadata Tracking (db.py:754-764)
```python
def set_metadata_dirty(self, book_id):
    if not self.session.query(Metadata_Dirtied).filter(
        Metadata_Dirtied.book == book_id
    ).one_or_none():
        self.session.add(Metadata_Dirtied(book_id))

def delete_dirty_metadata(self, book_id):
    self.session.query(Metadata_Dirtied).filter(
        Metadata_Dirtied.book == book_id
    ).delete()
```

#### Timestamp Updates (editbooks.py:431)
```python
def edit_book_param(param, vals):
    # ... modify book ...
    book.last_modified = datetime.now(timezone.utc)
    calibre_db.session.commit()
```

**Business Rules:**
1. **When to Mark Dirty:**
   - Any metadata change (title, authors, tags, etc.)
   - Custom column modifications
   - File format additions

2. **When NOT to Mark Dirty:**
   - Cover changes
   - Read status updates
   - Archive bit changes

3. **Purpose:** Tells Calibre desktop to refresh cached metadata

4. **Timestamp Behavior:**
   - `timestamp`: Set once on creation, never modified
   - `last_modified`: Updated on every metadata change
   - Always UTC timezone

**Recommendation for libcalibre:**
- ✅ Add `set_metadata_dirty()` method
- ✅ Auto-update `last_modified` on mutations
- ⚠️ Document which operations trigger dirty bit

---

### 2.6 Relationship Management (The `modify_database_object` Pattern)

**Pattern: Diff-Based Updates with Orphan Cleanup**

#### Core Algorithm (editbooks.py:1659-1687)
```python
def modify_database_object(input_elements, db_book_object, db_object,
                          db_session, db_type):
    """
    Universal function for managing many-to-many relationships.

    Args:
        input_elements: List of new values (e.g., ["Fiction", "Sci-Fi"])
        db_book_object: Book's current relationship (e.g., book.tags)
        db_object: Model class (e.g., db.Tags)
        db_session: SQLAlchemy session
        db_type: 'author'|'tags'|'series'|'languages'|'publishers'|'custom'
    """

    # 1. Handle case changes (rename without delete+add)
    for rec_a, rec_b in zip(db_book_object, input_elements):
        if rec_a.get().casefold() == rec_b.casefold() and rec_a.get() != rec_b:
            rec_a.name = rec_b  # Preserve DB object, just rename

    # 2. Find elements to remove
    del_elements = []
    for existing in db_book_object:
        if existing not in input_elements:
            del_elements.append(existing)

    # 3. Find elements to add
    add_elements = []
    for new_elem in input_elements:
        if new_elem not in [e.name for e in db_book_object]:
            add_elements.append(new_elem)

    # 4. Remove orphans
    for del_elem in del_elements:
        db_book_object.remove(del_elem)
        if len(del_elem.books) == 0:  # No other books use this tag/author/etc
            db_session.delete(del_elem)  # Delete from database

    # 5. Add new elements (or link existing ones)
    for add_elem in add_elements:
        # Case-insensitive search
        existing = db_session.query(db_object).filter(
            func.lower(db_object.name).ilike(add_elem)
        ).first()

        if existing:
            db_book_object.append(existing)  # Link existing
        else:
            new_obj = db_object(add_elem)  # Create new
            db_session.add(new_obj)
            db_book_object.append(new_obj)

    return changed
```

**Business Rules:**
1. **Case-Insensitive Matching:** `"Fiction"` and `"fiction"` are the same tag
2. **Orphan Cleanup:** Auto-delete tags/authors/etc. when no books reference them
3. **Rename Optimization:** Changing `"Sci-Fi"` → `"Sci-fi"` doesn't create new record
4. **Batch Operations:** Efficiently handles adding/removing multiple items

**Type-Specific Creation:**
```python
if db_type == 'author':
    new_obj = db.Authors(name, get_sorted_author(name), link="")
elif db_type == 'series':
    new_obj = db.Series(name, sort=name)
elif db_type == 'publisher':
    new_obj = db.Publishers(name, sort=None)
else:  # tags, languages
    new_obj = db_object(name)
```

**Recommendation for libcalibre:**
- ✅ Implement universal relationship manager
- ✅ Support orphan cleanup (configurable?)
- ✅ Handle case changes without delete+add
- ⚠️ Consider performance with large tag sets

---

### 2.7 Ratings System

**Pattern: Shared Rating Objects with Half-Star Support**

#### Rating Handling (editbooks.py:1187-1208)
```python
def edit_book_ratings(to_save, book):
    # User input: 0.0 to 5.0 (half stars)
    rating_x2 = int(float(to_save.get("rating")) * 2)  # 0-10 scale

    # Check if rating value already exists in DB
    existing_rating = session.query(Ratings).filter(
        Ratings.rating == rating_x2
    ).first()

    if existing_rating:
        book.ratings.append(existing_rating)  # Reuse existing
    else:
        new_rating = Ratings(rating=rating_x2)  # Create new
        book.ratings.append(new_rating)

    # Remove old rating (don't delete, other books may use it)
    if len(book.ratings) > 0:
        book.ratings.remove(book.ratings[0])
```

#### Schema (db.py:303-320)
```python
class Ratings(Base):
    __tablename__ = 'ratings'

    id = Column(Integer, primary_key=True)
    rating = Column(Integer,
                   CheckConstraint('rating>-1 AND rating<11'),  # 0-10
                   unique=True)  # UNIQUE constraint!
```

**Business Rules:**
1. **Shared Objects:** All 3-star books share the same `Ratings(rating=6)` object
2. **Half-Star Support:**
   - User: 0.0, 0.5, 1.0, 1.5, ... 5.0
   - Database: 0, 1, 2, 3, ... 10
3. **Constraint:** `0 <= rating <= 10` enforced at DB level
4. **No Orphan Cleanup:** Ratings never deleted (small, fixed set of 11 values)

**Custom Column Ratings:**
Same pattern for rating-type custom columns:
```python
if c.datatype == 'rating':
    to_save[cc_string] = str(int(float(to_save[cc_string]) * 2))
```

**Recommendation for libcalibre:**
- ✅ Implement shared rating objects
- ✅ Add constraint validation
- ✅ Document 0-10 scale clearly

---

### 2.8 Identifiers (ISBN, ASIN, etc.)

**Pattern: Type-Value Pairs with URL Generation**

#### Schema (db.py:98-215)
```python
class Identifiers(Base):
    __tablename__ = 'identifiers'

    id = Column(Integer, primary_key=True)
    type = Column(String(collation='NOCASE'), nullable=False, default="isbn")
    val = Column(String(collation='NOCASE'), nullable=False)
    book = Column(Integer, ForeignKey('books.id'), nullable=False)

    def format_type(self):
        # Returns display name
        if self.type.lower() == 'isbn':
            return "ISBN"
        elif self.type.lower() == 'amazon':
            return "Amazon"
        # ... 15+ supported types

    def __repr__(self):
        # Returns URL for identifier
        if self.type.lower() == "isbn":
            return f"https://www.worldcat.org/isbn/{self.val}"
        elif self.type.lower() == "amazon":
            return f"https://amazon.com/dp/{self.val}"
        # ... etc
```

**Supported Identifier Types:**
1. **Standard:** ISBN, ISSN, DOI, ASIN
2. **Bookstores:** Amazon (+ country variants), Kobo, Barnes & Noble, Smashwords, eBooks.com
3. **Databases:** Goodreads, Google Books, ISFDB, Douban, Babelio, Lubimyczytac, Databáze knih, StoryGraph, Litres

**Business Rules:**
1. **Case-Insensitive Types:** `"ISBN"`, `"isbn"`, `"Isbn"` are the same
2. **Multiple per Book:** Book can have ISBN + ASIN + Goodreads, etc.
3. **Unique Constraint:** One book cannot have two identifiers of same type
4. **Amazon Country Codes:** `amazon_uk`, `amazon_jp`, `amazon_de`, etc.

#### Identifier Modification (editbooks.py:1690-1714)
```python
def modify_identifiers(input_identifiers, db_identifiers, db_session):
    input_dict = {id.type.lower(): id for id in input_identifiers}
    db_dict = {id.type.lower(): id for id in db_identifiers}

    # Check for case-insensitive duplicates
    if len(input_identifiers) != len(input_dict):
        error = True  # User tried to add ISBN twice

    # Update or delete existing
    for id_type, identifier in db_dict.items():
        if id_type in input_dict:
            identifier.val = input_dict[id_type].val  # Update value
        else:
            db_session.delete(identifier)  # Remove identifier

    # Add new identifiers
    for id_type, identifier in input_dict.items():
        if id_type not in db_dict:
            db_session.add(identifier)
```

**Recommendation for libcalibre:**
- ✅ Support all identifier types
- ✅ Implement URL generation
- ✅ Enforce type uniqueness per book
- ⚠️ Handle Amazon country variants

---

### 2.9 Language Handling

**Pattern: ISO 639 Codes with Display Name Translation**

#### Language Code Validation (editbooks.py:1260-1284)
```python
def edit_book_languages(languages, book, upload_mode=False):
    input_languages = languages.split(',')
    unknown_languages = []

    if upload_mode:
        # From file metadata: validate existing codes
        input_l = isoLanguages.get_valid_language_codes_from_code(
            get_locale(), input_languages, unknown_languages
        )
    else:
        # From user input: convert names to codes
        input_l = isoLanguages.get_language_code_from_name(
            get_locale(), input_languages, unknown_languages
        )

    for lang in unknown_languages:
        raise ValueError(f"'{lang}' is not a valid language")

    # If user has language filter, override for visibility
    if upload_mode and len(input_l) == 1:
        if input_l[0] != current_user.filter_language():
            input_l[0] = current_user.filter_language()

    return modify_database_object(input_l, book.languages,
                                   db.Languages, session, 'languages')
```

#### Schema (db.py:323-343)
```python
class Languages(Base):
    __tablename__ = 'languages'

    id = Column(Integer, primary_key=True)
    lang_code = Column(String(collation='NOCASE'), nullable=False, unique=True)

    def get(self):
        if hasattr(self, "language_name"):
            return self.language_name  # Display name (dynamically added)
        return self.lang_code  # Fallback to code
```

**Business Rules:**
1. **Storage:** ISO 639 codes (`"eng"`, `"fra"`, `"deu"`)
2. **Display:** Translated names (`"English"`, `"French"`, `"German"`)
3. **Multiple Languages:** Books can have multiple (e.g., bilingual editions)
4. **User Language Filter:** Can force uploaded books to user's filter language
5. **Case-Insensitive:** `"ENG"` and `"eng"` are the same

**Recommendation for libcalibre:**
- ✅ Use ISO 639-1 (2-letter) or 639-2 (3-letter) codes
- ✅ Support language name → code lookup
- ✅ Document multi-language support
- ⚠️ Consider including full ISO 639 table

---

### 2.10 Search Implementation

**Pattern: Multi-Field Full-Text Search with Custom Column Support**

#### Search Query Builder (db.py:958-988)
```python
def search_query(self, term, config):
    term = term.lower()

    # Author search: split by spaces, match all terms
    author_terms = re.split("[, ]+", term)
    author_filters = [
        Books.authors.any(func.lower(Authors.name).ilike(f"%{term}%"))
        for term in author_terms
    ]

    # Build search across all fields
    filter_expression = [
        Books.tags.any(func.lower(Tags.name).ilike(f"%{term}%")),
        Books.series.any(func.lower(Series.name).ilike(f"%{term}%")),
        Books.authors.any(and_(*author_filters)),
        Books.publishers.any(func.lower(Publishers.name).ilike(f"%{term}%")),
        func.lower(Books.title).ilike(f"%{term}%")
    ]

    # Add custom columns (except datetime, rating, bool, int, float)
    for c in custom_columns:
        if c.datatype not in ["datetime", "rating", "bool", "int", "float"]:
            filter_expression.append(
                getattr(Books, f'custom_column_{c.id}').any(
                    func.lower(cc_classes[c.id].value).ilike(f"%{term}%")
                )
            )

    return query.filter(or_(*filter_expression))
```

**Search Behavior:**
1. **Case-Insensitive:** All searches use `ILIKE`
2. **Partial Matches:** `"%term%"` allows substring matching
3. **Author Split:** `"stephen king"` searches for both terms in author names
4. **Multi-Field:** Searches title, authors, tags, series, publishers, custom columns
5. **Excluded Types:** Numeric and date custom columns not searched

**Recommendation for libcalibre:**
- ✅ Implement multi-field search
- ✅ Support custom column search
- ⚠️ Consider full-text search index for performance

---

### 2.11 Filtering and Access Control

**Pattern: User-Based Content Filtering with Tag/Language Restrictions**

#### Common Filters (db.py:767-809)
```python
def common_filters(self, allow_show_archived=False):
    # 1. Archived books filter
    if not allow_show_archived:
        archived_books = ub.session.query(ub.ArchivedBook).filter(
            ub.ArchivedBook.user_id == current_user.id,
            ub.ArchivedBook.is_archived == True
        ).all()
        archived_filter = Books.id.notin_([b.book_id for b in archived_books])
    else:
        archived_filter = true()

    # 2. Language filter
    if current_user.filter_language() == "all":
        lang_filter = true()
    else:
        lang_filter = Books.languages.any(
            Languages.lang_code == current_user.filter_language()
        )

    # 3. Denied tags (blacklist)
    negtags_list = current_user.list_denied_tags()
    neg_tags_filter = Books.tags.any(Tags.name.in_(negtags_list))

    # 4. Allowed tags (whitelist)
    postags_list = current_user.list_allowed_tags()
    pos_tags_filter = Books.tags.any(Tags.name.in_(postags_list))

    # 5. Custom column restrictions
    if config.config_restricted_column:
        pos_cc_filter = getattr(Books, f'custom_column_{column_id}').any(
            cc_classes[column_id].value.in_(allowed_values)
        )

    return and_(lang_filter, pos_tags_filter, ~neg_tags_filter,
                pos_cc_filter, ~neg_cc_filter, archived_filter)
```

**Business Rules:**
1. **Archived Books:** Per-user, hidden by default
2. **Language Filter:** Show only books in user's preferred language
3. **Tag Blacklist:** Hide books with denied tags (e.g., adult content)
4. **Tag Whitelist:** Show only books with allowed tags (e.g., kids' books)
5. **Custom Column Filter:** Admin can restrict by custom column value

**Recommendation for libcalibre:**
- ⚠️ User filtering may be application-specific (not library concern)
- ✅ Consider exposing filter hooks/callbacks
- ✅ Document that filters apply to ALL queries

---

### 2.12 File and Cover Management

**Pattern: Filesystem Operations with Database Sync**

#### Cover Storage (helper.py:879-916)
```python
def save_cover(img, book_path):
    # Always convert to JPEG (Calibre requirement)
    if img.headers.get('content-type') not in ALLOWED_IMAGE_TYPES:
        return False, "Only jpg/jpeg/png/webp/bmp supported"

    # Convert to JPEG with sRGB colorspace
    if use_ImageMagick:
        imgc = Image(blob=img.content)
        imgc.format = 'jpeg'
        imgc.transform_colorspace("srgb")

    # Save as "cover.jpg" in book directory
    cover_path = os.path.join(calibre_path, book_path, "cover.jpg")
    save_cover_from_filestorage(cover_path, "cover.jpg", imgc)
```

**Business Rules:**
1. **Filename:** Always `"cover.jpg"` (case-sensitive)
2. **Format:** Must be JPEG (converted from PNG/WebP/BMP if needed)
3. **Colorspace:** sRGB (for device compatibility)
4. **Location:** `{calibre_library}/{book.path}/cover.jpg`
5. **Database:** `books.has_cover` set to 1

#### File Format Management (helper.py:90-100, editbooks.py:1440-1477)
```python
# Adding format to existing book
file_name = book.path.rsplit('/', 1)[-1]
filepath = os.path.join(calibre_path, book.path)
saved_filename = os.path.join(filepath, file_name + '.' + file_ext)

# Check if format already exists
if calibre_db.get_book_format(book_id, file_ext.upper()):
    log.warning('Format already exists')
else:
    file_size = os.path.getsize(saved_filename)
    db_format = db.Data(book_id, file_ext.upper(), file_size, file_name)
    session.add(db_format)
```

**Data Table Schema (db.py:368-390):**
```python
class Data(Base):
    __tablename__ = 'data'

    id = Column(Integer, primary_key=True)
    book = Column(Integer, ForeignKey('books.id'), nullable=False)
    format = Column(String(collation='NOCASE'), nullable=False)  # "EPUB", "PDF"
    uncompressed_size = Column(Integer, nullable=False)  # In bytes
    name = Column(String, nullable=False)  # Filename without extension
```

**Business Rules:**
1. **Format Uppercase:** Always store as `"EPUB"`, `"PDF"`, never lowercase
2. **One Format per Book:** Can't have two EPUB files for same book
3. **Filename Match:** `data.name + '.' + data.format.lower()` = actual filename
4. **Size Field:** `uncompressed_size` (NOT the file size on disk for compressed formats)

**Recommendation for libcalibre:**
- ✅ Add cover save/load with JPEG conversion
- ✅ Enforce format uniqueness
- ✅ Store uncompressed size for EPUBs/MOBIs
- ⚠️ Handle filesystem errors gracefully

---

## 3. Implementation Checklist for libcalibre

### High Priority ✅ (Core Functionality)

- [ ] **Author sort generation** with suffix handling (Jr., Sr., I-IV)
- [ ] **Title sort generation** with configurable prefix stripping
- [ ] **Path/filename sanitization** matching Calibre rules exactly
- [ ] **Custom column discovery** at runtime (all 9 datatypes)
- [ ] **Relationship management** (tags, authors, series) with orphan cleanup
- [ ] **Ratings system** (0-10 scale, shared objects)
- [ ] **Identifiers** (ISBN, ASIN, etc.) with URL generation
- [ ] **Metadata dirty tracking** with `last_modified` auto-update
- [ ] **Case-insensitive uniqueness** for authors, tags, series, languages
- [ ] **Language code validation** (ISO 639)

### Medium Priority ⚠️ (Enhanced Features)

- [ ] **Multi-field search** across title, authors, tags, custom columns
- [ ] **Author rename cascade** (update all books + directories)
- [ ] **File operations** (cover save/load, format management)
- [ ] **Directory structure management** (Author/Title (ID) pattern)
- [ ] **Series custom columns** with `extra` field support
- [ ] **ISBN/identifier lookup** from online sources
- [ ] **Duplicate detection** (same author + title)

### Low Priority 💡 (Application-Specific)

- [ ] User-based filtering (archived, language, tags) - *May be app-level*
- [ ] Read status tracking - *Calibre-Web specific*
- [ ] Google Drive support - *Calibre-Web specific*
- [ ] Format conversion - *Requires Calibre CLI*
- [ ] Email sending - *Calibre-Web specific*

---

## 4. Key Differences from Official Calibre API

| Feature | Calibre Desktop | Calibre-Web | libcalibre Current |
|---------|----------------|-------------|-------------------|
| Database Access | In-memory cache | Direct SQLite | Direct SQLite ✅ |
| Custom Columns | Runtime schema | Runtime schema | ❓ |
| Author Sorting | get_sorted_author() | get_sorted_author() | ❌ Missing |
| Title Sorting | Configurable regex | Configurable regex | ❌ Missing |
| Ratings Scale | 0-10 (half stars) | 0-10 (half stars) | ❓ |
| Filename Rules | Complex sanitization | Complex sanitization | ❌ Needs review |
| Case Handling | Case-insensitive | Case-insensitive | ❓ |
| Orphan Cleanup | Automatic | Automatic | ❌ Missing |

---

## 5. Testing Recommendations

### Unit Tests Needed:
1. **Author sorting:**
   - `"Stephen King"` → `"King, Stephen"`
   - `"Martin Luther King Jr"` → `"King, Martin Luther Jr"`
   - `"King, Stephen"` → `"King, Stephen"` (already sorted)

2. **Filename sanitization:**
   - Windows reserved chars: `*:<>?"/\|`
   - Unicode: `"Müller"`, `"村上春樹"`
   - Trailing periods: `"Book."` → `"Book_"`

3. **Custom columns:**
   - All 9 datatypes
   - Series with `extra` field
   - `is_multiple` flag behavior

4. **Relationship management:**
   - Case changes: `"Sci-Fi"` → `"Sci-fi"`
   - Orphan cleanup when removing last book's tag
   - Adding existing vs. creating new

### Integration Tests:
1. Concurrent access (two processes editing same book)
2. Large libraries (100k+ books performance)
3. International characters in all fields
4. Schema migration (adding new custom columns)

---

## 6. Documentation Needs

### For Users:
- Path/filename generation rules
- Custom column type mapping
- Supported identifier types
- Rating scale (0-10 vs 0-5 stars)
- Language code reference (ISO 639)

### For Developers:
- Database schema diagram with relationships
- Business logic decision tree (when to mark dirty, etc.)
- Custom column dynamic schema generation
- Concurrent access patterns and locking

---

## 7. Breaking Changes to Consider

If you update libcalibre to match these patterns, consider:

1. **Author Sort Field:** If you add automatic sort generation, existing code may break
   - **Migration:** Offer optional auto-conversion tool

2. **Case-Insensitive Behavior:** If you enforce case-insensitive uniqueness
   - **Migration:** Detect and merge duplicates (e.g., `"Fiction"` + `"fiction"`)

3. **Filename Sanitization:** If rules change, existing paths become invalid
   - **Solution:** Provide migration tool to rename directories

4. **Custom Column Discovery:** If you switch from static to dynamic schema
   - **Breaking Change:** API for accessing custom columns will change

---

## 8. Performance Considerations

From Calibre-Web's implementation:

1. **Connection Pooling:** Uses `StaticPool` for reuse
2. **Scoped Sessions:** Thread-local sessions for concurrency
3. **PRAGMA cache_size:** Set to 10,000 pages (db.py:696)
4. **Lazy Loading:** Relationships loaded on-demand
5. **Batch Operations:** `modify_database_object` handles multiple items efficiently

**Recommendations for libcalibre:**
- ✅ Keep Diesel's compile-time query optimization
- ⚠️ Consider connection pooling for web apps
- ⚠️ Profile performance with large custom column counts

---

## 9. Questions for Your Team

1. **Scope:** Should libcalibre handle file operations (covers, formats), or just database?
2. **Concurrency:** What concurrent access patterns do you need to support?
3. **Breaking Changes:** Acceptable to change API for correctness?
4. **Custom Columns:** Should schema be static (current) or dynamic (like Calibre-Web)?
5. **User Filtering:** In-library or application-level concern?

---

## Appendices

### A. Full Calibre-Web Database Schema
*(See db.py:61-430 for complete SQLAlchemy models)*

### B. Helper Function Reference
*(See helper.py for all utility functions)*

### C. File Operation Flow Charts
*(See helper.py:394-567 for directory/file management)*

---

**Document Version:** 1.0
**Based on:** Calibre-Web commit `HEAD` (2025-11-06)
**Analysis Completed:** 2025-11-06
**Next Review:** After libcalibre updates
**Calibre-Web Repository:** https://github.com/janeczku/calibre-web (cloned to /tmp/calibre-web)
