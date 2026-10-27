//! Operator commands against `citadel.db`. They run in their own process and
//! never need the server stopped: a running server picks up OPDS changes
//! within seconds and checks sessions and grants on every request.
use std::io::BufRead;

use citadel_core::{
    password::generate_sign_in_password,
    store::{CitadelStore, RegisteredLibrary},
};

use crate::ServerConfig;

pub const USAGE: &str = "commands:
  users list
  users add <name> [--password-stdin] [--no-grant]
  users remove <name>
  users reset-password <name> [--password-stdin]
  users app-password <name> [--rotate]
  grant <name> [<library-id>]
  revoke <name> [<library-id>]
  libraries list

Without a command, the server starts. Generated passwords are printed once;
--password-stdin reads the sign-in password from the first line of stdin.";

/// Runs one command and returns what to print.
pub fn run(config: &ServerConfig, args: &[String], stdin: impl BufRead) -> Result<String, String> {
    crate::validate_config(config)?;
    let source = crate::CalibreCatalogSource::open(&config.library_path)?;
    let (accounts, library) = crate::open_accounts(config, &source)?;
    execute(&accounts, &library, args, stdin)
}

fn execute(
    accounts: &CitadelStore,
    library: &RegisteredLibrary,
    args: &[String],
    stdin: impl BufRead,
) -> Result<String, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let flag = |name: &str| args.contains(&name);
    let error = |error: citadel_core::store::StoreError| error.to_string();
    let positional: Vec<&str> = args
        .iter()
        .copied()
        .filter(|arg| !arg.starts_with("--"))
        .collect();
    let known_flags: &[&str] = match positional.as_slice() {
        ["users", "add", _] => &["--password-stdin", "--no-grant"],
        ["users", "reset-password", _] => &["--password-stdin"],
        ["users", "app-password", _] => &["--rotate"],
        _ => &[],
    };
    if let Some(unknown) = args
        .iter()
        .find(|arg| arg.starts_with("--") && !known_flags.contains(arg))
    {
        return Err(format!("unknown option {unknown}\n\n{USAGE}"));
    }
    let password = |stdin: std::io::Lines<_>| -> Result<(String, bool), String> {
        if flag("--password-stdin") {
            read_password(stdin).map(|password| (password, false))
        } else {
            Ok((generate_sign_in_password(), true))
        }
    };

    match positional.as_slice() {
        ["users", "list"] => {
            let users = accounts.users().map_err(error)?;
            if users.is_empty() {
                return Ok("No users. Create one with `users add <name>`.".into());
            }
            Ok(users
                .iter()
                .map(|summary| {
                    let access = if summary.library_ids.contains(&library.id) {
                        "has access"
                    } else {
                        "no access"
                    };
                    format!("{}\t{}\t{access}", summary.user.username, summary.user.id)
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        ["users", "add", name] => {
            let (password, generated) = password(stdin.lines())?;
            let user = accounts.create_user(name, &password).map_err(error)?;
            let access = if flag("--no-grant") {
                "No library access yet; run `grant` to add it.".to_string()
            } else {
                accounts.grant(&user.username, &library.id).map_err(error)?;
                format!("Granted access to library {}.", library.id)
            };
            let app = accounts
                .rotate_app_password(&user.username)
                .map_err(error)?;
            let mut output = vec![
                format!("Created user {} ({}).", user.username, user.id),
                access,
            ];
            if generated {
                output.push(format!("Sign-in password: {password}"));
            }
            output.push(format!("OPDS app password: {}", app.password));
            Ok(output.join("\n"))
        }
        ["users", "remove", name] => {
            accounts.remove_user(name).map_err(error)?;
            Ok(format!(
                "Removed user {name}; their sessions and app password stop working."
            ))
        }
        ["users", "reset-password", name] => {
            let (password, generated) = password(stdin.lines())?;
            accounts.set_password(name, &password).map_err(error)?;
            let mut output = format!("Reset the sign-in password for {name} and signed them out.");
            if generated {
                output.push_str(&format!("\nSign-in password: {password}"));
            }
            Ok(output)
        }
        ["users", "app-password", name] => {
            let existing = if flag("--rotate") {
                None
            } else {
                accounts.app_password(name).map_err(error)?
            };
            let credential = match existing {
                Some(credential) => credential,
                None => accounts.rotate_app_password(name).map_err(error)?,
            };
            Ok(format!(
                "OPDS username: {}\nOPDS app password: {}",
                credential.username, credential.password
            ))
        }
        ["grant", name, rest @ ..] if rest.len() <= 1 => {
            let library_id = rest.first().copied().unwrap_or(&library.id);
            accounts.grant(name, library_id).map_err(error)?;
            Ok(format!("{name} can now access library {library_id}."))
        }
        ["revoke", name, rest @ ..] if rest.len() <= 1 => {
            let library_id = rest.first().copied().unwrap_or(&library.id);
            accounts.revoke(name, library_id).map_err(error)?;
            Ok(format!("{name} can no longer access library {library_id}."))
        }
        ["libraries", "list"] => Ok(accounts
            .libraries()
            .map_err(error)?
            .iter()
            .map(|registered| format!("{}\t{}", registered.id, registered.path))
            .collect::<Vec<_>>()
            .join("\n")),
        _ => Err(format!("unknown command\n\n{USAGE}")),
    }
}

fn read_password<B: BufRead>(mut lines: std::io::Lines<B>) -> Result<String, String> {
    let line = lines
        .next()
        .transpose()
        .map_err(|error| format!("could not read password from stdin: {error}"))?
        .ok_or("--password-stdin expects a password on stdin")?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, CitadelStore, RegisteredLibrary) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("library")).unwrap();
        let accounts = CitadelStore::open(&directory.path().join("citadel.db")).unwrap();
        let library = accounts
            .register_library(
                "calibre-library-uuid",
                &directory.path().join("library"),
                None,
            )
            .unwrap();
        (directory, accounts, library)
    }

    fn command(
        accounts: &CitadelStore,
        library: &RegisteredLibrary,
        line: &str,
        stdin: &str,
    ) -> Result<String, String> {
        let args: Vec<String> = line.split_whitespace().map(String::from).collect();
        execute(accounts, library, &args, stdin.as_bytes())
    }

    #[test]
    fn add_grants_the_configured_library_and_prints_generated_passwords_once() {
        let (_directory, accounts, library) = fixture();
        let output = command(&accounts, &library, "users add alice", "").unwrap();
        let password = output
            .lines()
            .find_map(|line| line.strip_prefix("Sign-in password: "))
            .unwrap();
        let alice = accounts
            .verify_password("alice", password)
            .unwrap()
            .unwrap();
        assert!(accounts.can_access(&alice.id, &library.id).unwrap());
        let app = accounts.app_password("alice").unwrap().unwrap();
        assert!(output.contains(&app.password));
        let listed = command(&accounts, &library, "users list", "").unwrap();
        assert!(listed.contains("alice") && listed.contains("has access"));
        assert!(!listed.contains(password));
    }

    #[test]
    fn passwords_can_come_from_stdin_and_resets_sign_users_out() {
        let (_directory, accounts, library) = fixture();
        let output = command(
            &accounts,
            &library,
            "users add kid --password-stdin --no-grant",
            "chosen password\n",
        )
        .unwrap();
        assert!(!output.contains("Sign-in password"));
        let kid = accounts
            .verify_password("kid", "chosen password")
            .unwrap()
            .unwrap();
        assert!(!accounts.can_access(&kid.id, &library.id).unwrap());
        let session = accounts.create_session(&kid.id).unwrap();
        command(&accounts, &library, "users reset-password kid", "").unwrap();
        assert!(accounts.session_user(&session).unwrap().is_none());
        assert!(accounts
            .verify_password("kid", "chosen password")
            .unwrap()
            .is_none());
        command(&accounts, &library, "grant kid", "").unwrap();
        assert!(accounts.can_access(&kid.id, &library.id).unwrap());
        command(
            &accounts,
            &library,
            &format!("revoke kid {}", library.id),
            "",
        )
        .unwrap();
        assert!(!accounts.can_access(&kid.id, &library.id).unwrap());
    }

    #[test]
    fn app_passwords_reveal_and_rotate() {
        let (_directory, accounts, library) = fixture();
        command(&accounts, &library, "users add alice", "").unwrap();
        let revealed = command(&accounts, &library, "users app-password alice", "").unwrap();
        assert_eq!(
            revealed,
            command(&accounts, &library, "users app-password alice", "").unwrap()
        );
        let rotated =
            command(&accounts, &library, "users app-password alice --rotate", "").unwrap();
        assert_ne!(revealed, rotated);
    }

    #[test]
    fn unknown_commands_options_and_users_are_errors() {
        let (_directory, accounts, library) = fixture();
        for line in [
            "users",
            "users add",
            "users add alice --rotate",
            "users remove nobody",
            "grant nobody",
            "frobnicate",
        ] {
            assert!(command(&accounts, &library, line, "").is_err(), "{line}");
        }
        assert!(command(&accounts, &library, "users add alice --password-stdin", "").is_err());
        assert!(command(&accounts, &library, "libraries list", "")
            .unwrap()
            .contains(&library.id));
    }
}
