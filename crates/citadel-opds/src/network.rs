use std::{
    collections::BTreeSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6},
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpdsInterfaceKind {
    Lan,
    Vpn,
    Loopback,
    Other,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpdsInterfaceState {
    Up,
    Down,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AddressScope {
    Private,
    Shared,
    LinkLocal,
    Loopback,
    Global,
    Other,
    Unspecified,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InterfaceAddress {
    pub address: IpAddr,
    pub scope: AddressScope,
    pub deprecated: bool,
    pub tentative: bool,
    pub duplicated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InterfaceSnapshot {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub state: OpdsInterfaceState,
    pub kind: OpdsInterfaceKind,
    pub addresses: Vec<InterfaceAddress>,
}

impl InterfaceSnapshot {
    pub fn bindable_ips(&self, policy: BindPolicy) -> impl Iterator<Item = IpAddr> + '_ {
        let allow_global = policy.allow_global;
        self.addresses
            .iter()
            .filter(move |address| allow_global || address.scope != AddressScope::Global)
            .filter_map(|address| match (address.address, &address.scope) {
                (
                    IpAddr::V4(ip),
                    AddressScope::Private | AddressScope::Shared | AddressScope::Global,
                ) => Some(IpAddr::V4(ip)),
                (IpAddr::V6(ip), AddressScope::Private | AddressScope::Global)
                    if !address.deprecated && !address.tentative && !address.duplicated =>
                {
                    Some(IpAddr::V6(ip))
                }
                _ => None,
            })
    }

    pub fn bindable_addresses(&self, port: u16, policy: BindPolicy) -> Vec<SocketAddr> {
        self.bindable_ips(policy)
            .map(|ip| match ip {
                IpAddr::V4(ip) => SocketAddr::new(IpAddr::V4(ip), port),
                IpAddr::V6(ip) => SocketAddr::V6(SocketAddrV6::new(ip, port, 0, 0)),
            })
            .collect()
    }
}

/// What the operating system calls an interface's hardware, as far as
/// telling LAN from VPN from virtual needs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostInterfaceType {
    Loopback,
    Ethernet,
    Wireless,
    Tunnel,
    Ppp,
    /// A proprietary virtual adapter, such as a VPN client's.
    Virtual,
    Bridge,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostIpv6Address {
    pub address: Ipv6Addr,
    pub deprecated: bool,
    pub tentative: bool,
    pub duplicated: bool,
}

/// One network interface as the operating system reports it, before Citadel
/// decides what kind it is and which of its addresses sharing may use.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostInterface {
    /// The system name (a GUID on Windows).
    pub name: String,
    pub friendly_name: Option<String>,
    pub description: Option<String>,
    pub interface_type: HostInterfaceType,
    pub up: bool,
    pub loopback: bool,
    pub point_to_point: bool,
    pub physical: bool,
    pub ipv4: Vec<Ipv4Addr>,
    pub ipv6: Vec<HostIpv6Address>,
}

impl From<HostInterface> for InterfaceSnapshot {
    fn from(interface: HostInterface) -> Self {
        let addresses = interface
            .ipv4
            .iter()
            .map(|&address| InterfaceAddress {
                address: IpAddr::V4(address),
                scope: ipv4_scope(address),
                deprecated: false,
                tentative: false,
                duplicated: false,
            })
            .chain(interface.ipv6.iter().map(|address| InterfaceAddress {
                address: IpAddr::V6(address.address),
                scope: ipv6_scope(address.address),
                deprecated: address.deprecated,
                tentative: address.tentative,
                duplicated: address.duplicated,
            }))
            .collect::<Vec<_>>();
        let label = interface
            .friendly_name
            .clone()
            .filter(|label| !label.trim().is_empty())
            .unwrap_or_else(|| interface.name.clone());
        let kind = classify(
            &interface.name,
            &label,
            interface.description.as_deref(),
            interface.interface_type,
            interface.loopback,
            interface.point_to_point,
            interface.physical,
            &addresses,
        );
        InterfaceSnapshot {
            id: interface.name,
            label,
            description: interface.description,
            state: if interface.up {
                OpdsInterfaceState::Up
            } else {
                OpdsInterfaceState::Down
            },
            kind,
            addresses,
        }
    }
}

/// Windows reports a GUID as the system `name` and the human-readable string
/// as the friendly label, so prefixes match all three identity fields.
fn classify(
    id: &str,
    label: &str,
    description: Option<&str>,
    interface_type: HostInterfaceType,
    loopback: bool,
    point_to_point: bool,
    physical: bool,
    addresses: &[InterfaceAddress],
) -> OpdsInterfaceKind {
    let system_name = id.to_ascii_lowercase();
    let display_name = label.to_ascii_lowercase();
    let description_text = description.map(|d| d.to_ascii_lowercase());
    let matches_prefix = |prefixes: &[&str]| {
        prefixes.iter().any(|prefix| {
            system_name.starts_with(prefix)
                || display_name.starts_with(prefix)
                || description_text
                    .as_deref()
                    .is_some_and(|d| d.contains(prefix))
        })
    };
    let vpn_name = matches_prefix(&[
        "utun",
        "tun",
        "tap",
        "wg",
        "tailscale",
        "proton",
        "nordlynx",
        "ipsec",
        "ppp",
        "openvpn",
        "wireguard",
        "zerotier",
    ]);
    let virtual_name = matches_prefix(&[
        "awdl", "llw", "bridge", "br-", "docker", "veth", "virbr", "vmenet", "vmnet", "vmware",
        "hyper-v", "virtual",
    ]);

    if loopback
        || interface_type == HostInterfaceType::Loopback
        || (!addresses.is_empty()
            && addresses
                .iter()
                .all(|address| address.scope == AddressScope::Loopback))
    {
        OpdsInterfaceKind::Loopback
    } else if point_to_point
        || vpn_name
        || matches!(
            interface_type,
            HostInterfaceType::Tunnel | HostInterfaceType::Ppp | HostInterfaceType::Virtual
        )
    {
        OpdsInterfaceKind::Vpn
    } else if virtual_name || interface_type == HostInterfaceType::Bridge {
        OpdsInterfaceKind::Other
    } else if physical
        || matches!(
            interface_type,
            HostInterfaceType::Ethernet | HostInterfaceType::Wireless
        )
    {
        OpdsInterfaceKind::Lan
    } else {
        OpdsInterfaceKind::Other
    }
}

pub(crate) fn ipv4_scope(address: Ipv4Addr) -> AddressScope {
    let octets = address.octets();
    if address.is_unspecified() {
        AddressScope::Unspecified
    } else if address.is_loopback() {
        AddressScope::Loopback
    } else if address.is_link_local() {
        AddressScope::LinkLocal
    } else if address.is_private() {
        AddressScope::Private
    } else if octets[0] == 100 && (64..=127).contains(&octets[1]) {
        AddressScope::Shared
    } else if address.is_multicast() || address.is_broadcast() || octets[0] >= 240 {
        AddressScope::Other
    } else {
        AddressScope::Global
    }
}

pub(crate) fn ipv6_scope(address: Ipv6Addr) -> AddressScope {
    let first = address.segments()[0];
    if address.is_unspecified() {
        AddressScope::Unspecified
    } else if address.is_loopback() {
        AddressScope::Loopback
    } else if (first & 0xffc0) == 0xfe80 {
        AddressScope::LinkLocal
    } else if (first & 0xfe00) == 0xfc00 {
        AddressScope::Private
    } else if (first & 0xe000) == 0x2000 {
        AddressScope::Global
    } else {
        AddressScope::Other
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WaitingReason {
    NoLocalInterface,
}

impl WaitingReason {
    pub fn message(&self) -> String {
        match self {
            Self::NoLocalInterface => {
                "No active local network has a usable address yet.".to_string()
            }
        }
    }
}

/// Where sharing listens. `AllInterfaces` is meant to be paired with
/// credentials (see the auth integration) since it serves every network the
/// computer can reach.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpdsBindTarget {
    LocalNetworks,
    AllInterfaces,
    Addresses { addresses: Vec<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BindPlan {
    Listen(BTreeSet<SocketAddr>),
    Wait(WaitingReason),
}

/// What address scopes sharing may reach. Globally-routable addresses stay
/// excluded until the caller can vouch for them (auth-enabled sharing).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct BindPolicy {
    pub allow_global: bool,
}

/// Where to listen. `ipv6` is whether the host can listen on IPv6 at all:
/// without it, nothing IPv6 is planned.
pub(crate) fn plan_bindings(
    interfaces: &[InterfaceSnapshot],
    target: &OpdsBindTarget,
    port: u16,
    policy: BindPolicy,
    ipv6: bool,
) -> BindPlan {
    match target {
        OpdsBindTarget::Addresses { addresses } => match explicit_addresses(addresses, policy) {
            Ok(addresses) => BindPlan::Listen(
                addresses
                    .into_iter()
                    .map(|address| SocketAddr::new(address, port))
                    .collect(),
            ),
            Err(_) => BindPlan::Wait(WaitingReason::NoLocalInterface),
        },
        OpdsBindTarget::AllInterfaces => {
            let mut sockets = BTreeSet::new();
            sockets.insert(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port));
            if ipv6 {
                sockets.insert(SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port));
            }
            BindPlan::Listen(sockets)
        }
        OpdsBindTarget::LocalNetworks => {
            let addresses = interfaces
                .iter()
                .filter(|interface| {
                    interface.kind == OpdsInterfaceKind::Lan
                        && interface.state == OpdsInterfaceState::Up
                })
                .flat_map(|interface| interface.bindable_addresses(port, policy))
                .filter(|address| ipv6 || address.is_ipv4())
                .collect::<BTreeSet<_>>();
            if addresses.is_empty() {
                BindPlan::Wait(WaitingReason::NoLocalInterface)
            } else {
                BindPlan::Listen(addresses)
            }
        }
    }
}

pub(crate) fn advertised_url(address: SocketAddr) -> String {
    format!("http://{address}/opds")
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        net::{IpAddr, Ipv4Addr, SocketAddr},
    };

    use super::*;

    fn interface(
        id: &str,
        kind: OpdsInterfaceKind,
        state: OpdsInterfaceState,
        addresses: Vec<InterfaceAddress>,
    ) -> InterfaceSnapshot {
        InterfaceSnapshot {
            id: id.to_string(),
            label: format!("{id} label"),
            description: None,
            kind,
            state,
            addresses,
        }
    }

    fn ipv4(address: [u8; 4]) -> InterfaceAddress {
        let address = Ipv4Addr::from(address);
        InterfaceAddress {
            address: IpAddr::V4(address),
            scope: ipv4_scope(address),
            deprecated: false,
            tentative: false,
            duplicated: false,
        }
    }

    fn ipv6(address: &str) -> InterfaceAddress {
        let address = address.parse::<Ipv6Addr>().unwrap();
        InterfaceAddress {
            address: IpAddr::V6(address),
            scope: ipv6_scope(address),
            deprecated: false,
            tentative: false,
            duplicated: false,
        }
    }

    fn listen_addresses(plan: BindPlan) -> BTreeSet<SocketAddr> {
        match plan {
            BindPlan::Listen(addresses) => addresses,
            BindPlan::Wait(reason) => panic!("expected listening plan, got {reason:?}"),
        }
    }

    #[test]
    fn local_networks_binds_usable_lan_addresses_and_skips_the_rest() {
        let interfaces = [
            interface(
                "en0",
                OpdsInterfaceKind::Lan,
                OpdsInterfaceState::Up,
                vec![ipv4([192, 168, 1, 42]), ipv6("fd12:3456::42")],
            ),
            interface(
                "utun4",
                OpdsInterfaceKind::Vpn,
                OpdsInterfaceState::Up,
                vec![ipv4([10, 0, 0, 8])],
            ),
            interface(
                "en1",
                OpdsInterfaceKind::Lan,
                OpdsInterfaceState::Down,
                vec![ipv4([192, 168, 2, 8])],
            ),
        ];

        let addresses = listen_addresses(plan_bindings(
            &interfaces,
            &OpdsBindTarget::LocalNetworks,
            8080,
            BindPolicy::default(),
            true,
        ));

        assert_eq!(
            addresses,
            BTreeSet::from([
                "192.168.1.42:8080".parse().unwrap(),
                "[fd12:3456::42]:8080".parse().unwrap(),
            ])
        );
        assert!(!addresses
            .iter()
            .any(|address| address.ip().is_unspecified()));
    }

    #[test]
    fn local_networks_waits_when_nothing_is_bindable() {
        let plan = plan_bindings(
            &[interface(
                "en0",
                OpdsInterfaceKind::Lan,
                OpdsInterfaceState::Up,
                vec![ipv4([169, 254, 1, 42])],
            )],
            &OpdsBindTarget::LocalNetworks,
            8080,
            BindPolicy::default(),
            true,
        );
        assert_eq!(plan, BindPlan::Wait(WaitingReason::NoLocalInterface));
    }

    #[test]
    fn all_interfaces_binds_both_wildcards_without_enumeration() {
        let plan = plan_bindings(
            &[],
            &OpdsBindTarget::AllInterfaces,
            8080,
            BindPolicy::default(),
            true,
        );
        assert_eq!(
            listen_addresses(plan),
            BTreeSet::from([
                "0.0.0.0:8080".parse().unwrap(),
                "[::]:8080".parse().unwrap(),
            ])
        );
    }

    #[test]
    fn bindable_addresses_excludes_link_local_and_unready_ipv6_addresses() {
        let mut deprecated = ipv6("fd12::2");
        deprecated.deprecated = true;
        let snapshot = interface(
            "en0",
            OpdsInterfaceKind::Lan,
            OpdsInterfaceState::Up,
            vec![ipv6("fd12::1"), ipv6("fe80::1"), deprecated],
        );

        assert_eq!(
            snapshot.bindable_addresses(8080, BindPolicy::default()),
            vec!["[fd12::1]:8080".parse().unwrap()]
        );
    }

    #[test]
    fn global_addresses_bind_only_when_the_policy_allows_them() {
        let snapshot = interface(
            "en0",
            OpdsInterfaceKind::Lan,
            OpdsInterfaceState::Up,
            vec![ipv4([192, 168, 1, 42]), ipv6("2001:db8::42")],
        );

        assert_eq!(
            snapshot
                .bindable_addresses(8080, BindPolicy::default())
                .len(),
            1
        );
        assert_eq!(
            snapshot
                .bindable_addresses(8080, BindPolicy { allow_global: true })
                .len(),
            2
        );
    }

    #[test]
    fn classify_routes_interfaces_by_name_label_and_description() {
        struct Row {
            id: &'static str,
            label: &'static str,
            description: Option<&'static str>,
            interface_type: HostInterfaceType,
            loopback: bool,
            point_to_point: bool,
            physical: bool,
            addresses: Vec<InterfaceAddress>,
            expected: OpdsInterfaceKind,
        }
        let cases = [
            Row {
                id: "en0",
                label: "en0",
                description: None,
                interface_type: HostInterfaceType::Ethernet,
                loopback: false,
                point_to_point: false,
                physical: true,
                addresses: vec![ipv4([192, 168, 1, 42])],
                expected: OpdsInterfaceKind::Lan,
            },
            Row {
                id: "wlp3s0",
                label: "wlp3s0",
                description: None,
                interface_type: HostInterfaceType::Wireless,
                loopback: false,
                point_to_point: false,
                physical: true,
                addresses: vec![ipv4([192, 168, 1, 43])],
                expected: OpdsInterfaceKind::Lan,
            },
            Row {
                id: "utun4",
                label: "utun4",
                description: None,
                interface_type: HostInterfaceType::Tunnel,
                loopback: false,
                point_to_point: true,
                physical: false,
                addresses: vec![ipv4([10, 0, 0, 8])],
                expected: OpdsInterfaceKind::Vpn,
            },
            Row {
                id: "{8A5C1A93-2F0E-4C1B-9D6B-5E1F2A3B4C5D}",
                label: "Tailscale",
                description: Some("Tailscale Tunnel"),
                interface_type: HostInterfaceType::Ethernet,
                loopback: false,
                point_to_point: false,
                physical: false,
                addresses: vec![ipv4([100, 100, 2, 1])],
                expected: OpdsInterfaceKind::Vpn,
            },
            Row {
                id: "{1B2C3D4E-5F6A-7B8C-9D0E-1F2A3B4C5D6E}",
                label: "OpenVPN TAP-Windows6",
                description: Some("TAP-Windows Adapter V9"),
                interface_type: HostInterfaceType::Ethernet,
                loopback: false,
                point_to_point: false,
                physical: false,
                addresses: vec![ipv4([10, 8, 0, 2])],
                expected: OpdsInterfaceKind::Vpn,
            },
            Row {
                id: "lo0",
                label: "lo0",
                description: None,
                interface_type: HostInterfaceType::Loopback,
                loopback: true,
                point_to_point: false,
                physical: false,
                addresses: vec![InterfaceAddress {
                    address: IpAddr::V4(Ipv4Addr::LOCALHOST),
                    scope: AddressScope::Loopback,
                    deprecated: false,
                    tentative: false,
                    duplicated: false,
                }],
                expected: OpdsInterfaceKind::Loopback,
            },
            Row {
                id: "docker0",
                label: "docker0",
                description: None,
                interface_type: HostInterfaceType::Bridge,
                loopback: false,
                point_to_point: false,
                physical: false,
                addresses: vec![ipv4([172, 17, 0, 1])],
                expected: OpdsInterfaceKind::Other,
            },
            Row {
                id: "{3C4D5E6F-7A8B-9C0D-1E2F-3A4B5C6D7E8F}",
                label: "vEthernet (WSL)",
                description: Some("Hyper-V Virtual Ethernet Adapter"),
                interface_type: HostInterfaceType::Ethernet,
                loopback: false,
                point_to_point: false,
                physical: false,
                addresses: vec![ipv4([192, 168, 137, 1])],
                expected: OpdsInterfaceKind::Other,
            },
        ];
        for row in cases {
            assert_eq!(
                classify(
                    row.id,
                    row.label,
                    row.description,
                    row.interface_type,
                    row.loopback,
                    row.point_to_point,
                    row.physical,
                    &row.addresses,
                ),
                row.expected,
                "unexpected classification for {}",
                row.label
            );
        }
    }
}

/// Validate explicit hosts with the same exposure policy as desktop sharing.
pub fn validate_explicit_addresses(
    addresses: &[String],
    authenticated: bool,
) -> Result<(), String> {
    explicit_addresses(
        addresses,
        BindPolicy {
            allow_global: authenticated,
        },
    )
    .map(|_| ())
}

fn explicit_addresses(addresses: &[String], policy: BindPolicy) -> Result<Vec<IpAddr>, String> {
    if addresses.is_empty() {
        return Err("At least one listener address is required.".into());
    }
    addresses
        .iter()
        .map(|address| {
            let address: IpAddr = address
                .parse()
                .map_err(|_| "Invalid listener address.".to_string())?;
            let scope = match address {
                IpAddr::V4(a) => ipv4_scope(a),
                IpAddr::V6(a) => ipv6_scope(a),
            };
            match scope {
                AddressScope::Loopback | AddressScope::Private | AddressScope::Shared => {
                    Ok(address)
                }
                AddressScope::Global if policy.allow_global => Ok(address),
                AddressScope::Global => {
                    Err("Public listener addresses require reader sign-in.".into())
                }
                _ => Err(
                    "Wildcard, link-local and non-unicast listener addresses are not allowed."
                        .into(),
                ),
            }
        })
        .collect()
}

#[cfg(test)]
mod explicit_tests {
    use super::*;
    #[test]
    fn explicit_hosts_enforce_exposure_policy() {
        for address in [
            "0.0.0.0",
            "::",
            "fe80::1",
            "169.254.1.1",
            "224.0.0.1",
            "bad",
        ] {
            assert!(
                validate_explicit_addresses(&[address.into()], true).is_err(),
                "{address}"
            );
        }
        assert!(validate_explicit_addresses(&[], true).is_err());
        for address in ["127.0.0.1", "::1", "192.168.1.2", "fd00::1"] {
            assert!(
                validate_explicit_addresses(&[address.into()], false).is_ok(),
                "{address}"
            );
        }
        assert!(validate_explicit_addresses(&["8.8.8.8".into()], false).is_err());
        assert!(validate_explicit_addresses(&["8.8.8.8".into()], true).is_ok());
    }
}
