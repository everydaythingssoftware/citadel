# 2. Interface-scoped OPDS listener

Status: Accepted — 2026-07-31

## Context

Citadel's desktop OPDS server runs only while the app is open and must be
enabled again after every app launch. Sharing defaults to ordinary local
networks, but the user may select one network interface, including a VPN. If a
selected interface disappears, Citadel must stop accepting connections rather
than silently widening access. The v1 service supports IPv4 plus global-unicast
and unique-local IPv6; it does not use TLS, mDNS, Bonjour, or a QR code.

An IP address is not an interface identity. DHCP, IPv6 privacy-address rotation,
Wi-Fi roaming, sleep, VPN reconnection, and cable changes can replace addresses
while the user's choice remains the same. Conversely, binding `0.0.0.0` or `::`
accepts on every matching local interface, including interfaces that appear
later. A concrete listener set must therefore be continually reconciled from a
persisted interface selection and fresh interface snapshots.

The implementation needs the same model on supported macOS and Linux builds:

- a persistable interface identity and a friendly label;
- administrative/operational state and all assigned IPv4/IPv6 addresses;
- IPv6 scope IDs and address-state flags;
- enough classification to exclude loopback, VPN, and virtual interfaces from
  the "All local networks" default;
- fail-closed listener recovery after interface/address changes; and
- deterministic tests that do not modify the machine's network configuration.

Interface classification is product policy, not a security boundary. A
physical adapter can have a globally routable IPv6 address, virtual adapters are
not named consistently, and routing or firewall rules can make a listener
reachable beyond the attached link.

## Spike evidence

The executable proof is
`src-tauri/examples/network_interface_spike.rs`. `InterfaceProvider` supplies
snapshots and `ListenerFactory` creates and closes listeners, allowing the
planner and lifecycle to be tested without changing host networking. The proof
opens real concrete TCP listeners when run without `--list`.

The proof pins `netdev` 0.45.0 with optional features disabled. This is the
current release evaluated for the spike and builds with the Rust 1.97.1
toolchain that CDL-28 will pin across the repository. It supplies:

- system name, index, localized friendly name, type, and state flags;
- IPv4 and IPv6 networks;
- an IPv6 scope ID aligned with each IPv6 address; and
- normalized temporary, deprecated, tentative, duplicate, and permanent IPv6
  address flags on macOS and Linux.

This avoids subprocess parsing and Citadel-owned unsafe platform code. Gateway,
DNS, route, and serialization features are not needed.

The injected suite proves all of the following:

- all usable addresses across multiple LAN interfaces are planned as concrete
  listeners;
- global-unicast, unique-local, stable, and temporary IPv6 addresses can
  coexist;
- temporary-address rotation closes only the stale listener and leaves a
  stable address open;
- deprecated, tentative, and duplicate IPv6 addresses are not bound;
- IPv6 URLs use bracketed literals;
- an IPv6-only selected interface fails closed when its usable address
  disappears and recovers when an address returns;
- a selected interface never falls back to another interface; and
- enumeration or bind failure closes the complete listener set.

A live macOS run on Rust 1.97.1 found Wi-Fi IPv4, two stable global IPv6
addresses, one temporary global IPv6 address, and link-local IPv6. It opened
only the four usable concrete listeners and emitted bracketed IPv6 URLs. A live
Linux arm64 container run with the same toolchain and dependency opened its
concrete Ethernet IPv4 and unique-local IPv6 listeners. The same 15 injected
tests passed natively on macOS and in that Linux environment.

Relevant platform contracts:

- Apple exposes the BSD device name separately from the localized display name
  through [System Configuration](https://developer.apple.com/documentation/systemconfiguration/scnetworkconfiguration).
- Linux distinguishes administrative `IFF_UP` from readiness to pass traffic;
  its [operational-state documentation](https://docs.kernel.org/networking/operstates.html)
  permits `UNKNOWN` where a driver does not implement operational state.
- Linux documents that
  [binding `INADDR_ANY` binds all local interfaces](https://www.man7.org/linux/man-pages/man7/ip.7.html).
  Concrete address binding has the required equivalent behavior on macOS and
  Linux for both address families.

### KOReader and IPv6 literals

The KOReader version inspected for this decision is commit
[`9192014d`](https://github.com/koreader/koreader/tree/9192014d8bd82a91dc1012473be0f238dedfdb54),
whose OPDS browser passes catalog URLs and optional credentials to
[`socket.http.request`](https://github.com/koreader/koreader/blob/9192014d8bd82a91dc1012473be0f238dedfdb54/plugins/opds.koplugin/opdsbrowser.lua#L411-L428).
Its pinned LuaSocket parses a bracketed IPv6 authority and removes the brackets
before connecting ([`url.lua`](https://github.com/lunarmodules/luasocket/blob/e3ca4a767a68d127df548d82669aba3689bd84f4/src/url.lua#L143-L191));
the HTTP client then passes that host to `connect`, which resolves it through
`getaddrinfo` ([`http.lua`](https://github.com/lunarmodules/luasocket/blob/e3ca4a767a68d127df548d82669aba3689bd84f4/src/http.lua#L122-L130),
[`inet.c`](https://github.com/lunarmodules/luasocket/blob/e3ca4a767a68d127df548d82669aba3689bd84f4/src/inet.c#L390-L428)).
That is sufficient evidence to plan global and unique-local literal URLs, which
need no zone identifier. CDL-27 must still manually certify the packaged
KOReader build: this LuaSocket version constructs an unbracketed IPv6 `Host`
header ([`http.lua`](https://github.com/lunarmodules/luasocket/blob/e3ca4a767a68d127df548d82669aba3689bd84f4/src/http.lua#L230-L241)).
Citadel should not require a syntactically strict `Host` value for this local
single-origin service, and generated OPDS links should be relative.

IPv6 link-local addresses are deliberately excluded. A link-local socket needs
a numeric scope ID on the server, while a URL needs a zone identifier meaningful
on the client. The server's `en0` name or interface index does not identify the
KOReader device's Wi-Fi interface. RFC 9844 requires the receiving host to
convert a locally meaningful zone identifier to its own interface index and
also describes URI handling as an interoperability problem
([RFC 9844](https://www.rfc-editor.org/rfc/rfc9844.html)). LuaSocket strips
brackets but does not percent-decode the host, so an RFC-style `%25zone` reaches
`getaddrinfo` unchanged; a raw `%zone` is nonconforming and remains
platform/name-dependent. Citadel therefore cannot advertise a portable
KOReader link-local literal. The snapshot retains the scope ID for diagnostics
and future discovery/client work, but v1 neither binds nor advertises link-local
addresses.

## Decision

### Enumeration and identity

Use pinned `netdev` 0.45.0 behind a Citadel-owned provider trait. Poll a fresh
snapshot every two seconds while sharing is running. Also enumerate when the
Sharing pane opens so stopped configuration shows current choices.

Persist the Unix system name (`en0`, `wlan0`, `eth0`, `wg0`) as the selected
interface ID. Show the localized friendly name where available and the system
name alongside it. The OS index is snapshot metadata only: it can change across
boots and must not be persisted. A MAC address is not an identity because it
can be absent, virtual, or privacy-managed. If the OS renames a selected
interface, wait for the saved name and ask the user to reselect; do not guess
from an index, MAC, label, or former address.

An interface is available only when both its administrative `UP` and `RUNNING`
flags are set and it has at least one usable address. Preserve both flags in
diagnostics rather than depending exclusively on `IF_OPER_UP`.

Normalize address scope and state. A usable v1 address is:

- IPv4 private, shared-address-space, or ordinary unicast;
- IPv6 global unicast (`2000::/3`) or unique local (`fc00::/7`); and
- for IPv6, neither deprecated, tentative, nor duplicate.

Temporary IPv6 addresses are usable. Loopback, unspecified, link-local,
multicast, broadcast, IPv4 class-E, and other unsupported IPv6 scopes are not.

### Classification

Normalize each interface to one of:

- **LAN**: physical Ethernet/Wi-Fi-like interfaces;
- **VPN**: point-to-point/tunnel/PPP interfaces and known tunnel names such as
  `utun*`, `tun*`, `tap*`, `wg*`, and `tailscale*`;
- **Loopback**: loopback flags/type/address; or
- **Other**: bridges, container/VM adapters, Apple peer-to-peer interfaces, and
  unrecognized virtual interfaces.

"All local networks" selects only available LAN interfaces. It never selects
VPN, Loopback, or Other. A specifically selected non-loopback interface may be
LAN, VPN, or Other; that explicit choice authorizes it. Classification controls
defaults and labels, not firewalling or proof of same-subnet origin.

### Binding, URLs, and recovery

For every usable address on every chosen interface, bind one listener to the
concrete `(address, configured port)` pair. Never bind `0.0.0.0`, `::`, or use
an interface-binding socket option. "All local networks" is a changing set of
concrete IPv4 and IPv6 listeners, not a wildcard listener.

The configured port must be in `1..=65535`. Port zero is not a usable
configuration: the OS would independently choose an ephemeral port for every
concrete listener, so Citadel could not present one stable catalog port.

Advertise one HTTP URL per listener. IPv4 uses
`http://192.168.1.20:PORT/opds`; IPv6 follows URI syntax and uses
`http://[2001:db8::20]:PORT/opds`. Do not produce a link-local URL. The Sharing
UI must show the exact bound addresses; a global IPv6 URL must not be described
as inherently LAN-only.

On every poll:

1. derive the complete desired address set from the selected mode;
2. close listeners whose address is no longer desired;
3. bind missing concrete addresses; and
4. publish Running only after every desired listener is open.

If any bind fails, close the entire listener set and publish an actionable
error. Retry on the next snapshot or explicit UI retry. If a selected interface
disappears, goes down, or loses every usable address, close all listeners and
publish a Waiting status naming it. Preserve the selection; when the same ID
returns with a usable address, bind the new set and return to Running. Never
fall back to all-local mode or another interface.

Close stale listeners before opening replacements. This accepts a brief
interruption for an address replacement while preventing an address excluded by
the newest snapshot from remaining reachable. The two-second poll bounds stale
reachability. Reconcile immediately on start, stop, app shutdown, and settings
changes as well.

The service remains plaintext because v1 has no custom-certificate workflow.
Optional HTTP Basic authentication is independent of interface binding and
applies uniformly to every listener.

## What we rejected

- **Wildcard listeners plus request-time filtering.** The socket accepts on
  excluded and newly appearing interfaces, and a source address does not
  reliably identify the receiving interface.
- **`SO_BINDTODEVICE` or platform equivalents.** This is platform-specific,
  often privilege-sensitive, and unnecessary with concrete address binding.
- **Persisting an interface index or matching by label/MAC/address.** These can
  change or collide; a wrong fallback can widen exposure.
- **Native System Configuration and netlink code in Citadel.** Current
  `netdev` supplies the required normalized data without subprocesses or new
  unsafe code.
- **Event subscriptions in v1.** Separate platform event loops add complexity;
  polling is cheap at desktop scale and preserves the same planner/reconciler.
- **IPv6 link-local listeners.** A portable client URL cannot be derived from
  the server's zone, and current KOReader/LuaSocket behavior does not repair
  that mismatch.
- **Choosing one preferred IPv6 address.** Multiple stable and temporary
  addresses can all be valid. Binding and displaying every usable address is
  deterministic and naturally reconciles rotation.

## Consequences

- The service cannot silently become reachable on a VPN or VM bridge after it
  starts in all-local mode.
- Network changes can cause up to roughly two seconds of stale reachability,
  followed by a short listener reconciliation.
- A global IPv6 listener may be internet-routable. The Sharing UI must show the
  concrete interface/URL and retain the plaintext and unauthenticated warnings;
  OS firewall behavior remains outside Citadel's guarantee.
- Temporary IPv6 rotation can change displayed URLs while sharing is active.
- IPv6-only networks work when they provide global or unique-local addresses;
  link-local-only networks do not.
- Users who rename or replace an adapter may need to select it again.
- CDL-25 can lift the proof's provider, snapshot, planner, and listener
  reconciler into production code. CDL-27 owns end-to-end KOReader acceptance,
  including global/ULA IPv6 and Basic auth.
