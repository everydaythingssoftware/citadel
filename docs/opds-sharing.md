# Share a library over OPDS

Citadel can expose the active Calibre library as a read-only OPDS 1.x catalog while the desktop app runs.

## Turn on sharing

1. Open **Settings → Sharing**.
2. Choose **All local networks** or a specific interface.
3. Keep port `8080` unless it conflicts with another service.
4. Optionally enable **Require a password**. Citadel can generate one; it is shown only once.
5. Select **Start Sharing**.
6. Copy one of the catalog URLs Citadel displays.

## Read it from any OPDS 1.x reader

Add a catalog with the copied URL and, if enabled, the username and password. Works with any OPDS 1.x reader — for example KOReader: File browser → OPDS catalog → Add new. Sharing stops when Citadel quits.
