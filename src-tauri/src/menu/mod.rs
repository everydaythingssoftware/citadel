//! The menu bar (macOS) and the windows it opens. Choices reach the library
//! window as one typed [`MenuCommandChosen`] event; what the menu shows is
//! pushed back from the frontend with [`clb_cmd_set_menu_state`].

use std::sync::Mutex;

use tauri::{window::Color, AppHandle, Manager, Runtime, Theme, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event;

use crate::app_updates::{ShowSoftwareUpdate, SoftwareUpdateStatus, SoftwareUpdates};

#[cfg(target_os = "macos")]
mod bar;
mod model;

use model::{menu_view, MenuState, MenuView};
pub use model::{MenuCommand, MenuStatePatch};

/// A menu choice, sent to the library window.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct MenuCommandChosen(pub MenuCommand);

/// Emitted to the main window when Library > Add Book… is chosen; the
/// frontend starts the same flow as the toolbar + button.
#[cfg(target_os = "macos")]
const EVENT_MENU_ADD_BOOK: &str = "menu://add-book";

#[cfg(target_os = "macos")]
const HELP_URL: &str = "https://github.com/everydaythingssoftware/citadel#readme";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const FILE_MANAGER_NAME: &str = if cfg!(target_os = "macos") {
    "Finder"
} else if cfg!(windows) {
    "File Explorer"
} else {
    "File Manager"
};

#[derive(Default)]
struct Shown {
    state: MenuState,
    /// What the menu bar shows now; None until it is first applied.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    view: Option<MenuView>,
    #[cfg(target_os = "macos")]
    bar: Option<bar::MenuBar<tauri::Wry>>,
}

/// The menu state the frontend last pushed, and the menu bar showing it.
/// Off macOS there is no menu bar and the state is only kept.
#[derive(Default)]
pub struct MenuController(Mutex<Shown>);

impl MenuController {
    fn lock(&self) -> std::sync::MutexGuard<'_, Shown> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn update(&self, patch: MenuStatePatch) -> tauri::Result<()> {
        let mut shown = self.lock();
        shown.state = shown.state.with(patch);
        #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
        let next = menu_view(&shown.state, FILE_MANAGER_NAME);
        #[cfg(target_os = "macos")]
        if let Some(bar) = &shown.bar {
            bar.apply(shown.view.as_ref(), &next)?;
            shown.view = Some(next);
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn reassert_checks(&self) -> tauri::Result<()> {
        let shown = self.lock();
        match (&shown.bar, &shown.view) {
            (Some(bar), Some(view)) => bar.set_checks(view),
            _ => Ok(()),
        }
    }
}

/// Builds the macOS menu bar and starts following menu choices. Elsewhere
/// the platform default stays (no menu bar on Windows and Linux).
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let (menu, menu_bar) = bar::build(app)?;
    app.set_menu(menu)?;
    app.on_menu_event(handle_menu_event);
    let controller = app.state::<MenuController>();
    controller.lock().bar = Some(menu_bar);
    controller.update(MenuStatePatch {
        update_ready_version: Some(ready_version(
            &app.state::<SoftwareUpdates>().state().status,
        )),
        ..MenuStatePatch::default()
    })
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

fn ready_version(status: &SoftwareUpdateStatus) -> Option<String> {
    match status {
        SoftwareUpdateStatus::Ready { version } => Some(version.clone()),
        _ => None,
    }
}

/// Shows or hides Restart to Update with the downloaded update. Runs off
/// the caller's thread: applying waits for the main thread, which must not
/// be the one waiting.
pub fn follow_software_update<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Some(controller), Some(updates)) = (
            app.try_state::<MenuController>(),
            app.try_state::<SoftwareUpdates>(),
        ) else {
            return;
        };
        let patch = MenuStatePatch {
            update_ready_version: Some(ready_version(&updates.state().status)),
            ..MenuStatePatch::default()
        };
        if let Err(err) = controller.update(patch) {
            log::error!("Failed to update the menu bar: {err}");
        }
    });
}

#[cfg(target_os = "macos")]
fn deliver(app: &AppHandle, command: MenuCommand) {
    // Undo and Redo act on the library window's history where it is; everything else
    // is about the library window, which comes back if it was closed.
    if !matches!(command, MenuCommand::Undo | MenuCommand::Redo) {
        crate::window::show_main_window(app);
    }
    if let Err(err) = MenuCommandChosen(command).emit_to(app, crate::window::MAIN_WINDOW) {
        log::error!("Failed to deliver a menu command: {err}");
    }
}

#[cfg(target_os = "macos")]
fn is_check_item(command: &MenuCommand) -> bool {
    matches!(
        command,
        MenuCommand::ToggleUnreadOnly
            | MenuCommand::SortNameAz
            | MenuCommand::SortNameZa
            | MenuCommand::SortAuthorAz
            | MenuCommand::SortAuthorZa
            | MenuCommand::SwitchLibrary(_)
    )
}

#[cfg(target_os = "macos")]
fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        bar::MENU_ID_SETTINGS => open_settings_window(app),
        bar::MENU_ID_CHECK_FOR_UPDATES => {
            open_software_update(app);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                app.state::<SoftwareUpdates>().check(&app).await;
            });
        }
        bar::MENU_ID_ADD_BOOK => {
            use tauri::Emitter;
            crate::window::show_main_window(app);
            let _ = app.emit_to(crate::window::MAIN_WINDOW, EVENT_MENU_ADD_BOOK, ());
        }
        bar::MENU_ID_HELP => {
            use tauri_plugin_opener::OpenerExt;
            if let Err(err) = app.opener().open_url(HELP_URL, None::<&str>) {
                log::error!("Failed to open Citadel Help: {err}");
            }
        }
        id => match MenuCommand::from_menu_id(id) {
            // Installs and relaunches at once; the menu item is the
            // confirmation.
            Some(MenuCommand::RestartToUpdate) => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = app.state::<SoftwareUpdates>().update_now(&app).await {
                        log::error!("Restart to Update failed: {err}");
                    }
                });
            }
            Some(command) => {
                let reassert = is_check_item(&command);
                deliver(app, command);
                if reassert {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = app.state::<MenuController>().reassert_checks() {
                            log::error!("Failed to update the menu bar: {err}");
                        }
                    });
                }
            }
            None => {}
        },
    }
}

/// Updates what the menu bar shows. Fields left out keep their value.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_set_menu_state(
    controller: tauri::State<'_, MenuController>,
    state: MenuStatePatch,
) -> Result<(), String> {
    controller.update(state).map_err(|err| err.to_string())
}

/// Opens Settings on General → Software Update. A new window starts there;
/// an open one is asked to switch.
pub fn open_software_update<R: Runtime>(app: &AppHandle<R>) {
    open_settings_window(app);
    if let Err(err) = ShowSoftwareUpdate.emit_to(app, "settings") {
        log::error!("Failed to show Software Update: {err}");
    }
}

/// Opens the dedicated settings window, or focuses it if it is already open.
/// Window options live here (not in tauri.conf.json) so the menu can open the
/// window even before any frontend has loaded.
pub fn open_settings_window<R: Runtime>(app: &AppHandle<R>) {
    // The settings window hides on close instead of destroying itself
    // (SettingsWindow.tsx intercepts close-requested), so after the first
    // open this branch makes every reopen instant: show + focus.
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // In dev, join the Vite dev server URL explicitly; WebviewUrl::App's
    // dev-url resolution proved unreliable for secondary windows (the webview
    // came up blank). Gate on is_dev(), not dev_url presence: the bundled
    // config still carries devUrl in release, and routing production to the
    // (nonexistent) Vite server left the settings window permanently blank
    // (CDL-15). In release, App URLs serve the bundled assets.
    let url = if tauri::is_dev() {
        match app.config().build.dev_url.clone() {
            Some(dev_url) => match dev_url.join("settings") {
                Ok(joined) => WebviewUrl::External(joined),
                Err(_) => WebviewUrl::App("/settings".into()),
            },
            None => WebviewUrl::App("/settings".into()),
        }
    } else {
        WebviewUrl::App("/settings".into())
    };

    // Match the webview backing to the app theme (`--ctd-bg` in styles.css)
    // so nothing white can flash before the frontend's first paint.
    let background = match app.get_webview_window("main").and_then(|w| w.theme().ok()) {
        Some(Theme::Dark) => Color(18, 19, 20, 255), // marble dark --ctd-bg
        _ => Color(241, 240, 237, 255),              // marble light --ctd-bg
    };

    // Created hidden; the frontend reveals it after its first paint
    // (SettingsWindow.tsx), so the user never sees an unstyled frame.
    // Overlay title bar with the title hidden: the native title text picked
    // its color from a window appearance that did not always match the
    // backing color (white-on-white in light mode), so the webview owns the
    // whole chrome and the tab strip doubles as the drag region. The lights
    // are vertically centered on the ~58px tab strip.
    let builder = WebviewWindowBuilder::new(app, "settings", url)
        .title("Settings")
        .inner_size(680.0, 520.0)
        .resizable(false)
        .minimizable(false)
        .visible(false)
        .background_color(background)
        .center();

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 28.75));

    // NOTE: transparent webview + sidebar effects left off for now — with
    // them, the settings webview came up blank (debugging round 5).

    if let Err(err) = builder.build() {
        log::error!("Failed to open settings window: {err}");
    }
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_open_settings(app: AppHandle) {
    open_settings_window(&app);
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_open_software_update(app: AppHandle) {
    open_software_update(&app);
}
