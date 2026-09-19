# OPDS v1 validation record

This record separates repeatable automated coverage from the physical package
and reader checks required by CDL-27. Do not mark an unexecuted platform or
client scenario as passing. Record exact versions, artifact identity, network
path, and fixture details when running the manual matrix.

## Current evidence

### Local macOS package inspection — 2026-08-02

| Field | Result |
| --- | --- |
| Host | macOS, Apple Silicon |
| Command | `bun run build` |
| Artifacts | `Citadel.app`, `Citadel_0.6.1_aarch64.dmg` |
| Signature | Ad-hoc/linker signature only; no Team ID |
| Gatekeeper | Rejected because the local artifact is not Developer ID signed |
| Notarization | Not tested; release credentials are unavailable to the local build |
| Bundled helpers | None; the app contains the Citadel executable, icon, and empty-library resource |
| WebDriver | Registration is guarded by `debug_assertions`; no WebDriver listener is started by release code |
| OPDS-specific WebView permission | None; management remains Tauri IPC and readers access the native Rust listener |
| Local-network usage description | None added; packaged listener behavior still requires physical verification on supported macOS releases |

The release workflow supplies Apple signing and notarization credentials and is
the correct source for the signed/notarized artifact. A successful local bundle
does not substitute for testing that release artifact.

### Existing real-reader evidence — 2026-08-02

The current branch was successfully opened from KOReader over the developer
machine's `en0` interface using HTTP Basic credentials. The KOReader version,
device/OS, Citadel package identity, authentication-disabled case, and full
navigation/download matrix were not recorded, so this is a useful v1 proof but
not a completed CDL-27 package result.

## Automated coverage

| Contract | Coverage |
| --- | --- |
| OPDS XML, escaping, optional metadata, search, and acquisition pagination | `crates/citadel-opds/src/catalog.rs` tests |
| Cover/book GET, HEAD, ranges, and bounded streaming | `crates/citadel-opds/src/assets.rs` tests |
| Library path containment and symlink escape rejection | `crates/libcalibre/tests/asset_resolution_test.rs` |
| Basic challenge, success/failure, verifier storage, bounded cache, and timing padding | `crates/citadel-opds/src/auth.rs` and `credentials.rs` tests |
| Interface selection, IPv4/IPv6 planning, loss/recovery, and no exposure broadening | `crates/citadel-opds/src/network.rs` and `service.rs` tests |
| Port conflict, stop/restart, shutdown timeout, and listener release | `crates/citadel-opds/src/service.rs` tests |
| Active-library switch during concurrent feed/download traffic | `src-tauri/src/state.rs` tests |
| Real headless process auth, catalog, acquisition, and signal shutdown | `crates/citadel-server/tests/headless_process.rs` |

Automation does not prove OS firewall UI, package signing/notarization,
cross-device routing, or KOReader's behavior on a particular device build.

## Physical package and KOReader matrix

Use a representative library with more than one catalog page, Unicode and XML
metacharacters, multiple authors/series/tags/genres, mixed read state, missing
optional metadata, covers and missing covers, multiple formats, and a large
book. Record the fixture identity and whether it is disposable.

| Platform/artifact | KOReader device/version | Target | Auth | Result/notes |
| --- | --- | --- | --- | --- |
| Signed/notarized macOS release | — | Specific Wi-Fi/Ethernet | Off | Not run |
| Signed/notarized macOS release | — | Specific Wi-Fi/Ethernet | Basic | Not run |
| Signed/notarized macOS release | — | All local networks | Off + Basic | Not run |
| Unsigned macOS development package | — | Specific Wi-Fi/Ethernet | Off + Basic | Authenticated `en0` smoke test only; exact versions missing |
| Ubuntu `.deb` | — | Specific Wi-Fi/Ethernet | Off + Basic | Not run |
| Ubuntu AppImage | — | All local networks | Off + Basic | Not run |

For every applicable row, verify and record:

- Manual URL entry and root navigation.
- All Books, Recently Modified, Unread, Authors, Series, Tags, Genres, and
  KOReader search.
- First/middle/last-page navigation without duplicates or omissions.
- Cover display and download/open for every fixture format.
- Missing, incorrect, and correct credentials; copied URLs contain no secrets.
- Stop/start in one launch and restart-off behavior with settings preserved.
- Active-library switching while sharing.
- Selected-interface loss, return, and address change.
- Port conflict plus macOS privacy/firewall or Linux firewall denial.
- Concurrent browsing and large download responsiveness.
- Listener and port release after Stop Sharing and after quitting Citadel.

Record in-scope defects with reproduction steps and add an automated regression
where practical. Propose excluded features separately; do not expand this
matrix to HTTPS, Bonjour/mDNS, QR codes, remote deployment, or additional client
support promises.
