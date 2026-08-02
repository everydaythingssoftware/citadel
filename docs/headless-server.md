# Headless OPDS server

`citadel-server` serves one Calibre library over the same OPDS runtime used by
the desktop application. It has no desktop, WebView, or remote management UI.

Copy `crates/citadel-server/example-config.toml`, use absolute paths for the
library and state directory, then run:

```sh
CITADEL_OPDS_PASSWORD='choose-a-password' cargo run -p citadel-server -- \
  --config /absolute/path/to/citadel-server.toml
```

The password is read from the environment variable named by
`credentials.passwordEnvironment`; it is never stored in the TOML file or
printed. Citadel persists only the username and Argon2id verifier beneath the
configured state directory. After the first successful start, the
`credentials` section and password environment variable may be omitted while
`authenticationEnabled` remains true.

The process logs lifecycle state and every concrete OPDS URL. It remains in the
foreground until SIGINT or SIGTERM, then gracefully closes its listeners.
Interface selections use the same stable system interface names and IPv4/IPv6
policy as desktop sharing.

For a reverse proxy on the same host, the target can instead use explicit
concrete addresses without depending on interface discovery:

```toml
[sharing.target]
type = "addresses"
addresses = ["127.0.0.1", "::1"]
```

Wildcard addresses such as `0.0.0.0` and `::` are rejected. Configure every
concrete address on which the process should listen.

Citadel serves plain HTTP. For access beyond a trusted local network, place it
behind an externally managed TLS reverse proxy and firewall. Service
supervision, certificates, public-exposure controls, and container or operating
system packages are not provided by this initial server.
