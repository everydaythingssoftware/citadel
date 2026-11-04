# syntax=docker/dockerfile:1.7
# citadel-server with the web app inside.
#
#   docker build -t citadel-server .
#   docker run -p 8081:8081 -p 8080:8080 \
#     -v citadel-state:/var/lib/citadel -v /path/to/books:/library citadel-server
#
# Release builds pass CITADEL_VERSION and CITADEL_BUILD_COMMIT; the build has
# no .git to read them from.
ARG RUST_VERSION=1.97.1
ARG BUN_VERSION=1.4.4
ARG DEBIAN_RELEASE=bookworm

# The web app is the same on every architecture, so it builds once, natively.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS web
WORKDIR /src
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

# The full image already has SQLite's and OpenSSL's headers and pkg-config.
FROM rust:${RUST_VERSION}-${DEBIAN_RELEASE} AS server
ARG RUST_VERSION
# Use the image's toolchain rather than installing rust-toolchain.toml's
# clippy and rustfmt, which a release build doesn't need.
ENV RUSTUP_TOOLCHAIN=${RUST_VERSION}
WORKDIR /src
COPY . .
ARG CITADEL_VERSION=
ARG CITADEL_BUILD_COMMIT=
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p citadel-server \
 && install -D target/release/citadel-server /out/citadel-server

FROM debian:${DEBIAN_RELEASE}-slim
# Debian's SQLite is built with FTS5, which Calibre's annotation triggers need.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 libssl3 tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=server /out/citadel-server /usr/lib/citadel/citadel-server
COPY --from=web /src/dist /usr/share/citadel/web
COPY docker/citadel-server /usr/local/bin/citadel-server
ENV CITADEL_LISTEN=0.0.0.0:8081 \
    CITADEL_OPDS_ADDRESSES=all \
    CITADEL_STATE_DIRECTORY=/var/lib/citadel \
    CITADEL_WEB_DIRECTORY=/usr/share/citadel/web \
    CITADEL_LIBRARY_ROOTS=/library,/libraries \
    PUID=1000 \
    PGID=1000
VOLUME ["/var/lib/citadel"]
# The browser and API, then OPDS for e-readers.
EXPOSE 8081 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --start-interval=2s --retries=3 \
    CMD ["citadel-server", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "citadel-server"]
ARG CITADEL_VERSION=
ARG CITADEL_BUILD_COMMIT=
LABEL org.opencontainers.image.title="Citadel server" \
      org.opencontainers.image.version="${CITADEL_VERSION}" \
      org.opencontainers.image.revision="${CITADEL_BUILD_COMMIT}" \
      org.opencontainers.image.description="Your Calibre library in the browser and on e-readers over OPDS." \
      org.opencontainers.image.source="https://github.com/everydaythingssoftware/citadel" \
      org.opencontainers.image.licenses="MIT"
