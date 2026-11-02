# 11. Secrets vault for third-party credentials

Status: Accepted - 2026-10-30 (CDL-56)

## Context

Hardcover lookups need a personal account token, and Hardcover's terms tie a
token to its owner, so a shared server can't hold one key for everyone: each
user brings their own (CDL-56). Citadel has to send the token to Hardcover, so
it must be stored reversibly, as app passwords are (ADR 0005). Unlike a
generated app password, a leaked Hardcover token works against a third-party
account. Secrets like that are stored encrypted even when the key sits beside
the database: copies of `citadel.db` travel further (backups, bug reports,
`citadel.db.<suffix>` recovery files) than the state directory as a whole.

## Decision

`citadel_core::vault::Vault` seals secrets with XChaCha20-Poly1305 (RustCrypto
`chacha20poly1305`). Its random 24-byte nonces make collisions a non-issue.

- **Key file**: 32 random bytes in `<stateDirectory>/secrets/credentials.key`,
  the directory `0700` and the file `0600` on Unix, created on first use with
  `create_new` so two processes can't race to different keys. A file of the
  wrong length is refused, not replaced.
- **Key ID**: the first 8 bytes of SHA-256 over a domain tag and the key,
  stored beside each sealed value. A mismatch means "sealed with another key".
- **AAD**: `citadel/provider-credential/v1 ‖ 0 ‖ user_id ‖ 0 ‖ provider`, so a
  ciphertext moved to another user's or provider's row doesn't open.
- **Table**: `provider_credentials(user_id, provider, key_id, nonce,
  ciphertext, label, created_at, verified_at)`, deleted with its user. `label`
  holds the provider account's name so listings never decrypt anything.

The server checks a key with the provider before saving it, opens it only for
the request that uses it, and never returns it to the browser. Listings report
the account name and dates.

**Lost or replaced key**: the server starts anyway and logs how many saved
keys it can't read; their owners see "enter your key again". A new key is
generated only when no key file exists; a damaged one stops startup with
instructions, so an operator mistake never silently invalidates every key.

## Consequences

- Someone with the whole state directory still gets the plaintext; the vault
  protects copies of the database alone, not a compromised host.
- Rotation can be added later: decrypt with the old `key_id`, reseal with the
  new one; rows already name their key.
- App passwords remain plaintext in `users.app_password` for now; moving them
  into the vault is CDL-60.
- The desktop keeps its Hardcover key in `settings.json` until CDL-62 moves it
  to the local user's row.
