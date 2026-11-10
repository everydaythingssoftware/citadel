# 14. View-only library grants

Status: Accepted - 2026-11-10

## Context

On the server, a grant (ADR 0009) decides which libraries a user sees, and
anyone who sees a library can change it: edit metadata, replace covers, add
books by upload and delete books permanently. The `reader` role (ADR 0012)
only means "not an administrator". The one other gate is the library's
read-only switch, which stops writes for everyone, administrators included.

A household or a small book club wants to hand someone a library to browse
and download from without letting them rename authors or delete books, while
others keep editing it. Nothing can express that today.

Two places could hold the permission:

- **On the role**, as a third role such as `viewer` beside `reader` and
  `administrator`. Roles are server-wide, so the permission would follow the
  user into every library they're granted. ADR 0012 already keeps roles for
  administering the server and leaves libraries to grants.
- **On the grant**, as a flag on the row that already links one user to one
  library. Permission then matches the scope of access itself: the same person
  can edit their own library and only browse someone else's, which matters
  once the server serves more than one library (ADR 0012 leaves that for
  later and asks that nothing here has to be undone).

## Decision

**Permission lives on the grant.** `library_grants` gains `can_edit`, a
boolean that defaults to true. The migration leaves every existing grant able
to edit, so upgrading changes nobody's access. `citadel_core::store` models
it as `LibraryPermission`, `view` or `edit`, and `grant(user, library,
permission)` creates or replaces the grant with the permission given. Roles
are unchanged: an administrator can be given view-only access to a library
like anyone else, and can change their own grant from the CLI.

**Enforced where read-only is enforced.** The session middleware already
loads the user's grant on every request; it now records the permission too.
The server's `write` helper, the cover routes' early checks and the upload
routes refuse a write when either the library is read-only or the grant is
view-only. Both answer 403 with the existing `readOnly` error code, so
clients that handle a read-only library already handle this, and the message
says which applies ("You can view this library but not change it"). A
view-only user can't start an upload either, so they never spend the
server's staging space on a book they can't add. Reads, downloads, OPDS,
metadata lookups and the user's own provider keys stay available, since none
of them change the library.

**Changes take effect on the next request.** Grants are read per request, so
an administrator who makes someone view-only stops their next write without
signing them out. An upload they staged before then can't be committed.

**What the browser sees.** `GET /api/library` keeps `readOnly` for the
library switch and adds `canEdit`, true only when the library is writable
and this user's grant allows editing. The web app opens the library for
writing only when `canEdit` is true, so edit, delete and upload controls hide
the same way they do for a read-only library. The server stays the
authority: hiding a control is a convenience, not a check.

**Administration.** `grant <name> [<library-id>] [--view-only]` creates or
changes a grant; granting again without the flag restores editing. `users
add --view-only` creates someone with view-only access to the served
library. `users list` shows each user's access as `can edit`, `view only`
or `no access`. User management in the browser (CDL-67) will offer the same
choice when it arrives; there is no web grant management yet.

**The desktop is unchanged.** Its one local user is always granted edit
access to its own libraries.

## Consequences

- One person can browse a library others edit, per library rather than per
  person.
- Every write path must go through the shared check. New write routes call
  `write` (or `ensure_can_edit` before work that runs ahead of it), and the
  API tests cover each route a view-only user could otherwise reach.
- A third role remains possible for server-wide powers; it isn't needed for
  library access.
- Finer permissions (may add books but not delete them, say) would replace
  the boolean with a level on the same row.
