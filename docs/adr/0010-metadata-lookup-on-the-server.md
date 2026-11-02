# 10. Metadata lookup on the server

Status: Accepted - 2026-10-30 (CDL-56)

## Context

Book-metadata lookups (Hardcover, Library of Congress, DNB, K10plus, Open
Library) lived in `src-tauri/src/metadata`, so the web app could not search
metadata or apply covers. Each call built its own HTTP client, Hardcover's had
no timeout or User-Agent, and nothing limited request rates. On a shared server
every user's lookups leave from one IP address, so one user's burst, or a
provider that stops answering, becomes everyone's problem.

## Decision

`crates/citadel-metadata` owns the providers, their DTOs (specta, plus utoipa
behind the `openapi` feature) and the HTTP plumbing. It is async and
network-bound, so it stays out of the synchronous `citadel-core` (ADR 0007).
The desktop and the server each hold one `MetadataClient`:

- **One pooled `reqwest::Client`** with connect and per-request timeouts and a
  `Citadel/<version> (+metadata-lookup[; contact])` User-Agent. The contact is
  the operator's, from server config. Credentials are passed on every call and
  attached per request; the client never stores them.
- **Per-provider admission across all users**: a token bucket and a
  concurrency cap per provider. Hardcover limits each account token, so its
  buckets are per credential; the others limit by IP and share one bucket.
- **Upstream `429`s are honoured**: `Retry-After` (capped at 10 minutes)
  blocks that bucket, and callers get `RateLimited` with the wait. This state
  is in memory only; the first request after a restart rediscovers it.
- **Circuit breaker**: five consecutive transport, timeout or 5xx failures
  skip the provider for 60 s and report it as unavailable, so nobody waits out
  the Library of Congress's 25 s timeout repeatedly. After the cooldown one
  failure reopens it; a success closes it. Credential and argument errors
  don't count.
- **ISBN misses are cached** for 10 minutes, keyed by the 13-digit form, so
  re-importing a book no source knows doesn't ask every source again.

Errors carry a kind (`InvalidArgument`, `Unauthorized`, `RateLimited`,
`Unavailable`, `Upstream`) and a user-facing message that never contains a
credential or the request URL. The desktop maps them to strings for IPC; the
server maps them to `LibraryError` codes.

Tests never use the live network: provider parsing runs against fixtures in
`crates/citadel-metadata/fixtures`, and client behaviour against local test
servers through `Endpoints`.

### Covers

Citadel fetches every cover itself, on the desktop as on the server, so a
webview or browser never contacts a provider host and clients never send
Citadel a URL. The desktop used to download any URL the frontend passed, with
no host check, size limit or timeout.

- **Cover IDs**: each lookup registers its results' images in an in-memory
  registry under `sha256(url)[..16]`, so the same image gets the same ID across
  searches and users. Results carry `cover_id`; the URL is never serialized.
  Entries are count-capped and expire after an hour unused; serving a cached
  answer re-registers its covers. An unknown ID answers `410 Gone` and the UI
  silently searches again once. A lookup table, not a signed token: the client
  can only name IDs the server issued, and losing them on restart costs one
  search.
- **Fetching**: only from each provider's own image hosts
  (`covers.openlibrary.org` and Internet Archive storage for Open Library,
  `assets.hardcover.app` for Hardcover), HTTPS only. Redirects are followed by
  hand, at most three, and every hop is checked against the same list.
  Responses must be images, are capped at 15 MiB while streaming, and must
  arrive within 15 s; at most eight fetches run at once.
- **Decoding**: images are decoded with `image` limits (10,000 px a side,
  64 MiB of allocation) and re-encoded as JPEG before anything keeps them.
  Uploaded cover files go through the same step.
- **Previews** are 600 px on the long edge, held in a 32 MiB in-memory cache
  for 180 s, no disk. Choosing a result during import prefetches the full-size
  image into the same cache for 60 s so applying it after the book is created
  doesn't wait on the provider.
- **Contract**: `setBookCoverFromUrl` is gone. Both hosts offer
  `setBookCoverFromMetadata(bookId, coverId)` and
  `setBookCoverFromFile(bookId, image)`. The server exposes
  `GET /api/metadata/covers/{id}/preview`, `POST …/prefetch`,
  `POST /api/books/{id}/cover {coverId}` and `PUT /api/books/{id}/cover` with
  the image as the body. The desktop serves previews from a `citadel-cover://`
  URI scheme backed by the same cache.

## Consequences

- The Tauri commands are thin adapters; IPC bindings are unchanged.
- The server exposes lookups at `/api/metadata/*` to signed-in users, with a
  per-user token bucket and a byte-bounded answer cache in front of the shared
  client. Keyed providers' answers are cached per user.
- Keyed providers use each user's own key, sealed in `citadel.db` (ADR 0011).
- Covers are centralized; see below.
