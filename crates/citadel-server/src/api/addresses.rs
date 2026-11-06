//! Which addresses browsers may reach Citadel at, and which one each request
//! used. People reach a home server by several names (a LAN address, a
//! Tailscale name, a domain behind a proxy), so the configuration lists them.
//! Once it does, requests for any other host are refused, which also closes
//! DNS rebinding; until then, any host is answered.
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use citadel_core::error::{LibraryError, LibraryErrorCode};

use super::{session::PublicUrl, ApiState};

/// Proxies trusted to say how the browser reached them when nothing else is
/// configured: this machine and private networks, where a reverse proxy or
/// its container network lives.
pub const DEFAULT_TRUSTED_PROXIES: &[&str] = &[
    "127.0.0.0/8",
    "::1/128",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "fc00::/7",
];

/// An address range, such as `172.16.0.0/12`, or one address.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IpRange {
    network: IpAddr,
    prefix: u8,
}

impl IpRange {
    pub fn parse(text: &str) -> Result<Self, String> {
        let invalid = || format!("{text:?} isn't an address or range such as 172.16.0.0/12");
        let (address, prefix) = match text.trim().split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (text.trim(), None),
        };
        let network: IpAddr = address.parse().map_err(|_| invalid())?;
        let bits = if network.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(prefix) => prefix
                .parse::<u8>()
                .ok()
                .filter(|prefix| *prefix <= bits)
                .ok_or_else(invalid)?,
            None => bits,
        };
        Ok(Self { network, prefix })
    }

    pub fn contains(&self, address: IpAddr) -> bool {
        let address = match address {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(address),
            v4 => v4,
        };
        match (self.network, address) {
            (IpAddr::V4(network), IpAddr::V4(address)) => {
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                u32::from(network) & mask == u32::from(address) & mask
            }
            (IpAddr::V6(network), IpAddr::V6(address)) => {
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                u128::from(network) & mask == u128::from(address) & mask
            }
            _ => false,
        }
    }
}

/// The address a request came in on, as the browser saw it.
#[derive(Clone, Debug)]
pub struct RequestOrigin(pub PublicUrl);

/// Where an address stands.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Standing {
    /// One of the server's public URLs.
    Listed,
    /// This machine, always allowed: no other site can make a browser send
    /// a loopback name.
    Loopback,
    /// No public URLs are configured, so every address is allowed.
    Unrestricted,
    Refused,
}

/// The server's public URLs, from its configuration (`publicUrls`, or
/// `CITADEL_PUBLIC_URLS`) and nowhere else. Citadel never writes them; with
/// none, it answers at any address.
pub struct Addresses {
    configured: Vec<PublicUrl>,
    trusted_proxies: Vec<IpRange>,
    /// This machine's own name on the listener's port, shown as always
    /// included.
    local: Option<PublicUrl>,
    /// The config file the list lives in, when the server runs from one
    /// rather than from environment variables.
    config_file: Option<String>,
}

impl Addresses {
    pub fn new(
        configured: Vec<PublicUrl>,
        trusted_proxies: Vec<IpRange>,
        local: Option<PublicUrl>,
        config_file: Option<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            configured,
            trusted_proxies,
            local,
            config_file,
        })
    }

    /// Only these addresses and the default proxies; for tests.
    pub fn fixed(configured: Vec<PublicUrl>) -> Arc<Self> {
        Self::new(configured, default_trusted_proxies(), None, None)
    }

    /// This machine's own address, which always works.
    pub fn local(&self) -> Option<&PublicUrl> {
        self.local.as_ref()
    }

    /// Where the list is set: a config file's path, or `None` for the
    /// environment.
    pub fn config_file(&self) -> Option<&str> {
        self.config_file.as_deref()
    }

    /// The configured public URLs, each once.
    pub fn all(&self) -> Vec<PublicUrl> {
        let mut all: Vec<PublicUrl> = Vec::new();
        for address in &self.configured {
            if !all.contains(address) {
                all.push(address.clone());
            }
        }
        all
    }

    /// Whether the list limits anything: it names an address other than
    /// this machine's own.
    pub fn restricted(&self) -> bool {
        self.configured.iter().any(|url| !url.is_loopback())
    }

    pub fn standing(&self, origin: &PublicUrl) -> Standing {
        if self.configured.contains(origin) {
            Standing::Listed
        } else if origin.is_loopback() {
            Standing::Loopback
        } else if !self.restricted() {
            Standing::Unrestricted
        } else {
            Standing::Refused
        }
    }

    /// What the browser used to reach this request: `Host`, or the
    /// forwarded headers when a trusted proxy sent it. No peer means the
    /// router was called in-process, which is trusted. Without `Host` there
    /// is no origin, and state-changing browser requests are refused.
    pub fn origin_of(&self, headers: &HeaderMap, peer: Option<IpAddr>) -> Option<PublicUrl> {
        let trusted = peer.is_none_or(|peer| {
            self.trusted_proxies
                .iter()
                .any(|range| range.contains(peer))
        });
        let forwarded = if trusted {
            forwarded(headers)
        } else {
            Forwarded::default()
        };
        let host = forwarded
            .host
            .or_else(|| header_text(headers, header::HOST.as_str()))?;
        let scheme = forwarded.proto.unwrap_or_else(|| "http".into());
        PublicUrl::parse(&format!("{scheme}://{host}")).ok()
    }
}

pub fn default_trusted_proxies() -> Vec<IpRange> {
    DEFAULT_TRUSTED_PROXIES
        .iter()
        .map(|range| IpRange::parse(range).expect("default proxy ranges parse"))
        .collect()
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Default)]
struct Forwarded {
    proto: Option<String>,
    host: Option<String>,
}

/// The nearest proxy's view: the standard `Forwarded` header, else the
/// common `X-Forwarded-Proto` and `X-Forwarded-Host`.
fn forwarded(headers: &HeaderMap) -> Forwarded {
    if let Some(value) = header_text(headers, "forwarded") {
        let first = value.split(',').next().unwrap_or_default();
        let mut found = Forwarded::default();
        for pair in first.split(';') {
            if let Some((key, value)) = pair.trim().split_once('=') {
                let value = value.trim().trim_matches('"').to_string();
                match key.trim().to_ascii_lowercase().as_str() {
                    "proto" => found.proto = Some(value.to_ascii_lowercase()),
                    "host" => found.host = Some(value),
                    _ => {}
                }
            }
        }
        if found.proto.is_some() || found.host.is_some() {
            return found;
        }
    }
    let first = |name| {
        header_text(headers, name)
            .and_then(|value| value.split(',').next().map(|part| part.trim().to_string()))
    };
    Forwarded {
        proto: first("x-forwarded-proto").map(|proto| proto.to_ascii_lowercase()),
        host: first("x-forwarded-host"),
    }
}

/// Refuses API requests for hosts Citadel isn't set up for, and records the
/// address each request used. `/api/version` answers anywhere, for health
/// checks; the web app's files too, so the refusal can be explained.
pub(super) async fn check_address(
    State(state): State<ApiState>,
    mut request: Request,
    next: Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| address.ip());
    let addresses = &state.access.addresses;
    let origin = addresses.origin_of(request.headers(), peer);
    let path = request.uri().path();
    let checked = (path == "/api" || path.starts_with("/api/")) && path != "/api/version";
    if checked {
        if let Some(origin) = &origin {
            if addresses.standing(origin) == Standing::Refused {
                return not_this_address(origin);
            }
        }
    }
    if let Some(origin) = origin {
        request.extensions_mut().insert(RequestOrigin(origin));
    }
    next.run(request).await
}

fn not_this_address(origin: &PublicUrl) -> Response {
    let error = LibraryError {
        code: LibraryErrorCode::InvalidArgument,
        message: format!(
            "{} isn't one of this server's public URLs. Whoever runs the server can add it to its configuration.",
            origin.origin()
        ),
    };
    (StatusCode::MISDIRECTED_REQUEST, Json(error)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn url(text: &str) -> PublicUrl {
        PublicUrl::parse(text).unwrap()
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn ranges_hold_their_addresses() {
        let private = IpRange::parse("172.16.0.0/12").unwrap();
        assert!(private.contains("172.20.0.5".parse().unwrap()));
        assert!(!private.contains("172.32.0.1".parse().unwrap()));
        assert!(private.contains("::ffff:172.17.0.1".parse().unwrap()));
        assert!(IpRange::parse("::1")
            .unwrap()
            .contains("::1".parse().unwrap()));
        assert!(IpRange::parse("fc00::/7")
            .unwrap()
            .contains("fd12::1".parse().unwrap()));
        for invalid in ["nas.local", "10.0.0.0/33", "::/129", ""] {
            assert!(IpRange::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn listed_and_loopback_addresses_are_allowed_and_others_refused() {
        let addresses = Addresses::fixed(vec![url("https://books.example.com")]);
        assert_eq!(
            addresses.standing(&url("https://books.example.com")),
            Standing::Listed
        );
        assert_eq!(
            addresses.standing(&url("http://localhost:8081")),
            Standing::Loopback
        );
        assert_eq!(
            addresses.standing(&url("http://127.0.0.1:8081")),
            Standing::Loopback
        );
        assert_eq!(
            addresses.standing(&url("http://[::1]:8081")),
            Standing::Loopback
        );
        assert_eq!(
            addresses.standing(&url("http://books.example.com")),
            Standing::Refused
        );
        assert_eq!(
            addresses.standing(&url("http://evil.example:8081")),
            Standing::Refused
        );
    }

    #[test]
    fn with_no_public_urls_configured_every_address_is_answered() {
        for configured in [vec![], vec![url("http://localhost:8081")]] {
            let addresses = Addresses::fixed(configured);
            assert!(!addresses.restricted());
            assert_eq!(
                addresses.standing(&url("http://nas.local:8081")),
                Standing::Unrestricted
            );
            assert_eq!(
                addresses.standing(&url("http://127.0.0.1:8081")),
                Standing::Loopback
            );
        }
        let configured = Addresses::new(
            vec![
                url("https://books.example.com"),
                url("https://books.example.com"),
            ],
            default_trusted_proxies(),
            Some(url("http://localhost:8081")),
            Some("/etc/citadel/server.toml".into()),
        );
        assert!(configured.restricted());
        assert_eq!(configured.all(), vec![url("https://books.example.com")]);
        assert_eq!(
            configured.standing(&url("http://nas.local:8081")),
            Standing::Refused
        );
        assert_eq!(
            configured.local().map(|local| local.origin().to_string()),
            Some("http://localhost:8081".into())
        );
        assert_eq!(configured.config_file(), Some("/etc/citadel/server.toml"));
    }

    #[test]
    fn the_request_origin_comes_from_host_or_a_trusted_proxy() {
        let addresses = Addresses::fixed(vec![]);
        let plain = headers(&[("host", "nas.local:8081")]);
        assert_eq!(
            addresses.origin_of(&plain, Some("192.168.1.20".parse().unwrap())),
            Some(url("http://nas.local:8081"))
        );
        let proxied = headers(&[
            ("host", "citadel:8081"),
            ("x-forwarded-proto", "https"),
            ("x-forwarded-host", "books.example.com"),
        ]);
        let from_proxy = addresses
            .origin_of(&proxied, Some("172.18.0.3".parse().unwrap()))
            .unwrap();
        assert_eq!(from_proxy, url("https://books.example.com"));
        assert!(from_proxy.secure());
        assert_eq!(
            addresses.origin_of(&proxied, Some("203.0.113.9".parse().unwrap())),
            Some(url("http://citadel:8081")),
            "a stranger can't claim to be a proxy"
        );
        let standard = headers(&[
            ("host", "citadel:8081"),
            (
                "forwarded",
                "for=192.0.2.60;proto=https;host=\"books.example.com\", for=10.0.0.1",
            ),
        ]);
        assert_eq!(
            addresses.origin_of(&standard, Some("127.0.0.1".parse().unwrap())),
            Some(url("https://books.example.com"))
        );
        let no_host = headers(&[("origin", "https://books.example.com")]);
        assert_eq!(
            addresses.origin_of(&no_host, None),
            None,
            "Origin alone names the page, not the server it reached"
        );
        assert_eq!(
            addresses.origin_of(&proxied, None),
            Some(url("https://books.example.com")),
            "in-process callers are trusted"
        );
    }
}
