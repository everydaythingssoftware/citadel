// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use libs::calibre;
#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri::Manager;
use tauri_specta::{collect_commands, Builder};

mod app_updates;
pub mod libs {
    pub mod calibre;
    pub mod cover_thumbs;
    pub mod file_formats;
}
mod book;
mod menu;
mod metadata;
mod state;

fn run_tauri_backend() -> std::io::Result<()> {
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        // Library and initialization commands
        calibre::init_client,
        calibre::query::clb_query_is_path_valid_library,
        calibre::command::clb_cmd_create_library,
        // First-run onboarding: detection-led library setup (CDL-19)
        calibre::query::clb_query_detect_calibre_library,
        calibre::query::clb_query_library_stats,
        calibre::query::clb_query_path_sync_status,
        calibre::query::clb_query_default_new_library_path,
        // Book query commands
        calibre::query::clb_query_search_books,
        calibre::query::clb_query_books,
        calibre::query::clb_query_get_book,
        calibre::query::clb_query_is_file_importable,
        calibre::query::clb_query_importable_file_metadata,
        calibre::query::clb_query_list_all_filetypes,
        // Series query commands
        calibre::query::clb_query_list_series,
        // Tag query commands
        calibre::query::clb_query_list_tags,
        // Book manipulation commands
        calibre::command::clb_cmd_create_book,
        calibre::command::clb_cmd_update_book,
        calibre::command::clb_cmd_upsert_book_identifier,
        calibre::command::clb_cmd_delete_book_identifier,
        calibre::command::clb_cmd_set_book_cover_from_url,
        calibre::command::clb_cmd_ensure_cover_thumbnails,
        calibre::command::clb_cmd_warm_cover_thumbnails,
        calibre::query::clb_query_list_cover_thumbnails,
        // Custom column commands
        calibre::query::clb_query_list_custom_columns,
        calibre::query::clb_query_get_custom_values_for_book,
        calibre::command::clb_cmd_set_custom_value,
        // Author query and manipulation commands
        calibre::query::clb_query_list_all_authors,
        calibre::command::clb_cmd_create_authors,
        calibre::command::clb_cmd_update_author,
        calibre::command::clb_cmd_delete_author,
        // Metadata-provider commands (Hardcover, LoC, DNB, Open Library)
        metadata::commands::clb_cmd_test_metadata_provider,
        metadata::commands::clb_query_metadata_search,
        metadata::commands::clb_query_metadata_by_isbn,
        app_updates::clb_cmd_check_for_updates,
        app_updates::clb_cmd_install_update_if_available,
        // Window commands
        menu::clb_cmd_open_settings,
    ]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    builder
        .export(
            // i64 fields (LibraryStats counts) export as `number`; fine for
            // values far below 2^53, which library counts always are.
            Typescript::default().bigint(specta_typescript::BigIntExportBehavior::Number),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    let mut tauri_builder = tauri::Builder::default();

    // WebDriver server for automated e2e testing; debug builds only.
    #[cfg(debug_assertions)]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_webdriver_automation::init());
    }

    tauri_builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state::CitadelState::new())
        .invoke_handler(builder.invoke_handler())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(move |app| {
            builder.mount_events(app);

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    Ok(())
}

fn main() -> std::io::Result<()> {
    run_tauri_backend()
}
