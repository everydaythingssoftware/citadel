use netdev::interface::types::InterfaceType;
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fmt::{self, Display},
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6, TcpListener},
    thread,
    time::Duration,
};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct InterfaceId(String);

impl Display for InterfaceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InterfaceState {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InterfaceClass {
    Lan,
    Vpn,
    Loopback,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AddressScope {
    Private,
    Shared,
    LinkLocal,
    Loopback,
    Global,
    Other,
    Unspecified,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct InterfaceAddress {
    address: IpAddr,
    prefix_length: u8,
    scope: AddressScope,
    scope_id: u32,
    temporary: bool,
    deprecated: bool,
    tentative: bool,
    duplicated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct InterfaceSnapshot {
    id: InterfaceId,
    index: u32,
    label: String,
    administrative_up: bool,
    running: bool,
    state: InterfaceState,
    class: InterfaceClass,
    addresses: Vec<InterfaceAddress>,
}

impl InterfaceSnapshot {
    fn bindable_addresses(&self, port: u16) -> Vec<SocketAddr> {
        self.addresses
            .iter()
            .filter_map(|address| match (address.address, address.scope) {
                (
                    IpAddr::V4(ip),
                    AddressScope::Private | AddressScope::Shared | AddressScope::Global,
                ) => Some(SocketAddr::new(IpAddr::V4(ip), port)),
                (IpAddr::V6(ip), AddressScope::Private | AddressScope::Global)
                    if !address.deprecated && !address.tentative && !address.duplicated =>
                {
                    Some(SocketAddr::V6(SocketAddrV6::new(ip, port, 0, 0)))
                }
                _ => None,
            })
            .collect()
    }
}

#[derive(Clone, Debug)]
struct InterfaceFacts {
    id: InterfaceId,
    index: u32,
    friendly_name: Option<String>,
    is_up: bool,
    is_running: bool,
    is_loopback: bool,
    is_point_to_point: bool,
    is_physical: bool,
    kind: InterfaceType,
    addresses: Vec<InterfaceAddress>,
}

fn classify_interface(facts: &InterfaceFacts) -> InterfaceClass {
    let name = facts.id.0.to_ascii_lowercase();
    let vpn_name = [
        "utun",
        "tun",
        "tap",
        "wg",
        "tailscale",
        "proton",
        "nordlynx",
        "ipsec",
        "ppp",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix));
    let virtual_name = [
        "awdl", "llw", "bridge", "br-", "docker", "veth", "virbr", "vmenet", "vmnet",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix));

    if facts.is_loopback
        || facts.kind == InterfaceType::Loopback
        || (!facts.addresses.is_empty()
            && facts
                .addresses
                .iter()
                .all(|address| address.scope == AddressScope::Loopback))
    {
        InterfaceClass::Loopback
    } else if facts.is_point_to_point
        || vpn_name
        || matches!(
            facts.kind,
            InterfaceType::Tunnel | InterfaceType::Ppp | InterfaceType::ProprietaryVirtual
        )
    {
        InterfaceClass::Vpn
    } else if virtual_name || facts.kind == InterfaceType::Bridge {
        InterfaceClass::Other
    } else if facts.is_physical
        || matches!(
            facts.kind,
            InterfaceType::Ethernet
                | InterfaceType::FastEthernetT
                | InterfaceType::FastEthernetFx
                | InterfaceType::GigabitEthernet
                | InterfaceType::Wireless80211
        )
    {
        InterfaceClass::Lan
    } else {
        InterfaceClass::Other
    }
}

fn snapshot_from_facts(facts: InterfaceFacts) -> InterfaceSnapshot {
    let class = classify_interface(&facts);
    let label = facts
        .friendly_name
        .filter(|label| !label.trim().is_empty())
        .unwrap_or_else(|| facts.id.0.clone());

    InterfaceSnapshot {
        id: facts.id,
        index: facts.index,
        label,
        administrative_up: facts.is_up,
        running: facts.is_running,
        state: if facts.is_up && facts.is_running {
            InterfaceState::Up
        } else {
            InterfaceState::Down
        },
        class,
        addresses: facts.addresses,
    }
}

fn ipv4_scope(address: Ipv4Addr) -> AddressScope {
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

fn ipv6_scope(address: Ipv6Addr) -> AddressScope {
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

fn advertised_url(address: SocketAddr) -> Option<String> {
    match address.ip() {
        IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_loopback() && !ip.is_link_local() => {
            Some(format!("http://{address}/opds"))
        }
        IpAddr::V6(ip)
            if !ip.is_unspecified()
                && !ip.is_loopback()
                && (ip.segments()[0] & 0xffc0) != 0xfe80 =>
        {
            Some(format!("http://{address}/opds"))
        }
        _ => None,
    }
}

#[cfg(test)]
fn scoped_link_local_socket(address: &InterfaceAddress, port: u16) -> Option<SocketAddr> {
    match (address.address, address.scope, address.scope_id) {
        (IpAddr::V6(ip), AddressScope::LinkLocal, scope_id) if scope_id != 0 => {
            Some(SocketAddr::V6(SocketAddrV6::new(ip, port, 0, scope_id)))
        }
        _ => None,
    }
}

trait InterfaceProvider {
    fn snapshot(&mut self) -> io::Result<Vec<InterfaceSnapshot>>;
}

struct NetdevProvider;

impl InterfaceProvider for NetdevProvider {
    fn snapshot(&mut self) -> io::Result<Vec<InterfaceSnapshot>> {
        Ok(netdev::get_interfaces()
            .into_iter()
            .map(|interface| {
                let mut addresses = interface
                    .ipv4
                    .iter()
                    .map(|network| InterfaceAddress {
                        address: IpAddr::V4(network.addr()),
                        prefix_length: network.prefix_len(),
                        scope: ipv4_scope(network.addr()),
                        scope_id: 0,
                        temporary: false,
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
                            prefix_length: network.prefix_len(),
                            scope: ipv6_scope(network.addr()),
                            scope_id: interface.ipv6_scope_ids.get(index).copied().unwrap_or(0),
                            temporary: flags.temporary,
                            deprecated: flags.deprecated,
                            tentative: flags.tentative,
                            duplicated: flags.duplicated,
                        }
                    }))
                    .collect::<Vec<_>>();
                addresses.sort_by_key(|address| address.address);

                snapshot_from_facts(InterfaceFacts {
                    id: InterfaceId(interface.name.clone()),
                    index: interface.index,
                    friendly_name: interface.friendly_name.clone(),
                    is_up: interface.is_up(),
                    is_running: interface.is_running(),
                    is_loopback: interface.is_loopback(),
                    is_point_to_point: interface.is_point_to_point(),
                    is_physical: interface.is_physical(),
                    kind: interface.if_type,
                    addresses,
                })
            })
            .collect())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum BindTarget {
    AllLocal,
    Selected(InterfaceId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum WaitingReason {
    NoLocalInterface,
    SelectedInterfaceMissing(InterfaceId),
    SelectedInterfaceDown(InterfaceId),
    SelectedInterfaceHasNoUsableAddress(InterfaceId),
    LoopbackCannotBeShared(InterfaceId),
}

impl Display for WaitingReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WaitingReason::NoLocalInterface => {
                formatter.write_str("no active local interface has a usable IP address")
            }
            WaitingReason::SelectedInterfaceMissing(id) => {
                write!(formatter, "selected interface {id} is missing")
            }
            WaitingReason::SelectedInterfaceDown(id) => {
                write!(formatter, "selected interface {id} is down")
            }
            WaitingReason::SelectedInterfaceHasNoUsableAddress(id) => {
                write!(
                    formatter,
                    "selected interface {id} has no usable IP address"
                )
            }
            WaitingReason::LoopbackCannotBeShared(id) => {
                write!(formatter, "selected interface {id} is loopback-only")
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum BindPlan {
    Listen(BTreeSet<SocketAddr>),
    Wait(WaitingReason),
}

fn plan_bindings(interfaces: &[InterfaceSnapshot], target: &BindTarget, port: u16) -> BindPlan {
    let selected = match target {
        BindTarget::AllLocal => interfaces
            .iter()
            .filter(|interface| {
                interface.class == InterfaceClass::Lan && interface.state == InterfaceState::Up
            })
            .collect::<Vec<_>>(),
        BindTarget::Selected(id) => {
            let Some(interface) = interfaces.iter().find(|interface| interface.id == *id) else {
                return BindPlan::Wait(WaitingReason::SelectedInterfaceMissing(id.clone()));
            };
            if interface.class == InterfaceClass::Loopback {
                return BindPlan::Wait(WaitingReason::LoopbackCannotBeShared(id.clone()));
            }
            if interface.state != InterfaceState::Up {
                return BindPlan::Wait(WaitingReason::SelectedInterfaceDown(id.clone()));
            }
            vec![interface]
        }
    };

    let addresses = selected
        .into_iter()
        .flat_map(|interface| interface.bindable_addresses(port))
        .collect::<BTreeSet<_>>();

    if !addresses.is_empty() {
        BindPlan::Listen(addresses)
    } else {
        match target {
            BindTarget::AllLocal => BindPlan::Wait(WaitingReason::NoLocalInterface),
            BindTarget::Selected(id) => BindPlan::Wait(
                WaitingReason::SelectedInterfaceHasNoUsableAddress(id.clone()),
            ),
        }
    }
}

trait ListenerFactory {
    type Listener;

    fn bind(&mut self, address: SocketAddr) -> io::Result<Self::Listener>;
    fn close(&mut self, address: SocketAddr, listener: Self::Listener);
}

struct TcpListenerFactory;

impl ListenerFactory for TcpListenerFactory {
    type Listener = TcpListener;

    fn bind(&mut self, address: SocketAddr) -> io::Result<Self::Listener> {
        let listener = TcpListener::bind(address)?;
        listener.set_nonblocking(true)?;
        Ok(listener)
    }

    fn close(&mut self, _address: SocketAddr, listener: Self::Listener) {
        drop(listener);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProbeStatus {
    Running(BTreeSet<SocketAddr>),
    Waiting(WaitingReason),
    Error(String),
}

struct ListenerProbe<Provider, Factory>
where
    Provider: InterfaceProvider,
    Factory: ListenerFactory,
{
    provider: Provider,
    factory: Factory,
    target: BindTarget,
    port: u16,
    listeners: BTreeMap<SocketAddr, Factory::Listener>,
    status: ProbeStatus,
}

impl<Provider, Factory> ListenerProbe<Provider, Factory>
where
    Provider: InterfaceProvider,
    Factory: ListenerFactory,
{
    fn new(provider: Provider, factory: Factory, target: BindTarget, port: u16) -> Self {
        Self {
            provider,
            factory,
            target,
            port,
            listeners: BTreeMap::new(),
            status: ProbeStatus::Waiting(WaitingReason::NoLocalInterface),
        }
    }

    fn tick(&mut self) -> &ProbeStatus {
        let interfaces = match self.provider.snapshot() {
            Ok(interfaces) => interfaces,
            Err(error) => {
                self.close_all();
                self.status = ProbeStatus::Error(format!("interface enumeration failed: {error}"));
                return &self.status;
            }
        };
        match plan_bindings(&interfaces, &self.target, self.port) {
            BindPlan::Wait(reason) => {
                self.close_all();
                self.status = ProbeStatus::Waiting(reason);
            }
            BindPlan::Listen(desired) => {
                self.reconcile(desired);
            }
        }
        &self.status
    }

    fn reconcile(&mut self, desired: BTreeSet<SocketAddr>) {
        let stale = self
            .listeners
            .keys()
            .filter(|address| !desired.contains(address))
            .copied()
            .collect::<Vec<_>>();
        for address in stale {
            if let Some(listener) = self.listeners.remove(&address) {
                self.factory.close(address, listener);
            }
        }

        for address in desired
            .iter()
            .filter(|address| !self.listeners.contains_key(address))
            .copied()
            .collect::<Vec<_>>()
        {
            if address.ip().is_unspecified() {
                self.close_all();
                self.status = ProbeStatus::Error("refusing wildcard listener".to_string());
                return;
            }
            match self.factory.bind(address) {
                Ok(listener) => {
                    self.listeners.insert(address, listener);
                }
                Err(error) => {
                    self.close_all();
                    self.status = ProbeStatus::Error(format!("could not bind {address}: {error}"));
                    return;
                }
            }
        }

        self.status = ProbeStatus::Running(desired);
    }

    fn close_all(&mut self) {
        let listeners = std::mem::take(&mut self.listeners);
        for (address, listener) in listeners {
            self.factory.close(address, listener);
        }
    }
}

impl<Provider, Factory> Drop for ListenerProbe<Provider, Factory>
where
    Provider: InterfaceProvider,
    Factory: ListenerFactory,
{
    fn drop(&mut self) {
        self.close_all();
    }
}

fn print_interfaces(interfaces: &[InterfaceSnapshot]) {
    for interface in interfaces {
        println!(
            "{} label={:?} index={} state={:?} administrative_up={} running={} class={:?}",
            interface.id,
            interface.label,
            interface.index,
            interface.state,
            interface.administrative_up,
            interface.running,
            interface.class
        );
        for address in &interface.addresses {
            println!(
                "  {}/{} scope={:?} scope_id={} temporary={} deprecated={} tentative={} duplicated={}",
                address.address,
                address.prefix_length,
                address.scope,
                address.scope_id,
                address.temporary,
                address.deprecated,
                address.tentative,
                address.duplicated,
            );
        }
    }
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| "--port must be between 1 and 65535".to_string())?;
    if port == 0 {
        return Err("--port must be between 1 and 65535".to_string());
    }
    Ok(port)
}

fn parse_args() -> Result<(bool, BindTarget, u16, u64), String> {
    let mut list_only = false;
    let mut target = BindTarget::AllLocal;
    let mut port = 8080;
    let mut ticks = 1;
    let mut args = env::args().skip(1);

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--list" => list_only = true,
            "--target" => {
                let value = args
                    .next()
                    .ok_or("--target requires all or an interface name")?;
                target = if value == "all" {
                    BindTarget::AllLocal
                } else {
                    BindTarget::Selected(InterfaceId(value))
                };
            }
            "--port" => {
                port = parse_port(&args.next().ok_or("--port requires a number")?)?;
            }
            "--ticks" => {
                ticks = args
                    .next()
                    .ok_or("--ticks requires a number")?
                    .parse()
                    .map_err(|_| "--ticks must be a positive integer")?;
                if ticks == 0 {
                    return Err("--ticks must be a positive integer".to_string());
                }
            }
            _ => return Err(format!("unknown argument: {argument}")),
        }
    }

    Ok((list_only, target, port, ticks))
}

fn run() -> Result<(), String> {
    let (list_only, target, port, ticks) = parse_args()?;
    if list_only {
        let mut provider = NetdevProvider;
        let interfaces = provider.snapshot().map_err(|error| error.to_string())?;
        print_interfaces(&interfaces);
        return Ok(());
    }

    let mut probe = ListenerProbe::new(NetdevProvider, TcpListenerFactory, target, port);
    for tick in 0..ticks {
        let status = probe.tick().clone();
        println!("tick {}: {status:?}", tick + 1);
        if let ProbeStatus::Running(addresses) = status {
            for url in addresses.into_iter().filter_map(advertised_url) {
                println!("  {url}");
            }
        }
        if tick + 1 < ticks {
            thread::sleep(Duration::from_secs(1));
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!(
            "{error}\nusage: network_interface_spike [--list] [--target all|NAME] [--port PORT] [--ticks N]"
        );
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::VecDeque, rc::Rc};

    fn address(address: &str, prefix_length: u8) -> InterfaceAddress {
        let address = address.parse::<IpAddr>().unwrap();
        let scope = match address {
            IpAddr::V4(address) => ipv4_scope(address),
            IpAddr::V6(address) => ipv6_scope(address),
        };
        InterfaceAddress {
            address,
            prefix_length,
            scope,
            scope_id: 0,
            temporary: false,
            deprecated: false,
            tentative: false,
            duplicated: false,
        }
    }

    fn temporary_address(address_value: &str, prefix_length: u8) -> InterfaceAddress {
        let mut address = address(address_value, prefix_length);
        address.temporary = true;
        address
    }

    fn scoped_address(address_value: &str, prefix_length: u8, scope_id: u32) -> InterfaceAddress {
        let mut address = address(address_value, prefix_length);
        address.scope_id = scope_id;
        address
    }

    fn interface(
        id: &str,
        state: InterfaceState,
        class: InterfaceClass,
        addresses: &[(&str, u8)],
    ) -> InterfaceSnapshot {
        interface_with_addresses(
            id,
            state,
            class,
            addresses
                .iter()
                .map(|(value, prefix)| address(value, *prefix))
                .collect(),
        )
    }

    fn interface_with_addresses(
        id: &str,
        state: InterfaceState,
        class: InterfaceClass,
        addresses: Vec<InterfaceAddress>,
    ) -> InterfaceSnapshot {
        InterfaceSnapshot {
            id: InterfaceId(id.to_string()),
            index: 7,
            label: id.to_string(),
            administrative_up: state == InterfaceState::Up,
            running: state == InterfaceState::Up,
            state,
            class,
            addresses,
        }
    }

    struct SequenceProvider {
        snapshots: VecDeque<io::Result<Vec<InterfaceSnapshot>>>,
    }

    impl InterfaceProvider for SequenceProvider {
        fn snapshot(&mut self) -> io::Result<Vec<InterfaceSnapshot>> {
            self.snapshots
                .pop_front()
                .expect("test requested an unexpected snapshot")
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum ListenerEvent {
        Bind(SocketAddr),
        Close(SocketAddr),
    }

    struct FakeFactory {
        events: Rc<RefCell<Vec<ListenerEvent>>>,
        fail_on: Option<SocketAddr>,
    }

    impl ListenerFactory for FakeFactory {
        type Listener = ();

        fn bind(&mut self, address: SocketAddr) -> io::Result<Self::Listener> {
            self.events.borrow_mut().push(ListenerEvent::Bind(address));
            if self.fail_on == Some(address) {
                Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "injected bind failure",
                ))
            } else {
                Ok(())
            }
        }

        fn close(&mut self, address: SocketAddr, _listener: Self::Listener) {
            self.events.borrow_mut().push(ListenerEvent::Close(address));
        }
    }

    fn probe(
        snapshots: Vec<Vec<InterfaceSnapshot>>,
        target: BindTarget,
    ) -> (
        ListenerProbe<SequenceProvider, FakeFactory>,
        Rc<RefCell<Vec<ListenerEvent>>>,
    ) {
        let events = Rc::new(RefCell::new(Vec::new()));
        (
            ListenerProbe::new(
                SequenceProvider {
                    snapshots: snapshots.into_iter().map(Ok).collect(),
                },
                FakeFactory {
                    events: events.clone(),
                    fail_on: None,
                },
                target,
                8080,
            ),
            events,
        )
    }

    #[test]
    fn preserves_stable_name_and_friendly_label_while_classifying_lan() {
        let snapshot = snapshot_from_facts(InterfaceFacts {
            id: InterfaceId("en0".to_string()),
            index: 12,
            friendly_name: Some("Wi-Fi".to_string()),
            is_up: true,
            is_running: true,
            is_loopback: false,
            is_point_to_point: false,
            is_physical: true,
            kind: InterfaceType::Wireless80211,
            addresses: vec![address("192.168.1.20", 24), address("fe80::1", 64)],
        });

        assert_eq!(snapshot.id, InterfaceId("en0".to_string()));
        assert_eq!(snapshot.index, 12);
        assert_eq!(snapshot.label, "Wi-Fi");
        assert!(snapshot.administrative_up);
        assert!(snapshot.running);
        assert_eq!(snapshot.state, InterfaceState::Up);
        assert_eq!(snapshot.class, InterfaceClass::Lan);
        assert_eq!(snapshot.addresses[1].scope, AddressScope::LinkLocal);
    }

    #[test]
    fn classifies_loopback_vpn_and_virtual_interfaces_before_physical_fallback() {
        let facts = |id: &str, kind, point_to_point, physical| InterfaceFacts {
            id: InterfaceId(id.to_string()),
            index: 1,
            friendly_name: None,
            is_up: true,
            is_running: true,
            is_loopback: id == "lo0",
            is_point_to_point: point_to_point,
            is_physical: physical,
            kind,
            addresses: vec![address(
                if id == "lo0" { "127.0.0.1" } else { "10.0.0.2" },
                24,
            )],
        };

        assert_eq!(
            classify_interface(&facts("lo0", InterfaceType::Loopback, false, false)),
            InterfaceClass::Loopback
        );
        assert_eq!(
            classify_interface(&facts("utun4", InterfaceType::Ethernet, true, true)),
            InterfaceClass::Vpn
        );
        assert_eq!(
            classify_interface(&facts("docker0", InterfaceType::Ethernet, false, true)),
            InterfaceClass::Other
        );
        assert_eq!(
            classify_interface(&facts("vmenet0", InterfaceType::Ethernet, false, true)),
            InterfaceClass::Other
        );
        let mut addressless = facts("anpi0", InterfaceType::Unknown, false, false);
        addressless.addresses.clear();
        assert_eq!(classify_interface(&addressless), InterfaceClass::Other);
    }

    #[test]
    fn all_local_binds_every_usable_ipv4_global_and_ula_ipv6_address() {
        let interfaces = vec![
            interface_with_addresses(
                "en0",
                InterfaceState::Up,
                InterfaceClass::Lan,
                vec![
                    address("192.168.1.20", 24),
                    address("2001:db8::20", 64),
                    temporary_address("2001:db8::21", 64),
                    address("fd00::20", 64),
                    scoped_address("fe80::1", 64, 14),
                    address("ff02::1", 16),
                ],
            ),
            interface(
                "eth0",
                InterfaceState::Up,
                InterfaceClass::Lan,
                &[("10.0.0.10", 24)],
            ),
            interface(
                "utun4",
                InterfaceState::Up,
                InterfaceClass::Vpn,
                &[("100.80.0.2", 32)],
            ),
            interface(
                "lo0",
                InterfaceState::Up,
                InterfaceClass::Loopback,
                &[("127.0.0.1", 8)],
            ),
        ];

        let BindPlan::Listen(addresses) = plan_bindings(&interfaces, &BindTarget::AllLocal, 8080)
        else {
            panic!("expected listeners");
        };
        assert_eq!(
            addresses,
            [
                "10.0.0.10:8080".parse().unwrap(),
                "192.168.1.20:8080".parse().unwrap(),
                "[2001:db8::20]:8080".parse().unwrap(),
                "[2001:db8::21]:8080".parse().unwrap(),
                "[fd00::20]:8080".parse().unwrap(),
            ]
            .into_iter()
            .collect()
        );
        assert!(addresses
            .iter()
            .all(|address| !address.ip().is_unspecified()));
    }

    #[test]
    fn advertised_urls_bracket_ipv6_literals() {
        assert_eq!(
            advertised_url("192.168.1.20:8080".parse().unwrap()),
            Some("http://192.168.1.20:8080/opds".to_string())
        );
        assert_eq!(
            advertised_url("[2001:db8::20]:8080".parse().unwrap()),
            Some("http://[2001:db8::20]:8080/opds".to_string())
        );
        assert_eq!(
            advertised_url("[fd00::20]:8080".parse().unwrap()),
            Some("http://[fd00::20]:8080/opds".to_string())
        );
    }

    #[test]
    fn configured_port_must_not_be_ephemeral() {
        assert_eq!(parse_port("8080"), Ok(8080));
        assert!(parse_port("0").is_err());
        assert!(parse_port("65536").is_err());
    }

    #[test]
    fn link_local_scope_id_is_retained_for_diagnostics_but_not_advertised() {
        let address = scoped_address("fe80::1", 64, 14);
        let socket = scoped_link_local_socket(&address, 8080).unwrap();

        assert_eq!(socket.to_string(), "[fe80::1%14]:8080");
        assert_eq!(advertised_url(socket), None);
        assert!(interface_with_addresses(
            "en0",
            InterfaceState::Up,
            InterfaceClass::Lan,
            vec![address],
        )
        .bindable_addresses(8080)
        .is_empty());
    }

    #[test]
    fn unusable_ipv6_address_states_are_not_bound() {
        let mut deprecated = address("2001:db8::40", 64);
        deprecated.deprecated = true;
        let mut tentative = address("2001:db8::41", 64);
        tentative.tentative = true;
        let mut duplicated = address("2001:db8::42", 64);
        duplicated.duplicated = true;

        assert!(interface_with_addresses(
            "en0",
            InterfaceState::Up,
            InterfaceClass::Lan,
            vec![deprecated, tentative, duplicated],
        )
        .bindable_addresses(8080)
        .is_empty());
    }

    #[test]
    fn explicitly_selected_vpn_is_allowed() {
        let interfaces = vec![interface(
            "wg0",
            InterfaceState::Up,
            InterfaceClass::Vpn,
            &[("10.8.0.4", 24)],
        )];

        assert_eq!(
            plan_bindings(
                &interfaces,
                &BindTarget::Selected(InterfaceId("wg0".to_string())),
                8080
            ),
            BindPlan::Listen(["10.8.0.4:8080".parse().unwrap()].into_iter().collect())
        );
    }

    #[test]
    fn selected_interface_disappearance_closes_then_recovers_without_widening() {
        let selected = BindTarget::Selected(InterfaceId("en0".to_string()));
        let (mut probe, events) = probe(
            vec![
                vec![interface(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    &[("192.168.1.20", 24)],
                )],
                vec![],
                vec![interface(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    &[("192.168.1.45", 24)],
                )],
            ],
            selected,
        );

        assert!(matches!(probe.tick(), ProbeStatus::Running(_)));
        assert!(matches!(
            probe.tick(),
            ProbeStatus::Waiting(WaitingReason::SelectedInterfaceMissing(_))
        ));
        assert!(matches!(probe.tick(), ProbeStatus::Running(_)));
        assert_eq!(
            *events.borrow(),
            vec![
                ListenerEvent::Bind("192.168.1.20:8080".parse().unwrap()),
                ListenerEvent::Close("192.168.1.20:8080".parse().unwrap()),
                ListenerEvent::Bind("192.168.1.45:8080".parse().unwrap()),
            ]
        );
        assert!(events.borrow().iter().all(|event| match event {
            ListenerEvent::Bind(address) | ListenerEvent::Close(address) =>
                !address.ip().is_unspecified(),
        }));
    }

    #[test]
    fn selected_interface_down_waits_without_falling_back_to_another_lan() {
        let interfaces = vec![
            interface(
                "en0",
                InterfaceState::Down,
                InterfaceClass::Lan,
                &[("192.168.1.20", 24)],
            ),
            interface(
                "en1",
                InterfaceState::Up,
                InterfaceClass::Lan,
                &[("10.0.0.10", 24)],
            ),
        ];

        assert_eq!(
            plan_bindings(
                &interfaces,
                &BindTarget::Selected(InterfaceId("en0".to_string())),
                8080
            ),
            BindPlan::Wait(WaitingReason::SelectedInterfaceDown(InterfaceId(
                "en0".to_string()
            )))
        );
    }

    #[test]
    fn address_change_closes_stale_listener_before_opening_replacement() {
        let (mut probe, events) = probe(
            vec![
                vec![interface(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    &[("192.168.1.20", 24)],
                )],
                vec![interface(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    &[("192.168.1.45", 24)],
                )],
            ],
            BindTarget::Selected(InterfaceId("en0".to_string())),
        );

        probe.tick();
        probe.tick();

        assert_eq!(
            *events.borrow(),
            vec![
                ListenerEvent::Bind("192.168.1.20:8080".parse().unwrap()),
                ListenerEvent::Close("192.168.1.20:8080".parse().unwrap()),
                ListenerEvent::Bind("192.168.1.45:8080".parse().unwrap()),
            ]
        );
    }

    #[test]
    fn temporary_ipv6_rotation_reconciles_without_restarting_stable_address() {
        let (mut probe, events) = probe(
            vec![
                vec![interface_with_addresses(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    vec![
                        address("2001:db8::20", 64),
                        temporary_address("2001:db8::30", 64),
                    ],
                )],
                vec![interface_with_addresses(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    vec![
                        address("2001:db8::20", 64),
                        temporary_address("2001:db8::31", 64),
                    ],
                )],
            ],
            BindTarget::Selected(InterfaceId("en0".to_string())),
        );

        probe.tick();
        probe.tick();

        assert_eq!(
            *events.borrow(),
            vec![
                ListenerEvent::Bind("[2001:db8::20]:8080".parse().unwrap()),
                ListenerEvent::Bind("[2001:db8::30]:8080".parse().unwrap()),
                ListenerEvent::Close("[2001:db8::30]:8080".parse().unwrap()),
                ListenerEvent::Bind("[2001:db8::31]:8080".parse().unwrap()),
            ]
        );
    }

    #[test]
    fn ipv6_only_interface_disappearance_fails_closed_then_recovers() {
        let selected = BindTarget::Selected(InterfaceId("en0".to_string()));
        let (mut probe, events) = probe(
            vec![
                vec![interface(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    &[("fd00::20", 64)],
                )],
                vec![interface(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    &[("fe80::1", 64)],
                )],
                vec![interface(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    &[("fd00::45", 64)],
                )],
            ],
            selected,
        );

        assert!(matches!(probe.tick(), ProbeStatus::Running(_)));
        assert!(matches!(
            probe.tick(),
            ProbeStatus::Waiting(WaitingReason::SelectedInterfaceHasNoUsableAddress(_))
        ));
        assert!(matches!(probe.tick(), ProbeStatus::Running(_)));
        assert_eq!(
            *events.borrow(),
            vec![
                ListenerEvent::Bind("[fd00::20]:8080".parse().unwrap()),
                ListenerEvent::Close("[fd00::20]:8080".parse().unwrap()),
                ListenerEvent::Bind("[fd00::45]:8080".parse().unwrap()),
            ]
        );
    }

    #[test]
    fn enumeration_error_closes_existing_listener() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let mut probe = ListenerProbe::new(
            SequenceProvider {
                snapshots: [
                    Ok(vec![interface(
                        "en0",
                        InterfaceState::Up,
                        InterfaceClass::Lan,
                        &[("192.168.1.20", 24)],
                    )]),
                    Err(io::Error::other("injected enumeration failure")),
                ]
                .into_iter()
                .collect(),
            },
            FakeFactory {
                events: events.clone(),
                fail_on: None,
            },
            BindTarget::AllLocal,
            8080,
        );

        probe.tick();
        assert_eq!(
            probe.tick(),
            &ProbeStatus::Error(
                "interface enumeration failed: injected enumeration failure".to_string()
            )
        );
        assert!(probe.listeners.is_empty());
        assert_eq!(
            *events.borrow(),
            vec![
                ListenerEvent::Bind("192.168.1.20:8080".parse().unwrap()),
                ListenerEvent::Close("192.168.1.20:8080".parse().unwrap()),
            ]
        );
    }

    #[test]
    fn bind_failure_closes_every_listener_and_reports_error() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let failing_address = "192.168.1.21:8080".parse().unwrap();
        let mut probe = ListenerProbe::new(
            SequenceProvider {
                snapshots: [Ok(vec![interface(
                    "en0",
                    InterfaceState::Up,
                    InterfaceClass::Lan,
                    &[("192.168.1.20", 24), ("192.168.1.21", 24)],
                )])]
                .into_iter()
                .collect(),
            },
            FakeFactory {
                events: events.clone(),
                fail_on: Some(failing_address),
            },
            BindTarget::AllLocal,
            8080,
        );

        assert_eq!(
            probe.tick(),
            &ProbeStatus::Error(format!(
                "could not bind {failing_address}: injected bind failure"
            ))
        );
        assert!(probe.listeners.is_empty());
        assert_eq!(
            *events.borrow(),
            vec![
                ListenerEvent::Bind("192.168.1.20:8080".parse().unwrap()),
                ListenerEvent::Bind(failing_address),
                ListenerEvent::Close("192.168.1.20:8080".parse().unwrap()),
            ]
        );
    }
}
