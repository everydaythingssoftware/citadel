# Share a library with KOReader

Citadel can expose the active Calibre library as a read-only OPDS catalog while
the desktop app is running. Current KOReader is the supported v1 client; other
OPDS readers may work but are not yet part of Citadel's compatibility promise.

## Start sharing

1. Open Citadel's **Settings**, then **Sharing**.
2. Choose **All local networks** or the specific Wi-Fi/Ethernet interface that
   should host the catalog.
3. Keep the default port, `8080`, unless it conflicts with another service.
4. Optionally enable **Require a password** and set a username and password.
   Citadel can generate a password, but shows it only once. Save it before
   leaving the pane.
5. Select **Start Sharing**.
6. Copy one of the concrete catalog URLs shown by Citadel. Do not add the
   username or password to the URL.

Only the current active library is shared. Switching libraries changes the
served catalog. Sharing stops when Citadel quits and must be started again
after every launch; the network, port, and authentication settings remain
saved.

## Add the catalog to KOReader

The KOReader device must be able to reach the selected computer interface.
Usually that means both devices are on the same local network.

1. In KOReader's File Browser, open the top menu and choose **OPDS catalog**.
2. Choose **Add new OPDS catalog**.
3. Enter a name such as `Citadel` and paste the URL copied from Citadel.
4. If authentication is enabled, enter the username and password in KOReader's
   credential fields.
5. Open the new catalog.

The root contains All Books, Recently Modified, Unread, Authors, Series, Tags,
and Genres, plus search. Genre is separate from arbitrary Calibre tags and is
populated only after genres have been accepted into Citadel's `Genres` custom
column. Books and covers are downloaded directly from the active library;
OPDS cannot edit the library or synchronize reading progress.

KOReader's current user guide documents the OPDS catalog entry point:
<https://koreader.rocks/user_guide/>.

## Network and security limits

Citadel serves plain HTTP. A Basic-auth password prevents unauthenticated
browsing, but the credentials and downloaded books are not encrypted in
transit. Use sharing only on a network you trust. Citadel does not configure
the operating-system firewall and does not provide HTTPS, remote internet
exposure, Bonjour/mDNS discovery, or a QR code in v1.

**All local networks** binds Citadel to the concrete addresses of eligible
local Wi-Fi/Ethernet interfaces; it does not use a wildcard listener. Choosing
one interface prevents Citadel from silently broadening to another interface.
If that interface disappears, Citadel waits for the same interface to return.

Citadel advertises usable IPv4 and global/unique-local IPv6 addresses. It does
not advertise IPv6 link-local URLs because their zone identifiers are not
portable between the computer and reader. If a reader cannot route a displayed
IPv6 address, use the displayed IPv4 URL instead.

## Troubleshooting

- **KOReader cannot open the catalog:** confirm sharing still says **Sharing**,
  use a URL currently displayed by Citadel, and check that both devices can
  communicate on the selected network. Guest Wi-Fi often isolates devices.
- **Authentication keeps failing:** edit credentials only while sharing is
  stopped, then restart sharing. Enter them in KOReader's username/password
  fields, not in the catalog URL.
- **Citadel is waiting for the network:** reconnect the selected interface or
  stop sharing and choose another interface. Citadel will not fall back to a
  broader listener automatically.
- **The port is already in use:** stop the conflicting service or choose a
  different port in Citadel before starting again.
- **macOS asks about incoming connections:** allow them for Citadel if the
  catalog should be reachable. Signed and unsigned builds can receive different
  firewall treatment.
- **Linux cannot be reached:** allow the selected TCP port in the host firewall.
  Citadel intentionally does not modify firewall rules.
- **The wrong books appear:** stop sharing if needed, select the intended
  library in Citadel, and reopen the catalog. Only one active library is served.

Stopping sharing or quitting Citadel closes every listener. If a listener still
appears reachable after the app exits, record the Citadel version, platform,
selected target, and catalog URL when reporting the defect.
