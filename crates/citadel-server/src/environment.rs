//! Settings from `CITADEL_*` environment variables, for containers and for
//! anyone without a config file. Every setting has a default, so the server
//! starts with none set. A config file, when one is given, is used alone.
use std::net::SocketAddr;

use toml::{map::Map, Value};

use crate::ServerConfig;

/// Points at a config file to use instead of the environment.
pub const CONFIG_FILE: &str = "CITADEL_CONFIG";

pub const LISTEN: &str = "CITADEL_LISTEN";
pub const PUBLIC_URLS: &str = "CITADEL_PUBLIC_URLS";
pub const OPDS_PORT: &str = "CITADEL_OPDS_PORT";
pub const OPDS_ADDRESSES: &str = "CITADEL_OPDS_ADDRESSES";
pub const STATE_DIRECTORY: &str = "CITADEL_STATE_DIRECTORY";
pub const WEB_DIRECTORY: &str = "CITADEL_WEB_DIRECTORY";
pub const UPDATE_CHECK: &str = "CITADEL_UPDATE_CHECK";
pub const LIBRARY_ROOTS: &str = "CITADEL_LIBRARY_ROOTS";
pub const TRUSTED_PROXIES: &str = "CITADEL_TRUSTED_PROXIES";

/// The variables that configure the server.
pub const SETTINGS: &[&str] = &[
    LISTEN,
    PUBLIC_URLS,
    OPDS_PORT,
    OPDS_ADDRESSES,
    STATE_DIRECTORY,
    WEB_DIRECTORY,
    UPDATE_CHECK,
    LIBRARY_ROOTS,
    TRUSTED_PROXIES,
];

/// `CITADEL_*` variables that mean something elsewhere: the config file,
/// build-time overrides, and the web app's development proxy.
const NOT_SETTINGS: &[&str] = &[
    CONFIG_FILE,
    "CITADEL_VERSION",
    "CITADEL_BUILD_COMMIT",
    "CITADEL_API_URL",
];

const DEFAULT_LISTEN: &str = "127.0.0.1:8081";
const DEFAULT_OPDS_PORT: u16 = 8080;

/// The server's settings from `var`, which looks a variable up.
pub fn config_from(var: impl Fn(&str) -> Option<String>) -> Result<ServerConfig, String> {
    let var = |name: &str| {
        var(name)
            .map(|value| value.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let listen_text = var(LISTEN).unwrap_or_else(|| DEFAULT_LISTEN.into());
    let listen: SocketAddr = listen_text.parse().map_err(|_| {
        format!("{LISTEN} must be an address and port, such as 0.0.0.0:8081 (got {listen_text:?})")
    })?;
    let opds_port = match var(OPDS_PORT) {
        Some(text) => text
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| format!("{OPDS_PORT} must be a port from 1 to 65535 (got {text:?})"))?,
        None => DEFAULT_OPDS_PORT,
    };
    let target = match var(OPDS_ADDRESSES).as_deref() {
        None => addresses(&["127.0.0.1".into()]),
        Some("all") => Value::String("allInterfaces".into()),
        Some("local") => Value::String("localNetworks".into()),
        Some(list) => addresses(
            &list
                .split(',')
                .map(|address| address.trim().to_string())
                .filter(|address| !address.is_empty())
                .collect::<Vec<_>>(),
        ),
    };

    let mut api = Map::new();
    api.insert("listen".into(), Value::String(listen.to_string()));
    if let Some(list) = var(PUBLIC_URLS) {
        api.insert("publicUrls".into(), list_value(&list));
    }
    if let Some(list) = var(TRUSTED_PROXIES) {
        api.insert("trustedProxies".into(), list_value(&list));
    }
    if let Some(directory) = var(WEB_DIRECTORY) {
        api.insert("webDirectory".into(), Value::String(directory));
    }
    let mut sharing = Map::new();
    sharing.insert("port".into(), Value::Integer(opds_port.into()));
    sharing.insert("target".into(), target);
    let mut root = Map::new();
    root.insert("api".into(), Value::Table(api));
    root.insert("sharing".into(), Value::Table(sharing));
    if let Some(directory) = var(STATE_DIRECTORY) {
        root.insert("stateDirectory".into(), Value::String(directory));
    }
    if let Some(list) = var(LIBRARY_ROOTS) {
        root.insert("libraryRoots".into(), list_value(&list));
    }
    if let Some(text) = var(UPDATE_CHECK) {
        let check = match text.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => {
                return Err(format!(
                    "{UPDATE_CHECK} must be true or false (got {text:?})"
                ))
            }
        };
        let mut updates = Map::new();
        updates.insert("check".into(), Value::Boolean(check));
        root.insert("updates".into(), Value::Table(updates));
    }
    let config: ServerConfig = Value::Table(root)
        .try_into()
        .map_err(|error| format!("could not read settings from the environment: {error}"))?;
    crate::validate_config(&config).map_err(|error| in_variable_terms(&error))?;
    Ok(config)
}

/// `[sharing.target.addresses] addresses = [...]`.
fn addresses(list: &[String]) -> Value {
    let mut inner = Map::new();
    inner.insert(
        "addresses".into(),
        Value::Array(list.iter().cloned().map(Value::String).collect()),
    );
    let mut target = Map::new();
    target.insert("addresses".into(), Value::Table(inner));
    Value::Table(target)
}

/// A comma-separated list.
/// A list separated by commas, spaces or newlines, so a YAML block scalar
/// in a Compose file works too.
fn list_value(list: &str) -> Value {
    Value::Array(
        list.split(|character: char| character == ',' || character.is_whitespace())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| Value::String(item.into()))
            .collect(),
    )
}

/// Validation speaks in config-file keys; name the variable instead.
fn in_variable_terms(error: &str) -> String {
    [
        ("api.listen", LISTEN),
        ("api.publicUrls", PUBLIC_URLS),
        ("api.trustedProxies", TRUSTED_PROXIES),
        ("api.webDirectory", WEB_DIRECTORY),
        ("stateDirectory", STATE_DIRECTORY),
        ("sharing.port", OPDS_PORT),
        ("libraryRoots", LIBRARY_ROOTS),
    ]
    .iter()
    .fold(error.to_string(), |message, (key, variable)| {
        message.replace(key, variable)
    })
}

/// Names of `CITADEL_*` variables that configure nothing, likely typos.
pub fn unrecognized(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut unknown: Vec<String> = names
        .filter(|name| name.starts_with("CITADEL_"))
        .filter(|name| !SETTINGS.contains(&name.as_str()) && !NOT_SETTINGS.contains(&name.as_str()))
        .collect();
    unknown.sort();
    unknown
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use citadel_opds::OpdsBindTarget;

    use super::*;

    /// `path` written as an absolute path on this platform.
    fn absolute(path: &str) -> String {
        if cfg!(windows) {
            format!("C:{}", path.replace('/', "\\"))
        } else {
            path.to_string()
        }
    }

    fn settings(vars: &[(&str, &str)]) -> Result<ServerConfig, String> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        config_from(|name| vars.get(name).cloned())
    }

    #[test]
    fn nothing_set_is_a_server_on_this_machine() {
        let config = settings(&[]).unwrap();
        assert_eq!(config.api.listen.to_string(), "127.0.0.1:8081");
        assert!(
            config.api.public_urls.is_empty(),
            "no address until the first administrator's"
        );
        assert!(config.api.trusted_proxies.is_none());
        assert_eq!(config.sharing.port, 8080);
        assert_eq!(
            config.sharing.target,
            OpdsBindTarget::Addresses {
                addresses: vec!["127.0.0.1".into()]
            }
        );
        assert!(config.state_directory.is_none());
        assert!(config.api.web_directory.is_none());
        assert!(config.updates.check.is_none());
    }

    #[test]
    fn a_container_listens_everywhere_and_is_reached_at_localhost_by_default() {
        let state = absolute("/var/lib/citadel");
        let config = settings(&[
            (LISTEN, "0.0.0.0:8081"),
            (OPDS_ADDRESSES, "all"),
            (STATE_DIRECTORY, &state),
            (UPDATE_CHECK, "off"),
            (
                LIBRARY_ROOTS,
                &format!("{}, {}", absolute("/library"), absolute("/libraries")),
            ),
        ])
        .unwrap();
        assert_eq!(
            config.library_roots,
            vec![
                std::path::PathBuf::from(absolute("/library")),
                std::path::PathBuf::from(absolute("/libraries"))
            ]
        );
        assert!(config.api.public_urls.is_empty());
        assert_eq!(config.sharing.target, OpdsBindTarget::AllInterfaces);
        assert_eq!(
            config.state_directory.as_deref(),
            Some(std::path::Path::new(&state))
        );
        assert_eq!(config.updates.check, Some(false));
    }

    #[test]
    fn each_setting_is_read() {
        let config = settings(&[
            (LISTEN, "127.0.0.1:9000"),
            (
                PUBLIC_URLS,
                " https://books.example.com ,\n http://nas.local:8081  http://192.168.1.20:8081",
            ),
            (TRUSTED_PROXIES, "172.18.0.0/16"),
            (OPDS_PORT, "9001"),
            (OPDS_ADDRESSES, "127.0.0.1, ::1"),
            (UPDATE_CHECK, "TRUE"),
        ])
        .unwrap();
        assert_eq!(
            config.api.public_urls,
            vec![
                "https://books.example.com",
                "http://nas.local:8081",
                "http://192.168.1.20:8081"
            ]
        );
        assert_eq!(
            config.api.trusted_proxies,
            Some(vec!["172.18.0.0/16".to_string()])
        );
        assert_eq!(config.sharing.port, 9001);
        assert_eq!(
            config.sharing.target,
            OpdsBindTarget::Addresses {
                addresses: vec!["127.0.0.1".into(), "::1".into()]
            }
        );
        assert_eq!(config.updates.check, Some(true));
        assert_eq!(
            settings(&[(OPDS_ADDRESSES, "local")])
                .unwrap()
                .sharing
                .target,
            OpdsBindTarget::LocalNetworks
        );
    }

    #[test]
    fn mistakes_name_the_variable() {
        for (vars, expected) in [
            (vec![(LISTEN, "8081")], LISTEN),
            (vec![(LISTEN, "0.0.0.0:0")], LISTEN),
            (vec![(PUBLIC_URLS, "books.example.com")], PUBLIC_URLS),
            (vec![(TRUSTED_PROXIES, "the proxy")], TRUSTED_PROXIES),
            (vec![(OPDS_PORT, "0")], OPDS_PORT),
            (vec![(OPDS_PORT, "eighty")], OPDS_PORT),
            (vec![(UPDATE_CHECK, "maybe")], UPDATE_CHECK),
            (vec![(STATE_DIRECTORY, "relative/state")], STATE_DIRECTORY),
            (vec![(WEB_DIRECTORY, "/no/such/web/build")], WEB_DIRECTORY),
            (vec![(LIBRARY_ROOTS, "/library,books")], LIBRARY_ROOTS),
        ] {
            let error = settings(&vars).unwrap_err();
            assert!(error.contains(expected), "{vars:?}: {error}");
        }
    }

    #[test]
    fn misspelled_variables_are_noticed() {
        let names = [
            "CITADEL_PUBLICURL",
            "CITADEL_PUBLIC_URL",
            "CITADEL_PUBLIC_URLS",
            "CITADEL_CONFIG",
            "CITADEL_VERSION",
            "PATH",
            "CITADEL_OPDS_PORTS",
        ];
        assert_eq!(
            unrecognized(names.iter().map(|name| name.to_string())),
            vec![
                "CITADEL_OPDS_PORTS",
                "CITADEL_PUBLICURL",
                "CITADEL_PUBLIC_URL"
            ]
        );
    }
}
