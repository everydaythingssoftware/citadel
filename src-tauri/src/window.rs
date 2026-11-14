//! The library window's life on the desktop: where it opens, the glass
//! behind it, and (on macOS) closing to the Dock rather than quitting.

use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

pub const MAIN_WINDOW: &str = "main";
pub const SETTINGS_WINDOW: &str = "settings";

/// Visibility stays out: the window is revealed by the frontend after its
/// first paint. Full screen stays out too: a window restored into full
/// screen before it has painted shows an empty Space.
const REMEMBERED: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/// Remembers the library window's size and position. The main window's
/// saved state is applied in [`place_main_window`], not as it is created,
/// so a first launch can still center it.
pub fn state_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(REMEMBERED)
        .with_denylist(&[SETTINGS_WINDOW])
        .skip_initial_state(MAIN_WINDOW)
        .build()
}

fn has_saved_state(saved: &str, label: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(saved)
        .ok()
        .and_then(|states| {
            let state = states.get(label)?;
            Some(state.get("width")?.as_u64()? > 0 && state.get("height")?.as_u64()? > 0)
        })
        .unwrap_or(false)
}

/// Where the library window was last time, or centered on first launch.
pub fn place_main_window<R: Runtime>(window: &WebviewWindow<R>) {
    let app = window.app_handle();
    let saved = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(app.filename())).ok());
    let restored = saved.is_some_and(|saved| has_saved_state(&saved, MAIN_WINDOW))
        && window.restore_state(REMEMBERED).is_ok();
    if !restored {
        if let Err(err) = window.center() {
            log::warn!("could not center the library window: {err}");
        }
    }
}

/// Writes window positions now, for exits that skip `RunEvent::Exit` (an
/// update's restart).
pub fn save_window_state<R: Runtime>(app: &AppHandle<R>) {
    if let Err(err) = app.save_window_state(REMEMBERED) {
        log::warn!("could not save window state: {err}");
    }
}

/// Glass behind the transparent webview: the popover material, which lets
/// the desktop's colour read through. It goes flat while the window is not
/// in front. The platform sidebar material (`Effect::Sidebar`, as in Apple's
/// own apps) was tried in CDL-90 and rejected by the owner on seeing it: it
/// smears the backdrop into a uniform grey. The `windowEffects` config on
/// the window never attaches (bare window backing shows through instead);
/// applying the same effects after the window exists does work.
#[cfg(target_os = "macos")]
pub fn apply_glass<R: Runtime>(window: &WebviewWindow<R>) {
    use tauri::{
        utils::config::WindowEffectsConfig,
        window::{Effect, EffectState},
    };
    if let Err(err) = window.set_effects(WindowEffectsConfig {
        effects: vec![Effect::Popover],
        state: Some(EffectState::FollowsWindowActiveState),
        radius: None,
        color: None,
        interactive: false,
    }) {
        log::warn!("window effects unavailable: {err}");
    }
}

/// Brings the library window back, after it was closed to the Dock or
/// minimized, and puts it in front.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// How long macOS takes to leave full screen before the window can be put
/// away; hiding it mid-animation leaves an empty Space behind.
#[cfg(target_os = "macos")]
const LEAVE_FULL_SCREEN: std::time::Duration = std::time::Duration::from_millis(800);

/// On macOS, closing the library window (red button, ⌘W) puts it away
/// instead of destroying it: Citadel keeps running in the Dock, and the
/// window comes back as it was, with every listener and its state intact,
/// from the Dock icon or any menu command.
#[cfg(target_os = "macos")]
pub fn handle_window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != MAIN_WINDOW {
        return;
    }
    api.prevent_close();
    if window.is_fullscreen().unwrap_or(false) {
        let _ = window.set_fullscreen(false);
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(LEAVE_FULL_SCREEN).await;
            let _ = window.hide();
            save_window_state(window.app_handle());
        });
    } else {
        let _ = window.hide();
        save_window_state(window.app_handle());
    }
}

#[cfg(not(target_os = "macos"))]
pub fn handle_window_event<R: Runtime>(_window: &tauri::Window<R>, _event: &tauri::WindowEvent) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_size_counts_as_saved_state() {
        assert!(has_saved_state(
            r#"{"main":{"width":1200,"height":800,"x":10,"y":20}}"#,
            "main"
        ));
    }

    #[test]
    fn missing_or_empty_state_does_not() {
        assert!(!has_saved_state("{}", "main"));
        assert!(!has_saved_state(
            r#"{"main":{"width":0,"height":0}}"#,
            "main"
        ));
        assert!(!has_saved_state(
            r#"{"settings":{"width":680,"height":520}}"#,
            "main"
        ));
        assert!(!has_saved_state("not json", "main"));
    }
}
