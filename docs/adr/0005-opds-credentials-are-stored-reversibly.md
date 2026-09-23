# 5. OPDS credentials are stored reversibly

Status: Accepted - 2026-09-22

## Context

ADR 0003 stored only an Argon2 verifier, so the password could never be shown again. That forced a one-time-display flow: copy the password into your reader immediately or rotate the credential. Rotating a credential also had to stop a running share, because listeners held a verifier baked in at start. Phil called the rotation-to-recover flow out during design review: "having to rotate to 'reveal' the password suuuuucks."

The generated password carries roughly 30.5 bits, and failed auth attempts back off exponentially. The server shares a library over the LAN or the user's own networks.

## Decision

The credential file stores the password reversibly (a `password` field, not a `passwordVerifier`). The auth layer reads a hot-swappable snapshot of username and password on every request and compares with a constant-time equality check; configuring or generating credentials swaps the snapshot in place, and a running share never stops. Clearing credentials still stops sharing, because the all-networks bind policy exists only while credentials do.

The Argon2 verifier, its concurrency semaphore, the 503-busy response, the HMAC-tagged result cache, and the response-padding machinery are deleted: all of it existed to make a deliberately slow verifier safe, and none of it has a job once the stored secret is plaintext. The backoff remains the online-guessing defense.

Pre-reveal credential files fail to parse and are treated as no credentials; users regenerate.

## Consequences

Reveal is a read, not a rotation. The reader UI can show and copy the password at any time; "only shown once" disappears from the product.

A same-user attacker who can read the 0600 credential file gets the plaintext — but that attacker can already read every book in the library, and citadel-server has always held this credential in plaintext TOML, so the stack has accepted reversible storage at rest from the start. Hashing would add cost without moving any real boundary. The one boundary that did change is the webview: `clb_query_opds_credential_secret` hands the plaintext to app JS, so a theoretical XSS now reaches the secret where a verifier used to be the ceiling. The app renders no untrusted HTML today; if that changes, this decision must be revisited alongside a Content-Security-Policy. Users may also type their own (possibly reused) password instead of generating one — the plaintext cost of that choice is theirs; the UI nudges toward generation. ADR 0003's machine-local placement is unchanged: the secret still never travels with a library.

Libraries and credential files from nightly builds with verifier-format files need one regeneration after updating.
