# 13. OPDS device keys

Status: Accepted - 2026-11-05 (CDL-60). Supersedes ADR 0005.

## Context

ADR 0005 stored each user's one OPDS app password reversibly so the UI could
show it again. Adding a second reader meant revealing the old password, and
revoking one reader meant changing the password for all of them. Self-hosted
apps split on this: Gitea, Immich, Komga and Nextcloud hash their keys and
show them once, while Kavita, Jellyfin and Paperless keep them in plaintext
and show them again. Show-once only hurts when there's a single key to reuse.
With a key per device, adding a reader means creating a key, not revealing an
old one.

## Decision

Each user has any number of **device keys** in `citadel.db` (`device_keys`),
each named for one reader, such as "Kobo" or "KOReader on phone".

- The server generates every key with the e-ink-friendly generator
  (`citadel_core::password::generate_app_password`). Users can't choose or
  edit one.
- A key is shown once, when it is created or rotated. There is no reveal, no
  QR code (e-readers can't scan one) and no URL with credentials in it.
- Only `sha256(salt || key)` is stored, with a random 128-bit salt for each
  key. A long generated key needs no slow hash, and OPDS checks one on every
  request.
- **Revoke** deletes a key. **Rotate** replaces it with a new key of the same
  name, and the old key stops working in the same transaction.
- Keys don't expire. Each key records `last_used_at`. The OPDS runtime reports
  a key's use to the host at most hourly, so busy readers don't write to the
  database on every request. Recording what each device did is left to
  analytics (CDL-49).
- OPDS stays HTTP Basic: a username plus one of that user's keys. The OPDS
  runtime holds a hot-swappable snapshot of verifiers (key ID, username, salt,
  hash), never keys. It checks every verifier so that timing doesn't show
  which one matched, and keeps the shared back-off on failures.

The migration turns each existing `users.app_password` into one key named
**"Existing password"**, so readers already set up keep signing in, and then
drops the column. SQLite can't hash, so the store registers
`citadel_sha256_hex` on its connection before migrating. The desktop's
pre-`citadel.db` `opds-credentials.json` is carried over the same way.

Both hosts manage keys the same way. The server's CLI has
`users keys <name> [add|rotate|revoke <device>]`, and the browser gets the
same controls with user management (CDL-67). The desktop's Sharing settings
list the local user's keys with Add, hold-to-Rotate and hold-to-Revoke. Revoking
the desktop's last key stops a share that requires sign-in.

## Consequences

- Nothing in `citadel.db` can be turned back into a working OPDS credential,
  so these keys don't need the vault (ADR 0011). The webview no longer
  receives a stored secret, only a key at the moment it's created.
- A lost key can't be recovered; the user rotates it, which affects only that
  device.
- Usernames are sign-in identifiers, not display names (amending ADR 0009).
  Renaming a user changes what every one of their readers sends, and the
  desktop warns about this while the name is being edited.
- `users add` no longer prints an OPDS password. Operators create a key for
  each device.
