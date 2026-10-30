# Frontend service boundaries

Components and hooks consume service interfaces. Generated Rust contract types
can be imported with `import type`; generated commands and native runtime APIs
belong exclusively to their owning adapters.

| Boundary | Responsibility | Implementation |
| --- | --- | --- |
| Library | Queries and mutations on the selected library, custom fields, genres, covers and import commit | `src/lib/services/library` |
| LibraryCatalog | Discover, validate, inspect, create, open and register libraries (the citadel.db library list) | `src/lib/services/library-catalog` |
| Metadata | Provider search, ISBN lookup and provider credential/connectivity tests | `src/lib/services/metadata` |
| Platform | Settings persistence, clipboard, dialogs, paths, menu events, window lifecycle/theme and desktop updates | `src/lib/platform` |
| OPDS administration | Local listener configuration and credentials | `src/lib/services/opds` |

LibraryCatalog opens the backend before constructing its Library handle. The
store retains serialized opens and shadow-switch/restore guards. New custom-field,
genre and cover entry points reject while the backend is diverted, reject results
from a superseded library, and invalidate book caches only after successful
writes. UI edit/metadata operations retain the originating library identity across
awaits. Covers are applied by metadata cover ID or uploaded image, never by URL
(ADR 0010); the desktop checks the original library root under the backend mutex
before applying a fetched image.

Metadata-provider descriptors and aggregation are independent of the IPC
transport. The registry delegates provider operations to Metadata; applying a
result uses Library actions. A provider cannot directly mutate a book. The
providers themselves live in `crates/citadel-metadata`, shared by the desktop
and the server (ADR 0010).

Host detection is isolated in Platform adapter selection. Browser adapters never
invoke native commands: local library discovery yields no candidate, unsupported
operations fail explicitly, and native window/menu lifecycle methods are inert.
The browser LibraryCatalog connects to the serving origin’s configured library;
its HTTP Library uses generated OpenAPI bindings and exposes a read-only
capability. Unbounded Library queries are assembled from bounded HTTP pages.
Initial and subsequently fetched pages request thumbnails on demand. Metadata
lookups and cover previews go through the server (ADR 0010); the browser's
remaining library mutations are subsequent work. No ordinary library
operation gains arbitrary server filesystem discovery or administration.

`bun lint:boundaries` parses TypeScript imports and command accesses. It rejects
runtime bindings/native imports outside adapters, direct consumption of private
transport adapters, and commands owned by another service. Its ownership map
assigns every generated command to exactly one adapter. Type-only contracts are
allowed throughout the app. `bun lint:web` includes this check, and quality CI
runs the frontend tests, including the boundary check's regression cases.
