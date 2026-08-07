# Interface-scoped OPDS listener research

This document supports [ADR 0002](../adr/0002-interface-scoped-opds-listener.md).
It records external research and design notes.
It does not describe code that exists in the repository.

## Network interfaces

Apple exposes the BSD device name and the localized display name as separate values through [System Configuration](https://developer.apple.com/documentation/systemconfiguration/scnetworkconfiguration).
The BSD device name is a better saved identity than a display name.

Linux separates administrative `IFF_UP` from readiness to pass traffic.
The [Linux operational-state documentation](https://docs.kernel.org/networking/operstates.html) also allows `UNKNOWN` when a driver does not provide an operational state.
The provider must keep both administrative and operational state.

Linux documents that [binding `INADDR_ANY` binds all local interfaces](https://www.man7.org/linux/man-pages/man7/ip.7.html).
This supports the decision to bind concrete addresses instead of using `0.0.0.0` or `::`.

Network-interface libraries can return more data than Citadel needs.
The provider only needs interface identity, display name, state, type, addresses, IPv6 scope IDs, and address-state flags.
The implementation must confirm the library version and API before it adds the dependency.

## KOReader and IPv6 URLs

The inspected KOReader version is commit [`9192014d`](https://github.com/koreader/koreader/tree/9192014d8bd82a91dc1012473be0f238dedfdb54).
Its OPDS browser passes catalog URLs and optional credentials to [`socket.http.request`](https://github.com/koreader/koreader/blob/9192014d8bd82a91dc1012473be0f238dedfdb54/plugins/opds.koplugin/opdsbrowser.lua#L411-L428).

Its pinned LuaSocket accepts a bracketed IPv6 authority.
It removes the brackets before it connects ([`url.lua`](https://github.com/lunarmodules/luasocket/blob/e3ca4a767a68d127df548d82669aba3689bd84f4/src/url.lua#L143-L191)).
The HTTP client passes the host to `connect`.
`connect` resolves the host with `getaddrinfo` ([`http.lua`](https://github.com/lunarmodules/luasocket/blob/e3ca4a767a68d127df548d82669aba3689bd84f4/src/http.lua#L122-L130), [`inet.c`](https://github.com/lunarmodules/luasocket/blob/e3ca4a767a68d127df548d82669aba3689bd84f4/src/inet.c#L390-L428)).

This supports literal URLs for global and unique-local IPv6.
These URLs do not need a zone identifier.
The packaged KOReader build still needs a manual acceptance test.
This LuaSocket version creates an IPv6 `Host` header without brackets ([`http.lua`](https://github.com/lunarmodules/luasocket/blob/e3ca4a767a68d127df548d82669aba3689bd84f4/src/http.lua#L230-L241)).
Citadel should not require a strict `Host` value for this local, single-origin service.
Generated OPDS links should be relative.

## Link-local IPv6

Citadel excludes IPv6 link-local addresses.
A link-local socket needs a numeric scope ID on the server.
A URL needs a zone identifier that is valid on the client.
The server's `en0` name or interface index does not identify the KOReader device's Wi-Fi interface.

[RFC 9844](https://www.rfc-editor.org/rfc/rfc9844.html) requires the receiving host to convert a local zone identifier to its own interface index.
It also describes URI handling as an interoperability problem.

LuaSocket removes brackets but does not percent-decode the host.
An RFC-style `%25zone` therefore reaches `getaddrinfo` unchanged.
A raw `%zone` is not conforming and depends on the platform and interface name.

Citadel cannot create a portable KOReader link-local URL.
Keep the scope ID for diagnostics and future discovery or client work.
Do not bind or advertise link-local addresses in version 1.
