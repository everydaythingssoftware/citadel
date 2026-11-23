# 18. Listener and admission limits

Status: Accepted - 2026-11-21

## Context

The API and OPDS shared 64 request slots, and a request held its slot until
its response was fully read, so slow or stalled clients could fill them.
Listeners had no header or idle timeouts and no connection caps, and HTTP/2
cleartext was on by accident. `/api/health` waited in the same queue, so a
busy server reported itself down and Docker restarted it. A request without
`Host` skipped the public-URL check.

## Decision

- **One listener** serves the API and every OPDS address: HTTP/1.1 only,
  headers within 10 s and 32 KiB, idle connections closed after 60 s, at most
  1,024 connections (evicting the oldest idle one) with 32 kept for loopback,
  and at most 32 per peer unless it is a trusted proxy.
- **Admission:** each listener has its own pools for public, short and stream
  requests, and each client may have 8, 16 and 4 in flight. Any response that
  averages under 1 KiB/s over a minute ends and frees its slot.
- **Health** is answered outside admission from a result cached every 2 s.
- **Public URLs:** scheme and host come from the configured forwarded header
  family, rightmost value. A `publicUrls` list always restricts, even when it
  names only this machine, and a request with no `Host` is refused while it
  is set.

All numbers are constants.

## Consequences

- Slow readers, idle connections and floods can't hold every slot, and health
  stays answerable under load.
- Idle keep-alive connections last 60 s, so a proxy with a longer upstream
  keep-alive may occasionally retry a request.
