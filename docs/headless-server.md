# Headless OPDS server

`citadel-server` serves one Calibre library over the same OPDS runtime used by
the desktop application. It has no desktop, WebView, or remote management UI.

Copy `crates/citadel-server/example-config.toml`, use absolute paths for the
library, create the first user, then run the server:

```sh
CONFIG=/absolute/path/to/citadel-server.toml
cargo run -p citadel-server -- --config "$CONFIG" users add alice
cargo run -p citadel-server -- --config "$CONFIG"
```

## Users and access

Citadel users live in `citadel.db` in the state directory, never inside the
library (see [ADR 0009](adr/0009-citadel-users-and-sessions.md)). The server
always requires sign-in. Each user has:

- a **sign-in password** for the browser, stored as an Argon2id hash;
- an **OPDS app password** for e-readers, revealable at any time;
- **library access** (a grant). Users without access to the served library
  cannot see it in the browser or OPDS. A separate user, such as a child's
  account, is how to give someone narrower access.

The operator manages users from the command line. Commands edit `citadel.db`
directly and do not require stopping the server; OPDS picks up changes within a
few seconds, and browser sessions are checked on every request.

```text
citadel-server --config <path> users list
citadel-server --config <path> users add <name> [--password-stdin] [--no-grant]
citadel-server --config <path> users remove <name>
citadel-server --config <path> users reset-password <name> [--password-stdin]
citadel-server --config <path> users app-password <name> [--rotate]
citadel-server --config <path> grant <name> [<library-id>]
citadel-server --config <path> revoke <name> [<library-id>]
citadel-server --config <path> libraries list
```

`users add` grants access to the configured library unless `--no-grant` is
given, and prints a generated sign-in password and the OPDS app password. Generated
sign-in passwords are shown only once; `--password-stdin` reads one from the
first line of standard input instead (at least 8 characters). `reset-password`
also signs the user out of every browser. `app-password` reveals the OPDS
password again, and `--rotate` replaces it. `grant` and `revoke` default to the
configured library. Usernames are case-insensitive and can't contain a colon.

The server refuses to start until at least one user can access the library.

### Upgrading from `CITADEL_OPDS_USERS`

`CITADEL_OPDS_USERS` and `sharing.authenticationEnabled` have been removed. Delete
`authenticationEnabled` from `[sharing]` (the server reports it as an error),
create a user for each former OPDS reader with `users add`, and give readers
their new app password from `users app-password`.

## State and listeners

`stateDirectory` is optional. On Unix it defaults to `$XDG_STATE_HOME/citadel`
when XDG_STATE_HOME is absolute, otherwise `~/.local/state/citadel`. On Windows
it defaults to the local application-data directory's `citadel` subdirectory.
An explicit override must be absolute. It holds `citadel.db` (mode 0600 on Unix)
and `secrets/credentials.key`, which seals users' provider keys inside
`citadel.db` (ADR 0011); back them up together. Without the key file, users have
to re-enter their provider keys.

### Library access

The server opens `libraryPath` for writing, as the desktop app does. Opening it
switches the database to SQLite's WAL journal and installs Citadel's triggers.
If the library can't be opened for writing (for example, a read-only file or
folder), the server logs `library=read-only` with the reason and serves it
read-only: browsing and OPDS work, and writes answer 403 `readOnly`.

Only one program should write to a library at a time. Running Calibre desktop,
the Citadel desktop app or another server against the same library while this
server writes is unsupported: SQLite keeps each change intact, but the others'
caches won't see Citadel's changes, and edits made elsewhere aren't tracked.

The process logs lifecycle state and every concrete OPDS URL. It remains in the
foreground until SIGINT or SIGTERM, then gracefully closes its listeners.
The localNetworks and allInterfaces targets use the desktop IPv4/IPv6 policy.

For a reverse proxy on the same host, the target can instead use explicit
concrete addresses without depending on interface discovery:

```toml
[sharing.target.addresses]
addresses = ["127.0.0.1", "::1"]
```

Wildcard, link-local and non-unicast addresses are rejected. Configure every
concrete address on which the process should listen.

Citadel serves plain HTTP. For access beyond a trusted local network, place it
behind an externally managed TLS reverse proxy and firewall. Service
supervision, certificates, public-exposure controls, and container or operating
system packages are not provided by this initial server.

## Validation and deployment

Build the host with `cargo build --release -p citadel-server`. This selects the headless package and does not build Tauri. Its configuration uses `sharing.target = "localNetworks"` or `"allInterfaces"`, or the explicit-address table shown above; do not combine those forms.

The Unix process test exercises the user commands, OPDS app passwords, browser sign-in, live user changes, catalog navigation, acquisition, and SIGTERM shutdown. The non-Unix Ctrl-C handler requires platform validation; it is not covered by that test. OPDS request limits are described in [Sharing](opds-sharing.md).

To generate a disposable validation library, provide an EPUB you can use for testing:

```sh
cargo run -p libcalibre --example create_opds_validation_library -- \
  /absolute/empty/output-directory /absolute/path/to/example.epub
```

The fixture includes 105 downloadable books, multiple pages, Unicode/XML metadata, assigned genres, missing covers, a large file and a fileless book. It is intended for smoke tests, not for an existing library.

## Browser library and HTTP API

The optional JSON listener exposes the same `citadel-core` book queries used by
Tauri. The browser uses this listener for browsing; the desktop client continues to use IPC. Add this top-level table to the server config to enable it:

```toml
[api]
listen = "127.0.0.1:8081"
# The origin browsers use to reach Citadel, as typed in the address bar.
publicUrl = "https://books.example.com"
# Optional: serve a frontend built with `bun run build:web`.
webDirectory = "/absolute/path/to/citadel/dist"
```

Omitting `[api]` leaves the listener disabled. `publicUrl` is required: when it is
https the session cookie is marked `Secure`, and state-changing requests must come
from that origin. Citadel itself serves plain HTTP; terminate TLS at a reverse
proxy for connections beyond a trusted local network. The address must pass the same
explicit-address checks as OPDS. A bind failure fails startup rather than
silently leaving only part of the configured server running.

Browsers sign in with their Citadel username and sign-in password and receive an
`HttpOnly`, `SameSite=Lax` session cookie that lasts 30 days from last use.
Signing out deletes the session. The API no longer accepts HTTP Basic.

Session routes:

- `POST /api/session` with `{"username": "…", "password": "…"}`: signs in and
  sets the cookie. Repeated failures back off (429).
- `GET /api/session`: the signed-in user and whether they can access the
  library, or 401.
- `DELETE /api/session`: signs out and clears the cookie.

Library routes (all require a session for a user with access; users without
access receive 404):

- `POST /api/books/query`: shared `LibraryBookQuery` JSON; HTTP requires an explicit
  `limit` between 0 and 200. Zero returns only the count. Desktop retains its
  existing unbounded-query behavior.
- `GET /api/books/{book_id}`: one book, using the existing numeric string ID.
- `GET /api/library`: the library's Calibre UUID, display name, and whether it is open read-only; no server filesystem path.
- `GET /api/authors`, `/api/series`, `/api/tags`, `/api/publishers`: browse facets and counts.
- `GET /api/custom-columns` and `/api/books/{book_id}/custom-values`: custom-field definitions and values.
- `POST /api/books/delete` (`{"book_ids": ["1"]}`) and `DELETE /api/authors/{author_id}`: permanently delete books (and their files) or an author with no books. Read-only libraries answer 403 `readOnly`.
- `GET /api/books/{book_id}/cover` and `/api/books/{book_id}/files/{format}/{filename}`: protected assets, including range and HEAD requests for downloads.
- `POST /api/covers/thumbnails`: thumbnail descriptors for at most 200 book IDs (`{"book_ids":["1"]}`). `GET` returns the bounded in-memory index; image URLs generate thumbnails on demand.
- `GET /api/openapi.json`: generated OpenAPI 3.1 contract.

Errors have `{ "code": "notFound", "message": "…" }` shape, with HTTP statuses
for invalid input (400), authentication (401), cross-origin requests (403), missing books or libraries (404), admission
limits (429), conflicts with an upload's state (409), oversized request bodies
(413), unavailable library or a busy server (503), no room for another upload
(507), and internal failures (500). Internal
database/filesystem diagnostics are hidden from remote callers. Responses retain
required nullable fields; request `Option` fields may be omitted or null.

API request bodies are limited to 1 MiB, and requests must be answered within
30 seconds (downloads only need to start within it). Upload chunks are the
exception: they stream to disk, bounded by `chunkBytes` and a 30-second idle
timeout. The API shares OPDS's request slots; OPDS keeps its own smaller limits.

### Uploads

Browsers add books by uploading them in chunks. A staged upload lives in
`<stateDirectory>/uploads` (created `0700`; files without a record are removed
at startup), never inside the library, and expires as described below. Only the
user who started an upload can see it. Upload routes:

- `GET /api/uploads`: the limits (`maxFileBytes`, `chunkBytes`, `reviewSeconds`)
  and your uploads, so a reloaded page can resume or review them.
- `POST /api/uploads` with `{"fileName": "Book.epub", "size": 1234}`: starts an
  upload. The extension must be EPUB, MOBI, AZW, AZW3, PDF or TXT.
- `PATCH /api/uploads/{upload_id}/content` with an `Upload-Offset` header and up to
  `chunkBytes` of raw bytes: appends the next chunk. The offset must equal
  `receivedBytes` (409 otherwise). A chunk that fails partway is discarded, so
  resend it from the same offset. The first chunk's content must match the file's
  extension. The final chunk returns `book`: the title, authors and other
  metadata read from the file, and a `coverUrl` when it has a cover.
- `GET /api/uploads/{upload_id}`: progress, for resuming after a lost connection.
- `GET /api/uploads/{upload_id}/cover`: a JPEG preview of the file's cover.
- `DELETE /api/uploads/{upload_id}`: cancels the upload and deletes its file.

- `POST /api/uploads/{upload_id}/commit` with the reviewed metadata
  (`{"title": "…", "authorNames": […], "identifier": "…", "publisher": "…",
  "language": "en", "tags": […], "publicationDate": "2021-03-04"}`; only `title`
  is required): adds the finished upload to the library with the cover from
  its file, records the signed-in user as the one who added it, and deletes the
  staged copy. Answers 201 with the new book, or 409 when the upload isn't
  finished or is busy, and 403 `readOnly` when the library is open read-only. An identifier is kept
  when it is an ISBN.

Limits can be tuned in an optional `[api.uploads]` table (defaults shown):

```toml
[api.uploads]
maxFileBytes = 209715200     # 200 MiB per file
chunkBytes = 8388608         # 8 MiB per request; 64 KiB to 64 MiB
maxStagedBytes = 2147483648  # 2 GiB reserved across all uploads
maxUploadsPerUser = 100
reviewHours = 24             # how long a finished upload waits to be added
```

Starting an upload reserves its declared size, so uploads in progress can't
exceed `maxStagedBytes`; when they would, or a user already has
`maxUploadsPerUser` uploads, the server answers 507.

Every upload reports `expiresAt`. An unfinished upload is discarded an hour
after its last chunk. Once a file has been read it gets a fixed deadline of
`reviewHours` from that moment, which checking on it doesn't extend;
`GET /api/uploads` reports the window as `reviewSeconds`. The staging
directory keeps a small record beside each file, so uploads survive a server
restart: finished ones stay ready to add, and unfinished ones resume from the
bytes already on disk. Behind a reverse proxy,
each chunk must fit the proxy's request limit: nginx's `client_max_body_size`
defaults to 1 MB, so raise it above `chunkBytes` or lower `chunkBytes`.
Cloudflare's Free and Pro plans accept requests up to 100 MB.

### Metadata lookups

Signed-in users can look books up through the server, which calls the providers
on their behalf (ADR 0010). Open Library, the Library of Congress, the Deutsche
Nationalbibliothek and K10plus need no setup.

- `GET /api/metadata/providers`: each provider and whether you can use it.
- `GET /api/metadata/search?provider=openlibrary&q=dune`: free-text search.
- `GET /api/metadata/isbn/{isbn}?provider=loc`: ISBN lookup.
- `POST /api/metadata/providers/{provider}/test`: checks the server can reach it,
  with your own key when the provider needs one.

Hardcover needs each user's own API key. Users add it under Settings → Account in
the browser; the server checks it with Hardcover, stores it encrypted, and never
returns it:

- `GET /api/account/provider-credentials`: your saved keys' account names and dates.
- `PUT /api/account/provider-credentials/hardcover` with `{"secret": "…"}`: checks
  and saves a key, replacing any earlier one.
- `DELETE /api/account/provider-credentials/hardcover`: forgets it.

Results name covers by an opaque `cover_id`, never a URL. The server fetches cover
images itself, only from the provider's own image hosts over HTTPS, and decodes and
re-encodes them before keeping them:

- `GET /api/metadata/covers/{cover_id}/preview`: a 600 px JPEG, cached briefly in memory.
- `POST /api/metadata/covers/{cover_id}/prefetch`: fetches the full-size image ahead of applying it.
- `POST /api/books/{book_id}/cover` with `{"coverId": "…"}`: sets a book's cover from a result.
- `PUT /api/books/{book_id}/cover` with a JPEG, PNG or WebP body: sets it from an image file.

Cover IDs expire an hour after a lookup last returned them; the server then answers
410 and the client searches again.

Every provider is limited across all users (a token bucket and a few concurrent
requests), an upstream `429` pauses that provider for its `Retry-After`, and a
provider that fails five times in a row is skipped for a minute. Answers are
cached briefly in memory; uncached lookups count against a per-user limit and
answer 429 with `Retry-After` when it runs out. Tune them in an optional
`[api.metadata]` table (defaults shown):

```toml
[api.metadata]
# contact = "admin@example.com"   # added to the User-Agent providers see
maxImageBytes = 15728640   # 15 MiB per cover download or upload
fetchTimeoutSecs = 15
maxConcurrentFetches = 8

[api.metadata.preview]
cacheBytes = 33554432      # 32 MiB for previews and chosen covers
ttlSecs = 180
longEdgePx = 600

[api.metadata.search]
cacheBytes = 8388608     # 8 MiB of cached answers
ttlSecs = 600            # how long an answer is reused
perUserPerMinute = 30
```

Build the frontend with `bun run build:web`, set `api.webDirectory` to the absolute build directory, and open `publicUrl` in your browser. The frontend itself is served without authentication and shows a sign-in form; the session cookie then authenticates API requests, images, and downloads. The sidebar has a sign-out button. The frontend and API must share an origin, either using this built-in hosting or a reverse proxy. Deep links serve the app; unknown API routes and missing assets remain 404s.

Browser startup uses the server’s configured library and ignores desktop library paths in browser settings. Search, paged books, authors, series, tags, publishers, covers, and downloads are available. Editing and imports are still hidden in the browser until it gains those screens; the upload API above is ready for them. Thumbnail generation uses a bounded in-memory cache and never writes inside the library.

For frontend development, set `publicUrl` to the Vite origin (`http://localhost:1420`) and run `CITADEL_API_URL=http://127.0.0.1:8081 bun dev:web` to proxy `/api` through Vite.

OPDS acquisition routes remain available. Editing book metadata and setting up a library through the browser remain follow-up work (CDL-57, CDL-39). Until web setup lands, configure the library using the server configuration described above.
