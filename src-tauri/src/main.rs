// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};

#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};

mod account;
mod app_updates;
pub mod libs {
    pub mod cover_thumbs;
    pub mod file_formats;
}
mod imports;
mod library;
mod menu;
mod metadata;
mod opds;
mod recovery;
mod state;

fn command_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .events(collect_events![
            library::registry::LibrariesChanged,
            app_updates::SoftwareUpdateChanged,
            app_updates::ShowSoftwareUpdate,
        ])
        .commands(collect_commands![
            // Library and initialization commands
            library::init_client,
            // citadel.db recovery at startup (ADR 0009)
            recovery::clb_query_database_problem,
            recovery::clb_query_database_restored,
            recovery::clb_cmd_recover_database,
            library::query::clb_query_is_path_valid_library,
            library::command::clb_cmd_create_library,
            // First-run onboarding: detection-led library setup (CDL-19)
            library::query::clb_query_detect_calibre_library,
            library::query::clb_query_library_stats,
            library::query::clb_query_path_sync_status,
            library::query::clb_query_default_new_library_path,
            // Library registry (citadel.db)
            library::registry::clb_query_libraries,
            library::registry::clb_cmd_register_library,
            library::registry::clb_cmd_rename_library,
            library::registry::clb_cmd_import_legacy_libraries,
            // Book query commands
            library::query::clb_query_search_books,
            library::query::clb_query_books,
            library::query::clb_query_get_book,
            library::query::clb_query_is_file_importable,
            library::query::clb_query_importable_file_metadata,
            library::query::clb_query_list_all_filetypes,
            // Series query commands
            library::query::clb_query_list_series,
            // Tag query commands
            library::query::clb_query_list_tags,
            // Publisher query commands
            library::query::clb_query_list_publishers,
            // Book manipulation commands
            library::command::clb_cmd_create_book,
            library::command::clb_cmd_update_book,
            library::command::clb_cmd_upsert_book_identifier,
            library::command::clb_cmd_delete_book_identifier,
            library::command::clb_cmd_set_book_cover_from_metadata,
            library::command::clb_cmd_set_book_cover_from_file,
            library::command::clb_cmd_ensure_cover_thumbnails,
            library::command::clb_cmd_warm_cover_thumbnails,
            library::query::clb_query_list_cover_thumbnails,
            // Custom column commands
            library::query::clb_query_list_custom_columns,
            library::query::clb_query_get_custom_values_for_book,
            library::command::clb_cmd_set_custom_value,
            library::command::clb_cmd_add_book_genres,
            // Author query and manipulation commands
            library::query::clb_query_list_all_authors,
            library::command::clb_cmd_create_authors,
            library::command::clb_cmd_update_author,
            library::command::clb_cmd_delete_author,
            library::command::clb_cmd_delete_books,
            // Metadata-provider commands (Hardcover, LoC, DNB, Open Library)
            metadata::commands::clb_cmd_test_metadata_provider,
            metadata::commands::clb_query_metadata_search,
            metadata::commands::clb_query_metadata_by_isbn,
            metadata::commands::clb_cmd_prefetch_metadata_cover,
            // Software Update (CDL-51)
            app_updates::clb_query_software_update,
            app_updates::clb_cmd_check_for_updates,
            app_updates::clb_cmd_update_later,
            app_updates::clb_cmd_update_now,
            // OPDS sharing commands
            opds::clb_query_opds_credential_status,
            opds::clb_cmd_configure_opds_credentials,
            opds::clb_cmd_generate_opds_credentials,
            opds::clb_cmd_clear_opds_credentials,
            opds::clb_cmd_start_opds,
            opds::clb_cmd_stop_opds,
            opds::clb_cmd_reconfigure_opds,
            opds::clb_query_opds_status,
            opds::clb_query_opds_credential_secret,
            // Window commands
            menu::clb_cmd_open_settings,
            menu::clb_cmd_open_software_update,
        ])
}

fn run_tauri_backend() -> std::io::Result<()> {
    let builder = command_builder();

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    builder
        .export(
            // i64 fields (LibraryStats counts) export as `number`; fine for
            // values far below 2^53, which library counts always are.
            Typescript::default().bigint(specta_typescript::BigIntExportBehavior::Number),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    let tauri_builder = tauri::Builder::default();

    // WebDriver server for automated e2e testing; debug builds only.
    #[cfg(debug_assertions)]
    let tauri_builder = tauri_builder.plugin(tauri_plugin_webdriver_automation::init());

    let state = state::CitadelState::new();
    let opds_state = state.clone();
    let app = tauri_builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .manage(metadata::client())
        .register_asynchronous_uri_scheme_protocol(
            metadata::COVER_SCHEME,
            metadata::serve_cover_preview,
        )
        .invoke_handler(builder.invoke_handler())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(move |app| {
            builder.mount_events(app);

            // Before anything that can stop startup: the recovery screen
            // offers "Update Citadel" too.
            app.manage(app_updates::SoftwareUpdates::new(
                app.package_info().version.to_string(),
            ));

            // citadel.db lives in app data: the local user, its sharing
            // password and the library list (ADR 0009).
            let account = match recovery::open(&app.path().app_data_dir()?) {
                recovery::Startup::Opened { account, restored } => {
                    if let Some(restored) = restored {
                        app.manage(restored);
                    }
                    account
                }
                recovery::Startup::NeedsRecovery(pending) => {
                    // The window shows the recovery screen instead of the app.
                    app.manage(pending);
                    return Ok(());
                }
            };
            let sharing = citadel_opds::OpdsService::with_ephemeral_credentials(
                Arc::new(opds_state.clone()),
                Vec::new(),
            )
            .map_err(|error| error.message)?;
            opds::sync_credentials(&sharing, &account).map_err(|error| error.message)?;
            app.manage(account);
            app.manage(sharing);

            // Native macOS menu bar: app menu with Settings…, File > Add
            // Book…, and the standard Edit/View/Window items.
            #[cfg(target_os = "macos")]
            {
                let app_menu = menu::build_menu(app.handle())?;
                app.set_menu(app_menu)?;
                app.on_menu_event(menu::handle_menu_event);
            }

            // Get the main window that was created from config and center it.
            if let Some(main_window) = app.get_webview_window("main") {
                main_window.center().unwrap();

                // Glass behind the transparent webview. The `windowEffects`
                // config on the window never attaches (bare window backing
                // shows through instead); applying the same effects after the
                // window exists does work.
                #[cfg(target_os = "macos")]
                {
                    use tauri::{
                        utils::config::WindowEffectsConfig,
                        window::{Effect, EffectState},
                    };
                    // Popover is noticeably clearer than Sidebar (which
                    // smears backdrop color into a uniform gray); the user
                    // wants desktop color to actually read through.
                    if let Err(err) = main_window.set_effects(WindowEffectsConfig {
                        effects: vec![Effect::Popover],
                        state: Some(EffectState::FollowsWindowActiveState),
                        radius: None,
                        color: None,
                        interactive: false,
                    }) {
                        eprintln!("window effects unavailable: {err}");
                    }
                }
            }

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    const OPDS_EXIT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);
    const RUNNING: u8 = 0;
    const STOPPING: u8 = 1;
    const EXITING: u8 = 2;
    let exit_phase = Arc::new(AtomicU8::new(RUNNING));
    app.run(move |app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // ⌘Q on macOS reaches Exit without ExitRequested, so sharing
            // hasn't stopped yet; give its downloads a moment to finish.
            if exit_phase.load(Ordering::Acquire) == RUNNING {
                if let Some(opds_service) = app_handle.try_state::<citadel_opds::OpdsService>() {
                    let opds_service = opds_service.inner().clone();
                    tauri::async_runtime::block_on(async move {
                        let _ = tokio::time::timeout(OPDS_EXIT_DEADLINE, opds_service.stop()).await;
                    });
                }
            }
            app_updates::install_pending_at_exit(app_handle);
        }
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            match exit_phase.compare_exchange(
                RUNNING,
                STOPPING,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    // Absent when startup stopped to offer database recovery.
                    let Some(opds_service) = app_handle.try_state::<citadel_opds::OpdsService>()
                    else {
                        return;
                    };
                    let opds_service = opds_service.inner().clone();
                    api.prevent_exit();
                    let app_handle = app_handle.clone();
                    let exit_phase = exit_phase.clone();
                    let exit_code = code.unwrap_or(0);
                    tauri::async_runtime::spawn(async move {
                        opds_service.stop().await;
                        exit_phase.store(EXITING, Ordering::Release);
                        app_handle.exit(exit_code);
                    });
                }
                Err(STOPPING) => api.prevent_exit(),
                Err(EXITING) => {}
                Err(_) => unreachable!(),
            }
        }
    });

    Ok(())
}

fn main() -> std::io::Result<()> {
    #[cfg(debug_assertions)]
    if std::env::args().nth(1).as_deref() == Some("--export-bindings") {
        command_builder()
            .export(
                Typescript::default().bigint(specta_typescript::BigIntExportBehavior::Number),
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.ts"),
            )
            .map_err(std::io::Error::other)?;
        return Ok(());
    }
    run_tauri_backend()
}

#[cfg(test)]
mod contract_tests {
    #[test]
    fn ipc_bindings_match_committed_contract() {
        let output = tempfile::tempdir().unwrap();
        let path = output.path().join("bindings.ts");
        super::command_builder()
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number),
                &path,
            )
            .unwrap();
        let committed = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.ts");
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            std::fs::read_to_string(committed).unwrap(),
            "Regenerate IPC bindings with cargo run -p citadel-desktop -- --export-bindings"
        );
    }
}
