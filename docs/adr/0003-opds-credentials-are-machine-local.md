# 3. OPDS credentials are machine-local

Status: Accepted - 2026-09-21. Storage format amended by ADR 0005: the file holds the reversible password, not a verifier.

## Context

The OPDS sharing server supports optional HTTP Basic authentication.
A credential set is a username and an Argon2 password verifier.
The plaintext password is never stored.
When credentials exist, sharing can reach beyond the local network.

Citadel libraries are portable.
Users copy them between machines, keep them in synced folders, and include them in backups.
Credentials are secrets.

## Decision

Credentials live in the application data directory, not in or next to any library.
There is one credential set per Citadel installation.
It applies to whichever library is open.

Moving, copying, syncing, or backing up a library never moves credentials.
A leaked library archive contains no credential material.
A leaked credential file contains a verifier, not a password.

Installing Citadel on a new machine starts with no credentials.
The user sets them again if they want auth there.
Windows cannot enforce Unix file modes; per-user ACLs on the app-data directory are the equivalent.

## Consequences

One server per application means one credential set per machine, even across libraries.
Readers configured with the username and password keep working across library switches.
They stop working on a fresh install until credentials are set again.
