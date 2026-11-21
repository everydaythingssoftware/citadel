# 17. Sign-in guard and client addresses

Status: Proposed - 2026-11-21 (C-02). Phase 1 (client addresses, proxy trust,
listeners, admission, health) is implemented; the sign-in guard is the next
phase.

## Context

The security review's C-02 found that one flood could stop every listener at
once. The API and OPDS shared one set of 64 request slots, and downloads also
held one of OPDS's blocking-work permits. Listeners had no header or idle
timeouts and no connection caps. HTTP/2 cleartext was switched on by accident,
because reqwest enables hyper-util's `http2` feature. `/api/health` waited in
the same queue as everything else, so a full server also reported itself
down. Nothing knew who a request came from: `X-Forwarded-For` was never read.
Every network on the machine was trusted to say how the browser reached
Citadel, which is fine for scheme and host but would let anyone on the LAN
pick their own address once addresses count. Separately, L-03 found that a
request with no `Host` skipped the public-URL check, and `PublicUrl::parse`
accepted `http://:80`.

A sign-in guard (per-address and per-username limits) needs a client address
it can trust before it can exist, so this ADR covers the groundwork first.

## Decision

### Client addresses (`citadel_opds::client`)

If the TCP peer isn't a trusted proxy, the client is the peer, and forwarded
headers are ignored for every purpose. If it is trusted, Citadel reads one
configured header (`api.forwardedHeader`: `x-forwarded-for` by default, or
`forwarded` and its `for=` values), joins every instance of it in order, and
walks right to left skipping trusted entries. The first untrusted entry is
the client. If every entry is trusted, the leftmost is. Entries may be `ip`,
`ip:port`, `[v6]` or `[v6]:port`, quoted in `Forwarded`. IPv4-mapped IPv6
addresses count as IPv4. A request made in-process, with no peer, is
loopback.

Two cases put a request in **soft mode** (`ClientAddress::soft()`), where
address-based penalties should be lenient because many people may share the
address. In the first, the nearest entry Citadel would believe can't be read,
so the request is keyed by that proxy. In the second, an untrusted peer on a
private, loopback, CGNAT (`100.64.0.0/10`) or link-local network sends
forwarding headers. That second kind of peer is probably a reverse proxy
nobody configured. Citadel records it in `UntrustedForwarders`, a list of at
most 64 that forgets the least recently seen first, with the header names and
when it was last seen. Public peers are never recorded. One log line is
written at most once a minute across the process.

Counting uses `AddressKey`: `/32` (IPv4) or `/64` (IPv6) for one client, and
the aggregates `/24`, `/56` and `/48` for its neighbourhood.

### Trust split

When `trustedProxies` isn't configured, client addresses trust loopback only
(`127.0.0.0/8`, `::1`). Origin derivation (scheme and host) keeps the old
default, which adds the private ranges, so existing proxy setups keep their
addresses and cookies. When `trustedProxies` is configured, that one list
applies to both. The server's OPDS listener uses the same trust and header
(one shared `ClientResolver`), and the desktop's OPDS trusts loopback only.

Administrators can add ranges from Settings. `GET /api/server/proxies` lists
recorded untrusted forwarders. `POST` trusts a range, and `DELETE` untrusts
one and dismisses the forwarders in it, which is also how the offer is
dismissed. Stored ranges live in `citadel.db`'s `properties` table, because
Citadel never writes its config file. The effective list is the configured
ranges plus the stored ones, and it applies immediately.

### Listeners (`citadel_opds::listener`)

One hyper accept loop serves the API and every OPDS address, on both the
server and the desktop:

- HTTP/1.1 only (`http1::Builder`), so HTTP/2 prior knowledge is refused.
- `ConnectInfo<SocketAddr>` and a `ConnectionControl` on every request.
- A request's headers must arrive within 10 s of its first byte (or of the
  connection opening), and may be at most 32 KiB, answered with 431.
- A keep-alive connection with no request for 60 s is closed.
- At most 1,024 connections. When full, a new connection evicts the oldest
  idle one, or is refused if none is idle. 32 of those places are only for
  loopback peers, so `citadel-server health` always connects.
- At most 32 connections per peer, unless the peer is a trusted proxy.
- Shutdown stops accepting, closes idle connections and lets requests in
  progress finish.

These are constants, not settings. Hyper's own `header_read_timeout` restarts
whenever a keep-alive connection goes idle. It would close idle connections
after 10 s, so it is turned off and both timeouts live in the loop. Hyper's
`max_buf_size` can be overshot by a single large read, so the socket wrapper
reads no more of a request head than the limit allows.

### Admission (`citadel_opds::limits`)

Each listener has its own `Limits`. That includes each OPDS address and the
work permits of the API's asset routes. Requests fall into three classes:

| Class | What | API | OPDS |
| --- | --- | --- | --- |
| public | web app files, `/api/version`, `GET /api/setup` | 32 | — |
| short | JSON, feeds, covers, thumbnails | 64 | 48 |
| stream | book files, upload chunks, cover uploads | 32 | 24 |

Each client (`AddressKey`) may have 16 short and 4 stream requests in flight,
eight times as many in soft mode. A request keeps its slot until its response
body ends. A streamed response body that sends less than 60 KiB in any 60 s
window (1 KiB/s) ends, gives its slot back and closes its connection. A
watchdog checks this, because a client that stops reading stops the body from
being polled. An upload chunk that sends nothing for 30 s ends.

### Health

`/api/health` and `/api/version` are answered before admission, behind their
own 8-permit semaphore. Anonymous health comes from a result a background task
computes every 2 s, so floods do no database work. Overflow gets the same
cached answer. Before the first result exists, permit holders wait for it and
overflow is told to retry. A health request with a session cookie takes the
admitted path and keeps the administrator's detail.

### L-03

`PublicUrl::parse` rejects an empty host or a host that is only a port, and
the error names the value. When `Host` is missing, the authority comes from
the request target. When `publicUrls` is set and no origin can be derived,
checked paths answer 400 "Missing Host". Loopback peers and in-process calls
work as before.

## Sign-in guard

_To be written by the next phase: per-address and per-username tiers keyed by
`ClientAddress::key()` and `aggregate_keys()`, lenient for
`ClientAddress::is_soft()`; an Argon2 verifier pool; known-device cookies._

## Consequences

- Deployments with a proxy on a private network, and no `trustedProxies`,
  keep their addresses and cookies. Their clients count as the proxy,
  softly, until an administrator trusts it from the Settings offer.
- Covers count as short requests so a browser's grid isn't throttled to four.
  Only book files and uploads are streams.
- Idle keep-alive connections last 60 s rather than indefinitely. Proxies
  whose upstream keep-alive is longer may see an occasional retried request.
