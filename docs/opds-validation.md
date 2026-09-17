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
does not substitute for testing that release artifact. The repository has all
Apple certificate and App Store Connect API secret names configured, and the
most recent manual Release run completed both its macOS and Ubuntu jobs on
2026-07-10/11. That proves the publishing pipeline and credentials worked for
the main branch at the time; it does not prove or publish the current OPDS
commits.

### Signed macOS prerelease verification — 2026-08-02

The `Release` workflow was dispatched as a nightly prerelease from the OPDS
branch head. Its macOS 15 job completed successfully and published
[`v0.6.1-nightly.20260803.163`](https://github.com/everydaythingssoftware/citadel/releases/tag/v0.6.1-nightly.20260803.163).

The published `Citadel_0.6.1-nightly.20260803.163_aarch64.dmg` was downloaded
again rather than inspected only inside CI. Its SHA-256 was
`639c4d506ad4bc45260dd2e8a7201228e67ed53f24c03abe11d60c18619ec92a`,
matching GitHub's asset digest, and the disk image verified successfully while
mounting read-only. The contained `Citadel.app` passed:

- `codesign --verify --deep --strict`, with Developer ID Application identity
  `PHILIP GEORGE DENHOFF (J287EZX7X6)`, Team ID `J287EZX7X6`, hardened runtime,
  and a trusted Apple certificate chain;
- `spctl --assess --type execute`, reported as accepted from **Notarized
  Developer ID**; and
- `xcrun stapler validate`, confirming the stapled notarization ticket.

This proves that the current OPDS v1 head can be released as a signed,
notarized, stapled Apple Silicon package. It does not substitute for running
the physical-network and current KOReader scenarios in the matrix below.
The same workflow's Ubuntu 22.04 job also completed successfully and published
x86-64 AppImage, Debian, and RPM packages plus their updater signatures.

### Isolated packaged-app smoke test — 2026-08-02

The release app was rebuilt with the compile-time QA identifier
`software.everydaythings.citadel.opdsqa` and run on macOS 26.5.1 (25F80,
arm64). It used a separate settings directory, a disposable empty Calibre
library, port 18080, and QA-only credentials. The installed Citadel process,
production settings, and production library were not changed.

Passed:

- The packaged Sharing pane started and stopped **All local networks** and the
  specific Wi-Fi interface `en0`.
- The UI displayed one concrete IPv4 URL and three bracketed global IPv6 URLs;
  it displayed no wildcard, loopback, link-local, or credential-bearing URL.
- IPv4 and global IPv6 returned parseable XML with HTTP 200 for the root, All
  Books, Recently Modified, Unread, Authors, Series, Tags, Genres, search, and
  OpenSearch routes while authentication was disabled.
- With Basic authentication enabled, missing and incorrect credentials returned
  401 with `WWW-Authenticate: Basic realm="Citadel"`; correct credentials
  returned 200. An authorization value over the explicit limit returned 401.
- The credential file was mode 0600, contained the username and an Argon2id
  verifier, and neither it nor the QA settings contained the plaintext password.
- Stop Sharing closed every listener and released the port. Quitting while
  sharing also closed the listener. On relaunch, sharing was off while the
  selected target, port, username, authentication mode, and verifier remained
  available; restarting with the stored verifier authenticated successfully.
- Occupying the selected address/port produced the packaged UI state **Needs
  attention** with “That port is already in use on the selected network
  interface.” Stopping recovered to editable configuration.

This was a same-host network smoke test against an empty library. It does not
run the signed/notarized current artifact, cover OS firewall denial, a separate
KOReader device, representative books/covers/acquisitions, active-library
switching, or interface loss/recovery. The QA app, isolated settings/verifier,
and disposable library were moved to Trash after the run.

### Representative packaged-app crawl — 2026-08-02

The same isolated, ad-hoc macOS QA package was run again on `en0` with
authentication disabled and a disposable library generated by
`create_opds_validation_library`. The fixture contained 106 books: 105 EPUB
acquisitions, 53 TXT acquisitions, 52 covered acquisitions, 53 coverless
acquisitions, and one fileless book that must not appear in acquisition feeds.
It also included multiple pages of books and authors, mixed read state,
multiple authors/series/tags/genres, missing optional metadata, identifiers,
Unicode and XML metacharacters, and one 8 MiB TXT file.

Passed:

- Root navigation exposed All Books, Recently Modified, Unread, Authors,
  Series, Tags, Genres, and OpenSearch.
- All Books and Recently Modified returned 105 unique acquisitions over pages
  of 50/50/5. Unread returned the expected 70 over pages of 50/20. The
  fileless book was excluded.
- Authors returned 63 unique facets over pages of 50/13; Series returned 7,
  Tags 3, and Genres 3. A child feed from every facet type returned acquisition
  entries.
- Search returned 104 title matches over pages of 50/50/4. A Unicode query
  returned the exact `A & B <C> — 東京` title, both Unicode authors, escaped
  categories, canonical language, and ISBN identifier; its intentionally
  missing description and cover remained absent.
- The cover endpoint returned JPEG data. EPUB GET bytes exactly matched the
  source fixture, EPUB HEAD returned the expected length with no body, and a
  TXT byte range returned 206 with the exact 1,024 requested bytes and correct
  `Content-Range` for the 8 MiB file.
- A root feed completed in 3 ms while a deliberately slow client streamed the
  8 MiB download. Root, last-page, and search XML also parsed over a global
  IPv6 address.
- While the listener remained running, switching through the packaged Library
  pane from the representative library to a second empty library changed the
  same URL to the second library UUID with zero acquisitions. Switching back
  restored the first UUID and its acquisitions without restarting sharing.
- Stop Sharing released the listener and quitting the QA app left the port
  closed. The QA app, isolated settings, generated EPUB, and disposable
  libraries were moved to Trash after the run.

This remains a same-host protocol crawl, not a separate-device KOReader result.
It does not run the signed/notarized current artifact, cover OS firewall denial, a
Linux OPDS client path, or physical interface loss/recovery.

### Linux package smoke test — 2026-08-02

Commit `2b864c0b` was exported without the developer worktree's unrelated
uncommitted files and built in an Ubuntu 24.04.1 LTS ARM64 guest with the pinned
Rust 1.97.1 toolchain and Bun 1.3.14.

Passed:

- The production frontend and Tauri release binary built successfully.
- `Citadel_0.6.1_arm64.deb` was produced, reported package/version/architecture
  `citadel`/`0.6.1`/`arm64`, declared its WebKitGTK and GTK runtime
  dependencies, installed through `apt`, and installed the application binary,
  desktop entry, icons, and empty-library resource.
- The installed `.deb` application stayed running for the ten-second headless
  smoke window under Xvfb, created isolated settings, and had no immediate
  loader, dependency, or startup failure.
- `Citadel_0.6.1_aarch64.AppImage` was produced as an ARM64 ELF AppImage. Its
  extracted launcher started the bundled Citadel executable, which stayed
  running for the headless smoke window with no immediate loader or startup
  failure.
- SHA-256 was
  `59a02cdc58b70a68205f0cb7e588c75fa28e4952fc2f9e4ba1fd47c2030d21d3`
  for the 13 MiB `.deb` and
  `45e3ba608baaf5f47829279fe1c0ce03ca0917949fb72505cfa46cd20c0b6b88`
  for the 83 MiB AppImage.

The first AppImage bundle attempt on the minimal guest exposed that Tauri's
bundler requires `/usr/bin/xdg-open`. Installing `xdg-utils` fixed the bundle;
the build and release workflows now declare that prerequisite instead of
relying on the hosted runner image.

This proves clean ARM64 package construction, installation, contents, dynamic
loading, and startup. It does not claim an interactive Linux OPDS or KOReader
result: sharing deliberately starts off, and the headless guest did not provide
a safe physical LAN/client path for enabling and exercising it. Linux host
firewall behavior was not changed or tested.

### Existing real-reader evidence — 2026-08-02

An early development build (`bun run dev`) was successfully opened from
KOReader on a Kobo Libra Colour over the developer machine's `en0` interface
using HTTP Basic credentials. That build exposed only the flat book list,
before the current category navigation was implemented. The KOReader version,
authentication-disabled case, acquisition/download behavior, and the current
navigation matrix were not recorded, so this is a useful real-device v1 proof
but not a completed packaged-client result.

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
| Disposable representative Calibre library | `crates/libcalibre/examples/create_opds_validation_library.rs` |

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
| Ad-hoc macOS QA package | Same-host HTTP client | All local networks + `en0` | Off + Basic | Passed empty-library auth/lifecycle/port-conflict smoke plus representative pagination/facet/search/metadata/cover/download/range/concurrency crawl over IPv4 and IPv6 on macOS 26.5.1; not a KOReader result |
| Dev build | Kobo Libra Colour / KOReader version unknown | `en0` | Basic | Passed manual connection to the early flat catalog; current navigation, package behavior, auth-off, and downloads were not recorded |
| Ubuntu 24.04.1 ARM64 `.deb` | Headless package smoke only | — | — | Built, installed, and stayed running under Xvfb; no interactive OPDS/client path exercised |
| Ubuntu 24.04.1 ARM64 AppImage | Headless package smoke only | — | — | Built and launched its bundled Citadel executable under Xvfb; no interactive OPDS/client path exercised |

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
