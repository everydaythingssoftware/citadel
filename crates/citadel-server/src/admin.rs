//! Operator commands against `citadel.db`. They run in their own process and
//! never need the server stopped: a running server picks up OPDS changes
//! within seconds and checks sessions and grants on every request. The
//! browser does the same jobs for administrators; the CLI remains for
//! scripts and for getting back in when nobody can sign in.
use std::io::BufRead;

use citadel_core::{
    password::generate_sign_in_password,
    store::{CitadelStore, RegisteredLibrary, Role},
};
use libcalibre::Library;

use crate::ServerConfig;

pub const USAGE: &str = "commands:
  users list
  users add <name> [--password-stdin] [--no-grant] [--admin]
  users remove <name>
  users reset-password <name> [--password-stdin]
  users app-password <name> [--rotate]
  users promote <name>
  users demote <name>
  grant <name> [<library-id>]
  revoke <name> [<library-id>]
  libraries list
  libraries add <absolute path> [--read-only]
  libraries read-only <on|off> [<library-id>]

Without a command, the server starts. Generated passwords are printed once;
--password-stdin reads the sign-in password from the first line of stdin.
Administrators set the server up in the browser; `users promote` is the way
back in when none can sign in.";

/// Runs one command and returns what to print.
pub fn run(config: &ServerConfig, args: &[String], stdin: impl BufRead) -> Result<String, String> {
    let (_, accounts) = crate::open_accounts(config)?;
    let library = accounts
        .active_library()
        .map_err(|error| error.to_string())?;
    execute(&accounts, library.as_ref(), args, stdin)
}

fn execute(
    accounts: &CitadelStore,
    library: Option<&RegisteredLibrary>,
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
        ["users", "add", _] => &["--password-stdin", "--no-grant", "--admin"],
        ["users", "reset-password", _] => &["--password-stdin"],
        ["users", "app-password", _] => &["--rotate"],
        ["libraries", "add", _] => &["--read-only"],
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
    let served = || {
        library.map(|library| library.id.as_str()).ok_or_else(|| {
            "No library is set up yet. Set one up in the browser or run `libraries add <path>`."
                .to_string()
        })
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
                    let access = match library {
                        Some(library) if summary.library_ids.contains(&library.id) => "has access",
                        Some(_) => "no access",
                        None => "no library yet",
                    };
                    format!(
                        "{}\t{}\t{}\t{access}",
                        summary.user.username,
                        summary.user.id,
                        summary.user.role.as_str()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        ["users", "add", name] => {
            let (password, generated) = password(stdin.lines())?;
            let role = if flag("--admin") {
                Role::Administrator
            } else {
                Role::Reader
            };
            let user = accounts
                .create_user_with_role(name, &password, role)
                .map_err(error)?;
            let access = match (flag("--no-grant"), library) {
                (true, _) => "No library access yet; run `grant` to add it.".to_string(),
                (false, Some(library)) => {
                    accounts.grant(&user.username, &library.id).map_err(error)?;
                    format!("Granted access to library {}.", library.id)
                }
                (false, None) => {
                    "No library is set up yet; access is granted when one is.".to_string()
                }
            };
            let app = accounts
                .rotate_app_password(&user.username)
                .map_err(error)?;
            let mut output = vec![
                format!(
                    "Created {} {} ({}).",
                    user.role.as_str(),
                    user.username,
                    user.id
                ),
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
        ["users", "promote", name] => {
            let user = accounts
                .set_role(name, Role::Administrator)
                .map_err(error)?;
            Ok(format!("{} is now an administrator.", user.username))
        }
        ["users", "demote", name] => {
            let user = accounts.set_role(name, Role::Reader).map_err(error)?;
            Ok(format!("{} is now a reader.", user.username))
        }
        ["grant", name, rest @ ..] if rest.len() <= 1 => {
            let library_id = match rest.first() {
                Some(id) => id,
                None => served()?,
            };
            accounts.grant(name, library_id).map_err(error)?;
            Ok(format!("{name} can now access library {library_id}."))
        }
        ["revoke", name, rest @ ..] if rest.len() <= 1 => {
            let library_id = match rest.first() {
                Some(id) => id,
                None => served()?,
            };
            accounts.revoke(name, library_id).map_err(error)?;
            Ok(format!("{name} can no longer access library {library_id}."))
        }
        ["libraries", "list"] => {
            let libraries = accounts.libraries().map_err(error)?;
            if libraries.is_empty() {
                return Ok(
                    "No libraries. Set one up in the browser or run `libraries add <path>`.".into(),
                );
            }
            Ok(libraries
                .iter()
                .map(|registered| {
                    let served = if library.is_some_and(|served| served.id == registered.id) {
                        "\tserved"
                    } else {
                        ""
                    };
                    let read_only = if registered.read_only {
                        "\tread-only"
                    } else {
                        ""
                    };
                    format!(
                        "{}\t{}\t{}{served}{read_only}",
                        registered.id, registered.display_name, registered.path
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        ["libraries", "add", path] => {
            if let Some(library) = library {
                return Err(format!(
                    "This server already serves {} at {}; one library at a time for now.",
                    library.display_name, library.path
                ));
            }
            let root = std::path::Path::new(path);
            if !root.is_absolute() {
                return Err("libraries add needs an absolute path".into());
            }
            let database = libcalibre::util::get_db_path(path)
                .ok_or_else(|| format!("No Calibre library at {path} (no metadata.db inside)."))?;
            let id = Library::open_read_only(database)
                .and_then(|mut library| library.library_uuid())
                .map_err(|error| format!("Could not read the library at {path}: {error}"))?;
            let registered = accounts
                .register_library(&id, root, None)
                .and_then(|library| {
                    accounts.set_library_read_only(&library.id, flag("--read-only"))
                })
                .and_then(|library| accounts.set_active_library(&library.id))
                .map_err(error)?;
            let how = if registered.read_only {
                " read-only"
            } else {
                ""
            };
            Ok(format!(
                "Serving {} ({}){how} from {}. Give readers access with `grant <name>`.",
                registered.display_name, registered.id, registered.path
            ))
        }
        ["libraries", "read-only", setting, rest @ ..] if rest.len() <= 1 => {
            let read_only = match *setting {
                "on" => true,
                "off" => false,
                _ => return Err(format!("libraries read-only takes on or off\n\n{USAGE}")),
            };
            let library_id = match rest.first() {
                Some(id) => *id,
                None => library
                    .map(|library| library.id.as_str())
                    .ok_or("No library is set up yet.")?,
            };
            let registered = accounts
                .set_library_read_only(library_id, read_only)
                .map_err(error)?;
            Ok(format!(
                "{} is {}. Restart the server for it to take effect.",
                registered.display_name,
                if read_only {
                    "now served read-only"
                } else {
                    "no longer read-only"
                }
            ))
        }
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
        library: Option<&RegisteredLibrary>,
        line: &str,
        stdin: &str,
    ) -> Result<String, String> {
        let args: Vec<String> = line.split_whitespace().map(String::from).collect();
        execute(accounts, library, &args, stdin.as_bytes())
    }

    #[test]
    fn add_grants_the_served_library_and_prints_generated_passwords_once() {
        let (_directory, accounts, library) = fixture();
        let output = command(&accounts, Some(&library), "users add alice", "").unwrap();
        let password = output
            .lines()
            .find_map(|line| line.strip_prefix("Sign-in password: "))
            .unwrap();
        let alice = accounts
            .verify_password("alice", password)
            .unwrap()
            .unwrap();
        assert_eq!(alice.role, Role::Reader);
        assert!(accounts.can_access(&alice.id, &library.id).unwrap());
        let app = accounts.app_password("alice").unwrap().unwrap();
        assert!(output.contains(&app.password));
        let listed = command(&accounts, Some(&library), "users list", "").unwrap();
        assert!(listed.contains("alice") && listed.contains("has access"));
        assert!(listed.contains("reader"));
        assert!(!listed.contains(password));
    }

    #[test]
    fn passwords_can_come_from_stdin_and_resets_sign_users_out() {
        let (_directory, accounts, library) = fixture();
        let output = command(
            &accounts,
            Some(&library),
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
        command(&accounts, Some(&library), "users reset-password kid", "").unwrap();
        assert!(accounts.session_user(&session).unwrap().is_none());
        assert!(accounts
            .verify_password("kid", "chosen password")
            .unwrap()
            .is_none());
        command(&accounts, Some(&library), "grant kid", "").unwrap();
        assert!(accounts.can_access(&kid.id, &library.id).unwrap());
        command(
            &accounts,
            Some(&library),
            &format!("revoke kid {}", library.id),
            "",
        )
        .unwrap();
        assert!(!accounts.can_access(&kid.id, &library.id).unwrap());
    }

    #[test]
    fn app_passwords_reveal_and_rotate() {
        let (_directory, accounts, library) = fixture();
        command(&accounts, Some(&library), "users add alice", "").unwrap();
        let revealed = command(&accounts, Some(&library), "users app-password alice", "").unwrap();
        assert_eq!(
            revealed,
            command(&accounts, Some(&library), "users app-password alice", "").unwrap()
        );
        let rotated = command(
            &accounts,
            Some(&library),
            "users app-password alice --rotate",
            "",
        )
        .unwrap();
        assert_ne!(revealed, rotated);
    }

    #[test]
    fn administrators_are_made_promoted_and_demoted() {
        let (_directory, accounts, _) = fixture();
        assert!(!accounts.administrator_exists().unwrap());
        let output = command(&accounts, None, "users add root --admin", "").unwrap();
        assert!(output.starts_with("Created administrator root"), "{output}");
        assert!(output.contains("No library is set up yet"), "{output}");
        assert!(accounts.administrator_exists().unwrap());
        command(&accounts, None, "users add alice", "").unwrap();
        assert!(command(&accounts, None, "users promote alice", "")
            .unwrap()
            .contains("administrator"));
        assert!(accounts.user("alice").unwrap().is_administrator());
        command(&accounts, None, "users demote alice", "").unwrap();
        assert!(!accounts.user("alice").unwrap().is_administrator());
        assert!(command(&accounts, None, "users promote nobody", "").is_err());
        let listed = command(&accounts, None, "users list", "").unwrap();
        assert!(listed.contains("no library yet"), "{listed}");
        assert!(command(&accounts, None, "grant alice", "")
            .unwrap_err()
            .contains("libraries add"));
    }

    #[test]
    fn libraries_add_registers_and_serves_one_library() {
        let directory = tempfile::tempdir().unwrap();
        let accounts = CitadelStore::open(&directory.path().join("citadel.db")).unwrap();
        let root = directory.path().join("Books");
        let mut created = Library::create_library_at(root.to_str().unwrap()).unwrap();
        let id = created.library_uuid().unwrap();
        drop(created);
        assert!(command(&accounts, None, "libraries list", "")
            .unwrap()
            .contains("No libraries"));
        assert!(command(&accounts, None, "libraries add relative/path", "").is_err());
        assert!(command(
            &accounts,
            None,
            &format!("libraries add {}", directory.path().display()),
            ""
        )
        .unwrap_err()
        .contains("No Calibre library"));
        let output = command(
            &accounts,
            None,
            &format!("libraries add {}", root.display()),
            "",
        )
        .unwrap();
        assert!(output.contains(&id), "{output}");
        let served = accounts.active_library().unwrap().unwrap();
        assert_eq!(served.id, id);
        let listed = command(&accounts, Some(&served), "libraries list", "").unwrap();
        assert!(listed.contains("served"), "{listed}");
        assert!(command(
            &accounts,
            Some(&served),
            &format!("libraries add {}", root.display()),
            ""
        )
        .unwrap_err()
        .contains("already serves"));
        command(&accounts, Some(&served), "users add alice", "").unwrap();
        assert!(accounts
            .can_access(&accounts.user("alice").unwrap().id, &id)
            .unwrap());
        assert!(!served.read_only);
        let output = command(&accounts, Some(&served), "libraries read-only on", "").unwrap();
        assert!(output.contains("now served read-only"), "{output}");
        let listed = command(&accounts, Some(&served), "libraries list", "").unwrap();
        assert!(listed.ends_with("served\tread-only"), "{listed}");
        assert!(command(&accounts, Some(&served), "libraries read-only maybe", "").is_err());
        assert!(command(
            &accounts,
            Some(&served),
            "libraries read-only on unknown-id",
            ""
        )
        .is_err());
        command(
            &accounts,
            Some(&served),
            &format!("libraries read-only off {id}"),
            "",
        )
        .unwrap();
        assert!(!accounts.active_library().unwrap().unwrap().read_only);
    }

    #[test]
    fn libraries_add_can_serve_read_only() {
        let directory = tempfile::tempdir().unwrap();
        let accounts = CitadelStore::open(&directory.path().join("citadel.db")).unwrap();
        let root = directory.path().join("Books");
        drop(Library::create_library_at(root.to_str().unwrap()).unwrap());
        let output = command(
            &accounts,
            None,
            &format!("libraries add {} --read-only", root.display()),
            "",
        )
        .unwrap();
        assert!(output.contains("read-only from"), "{output}");
        assert!(accounts.active_library().unwrap().unwrap().read_only);
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
            "libraries add",
        ] {
            assert!(
                command(&accounts, Some(&library), line, "").is_err(),
                "{line}"
            );
        }
        assert!(command(
            &accounts,
            Some(&library),
            "users add alice --password-stdin",
            ""
        )
        .is_err());
        assert!(command(&accounts, Some(&library), "libraries list", "")
            .unwrap()
            .contains(&library.id));
    }
}
