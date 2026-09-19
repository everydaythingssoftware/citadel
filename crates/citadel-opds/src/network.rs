use std::{
    collections::BTreeSet,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6},
};

use netdev::interface::types::InterfaceType;
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsNetworkInterface {
    pub id: String,
    pub label: String,
    pub kind: OpdsInterfaceKind,
    pub state: OpdsInterfaceState,
    pub addresses: Vec<String>,
    pub shareable: bool,
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
    pub fn bindable_ips(&self) -> impl Iterator<Item = IpAddr> + '_ {
        self.addresses
            .iter()
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

    pub fn bindable_addresses(&self, port: u16) -> Vec<SocketAddr> {
        self.bindable_ips()
            .map(|ip| match ip {
                IpAddr::V4(ip) => SocketAddr::new(IpAddr::V4(ip), port),
                IpAddr::V6(ip) => SocketAddr::V6(SocketAddrV6::new(ip, port, 0, 0)),
            })
            .collect()
    }

    pub fn public(&self) -> OpdsNetworkInterface {
        let addresses = self
            .bindable_ips()
            .map(|address| address.to_string())
            .collect::<Vec<_>>();
        OpdsNetworkInterface {
            id: self.id.clone(),
            label: self.label.clone(),
            kind: self.kind.clone(),
            state: self.state.clone(),
            shareable: self.kind != OpdsInterfaceKind::Loopback,
            addresses,
        }
    }
}

pub(crate) trait InterfaceProvider: Send {
    fn snapshot(&mut self) -> io::Result<Vec<InterfaceSnapshot>>;
}

pub(crate) struct NetdevInterfaceProvider;

impl InterfaceProvider for NetdevInterfaceProvider {
    fn snapshot(&mut self) -> io::Result<Vec<InterfaceSnapshot>> {
        Ok(netdev::get_interfaces()
            .into_iter()
            .map(|interface| {
                let addresses = interface
                    .ipv4
                    .iter()
                    .map(|network| InterfaceAddress {
                        address: IpAddr::V4(network.addr()),
                        scope: ipv4_scope(network.addr()),
                        deprecated: false,
                        tentative: false,
                        duplicated: false,
                    })
                    .chain(interface.ipv6.iter().enumerate().map(|(index, network)| {
                        let flags = interface
                            .ipv6_addr_flags
                            .get(index)
                            .copied()
                            .unwrap_or_default();
                        InterfaceAddress {
                            address: IpAddr::V6(network.addr()),
                            scope: ipv6_scope(network.addr()),
                            deprecated: flags.deprecated,
                            tentative: flags.tentative,
                            duplicated: flags.duplicated,
                        }
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
                    interface.if_type,
                    interface.is_loopback(),
                    interface.is_point_to_point(),
                    interface.is_physical(),
                    &addresses,
                );
                InterfaceSnapshot {
                    id: interface.name.clone(),
                    label,
                    description: interface.description.clone(),
                    state: if interface.is_up() && interface.is_running() {
                        OpdsInterfaceState::Up
                    } else {
                        OpdsInterfaceState::Down
                    },
                    kind,
                    addresses,
                }
            })
            .collect())
    }
}

/// Windows reports a GUID as the system `name` and the human-readable string
/// as the friendly label, so prefixes match all three identity fields.
fn classify(
    id: &str,
    label: &str,
    description: Option<&str>,
    interface_type: InterfaceType,
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
        || interface_type == InterfaceType::Loopback
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
            InterfaceType::Tunnel | InterfaceType::Ppp | InterfaceType::ProprietaryVirtual
        )
    {
        OpdsInterfaceKind::Vpn
    } else if virtual_name || interface_type == InterfaceType::Bridge {
        OpdsInterfaceKind::Other
    } else if physical
        || matches!(
            interface_type,
            InterfaceType::Ethernet
                | InterfaceType::FastEthernetT
                | InterfaceType::FastEthernetFx
                | InterfaceType::GigabitEthernet
                | InterfaceType::Wireless80211
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
    SelectedInterfaceMissing(String),
    SelectedInterfaceDown(String),
    SelectedInterfaceHasNoUsableAddress(String),
    LoopbackCannotBeShared(String),
    NoConfiguredAddress,
    InvalidConfiguredAddress(String),
}

impl WaitingReason {
    pub fn message(&self) -> String {
        match self {
            Self::NoLocalInterface => {
                "No active local interface has a usable IP address.".to_string()
            }
            Self::SelectedInterfaceMissing(id) => {
                format!("The selected interface ({id}) is unavailable.")
            }
            Self::SelectedInterfaceDown(id) => {
                format!("The selected interface ({id}) is currently down.")
            }
            Self::SelectedInterfaceHasNoUsableAddress(id) => {
                format!("The selected interface ({id}) has no usable local address.")
            }
            Self::LoopbackCannotBeShared(id) => {
                format!("The selected interface ({id}) is loopback-only and cannot be shared.")
            }
            Self::NoConfiguredAddress => "No explicit listener address was configured.".to_string(),
            Self::InvalidConfiguredAddress(address) => {
                format!("The configured listener address ({address}) is invalid.")
            }
        }
    }
}

/// Where the OPDS listener should attach. Persisted as user configuration, so
/// the `id` in [`OpdsBindTarget::Interface`] must stay stable across reboots.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum OpdsBindTarget {
    AllLocalNetworks,
    Interface { id: String },
    Addresses { addresses: Vec<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BindPlan {
    Listen(BTreeSet<SocketAddr>),
    Wait(WaitingReason),
}

/// Pure and cheap: the service layer re-snapshots interfaces and re-plans on
/// every change (DHCP renew, roam, sleep/wake), so callers must not assume a
/// plan outlives the interface state it was computed from.
pub(crate) fn plan_bindings(
    interfaces: &[InterfaceSnapshot],
    target: &OpdsBindTarget,
    port: u16,
) -> BindPlan {
    if let OpdsBindTarget::Addresses { addresses } = target {
        if addresses.is_empty() {
            return BindPlan::Wait(WaitingReason::NoConfiguredAddress);
        }
        let mut sockets = BTreeSet::new();
        for address in addresses {
            let Ok(address) = address.parse::<IpAddr>() else {
                return BindPlan::Wait(WaitingReason::InvalidConfiguredAddress(address.clone()));
            };
            sockets.insert(SocketAddr::new(address, port));
        }
        return BindPlan::Listen(sockets);
    }

    let selected = match target {
        OpdsBindTarget::AllLocalNetworks => interfaces
            .iter()
            .filter(|interface| {
                interface.kind == OpdsInterfaceKind::Lan
                    && interface.state == OpdsInterfaceState::Up
            })
            .collect::<Vec<_>>(),
        OpdsBindTarget::Interface { id } => {
            let Some(interface) = interfaces.iter().find(|interface| interface.id == *id) else {
                return BindPlan::Wait(WaitingReason::SelectedInterfaceMissing(id.clone()));
            };
            if interface.kind == OpdsInterfaceKind::Loopback {
                return BindPlan::Wait(WaitingReason::LoopbackCannotBeShared(id.clone()));
            }
            if interface.state != OpdsInterfaceState::Up {
                return BindPlan::Wait(WaitingReason::SelectedInterfaceDown(id.clone()));
            }
            vec![interface]
        }
        OpdsBindTarget::Addresses { .. } => unreachable!(),
    };

    let addresses = selected
        .into_iter()
        .flat_map(|interface| interface.bindable_addresses(port))
        .collect::<BTreeSet<_>>();
    if addresses.is_empty() {
        BindPlan::Wait(match target {
            OpdsBindTarget::AllLocalNetworks => WaitingReason::NoLocalInterface,
            OpdsBindTarget::Interface { id } => {
                WaitingReason::SelectedInterfaceHasNoUsableAddress(id.clone())
            }
            OpdsBindTarget::Addresses { .. } => unreachable!(),
        })
    } else {
        BindPlan::Listen(addresses)
    }
}

pub(crate) fn advertised_url(address: SocketAddr) -> String {
    format!("http://{address}/opds")
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
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

    fn interface_address(address: IpAddr, scope: AddressScope) -> InterfaceAddress {
        InterfaceAddress {
            address,
            scope,
            deprecated: false,
            tentative: false,
            duplicated: false,
        }
    }

    fn ipv4(address: [u8; 4]) -> InterfaceAddress {
        let address = Ipv4Addr::from(address);
        interface_address(IpAddr::V4(address), ipv4_scope(address))
    }

    fn ipv6(address: &str) -> InterfaceAddress {
        let address = address.parse::<Ipv6Addr>().unwrap();
        interface_address(IpAddr::V6(address), ipv6_scope(address))
    }

    fn listen_addresses(plan: BindPlan) -> BTreeSet<SocketAddr> {
        match plan {
            BindPlan::Listen(addresses) => addresses,
            BindPlan::Wait(reason) => panic!("expected listening plan, got {reason:?}"),
        }
    }

    #[test]
    fn all_local_networks_binds_only_exact_usable_lan_addresses() {
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
                vec![ipv4([10, 0, 0, 8]), ipv6("2001:db8::8")],
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
            &OpdsBindTarget::AllLocalNetworks,
            8080,
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
    fn selected_interface_binds_only_that_interface() {
        let interfaces = [
            interface(
                "en0",
                OpdsInterfaceKind::Lan,
                OpdsInterfaceState::Up,
                vec![ipv4([192, 168, 1, 42])],
            ),
            interface(
                "en1",
                OpdsInterfaceKind::Lan,
                OpdsInterfaceState::Up,
                vec![ipv4([192, 168, 2, 42]), ipv6("2001:db8::42")],
            ),
        ];

        let addresses = listen_addresses(plan_bindings(
            &interfaces,
            &OpdsBindTarget::Interface {
                id: "en1".to_string(),
            },
            8080,
        ));

        assert_eq!(
            addresses,
            BTreeSet::from([
                "192.168.2.42:8080".parse().unwrap(),
                "[2001:db8::42]:8080".parse().unwrap(),
            ])
        );
    }

    #[test]
    fn selected_interface_reports_missing_down_and_unusable_states() {
        let missing = plan_bindings(
            &[],
            &OpdsBindTarget::Interface {
                id: "en0".to_string(),
            },
            8080,
        );
        assert_eq!(
            missing,
            BindPlan::Wait(WaitingReason::SelectedInterfaceMissing("en0".to_string()))
        );

        let down = plan_bindings(
            &[interface(
                "en0",
                OpdsInterfaceKind::Lan,
                OpdsInterfaceState::Down,
                vec![ipv4([192, 168, 1, 42])],
            )],
            &OpdsBindTarget::Interface {
                id: "en0".to_string(),
            },
            8080,
        );
        assert_eq!(
            down,
            BindPlan::Wait(WaitingReason::SelectedInterfaceDown("en0".to_string()))
        );

        let unusable = plan_bindings(
            &[interface(
                "en0",
                OpdsInterfaceKind::Lan,
                OpdsInterfaceState::Up,
                vec![ipv4([169, 254, 1, 42])],
            )],
            &OpdsBindTarget::Interface {
                id: "en0".to_string(),
            },
            8080,
        );
        assert_eq!(
            unusable,
            BindPlan::Wait(WaitingReason::SelectedInterfaceHasNoUsableAddress(
                "en0".to_string()
            ))
        );
    }

    #[test]
    fn loopback_interface_cannot_be_selected_for_sharing() {
        let plan = plan_bindings(
            &[interface(
                "lo0",
                OpdsInterfaceKind::Loopback,
                OpdsInterfaceState::Up,
                vec![interface_address(
                    IpAddr::V4(Ipv4Addr::LOCALHOST),
                    AddressScope::Loopback,
                )],
            )],
            &OpdsBindTarget::Interface {
                id: "lo0".to_string(),
            },
            8080,
        );

        assert_eq!(
            plan,
            BindPlan::Wait(WaitingReason::LoopbackCannotBeShared("lo0".to_string()))
        );
    }

    #[test]
    fn bindable_addresses_excludes_link_local_and_unready_ipv6_addresses() {
        let mut deprecated = ipv6("fd12::2");
        deprecated.deprecated = true;
        let mut tentative = ipv6("fd12::3");
        tentative.tentative = true;
        let mut duplicated = ipv6("fd12::4");
        duplicated.duplicated = true;
        let snapshot = interface(
            "en0",
            OpdsInterfaceKind::Lan,
            OpdsInterfaceState::Up,
            vec![
                ipv6("fd12::1"),
                ipv6("fe80::1"),
                deprecated,
                tentative,
                duplicated,
            ],
        );

        assert_eq!(
            snapshot.bindable_addresses(8080),
            vec!["[fd12::1]:8080".parse().unwrap()]
        );
    }

    #[test]
    fn advertised_url_brackets_ipv6_addresses() {
        assert_eq!(
            advertised_url("[2001:db8::42]:8080".parse().unwrap()),
            "http://[2001:db8::42]:8080/opds"
        );
    }

    #[test]
    fn explicit_addresses_do_not_depend_on_interface_enumeration() {
        let plan = plan_bindings(
            &[],
            &OpdsBindTarget::Addresses {
                addresses: vec!["127.0.0.1".to_string(), "::1".to_string()],
            },
            8080,
        );
        assert_eq!(
            plan,
            BindPlan::Listen(BTreeSet::from([
                "127.0.0.1:8080".parse().unwrap(),
                "[::1]:8080".parse().unwrap(),
            ]))
        );

        assert_eq!(
            plan_bindings(
                &[],
                &OpdsBindTarget::Addresses {
                    addresses: vec!["not-an-address".to_string()],
                },
                8080,
            ),
            BindPlan::Wait(WaitingReason::InvalidConfiguredAddress(
                "not-an-address".to_string()
            ))
        );
    }

    #[test]
    fn public_interface_exposes_bindable_addresses_and_shareability() {
        let public = interface(
            "en0",
            OpdsInterfaceKind::Lan,
            OpdsInterfaceState::Up,
            vec![
                ipv4([192, 168, 1, 42]),
                ipv6("fd12::42"),
                ipv4([169, 254, 1, 42]),
            ],
        )
        .public();

        assert_eq!(
            public,
            OpdsNetworkInterface {
                id: "en0".to_string(),
                label: "en0 label".to_string(),
                kind: OpdsInterfaceKind::Lan,
                state: OpdsInterfaceState::Up,
                addresses: vec!["192.168.1.42".to_string(), "fd12::42".to_string()],
                shareable: true,
            }
        );

        let loopback = interface(
            "lo0",
            OpdsInterfaceKind::Loopback,
            OpdsInterfaceState::Up,
            vec![interface_address(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                AddressScope::Loopback,
            )],
        )
        .public();
        assert!(loopback.addresses.is_empty());
        assert!(!loopback.shareable);
    }

    #[test]
    fn shareable_is_capability_even_when_down_or_addressless() {
        let down = interface(
            "en0",
            OpdsInterfaceKind::Lan,
            OpdsInterfaceState::Down,
            vec![],
        )
        .public();
        assert!(down.shareable);
        assert!(down.addresses.is_empty());
    }

    #[test]
    fn selected_interface_accepts_unclassified_interfaces_as_escape_hatch() {
        let bridged_lan = interface(
            "br0",
            OpdsInterfaceKind::Other,
            OpdsInterfaceState::Up,
            vec![ipv4([192, 168, 1, 7])],
        );

        assert_eq!(
            plan_bindings(
                &[bridged_lan],
                &OpdsBindTarget::Interface {
                    id: "br0".to_string(),
                },
                8080,
            ),
            BindPlan::Listen(BTreeSet::from(["192.168.1.7:8080".parse().unwrap()]))
        );
    }

    #[test]
    fn classify_routes_interfaces_by_name_label_and_description() {
        struct Row {
            id: &'static str,
            label: &'static str,
            description: Option<&'static str>,
            interface_type: InterfaceType,
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
                interface_type: InterfaceType::Ethernet,
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
                interface_type: InterfaceType::Wireless80211,
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
                interface_type: InterfaceType::Tunnel,
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
                interface_type: InterfaceType::Ethernet,
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
                interface_type: InterfaceType::Ethernet,
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
                interface_type: InterfaceType::Loopback,
                loopback: true,
                point_to_point: false,
                physical: false,
                addresses: vec![interface_address(
                    IpAddr::V4(Ipv4Addr::LOCALHOST),
                    AddressScope::Loopback,
                )],
                expected: OpdsInterfaceKind::Loopback,
            },
            Row {
                id: "docker0",
                label: "docker0",
                description: None,
                interface_type: InterfaceType::Bridge,
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
                interface_type: InterfaceType::Ethernet,
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
