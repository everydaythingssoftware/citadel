# 2. Bind OPDS listeners to selected interfaces

Status: Superseded by 0004 - 2026-09-21 (interface selection and the reconcile loop are replaced; exact-address binding and Basic authentication are retained there).

## Context

Citadel is adding an OPDS catalog server to the desktop application.
When the application runs, the user will be able to share the catalog on all local networks or select one network interface.
The selected interface can be a VPN.

Citadel must keep this sharing limit when the network changes.
It must work on macOS and Linux.
It must not give more network access without a user action.

An IP address does not identify an interface forever.
An interface can get a new address without a change to the interface.
A wildcard listener, such as `0.0.0.0` or `::`, accepts connections on interfaces that the user did not select.
It also accepts connections on new interfaces.
Citadel cannot reliably identify the receiving interface after it accepts a connection.

Version 1 will support IPv4, global-unicast IPv6, and unique-local IPv6.
It will not support additional discovery features like mDNS/Bonjour or QR-code
generation.
It will not support TLS, and will recommend termination happen at a proxy, if required.
The user will be able to enable HTTP Basic authentication for all listeners.

## Decision

Citadel will bind one OPDS listener to each usable address on each selected interface.
It will not use wildcard listeners.
It will not filter requests after it accepts a connection.

Citadel will save the Unix system name as the interface identity.
Examples are `en0`, `wlan0`, `eth0`, and `wg0`.
It will not save the OS index, MAC address, display label, or IP address as the identity.
These values can change or conflict with another interface.

Citadel will get interface data from a network-interface library.
The library will be behind a provider interface that Citadel owns.
The provider will return the system name, display name, state, type, addresses, IPv6 scope IDs, and address-state flags.
This design avoids new platform code and command-line parsing.

Citadel will treat an interface as available when it is up and running.
It must also have one or more usable addresses.
`All local networks` will select available LAN interfaces only.
An explicit user selection will be able to select any available non-loopback interface.
Citadel will classify interfaces as LAN, VPN, Loopback, or Other.
It will use this classification for defaults and labels.
The classification will not be a security limit.

A usable address will be an ordinary IPv4 unicast address.
This includes private and shared-address-space addresses.
A usable IPv6 address will be global-unicast (`2000::/3`) or unique-local (`fc00::/7`).
Citadel will not use loopback, unspecified, link-local, multicast, broadcast, IPv4 class-E, or unsupported IPv6 scopes.
It will not use deprecated, tentative, or duplicate IPv6 addresses.
It will be able to use temporary IPv6 addresses.

Citadel will reconcile the listener set when sharing starts, stops, or shuts down.
It will also reconcile the set when sharing settings change or when the Sharing pane opens.
While sharing runs, Citadel will subscribe to events that suggest an interface/address/link has changed, and may process them debounced.
Subscriptions will use platform-specific code in pursuit of correctness and efficiency behind the existing platform provider.
On any interface/address/link change, Citadel will reconcile the listener set.
For each reconciliation, Citadel will do these steps:

1. Calculate the complete listener set that it needs.
2. Close listeners that are not in that set.
3. Open listeners that are missing from that set.
4. Report `Running` only when all required listeners are open.

Each listener will bind one `(address, configured port)` pair.
The port must be in `1..=65535`.
Citadel will advertise one HTTP URL for each listener.
It will put brackets around an IPv6 literal in a URL.

If interface enumeration or listener binding fails, Citadel will close all listeners.
It will then show an actionable error.
If a selected interface disappears, goes down, or loses all usable addresses, Citadel will close all listeners.
It will then report `Waiting`.
Citadel will keep the user selection.
It will resume sharing only when the same interface name returns with a usable address.
It will not select another interface.
It will not change to `All local networks`.

## What we rejected

- **Wildcard listeners with request-time filtering.** A wildcard listener accepts connections on excluded interfaces.
  A peer source address does not reliably identify the receiving interface.
- **`SO_BINDTODEVICE` or an equivalent platform feature.** This feature is not portable.
  It can also require special privileges.
  Concrete address binding gives the required limit on both target platforms.
- **An interface index, label, MAC address, or IP address as the identity.** These values can change or conflict.
  The system name keeps the user selection when an address changes.
- **IPv6 link-local listeners.** Citadel cannot make a portable client URL for an address that requires an interface scope.
- **One preferred IPv6 address.** An interface can have more than one valid stable or temporary address.
  Citadel binds all usable addresses to handle address rotation.
- **A two-second polling loop**, instead of platform-specific network change event subscriptions.
  - Efficiency was felt to be more important than minimal code.
  - This also avoids correctness isues in between polls.

## Consequences

- `All local networks` will not include a VPN or VM bridge that appears after sharing starts.
- Address replacement will cause a short sharing interruption.
  Citadel will close the old listener before it opens the replacement listener.
- A global IPv6 listener can be reachable from the internet.
  The Sharing UI must show the interface and URL.
  It must warn the user about plaintext HTTP, authentication, and firewall limits.
- Temporary IPv6 rotation can change the URLs while sharing runs.
- IPv6-only networks will work only with global-unicast or unique-local addresses.
  Link-local-only networks will not work.
- The OS can rename or replace an interface.
  The user will then need to select an interface again.

Supporting research: [`docs/research/interface-scoped-opds-listener.md`](../research/interface-scoped-opds-listener.md).
