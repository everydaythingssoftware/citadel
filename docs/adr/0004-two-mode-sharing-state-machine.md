# 4. The sharing service has two modes and an explicit state machine

Status: Accepted - 2026-09-21

Supersedes 0002. See "Relationship to 0002" below.

## Context

ADR 0002 decided the OPDS listener would bind exact addresses on
user-selected interfaces, with a reconcile loop to keep those binds current.
The design assumed a picker of network interfaces.

The picker does not survive contact with a real machine.
A developer workstation exposes around 65 interfaces:
Docker and Colima bridges, Tunnelscale and VPN adapters, AWDL, loopback
variants, and the actual LAN.
Choosing one of sixty-five is not a decision a reader app should ask for.

Sharing is a mode choice, not a network configuration task.
The user decides between "my local network" and "everywhere".
Calibre is the mental-model reference for that simplicity.
It is not a posture reference: Calibre binds a wildcard with no gate.

The threat model is plain.
On the local network: other devices and guests on the same LAN.
On the host: containers and virtual machines.
Through a VPN: that network's peers.
Through global IPv6 or a public address: anyone the router or firewall lets
through.
Basic authentication is the only tool readers support.
OPDS readers speak plaintext Basic; they do not trust self-signed TLS and
ACME does not exist on a LAN.

The reconcile loop cost more than it bought.
It was around four hundred lines of time-based code - a failure ledger,
backoff, and per-address reconciliation - and it produced the feature's only
deadlock and its only stale-event race.
Recovery for a changed network is one user action: turn sharing off and on.

## Decision

The service has two modes.

`LocalNetworks` binds exact addresses: interfaces classified as LAN and up,
carrying private (RFC 1918) or unique-local IPv6 addresses.
Globally routable addresses are excluded.
It never binds Docker bridges, VPN adapters, or wildcards.

`AllInterfaces` binds two wildcard sockets, `0.0.0.0` and `::`, with
`IPV6_ONLY` set on the v6 socket.
It serves every network the computer can reach, and it requires
credentials.

Credentials gate the mode, not a checkbox.
`AllInterfaces` starts only when a credential set exists.
Clearing credentials while sharing is active stops sharing.
ADR 0003 records where credentials live.

The service is an explicit state machine.
The states are Stopped, Starting, Running, Waiting, and Failed.
Each variant owns its resources; transitions are the only code that changes
state; a generation counter dismisses events from a superseded run.
The mutex is never held across an await.

Interfaces are enumerated once per start attempt.
`LocalNetworks` that find no usable address enter `Waiting`, and a small poll
retries while - and only while - the service is Waiting.
There is no reconcile loop.
If the network changes under a running share, the user turns sharing off and
on.

There is no interface picker.
Per-interface binding is not a feature of the desktop application.

## Alternatives considered

- A filtered, grouped interface picker (LAN first, VPN and virtual secondary):
  still asks the user a networking question the product does not want to ask.
- Wildcard by default, gated on credentials alone: exposes containers,
  tailnet peers, and global addresses even in the default posture.
- Keeping the reconcile loop: the complexity budget went to the state
  machine; the loop fixed a case that is one toggle away from self-service.
- Reacting to OS network-change events: no cross-platform event source in
  Tauri; three platform bindings for one deferred case.
- Keeping `Interface{id}` in the persisted settings: dead configuration for a
  deleted picker; new installs fall back to `LocalNetworks`.
- mDNS/Bonjour advertisement: no OPDS standard exists for it, and it adds a
  macOS entitlement.
- TLS: self-signed certificates are untrusted on readers and ACME needs a
  public name. Basic over plaintext with a generated password is the ceiling.
- Digest authentication: reader support is poor.
- Typestate encoding of the state machine: consuming transitions do not
  compose with shared, async, externally driven state.

## Consequences

After sleep or wake with a new address, a Running share binds a stale
address.
The socket does not die, so nothing detects it; connections fail and the
status still says Running until the user re-toggles.
This is the accepted cost of enumerate-once.
A periodic compare-while-Running is the planned mitigation and is deferred.

The macOS firewall prompts once for the app.
If the user denies it, every bind fails with a "port unavailable" message
that does not mention the firewall.
Known copy gap.

On Windows, ports reserved by Hyper-V and WSL fail with a permission error.
It is reported with the generic port message.
Known copy gap.

Bridged LAN ports (`br0`-style) are classified as unknown and are not served
by `LocalNetworks`.
Their path is `AllInterfaces` with credentials.
"Share only on my tailnet" is not expressible.
Both are accepted for v1.

Under `AllInterfaces`, containers and virtual machines on the host can reach
the library, behind the password.
This is stated plainly, not hidden.

One credential set per installation is stored as an Argon2 verifier in the
application data directory (ADR 0003).
It is not portable with the library and no keychain is used.

Transitions are pure and table-tested; network behaviour sits behind two
trait seams (interface snapshots and listener creation).

This decision reopens if real users demand per-interface binding, a
cross-platform network-change event appears, readers gain TLS trust, or
OPDS 2.0 changes discovery.

## Relationship to 0002

Retained: exact-address binding for local networks, interface
classification, the no-wildcard default for local sharing, and Basic
authentication.

Replaced: interface selection, the persisted interface identity, the
reconcile loop, and "the user selects one network interface".

Added: the `AllInterfaces` mode, the credentials-derived global gate, and
the state machine.
