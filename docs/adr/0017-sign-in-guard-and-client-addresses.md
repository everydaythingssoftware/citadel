# 17. Sign-in guard and client addresses

Status: Proposed - 2026-11-21 (C-02). Both phases are implemented: client
addresses, proxy trust, listeners, admission and health first, then the
sign-in guard.

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
ranges plus the stored ones, and it applies immediately. Settings lists
both: configured ranges read-only, stored ones with Stop Trusting, which
asks once (ADR 0014: rare and deliberate).

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

Before this, every way of signing in shared one global back-off. It was
checked before the work and recorded after it, so a burst all got through;
any success reset it; and while it was on, nobody could sign in, the real
administrator included. Every attempt ran Argon2id (19 MiB, about 31 ms of
CPU) on tokio's blocking pool while holding one of the API's 64 work
permits: 64 concurrent wrong sign-ins took the server to 1.3 GB of memory.
OPDS counted requests without an `Authorization` header as failures, and
`DeviceKeyVerifier::matches` returned before hashing when the username
differed.

`citadel_opds::guard::SignInGuard` replaces both back-offs. One guard per
process judges browser sign-in, the setup code and OPDS device keys; the
server shares the OPDS service's guard with the API. Its core is synchronous
with an injected clock, and it never reads a database, so real and unknown
usernames are treated the same. It follows OWASP's "Slow Down Online Guessing
Attacks with Device Cookies" and the Credential Stuffing Prevention cheat
sheet. Every number below is a named constant, not a setting.

### Address tier

The main protection. Each client key (`/32` or `/64`) has a bucket of 100
failures that refills at 100 an hour. Its neighbourhoods have their own:
`/24` and `/56` 400 an hour, `/48` 1,000 an hour. When a bucket is spent,
that key is banned for an hour, doubling on each re-ban up to a day, and
refused cheaply with 429 and the real `Retry-After`.

Client keys live in a map of at most 100,000 entries that forgets the least
recently seen entry that isn't banned (or verifying). A forgotten client's
failures still count in its neighbourhoods, which are fixed tables of 65,536
hashed buckets. If the map is ever full of bans, new clients are judged by
their neighbourhoods alone. The guard never fails open, and never closes for
everyone.

Soft clients (`ClientAddress::is_soft()`, above) skip the address tier
entirely: no bans and no in-flight cap, since they may be many people behind
an unconfigured proxy. The username tier and the verifier pool still apply.

### Username tier

Each username, normalised exactly as sign-in compares it (`trim()` and ASCII
case folding, as `COLLATE NOCASE` does; other letters keep their case), is
keyed with SipHash-2-4 under a per-process random key into one of 65,536
buckets. A bucket holds 10 guesses and refills one every 30 seconds. When
it's empty, the guess is refused with 429 and `Retry-After` set to the
seconds until the next one (at most 30). Usernames are never banned. The
setup code has no username, so only the address tier applies to it.

### Known devices

A device that signed in before skips the username tier, so an attack on a
name doesn't lock its owner out:

- A browser gets a **known-device cookie** (`citadel_device`) on every
  successful sign-in: a random device ID and an expiry 90 days out, signed
  with HMAC-SHA-256 over them and the normalised username. It is separate
  from the session cookie, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS,
  and sent only to `/api/session`. The signing key is made on first use and
  kept in `citadel.db`'s `properties`, so cookies survive restarts; the
  SipHash key isn't kept, since nothing stored depends on it.
- An OPDS reader is known by its pair of username key and client key,
  recorded on success: the 8 most recent per username, each for 30 days
  after its last success, in memory only.

A cookie or pair counts only for the username it was made for. Each known
device has its own budget of 20 failures an hour; past that its exemption is
suspended for the hour and the username tier applies again.

### Repeats

The same failed credential (SHA-256 over the username key and the secret)
from the same client within 10 minutes counts once, in both tiers, so a
reader retrying a stale key doesn't ban its own address. A repeat is
answered as wrong at once, without checking it again: otherwise resending
one wrong password would keep the verifier busy without ever being counted.
Each client keeps the last 64. A password changed, within those 10 minutes,
to a string that same client just tried is refused until the entry expires.

### Reserving before work

`reserve` decides under one short lock. It refuses if the client or one of
its neighbourhoods is banned. For browser sign-in, it refuses with 429 when
the client already has 2 checks in flight. It refuses when the username's
bucket is empty and the device isn't known. Otherwise it debits every tier
at once and returns a `Ticket`. Settling a ticket as a success refunds its
debits without resetting anything and records the known device; a failure
keeps them; a ticket dropped unsettled counts as a failure; a ticket for a
check the server couldn't run is refunded.

### Verifier pool

`citadel_opds::verifier::VerifierPool` is the only place passwords are
checked: exactly 2 dedicated OS threads, not tokio's blocking pool, and not
the API's work permits. Known devices have a lane of their own (16 waiting)
that goes first; everyone else waits in a fair queue that takes turns
between neighbourhoods (`/24` or `/48`), at most 4 waiting from each and 64
in all. When full, the ticket is refunded and the request gets 503 with
`Retry-After: 1`. A check stays in flight until a thread finishes it, not
until its request goes away, so cancelling and resending can't exceed 2. A
check whose requester has gone is skipped before hashing and still counts as
a failure.

`CitadelStore::verify_password` is split into a cheap `lookup_hash` and an
expensive `StoredPassword::verify`; the pool runs only the second. Real and
unknown names both go through one lookup and one verification, the unknown
ones against a dummy hash with the same parameters, which the server makes
at startup.

### OPDS

OPDS uses the guard, synchronously in `authorize`, but not the pool or the
in-flight cap: its salted SHA-256 is cheap, and readers fetch covers in
parallel. A request with no `Authorization` header gets the 401 challenge
and isn't counted. A malformed header or an empty username counts as a
failure against the address. `DeviceKeyVerifier::matches` always hashes the
key, then checks the username.

### What a guesser gets

Generated device keys keep their format (ADR 0013): a word, three digits
from 2-9 with no two alike in a row, one of 6 symbols and another word, from
a pool of about 804 words, so about 804² × 8 × 7 × 7 × 6 ≈ 1.52 × 10⁹ keys
(30.5 bits). The username tier bounds a guesser who isn't on a known
device to about 120 guesses an hour per username, however many addresses
they have:

| Guesser | Guesses per hour per username | Chance of finding a given key in a year |
| --- | --- | --- |
| Many addresses, no known device | 120 (+10 burst) | ≈ 0.07 % |
| Worst case: also behind all 8 known reader addresses | 120 + 8 × 20 = 280 | ≈ 0.16 % |

A user with k keys multiplies the chance by k. One address alone is held to
100 an hour, and to far fewer once its bans double.

Browser passwords are chosen by people, so their strength varies; the same
tiers bound guessing, and credential stuffing (one password per many
usernames) is bounded by the address tier, since the username tier doesn't
see it.

NIST SP 800-63B-4 §3.2.2 requires disabling an authenticator after at most
100 consecutive failed attempts. Citadel deliberately diverges: it never
locks an account, because on a home server a lockout is something anyone
can trigger against the administrator. Rate limiting by address and by
username bounds guessing indefinitely instead, and known devices keep their
owners in.

### Administrators

`GET /api/server/sign-in` reports counts only: clients and neighbourhoods
banned now, and usernames being slowed now. Settings shows them on the
Server page.

## Consequences

- Deployments with a proxy on a private network, and no `trustedProxies`,
  keep their addresses and cookies. Their clients count as the proxy,
  softly, until an administrator trusts it from the Settings offer.
- Covers count as short requests so a browser's grid isn't throttled to four.
  Only book files and uploads are streams.
- Idle keep-alive connections last 60 s rather than indefinitely. Proxies
  whose upstream keep-alive is longer may see an occasional retried request.
- An attack on a username slows that name for new devices (a wait of up to
  30 seconds per guess), never for devices that signed in before. An
  administrator can always get back in from a browser they used before, or
  with the CLI's `users` commands.
- Admission still applies on top: one client may have 16 short requests in
  flight, so a reader fetching more than 16 covers at once gets 503 for the
  rest. The guard never refuses them.
- Argon2 memory is held only while hashing. On glibc the server fixes the
  allocator's mapping threshold at startup, so each 19 MiB buffer is
  unmapped when freed instead of staying in the verifier thread's heap.
- The verifier's queues are kept small (16 in the fair queue, 8 in the
  known-device lane), so waiting sign-ins hold at most 24 of the API's 64
  short slots. A flood from many neighbourhoods that cycles usernames gets
  503 from the full queue instead of crowding out other requests.
- On loopback every client is local, so the load test's spoofed-header
  scenario runs in soft mode, the worst case: only the username tier and the
  pool apply, and the two verifier threads stay busy.
