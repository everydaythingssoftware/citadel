//! Who a request comes from (ADR 0017).
//!
//! The TCP peer is the client unless it is a trusted proxy. Only then is one
//! configured header read (`X-Forwarded-For`, or `Forwarded`'s `for=`), right
//! to left, skipping trusted hops: the first untrusted entry is the client.
//! Anything a proxy can't vouch for is ignored, so a client can't name itself.
//!
//! Two situations are flagged as *soft mode*, where address-based penalties
//! should be lenient because many people may share the one address Citadel
//! sees: the nearest unvouched entry can't be read (the request is keyed by
//! the proxy), and a private, loopback or CGNAT peer that isn't trusted sends
//! forwarding headers (likely an unconfigured reverse proxy). The latter are
//! recorded in [`UntrustedForwarders`] so an administrator can trust them.
use std::{
    collections::HashMap,
    convert::Infallible,
    fmt,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant, SystemTime},
};

use axum::{
    extract::{connect_info::MockConnectInfo, ConnectInfo, FromRequestParts, Request, State},
    http::{request::Parts, Extensions, HeaderMap},
    middleware::Next,
    response::Response,
};

/// Trusted for client addresses when `trustedProxies` isn't configured.
pub const LOOPBACK_PROXIES: &[&str] = &["127.0.0.0/8", "::1/128"];

/// Trusted for how the browser reached Citadel (scheme and host) when
/// `trustedProxies` isn't configured: this machine and private networks,
/// where a reverse proxy or its container network lives.
pub const PRIVATE_PROXIES: &[&str] = &[
    "127.0.0.0/8",
    "::1/128",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "fc00::/7",
];

/// Ranges whose untrusted peers sending forwarding headers are probably a
/// proxy nobody has told Citadel about, rather than someone on the internet.
const LOCAL_RANGES: &[&str] = &[
    "127.0.0.0/8",
    "::1/128",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "169.254.0.0/16",
    "fc00::/7",
    "fe80::/10",
];

/// Headers that say a request passed through a proxy.
const FORWARDING_HEADERS: &[&str] = &[
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
];

/// How many untrusted forwarders are remembered.
pub const UNTRUSTED_FORWARDERS_CAPACITY: usize = 64;
const FORWARDER_LOG_INTERVAL: Duration = Duration::from_secs(60);

/// An address range, such as `172.16.0.0/12`, or one address.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
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
        let bits = bits(network);
        let prefix = match prefix {
            Some(prefix) => prefix
                .parse::<u8>()
                .ok()
                .filter(|prefix| *prefix <= bits)
                .ok_or_else(invalid)?,
            None => bits,
        };
        Ok(Self {
            network: mask(network, prefix),
            prefix,
        })
    }

    /// Exactly `address`.
    pub fn single(address: IpAddr) -> Self {
        let address = address.to_canonical();
        Self {
            network: address,
            prefix: bits(address),
        }
    }

    pub fn network(&self) -> IpAddr {
        self.network
    }

    pub fn prefix(&self) -> u8 {
        self.prefix
    }

    pub fn contains(&self, address: IpAddr) -> bool {
        let address = address.to_canonical();
        self.network.is_ipv4() == address.is_ipv4() && mask(address, self.prefix) == self.network
    }
}

/// `10.0.0.0/8`, or a single address without its prefix.
impl fmt::Display for IpRange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.prefix == bits(self.network) {
            write!(f, "{}", self.network)
        } else {
            write!(f, "{}/{}", self.network, self.prefix)
        }
    }
}

fn bits(address: IpAddr) -> u8 {
    if address.is_ipv4() {
        32
    } else {
        128
    }
}

fn mask(address: IpAddr, prefix: u8) -> IpAddr {
    match address {
        IpAddr::V4(v4) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
            IpAddr::V4(Ipv4Addr::from(u32::from(v4) & mask))
        }
        IpAddr::V6(v6) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
            IpAddr::V6(Ipv6Addr::from(u128::from(v6) & mask))
        }
    }
}

pub fn parse_ranges(ranges: &[&str]) -> Vec<IpRange> {
    ranges
        .iter()
        .map(|range| IpRange::parse(range).expect("built-in ranges parse"))
        .collect()
}

fn in_any(ranges: &[IpRange], address: IpAddr) -> bool {
    ranges.iter().any(|range| range.contains(address))
}

/// Private, loopback, CGNAT or link-local.
pub fn is_local(address: IpAddr) -> bool {
    in_any(&parse_ranges(LOCAL_RANGES), address)
}

/// The one header a trusted proxy's view of the client is read from.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ForwardedHeader {
    /// `X-Forwarded-For`, which nginx, Caddy and Traefik send.
    #[default]
    XForwardedFor,
    /// The standard `Forwarded` header's `for=` parameters.
    Forwarded,
}

impl ForwardedHeader {
    pub fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "x-forwarded-for" => Ok(Self::XForwardedFor),
            "forwarded" => Ok(Self::Forwarded),
            _ => Err(format!(
                "{text:?} isn't a forwarding header Citadel reads; use \"x-forwarded-for\" or \"forwarded\""
            )),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::XForwardedFor => "x-forwarded-for",
            Self::Forwarded => "forwarded",
        }
    }
}

/// Which peers are proxies. With `trustedProxies` configured, that one list
/// decides both client addresses and request origins. Without it, client
/// addresses trust only this machine while origins (scheme and host) keep
/// trusting private networks too. Ranges an administrator trusts in Settings
/// (`stored`) add to both.
#[derive(Debug)]
pub struct ProxyTrust {
    configured: Option<Vec<IpRange>>,
    stored: RwLock<Vec<IpRange>>,
    loopback: Vec<IpRange>,
    private: Vec<IpRange>,
}

impl ProxyTrust {
    pub fn new(configured: Option<Vec<IpRange>>, stored: Vec<IpRange>) -> Arc<Self> {
        Arc::new(Self {
            configured,
            stored: RwLock::new(stored),
            loopback: parse_ranges(LOOPBACK_PROXIES),
            private: parse_ranges(PRIVATE_PROXIES),
        })
    }

    /// Nothing configured or stored: the desktop's trust.
    pub fn loopback_only() -> Arc<Self> {
        Self::new(None, Vec::new())
    }

    /// `trustedProxies`, when set.
    pub fn configured(&self) -> Option<&[IpRange]> {
        self.configured.as_deref()
    }

    /// Ranges trusted from Settings.
    pub fn stored(&self) -> Vec<IpRange> {
        self.stored
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn set_stored(&self, ranges: Vec<IpRange>) {
        *self
            .stored
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = ranges;
    }

    fn base_for_clients(&self) -> &[IpRange] {
        self.configured.as_deref().unwrap_or(&self.loopback)
    }

    fn base_for_origins(&self) -> &[IpRange] {
        self.configured.as_deref().unwrap_or(&self.private)
    }

    fn with_stored(&self, base: &[IpRange]) -> Vec<IpRange> {
        let mut all = base.to_vec();
        for range in self.stored() {
            if !all.contains(&range) {
                all.push(range);
            }
        }
        all
    }

    /// Whose forwarded client address is believed.
    pub fn client_ranges(&self) -> Vec<IpRange> {
        self.with_stored(self.base_for_clients())
    }

    /// Whose forwarded scheme and host are believed.
    pub fn origin_ranges(&self) -> Vec<IpRange> {
        self.with_stored(self.base_for_origins())
    }

    pub fn client_trusts(&self, address: IpAddr) -> bool {
        in_any(self.base_for_clients(), address) || self.stored_contains(address)
    }

    pub fn origin_trusts(&self, address: IpAddr) -> bool {
        in_any(self.base_for_origins(), address) || self.stored_contains(address)
    }

    fn stored_contains(&self, address: IpAddr) -> bool {
        in_any(
            &self
                .stored
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            address,
        )
    }
}

/// Why address-based penalties should be lenient for a request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SoftReason {
    /// A trusted proxy forwarded a client entry Citadel couldn't read, so the
    /// request is keyed by that proxy, which many people may share.
    UnreadableForwardedEntry,
    /// An untrusted private, loopback or CGNAT peer sent forwarding headers:
    /// probably a reverse proxy nobody has told Citadel about.
    UntrustedLocalForwarder,
}

/// A network prefix that identifies a client, or a group of clients, for
/// counting: `/32` or `/64` for one client, `/24`, `/56` and `/48` for
/// their neighbourhoods.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AddressKey {
    network: IpAddr,
    prefix: u8,
}

impl AddressKey {
    pub const V4_CLIENT: u8 = 32;
    pub const V6_CLIENT: u8 = 64;
    pub const V4_AGGREGATES: &'static [u8] = &[24];
    pub const V6_AGGREGATES: &'static [u8] = &[56, 48];

    /// `address` masked to `prefix` bits (clamped to the address length).
    pub fn new(address: IpAddr, prefix: u8) -> Self {
        let address = address.to_canonical();
        let prefix = prefix.min(bits(address));
        Self {
            network: mask(address, prefix),
            prefix,
        }
    }

    /// One client: an IPv4 address, or an IPv6 /64 (one network's hosts
    /// choose their own addresses within it).
    pub fn client(address: IpAddr) -> Self {
        let address = address.to_canonical();
        Self::new(
            address,
            if address.is_ipv4() {
                Self::V4_CLIENT
            } else {
                Self::V6_CLIENT
            },
        )
    }

    /// The client's neighbourhoods, widest last: `/24` for IPv4, `/56` and
    /// `/48` for IPv6.
    pub fn aggregates(address: IpAddr) -> Vec<Self> {
        let address = address.to_canonical();
        let prefixes = if address.is_ipv4() {
            Self::V4_AGGREGATES
        } else {
            Self::V6_AGGREGATES
        };
        prefixes
            .iter()
            .map(|prefix| Self::new(address, *prefix))
            .collect()
    }

    pub fn network(&self) -> IpAddr {
        self.network
    }

    pub fn prefix(&self) -> u8 {
        self.prefix
    }

    pub fn contains(&self, address: IpAddr) -> bool {
        let address = address.to_canonical();
        address.is_ipv4() == self.network.is_ipv4() && mask(address, self.prefix) == self.network
    }
}

impl fmt::Display for AddressKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.network, self.prefix)
    }
}

/// Who a request is from, as far as Citadel can tell.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientAddress {
    ip: IpAddr,
    peer: Option<SocketAddr>,
    forwarded: bool,
    soft: Option<SoftReason>,
}

impl ClientAddress {
    /// A request made in-process, with no TCP peer: this machine.
    pub fn in_process() -> Self {
        Self {
            ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            peer: None,
            forwarded: false,
            soft: None,
        }
    }

    /// The peer itself, believing no headers.
    pub fn direct(peer: SocketAddr) -> Self {
        Self {
            ip: peer.ip().to_canonical(),
            peer: Some(peer),
            forwarded: false,
            soft: None,
        }
    }

    /// The client's address (IPv4-mapped IPv6 normalised to IPv4).
    pub fn ip(&self) -> IpAddr {
        self.ip
    }

    /// The TCP peer; `None` in-process.
    pub fn peer(&self) -> Option<SocketAddr> {
        self.peer
    }

    /// The address came from a trusted proxy's header rather than the peer.
    pub fn forwarded(&self) -> bool {
        self.forwarded
    }

    pub fn soft(&self) -> Option<SoftReason> {
        self.soft
    }

    /// Address-based penalties should be lenient (see [`SoftReason`]).
    pub fn is_soft(&self) -> bool {
        self.soft.is_some()
    }

    pub fn is_loopback(&self) -> bool {
        self.ip.is_loopback()
    }

    /// The key that counts this one client.
    pub fn key(&self) -> AddressKey {
        AddressKey::client(self.ip)
    }

    /// Keys for the client's neighbourhoods (see [`AddressKey::aggregates`]).
    pub fn aggregate_keys(&self) -> Vec<AddressKey> {
        AddressKey::aggregates(self.ip)
    }

    /// What [`resolve_client`] recorded on the request, else the peer
    /// believing no headers, else in-process.
    pub fn of(extensions: &Extensions) -> Self {
        extensions
            .get::<ClientAddress>()
            .cloned()
            .or_else(|| peer_of(extensions).map(Self::direct))
            .unwrap_or_else(Self::in_process)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for ClientAddress {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self::of(&parts.extensions))
    }
}

/// The TCP peer the listener recorded, or a test's `MockConnectInfo`.
pub fn peer_of(extensions: &Extensions) -> Option<SocketAddr> {
    extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(peer)| *peer)
        .or_else(|| {
            extensions
                .get::<MockConnectInfo<SocketAddr>>()
                .map(|MockConnectInfo(peer)| *peer)
        })
}

/// An untrusted local peer that sent forwarding headers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UntrustedForwarder {
    pub address: IpAddr,
    /// Which forwarding headers it sent, lowercase.
    pub headers: Vec<String>,
    pub last_seen: SystemTime,
    pub requests: u64,
}

struct ForwarderEntry {
    headers: Vec<&'static str>,
    last_seen: SystemTime,
    touched: Instant,
    requests: u64,
    dismissed: bool,
}

/// The most recently seen untrusted local forwarders, at most
/// [`UNTRUSTED_FORWARDERS_CAPACITY`]; the least recently seen is forgotten
/// first. Public peers are never recorded, so strangers can't fill it.
#[derive(Default)]
pub struct UntrustedForwarders {
    entries: Mutex<HashMap<IpAddr, ForwarderEntry>>,
}

static LAST_FORWARDER_LOG: Mutex<Option<Instant>> = Mutex::new(None);

impl UntrustedForwarders {
    fn record(&self, address: IpAddr, headers: Vec<&'static str>) {
        let now = Instant::now();
        let first_time = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !entries.contains_key(&address) && entries.len() >= UNTRUSTED_FORWARDERS_CAPACITY {
                if let Some(oldest) = entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.touched)
                    .map(|(address, _)| *address)
                {
                    entries.remove(&oldest);
                }
            }
            let first_time = !entries.contains_key(&address);
            let entry = entries.entry(address).or_insert_with(|| ForwarderEntry {
                headers: Vec::new(),
                last_seen: SystemTime::now(),
                touched: now,
                requests: 0,
                dismissed: false,
            });
            for header in headers {
                if !entry.headers.contains(&header) {
                    entry.headers.push(header);
                }
            }
            entry.headers.sort_unstable();
            entry.last_seen = SystemTime::now();
            entry.touched = now;
            entry.requests = entry.requests.saturating_add(1);
            first_time && !entry.dismissed
        };
        if first_time {
            log_forwarder(address, now);
        }
    }

    /// Recorded forwarders nobody dismissed, most recently seen first.
    pub fn list(&self) -> Vec<UntrustedForwarder> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut listed: Vec<(Instant, UntrustedForwarder)> = entries
            .iter()
            .filter(|(_, entry)| !entry.dismissed)
            .map(|(address, entry)| {
                (
                    entry.touched,
                    UntrustedForwarder {
                        address: *address,
                        headers: entry.headers.iter().map(|name| name.to_string()).collect(),
                        last_seen: entry.last_seen,
                        requests: entry.requests,
                    },
                )
            })
            .collect();
        listed.sort_by_key(|(touched, _)| std::cmp::Reverse(*touched));
        listed.into_iter().map(|(_, forwarder)| forwarder).collect()
    }

    /// How many are remembered, dismissed ones included.
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Stops listing forwarders in `range`; they stay remembered, so they
    /// don't come back while they keep sending headers.
    pub fn dismiss(&self, range: &IpRange) {
        for (address, entry) in self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter_mut()
        {
            if range.contains(*address) {
                entry.dismissed = true;
            }
        }
    }

    /// Forgets forwarders in `range`, such as once it is trusted.
    pub fn forget(&self, range: &IpRange) {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|address, _| !range.contains(*address));
    }
}

fn log_forwarder(address: IpAddr, now: Instant) {
    let mut last = LAST_FORWARDER_LOG
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if last.is_some_and(|last| now.duration_since(last) < FORWARDER_LOG_INTERVAL) {
        return;
    }
    *last = Some(now);
    eprintln!(
        "citadel warning=\"requests from {address} include forwarding headers, but it isn't a trusted proxy; \
         its headers are ignored. If it is your reverse proxy, trust it in Settings or with trustedProxies\""
    );
}

/// Resolves client addresses with one trust configuration and header.
#[derive(Clone)]
pub struct ClientResolver {
    trust: Arc<ProxyTrust>,
    header: ForwardedHeader,
    forwarders: Arc<UntrustedForwarders>,
}

impl ClientResolver {
    pub fn new(trust: Arc<ProxyTrust>, header: ForwardedHeader) -> Self {
        Self {
            trust,
            header,
            forwarders: Arc::default(),
        }
    }

    /// Believes forwarded headers from this machine only.
    pub fn loopback_only() -> Self {
        Self::new(ProxyTrust::loopback_only(), ForwardedHeader::default())
    }

    pub fn trust(&self) -> &Arc<ProxyTrust> {
        &self.trust
    }

    pub fn header(&self) -> ForwardedHeader {
        self.header
    }

    pub fn untrusted_forwarders(&self) -> &UntrustedForwarders {
        &self.forwarders
    }

    /// Whether `peer` is a proxy whose forwarded client address is believed.
    pub fn trusts_peer(&self, peer: IpAddr) -> bool {
        self.trust.client_trusts(peer)
    }

    pub fn resolve(&self, peer: Option<SocketAddr>, headers: &HeaderMap) -> ClientAddress {
        let Some(peer) = peer else {
            return ClientAddress::in_process();
        };
        let peer_ip = peer.ip().to_canonical();
        if !self.trust.client_trusts(peer_ip) {
            let mut client = ClientAddress::direct(peer);
            let sent: Vec<&'static str> = FORWARDING_HEADERS
                .iter()
                .copied()
                .filter(|name| headers.contains_key(*name))
                .collect();
            if !sent.is_empty() && is_local(peer_ip) {
                self.forwarders.record(peer_ip, sent);
                client.soft = Some(SoftReason::UntrustedLocalForwarder);
            }
            return client;
        }
        let mut nearest = peer_ip;
        let mut forwarded = false;
        for entry in forwarded_entries(headers, self.header).into_iter().rev() {
            match entry {
                None => {
                    return ClientAddress {
                        ip: nearest,
                        peer: Some(peer),
                        forwarded,
                        soft: Some(SoftReason::UnreadableForwardedEntry),
                    }
                }
                Some(address) if self.trust.client_trusts(address) => {
                    nearest = address;
                    forwarded = true;
                }
                Some(address) => {
                    return ClientAddress {
                        ip: address,
                        peer: Some(peer),
                        forwarded: true,
                        soft: None,
                    }
                }
            }
        }
        // Every hop was trusted: the leftmost is as far back as anyone vouches.
        ClientAddress {
            ip: nearest,
            peer: Some(peer),
            forwarded,
            soft: None,
        }
    }
}

/// Middleware recording each request's [`ClientAddress`] in its extensions.
pub async fn resolve_client(
    State(resolver): State<ClientResolver>,
    mut request: Request,
    next: Next,
) -> Response {
    let client = resolver.resolve(peer_of(request.extensions()), request.headers());
    request.extensions_mut().insert(client);
    next.run(request).await
}

/// Every instance of the configured header, in order, as entries: `None`
/// for one that can't be read. Empty entries are skipped.
fn forwarded_entries(headers: &HeaderMap, header: ForwardedHeader) -> Vec<Option<IpAddr>> {
    let mut entries = Vec::new();
    for value in headers.get_all(header.name()) {
        let Ok(value) = value.to_str() else {
            entries.push(None);
            continue;
        };
        for element in split_outside_quotes(value, ',') {
            let element = element.trim();
            if element.is_empty() {
                continue;
            }
            entries.push(match header {
                ForwardedHeader::XForwardedFor => parse_node(element),
                ForwardedHeader::Forwarded => split_outside_quotes(element, ';')
                    .into_iter()
                    .filter_map(|pair| pair.split_once('='))
                    .find(|(key, _)| key.trim().eq_ignore_ascii_case("for"))
                    .and_then(|(_, value)| parse_node(value)),
            });
        }
    }
    entries
}

fn split_outside_quotes(text: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (index, character) in text.char_indices() {
        match character {
            '"' => quoted = !quoted,
            _ if character == separator && !quoted => {
                parts.push(&text[start..index]);
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// `192.0.2.1`, `192.0.2.1:443`, `2001:db8::1`, `[2001:db8::1]` or
/// `[2001:db8::1]:443`, optionally quoted.
fn parse_node(text: &str) -> Option<IpAddr> {
    let text = text.trim();
    let text = text
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(text)
        .trim();
    let port_ok = |port: &str| port.is_empty() || port.parse::<u16>().is_ok();
    let address = if let Some(rest) = text.strip_prefix('[') {
        let (inner, after) = rest.split_once(']')?;
        let port = match after {
            "" => "",
            after => after.strip_prefix(':')?,
        };
        if !port_ok(port) || port.is_empty() && !after.is_empty() {
            return None;
        }
        IpAddr::V6(inner.parse().ok()?)
    } else if let Ok(address) = text.parse::<IpAddr>() {
        address
    } else {
        let (host, port) = text.rsplit_once(':')?;
        if port.is_empty() || !port_ok(port) {
            return None;
        }
        IpAddr::V4(host.parse().ok()?)
    };
    Some(address.to_canonical())
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    fn peer(text: &str) -> Option<SocketAddr> {
        Some(SocketAddr::new(text.parse().unwrap(), 50_000))
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    fn trusting(ranges: &[&str], header: ForwardedHeader) -> ClientResolver {
        ClientResolver::new(
            ProxyTrust::new(
                Some(
                    ranges
                        .iter()
                        .map(|range| IpRange::parse(range).unwrap())
                        .collect(),
                ),
                Vec::new(),
            ),
            header,
        )
    }

    struct Case {
        name: &'static str,
        trusted: &'static [&'static str],
        header: ForwardedHeader,
        peer: &'static str,
        sent: &'static [(&'static str, &'static str)],
        client: &'static str,
        soft: Option<SoftReason>,
    }

    const XFF: ForwardedHeader = ForwardedHeader::XForwardedFor;
    const STD: ForwardedHeader = ForwardedHeader::Forwarded;
    const PROXY: &[&str] = &["172.18.0.0/16"];

    #[test]
    fn client_addresses_follow_the_rightmost_untrusted_rule() {
        let cases = [
            Case {
                name: "an untrusted peer's X-Forwarded-For is not believed",
                trusted: PROXY,
                header: XFF,
                peer: "203.0.113.9",
                sent: &[("x-forwarded-for", "198.51.100.1")],
                client: "203.0.113.9",
                soft: None,
            },
            Case {
                name: "a trusted proxy's rightmost entry wins over a spoofed one",
                trusted: PROXY,
                header: XFF,
                peer: "172.18.0.5",
                sent: &[("x-forwarded-for", "1.2.3.4, 198.51.100.7")],
                client: "198.51.100.7",
                soft: None,
            },
            Case {
                name: "a chain of two trusted proxies is skipped",
                trusted: &["172.18.0.0/16", "10.0.0.0/8"],
                header: XFF,
                peer: "172.18.0.5",
                sent: &[("x-forwarded-for", "1.2.3.4, 198.51.100.7, 10.1.1.1")],
                client: "198.51.100.7",
                soft: None,
            },
            Case {
                name: "several X-Forwarded-For headers are joined in order",
                trusted: &["172.18.0.0/16", "10.0.0.0/8"],
                header: XFF,
                peer: "172.18.0.5",
                sent: &[
                    ("x-forwarded-for", "1.2.3.4, 198.51.100.7"),
                    ("x-forwarded-for", "10.1.1.1"),
                ],
                client: "198.51.100.7",
                soft: None,
            },
            Case {
                name: "with Forwarded chosen, an attacker's X-Forwarded-For is ignored",
                trusted: PROXY,
                header: STD,
                peer: "172.18.0.5",
                sent: &[
                    ("x-forwarded-for", "1.2.3.4"),
                    ("forwarded", "for=198.51.100.7;proto=https"),
                ],
                client: "198.51.100.7",
                soft: None,
            },
            Case {
                name: "ports are parsed off",
                trusted: PROXY,
                header: XFF,
                peer: "172.18.0.5",
                sent: &[("x-forwarded-for", "198.51.100.7:51234")],
                client: "198.51.100.7",
                soft: None,
            },
            Case {
                name: "bracketed IPv6 with a port",
                trusted: PROXY,
                header: XFF,
                peer: "172.18.0.5",
                sent: &[("x-forwarded-for", "[2001:db8::7]:443")],
                client: "2001:db8::7",
                soft: None,
            },
            Case {
                name: "an unreadable rightmost entry keys by the proxy, softly",
                trusted: PROXY,
                header: XFF,
                peer: "172.18.0.5",
                sent: &[("x-forwarded-for", "198.51.100.7, not-an-address")],
                client: "172.18.0.5",
                soft: Some(SoftReason::UnreadableForwardedEntry),
            },
            Case {
                name: "an unreadable entry behind a trusted hop keys by that hop",
                trusted: &["172.18.0.0/16", "10.0.0.0/8"],
                header: XFF,
                peer: "172.18.0.5",
                sent: &[("x-forwarded-for", "unknown, 10.1.1.1")],
                client: "10.1.1.1",
                soft: Some(SoftReason::UnreadableForwardedEntry),
            },
            Case {
                name: "Forwarded's quoted, bracketed IPv6 with a port",
                trusted: PROXY,
                header: STD,
                peer: "172.18.0.5",
                sent: &[("forwarded", "for=\"[2001:db8::1]:443\";proto=https")],
                client: "2001:db8::1",
                soft: None,
            },
            Case {
                name: "Forwarded elements across headers, rightmost untrusted",
                trusted: &["172.18.0.0/16", "10.0.0.0/8"],
                header: STD,
                peer: "172.18.0.5",
                sent: &[
                    ("forwarded", "for=1.2.3.4, for=198.51.100.7"),
                    ("forwarded", "For=10.1.1.1;by=10.0.0.1"),
                ],
                client: "198.51.100.7",
                soft: None,
            },
            Case {
                name: "a Forwarded element without for= can't be read",
                trusted: PROXY,
                header: STD,
                peer: "172.18.0.5",
                sent: &[("forwarded", "proto=https;host=books.example.com")],
                client: "172.18.0.5",
                soft: Some(SoftReason::UnreadableForwardedEntry),
            },
            Case {
                name: "IPv4-mapped IPv6 entries are IPv4",
                trusted: PROXY,
                header: XFF,
                peer: "::ffff:172.18.0.5",
                sent: &[("x-forwarded-for", "::ffff:198.51.100.7")],
                client: "198.51.100.7",
                soft: None,
            },
            Case {
                name: "when every hop is trusted the leftmost is the client",
                trusted: &["172.18.0.0/16", "10.0.0.0/8"],
                header: XFF,
                peer: "172.18.0.5",
                sent: &[("x-forwarded-for", "10.2.2.2, 10.1.1.1")],
                client: "10.2.2.2",
                soft: None,
            },
            Case {
                name: "empty headers and entries are ignored",
                trusted: PROXY,
                header: XFF,
                peer: "172.18.0.5",
                sent: &[
                    ("x-forwarded-for", ""),
                    ("x-forwarded-for", "198.51.100.7, ,"),
                ],
                client: "198.51.100.7",
                soft: None,
            },
            Case {
                name: "a trusted proxy that sends nothing is the client",
                trusted: PROXY,
                header: XFF,
                peer: "172.18.0.5",
                sent: &[],
                client: "172.18.0.5",
                soft: None,
            },
            Case {
                name: "an untrusted private peer sending forwarding headers is soft",
                trusted: PROXY,
                header: XFF,
                peer: "192.168.1.30",
                sent: &[("x-forwarded-for", "198.51.100.7")],
                client: "192.168.1.30",
                soft: Some(SoftReason::UntrustedLocalForwarder),
            },
            Case {
                name: "an untrusted CGNAT peer sending forwarding headers is soft",
                trusted: PROXY,
                header: XFF,
                peer: "100.100.1.2",
                sent: &[("x-real-ip", "198.51.100.7")],
                client: "100.100.1.2",
                soft: Some(SoftReason::UntrustedLocalForwarder),
            },
            Case {
                name: "an untrusted public peer is never soft",
                trusted: PROXY,
                header: XFF,
                peer: "203.0.113.9",
                sent: &[("forwarded", "for=1.2.3.4")],
                client: "203.0.113.9",
                soft: None,
            },
        ];
        for case in cases {
            let resolver = trusting(case.trusted, case.header);
            let client = resolver.resolve(peer(case.peer), &headers(case.sent));
            assert_eq!(client.ip(), ip(case.client), "{}", case.name);
            assert_eq!(client.soft(), case.soft, "{}", case.name);
        }
    }

    #[test]
    fn public_peers_are_never_recorded_and_the_record_stays_bounded() {
        let resolver = trusting(PROXY, XFF);
        let spoofing = headers(&[("x-forwarded-for", "198.51.100.1")]);
        for last in 0..=255u8 {
            resolver.resolve(peer(&format!("203.0.113.{last}")), &spoofing);
        }
        assert!(resolver.untrusted_forwarders().is_empty());

        for third in 0..8u8 {
            for last in 0..=255u8 {
                resolver.resolve(peer(&format!("10.0.{third}.{last}")), &spoofing);
            }
        }
        assert_eq!(
            resolver.untrusted_forwarders().len(),
            UNTRUSTED_FORWARDERS_CAPACITY
        );
        let listed = resolver.untrusted_forwarders().list();
        assert_eq!(
            listed[0].address,
            ip("10.0.7.255"),
            "the most recent is first"
        );
        assert_eq!(listed[0].headers, vec!["x-forwarded-for"]);
        assert!(
            !listed.iter().any(|seen| seen.address == ip("10.0.0.0")),
            "the least recently seen were forgotten"
        );
    }

    #[test]
    fn dismissed_forwarders_stay_hidden_and_trusted_ones_are_forgotten() {
        let resolver = trusting(PROXY, XFF);
        let sent = headers(&[("x-forwarded-proto", "https")]);
        resolver.resolve(peer("192.168.1.30"), &sent);
        resolver.resolve(peer("192.168.1.31"), &sent);
        resolver
            .untrusted_forwarders()
            .dismiss(&IpRange::parse("192.168.1.30").unwrap());
        resolver.resolve(peer("192.168.1.30"), &sent);
        let listed: Vec<IpAddr> = resolver
            .untrusted_forwarders()
            .list()
            .into_iter()
            .map(|seen| seen.address)
            .collect();
        assert_eq!(listed, vec![ip("192.168.1.31")]);
        resolver
            .untrusted_forwarders()
            .forget(&IpRange::parse("192.168.1.0/24").unwrap());
        assert!(resolver.untrusted_forwarders().is_empty());
    }

    #[test]
    fn without_configuration_clients_trust_loopback_and_origins_private_networks() {
        let trust = ProxyTrust::new(None, Vec::new());
        assert_eq!(trust.client_ranges(), parse_ranges(LOOPBACK_PROXIES));
        assert_eq!(trust.origin_ranges(), parse_ranges(PRIVATE_PROXIES));
        assert!(trust.client_trusts(ip("127.0.0.1")));
        assert!(trust.client_trusts(ip("::1")));
        assert!(trust.client_trusts(ip("::ffff:127.0.0.1")));
        assert!(!trust.client_trusts(ip("172.18.0.5")));
        assert!(!trust.client_trusts(ip("192.168.1.1")));
        assert!(trust.origin_trusts(ip("172.18.0.5")));
        assert!(trust.origin_trusts(ip("fd00::1")));

        let resolver = ClientResolver::new(trust.clone(), XFF);
        let sent = headers(&[("x-forwarded-for", "198.51.100.7")]);
        assert_eq!(
            resolver.resolve(peer("172.18.0.5"), &sent).ip(),
            ip("172.18.0.5"),
            "a container network isn't believed for client addresses by default"
        );
        assert_eq!(
            resolver.resolve(peer("127.0.0.1"), &sent).ip(),
            ip("198.51.100.7")
        );

        trust.set_stored(vec![IpRange::parse("172.18.0.5").unwrap()]);
        assert!(trust.client_trusts(ip("172.18.0.5")));
        assert_eq!(
            resolver.resolve(peer("172.18.0.5"), &sent).ip(),
            ip("198.51.100.7"),
            "a range trusted in Settings applies at once"
        );
    }

    #[test]
    fn an_explicit_list_applies_to_clients_and_origins_alike() {
        let trust = ProxyTrust::new(
            Some(vec![IpRange::parse("203.0.113.0/24").unwrap()]),
            vec![],
        );
        for address in ["203.0.113.7"] {
            assert!(trust.client_trusts(ip(address)));
            assert!(trust.origin_trusts(ip(address)));
        }
        for address in ["127.0.0.1", "172.18.0.5"] {
            assert!(!trust.client_trusts(ip(address)), "{address}");
            assert!(!trust.origin_trusts(ip(address)), "{address}");
        }
        assert_eq!(trust.client_ranges(), trust.origin_ranges());
    }

    #[test]
    fn in_process_requests_are_this_machine() {
        let resolver = ClientResolver::loopback_only();
        let client = resolver.resolve(None, &headers(&[("x-forwarded-for", "198.51.100.7")]));
        assert_eq!(client, ClientAddress::in_process());
        assert!(client.is_loopback());
        assert_eq!(ClientAddress::of(&Extensions::new()), client);
    }

    #[test]
    fn keys_count_clients_and_their_neighbourhoods() {
        let v4 = ClientAddress::direct("198.51.100.7:1".parse().unwrap());
        assert_eq!(v4.key().to_string(), "198.51.100.7/32");
        let aggregates: Vec<String> = v4
            .aggregate_keys()
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(aggregates, vec!["198.51.100.0/24"]);

        let v6 = ClientAddress::direct("[2001:db8:1:2:3:4:5:6]:1".parse().unwrap());
        assert_eq!(v6.key().to_string(), "2001:db8:1:2::/64");
        let aggregates: Vec<String> = v6
            .aggregate_keys()
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(aggregates, vec!["2001:db8:1::/56", "2001:db8:1::/48"]);
        assert_eq!(
            AddressKey::client(ip("2001:db8:1:2::99")),
            v6.key(),
            "one /64 is one client"
        );
        assert!(v6.key().contains(ip("2001:db8:1:2:ffff::1")));

        let mapped = ClientAddress::direct("[::ffff:198.51.100.7]:1".parse().unwrap());
        assert_eq!(mapped.key(), v4.key());
    }

    #[test]
    fn ranges_hold_their_addresses() {
        let private = IpRange::parse("172.16.0.0/12").unwrap();
        assert!(private.contains(ip("172.20.0.5")));
        assert!(!private.contains(ip("172.32.0.1")));
        assert!(private.contains(ip("::ffff:172.17.0.1")));
        assert!(IpRange::parse("::1").unwrap().contains(ip("::1")));
        assert!(IpRange::parse("fc00::/7").unwrap().contains(ip("fd12::1")));
        assert_eq!(
            IpRange::parse("10.1.2.3/8").unwrap().to_string(),
            "10.0.0.0/8"
        );
        assert_eq!(
            IpRange::parse("172.18.0.5").unwrap().to_string(),
            "172.18.0.5"
        );
        for invalid in ["nas.local", "10.0.0.0/33", "::/129", ""] {
            assert!(IpRange::parse(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            ForwardedHeader::parse(" Forwarded ").unwrap(),
            ForwardedHeader::Forwarded
        );
        assert!(ForwardedHeader::parse("x-real-ip").is_err());
    }
}
