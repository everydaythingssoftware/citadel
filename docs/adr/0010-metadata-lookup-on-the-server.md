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

## Consequences

- The Tauri commands are thin adapters; IPC bindings are unchanged.
- Server routes, per-user credentials and centralized cover fetching build on
  this crate (CDL-56) and are recorded here as they land.
