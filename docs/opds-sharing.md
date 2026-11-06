# Share a library over OPDS

Citadel shares the active Calibre library as a read-only OPDS 1.x catalog while the desktop app runs.

## Turn on sharing

1. Open **Settings → Sharing** with a library open.
2. Choose local networks, or all networks. Sharing on all networks requires reader sign-in.
3. Keep port 8080 unless another service uses it.
4. Turn sharing on and copy one of the displayed catalog URLs.
5. If using sign-in, add a device for each reader app. Each gets its own password, shown only once. Reader apps can't sign in until they have one, and adding, rotating or revoking one doesn't interrupt sharing.

Add the URL, your username and the device's password to an OPDS 1.x reader. For example, in KOReader use **File browser → OPDS catalog → Add new**.

The root catalog links to all books, recently modified books, unread books, authors, series, tags and genres. Search is advertised through OpenSearch. Genre browsing uses Citadel's assigned genres, independently of tags; an unassigned collection has an empty genre feed. Facet counts include downloadable books only. Fileless books and unsafe or missing files are excluded from acquisition pages.

Switching libraries stops sharing; start it again for the new library. Quitting Citadel also stops sharing. Rotating or revoking a device password takes effect on that device's next request.

## Network access

Citadel serves plain HTTP, including Basic authentication. Use a trusted network or an externally managed TLS reverse proxy and firewall for remote access. The all-networks choice can include VPN and public interfaces. A catalog URL must be reachable from the reader; a firewall or network isolation can prevent connections.

Feed responses have a 30-second deadline. Request bodies are limited to 16 KiB. The service shares 64 request slots across its listeners, retaining slots through response-body completion; blocking work has a separate shared 64-slot limit. Busy requests receive 503 with Retry-After. Book downloads are not cut off by the feed deadline. Failed sign-in attempts use exponential backoff. These limits begin after HTTP headers arrive and do not limit accepted sockets or slow-header connections.

For a host without the desktop application, see [Headless server](headless-server.md).
