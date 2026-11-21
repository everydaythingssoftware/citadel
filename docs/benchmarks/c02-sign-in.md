# C-02 sign-in flood: before and after

The sign-in guard and verifier pool (ADR 0017) measured with
`scripts/load/sign_in_flood.py` against release builds of the commit before
them (9503ca8) and of the commit that adds them. Measured 2026-11-21 on a
4-core Intel Xeon at 2.10 GHz (Linux, loopback), one run each, nothing else
running.

```sh
cargo build --release --locked -p citadel-server --bin citadel-server
python3 -I scripts/load/sign_in_flood.py --server target/release/citadel-server
```

Each scenario starts a fresh server with a scratch state directory and an
administrator, attacks from 127.0.0.1 with 64 connections, and meanwhile
every 2 s signs the administrator in from 127.0.0.2 with the known-device
cookie an earlier sign-in set ("known device") and from 127.0.0.3 without one
("new device"). CPU and memory are sampled from `/proc` every 100 ms and
`/api/health` is polled every 100 ms. Thresholds: RSS under 150 MB, health
always 200, the known device always in, the new device always answered (in,
or 429/503 with `Retry-After` of at most 30 s), at most 2 cores on average.

- **burst**: 64 wrong sign-ins for the administrator at once.
- **sustained**: 30 s of wrong sign-ins cycling usernames.
- **spoofed**: the same with a made-up `X-Forwarded-For` on each, sent
  directly. On loopback the peer is a local, untrusted forwarder, so this
  runs in soft mode: no address tier, the worst case.
- **botnet**: 30 s of wrong sign-ins for the administrator from 1,000
  addresses named by `X-Forwarded-For` through a trusted proxy on this
  machine (`CITADEL_TRUSTED_PROXIES=127.0.0.1/32`).

## Before (9503ca8)

| before (9503ca8) | attempts (rate) | peak RSS / VmHWM | CPU mean / busiest 1 s (verifier threads) | health 200 | known device in | new device answered (in) | slowest legit | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| burst | 64 (5/s) | 276 / 276 MB | 0.04 / 0.42 (—) | 100.0% | 0.0% | 100.0% (0%) | 0.0 s | MISS: RSS 276 MB, known device 0.0% |
| sustained | 121626 (4003/s) | 335 / 335 MB | 0.52 / 0.72 (—) | 100.0% | 0.0% | 100.0% (0%) | 0.1 s | MISS: RSS 335 MB, known device 0.0% |
| spoofed | 111100 (3656/s) | 639 / 639 MB | 0.53 / 0.98 (—) | 100.0% | 0.0% | 100.0% (0%) | 0.1 s | MISS: RSS 639 MB, known device 0.0% |
| botnet | 119106 (3922/s) | 1020 / 1020 MB | 0.81 / 1.57 (—) | 100.0% | 0.0% | 100.0% (0%) | 0.1 s | MISS: RSS 1020 MB, known device 0.0% |

The global back-off refused everyone, the administrator included: no
legitimate sign-in succeeded during any attack, and Argon2 on tokio's
blocking pool took memory to 1 GB.

## After

| after | attempts (rate) | peak RSS / VmHWM | CPU mean / busiest 1 s (verifier threads) | health 200 | known device in | new device answered (in) | slowest legit | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| burst | 64 (5/s) | 72 / 72 MB | 0.03 / 0.10 (0.03) | 100.0% | 100.0% | 100.0% (100%) | 0.0 s | pass |
| sustained | 111825 (3659/s) | 75 / 75 MB | 0.59 / 1.09 (0.11) | 100.0% | 100.0% | 100.0% (100%) | 0.1 s | pass |
| spoofed | 82719 (2716/s) | 75 / 75 MB | 2.12 / 2.25 (1.75) | 100.0% | 100.0% | 100.0% (14%) | 0.1 s | MISS: CPU 2.12 cores |
| botnet | 117371 (3876/s) | 77 / 77 MB | 0.62 / 0.72 (0.02) | 100.0% | 100.0% | 100.0% (0%) | 0.1 s | pass |

The known device signed in every time and nothing went over 77 MB. A new
device got in whenever its username wasn't under attack; in the botnet
scenario, which attacks the administrator's own name, it was told to retry in
at most 30 s every time.

One miss: in the soft-mode spoofed scenario the process averaged 2.12 cores.
The two verifier threads used 1.75 of them; the rest was refusing about 2,700
requests a second. Verification is capped at two threads by construction; the
overhead of answering a flood grows with its rate. In that scenario the new
device shares the attacker's `/24` lane in the verifier's fair queue (every
loopback client does), so it was mostly answered 503 with `Retry-After: 1`
and got in 14% of the time.

## Timing

`cargo run --release -p citadel-server --example sign_in_timing`: 2,000
alternating samples each after 100 warm-up rounds, tested for equivalence
with TOST (two one-sided Welch t-tests, α = 0.05) at a margin of ±2% of the
real user's mean. Sign-in times `lookup_hash` plus `verify` for a real user
with a wrong password and for unknown names; OPDS times checking four
verifiers of one username against a wrong key, for that username and another.

```text
2000 alternating samples each after 100 warm-up rounds; margin ±2%
sign-in, real vs unknown user (mean): 18.880 vs 18.887 ms, difference -0.006 ms (-0.03%), 90% CI [-0.107, +0.094], margin ±0.378, t = 6.1 / 6.3 (critical 1.65, df 3989): EQUIVALENT
sign-in, real vs unknown user (5% trimmed): 18.626 vs 18.643 ms, difference -0.017 ms (-0.09%), 90% CI [-0.108, +0.073], margin ±0.373, t = 6.5 / 7.1 (critical 1.65, df 3597): EQUIVALENT
OPDS check, username with keys vs without (mean): 7.216 vs 7.186 µs, difference +0.031 µs (+0.43%), 90% CI [-0.039, +0.101], margin ±0.144, t = 4.1 / 2.7 (critical 1.65, df 3985): EQUIVALENT
OPDS check, username with keys vs without (5% trimmed): 6.973 vs 6.948 µs, difference +0.025 µs (+0.36%), 90% CI [-0.010, +0.059], margin ±0.139, t = 7.8 / 5.5 (critical 1.65, df 3590): EQUIVALENT
```
