//! What the system knows about a book's files: the app that opens them, the
//! icons it shows for them, and Quick Look.

use serde::Serialize;
use tauri::AppHandle;

/// The app a file opens in by default, with its icon as a PNG data URL.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DefaultApp {
    pub name: String,
    pub icon_data_url: String,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const ICON_PIXELS: isize = 64;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn png_data_url(png: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_display_name(display_name: &str) -> &str {
    display_name.strip_suffix(".app").unwrap_or(display_name)
}

/// Runs AppKit work on the main thread and hands back its result.
#[cfg(target_os = "macos")]
async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce() -> Option<T> + Send + 'static,
) -> Option<T> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(objc2::rc::autoreleasepool(|_| work()));
    })
    .ok()?;
    receiver.await.ok().flatten()
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
        NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSFileManager, NSPoint, NSRect, NSSize, NSString, NSURL};

    use super::{app_display_name, ICON_PIXELS};

    pub fn default_app(path: &str) -> Option<(String, Vec<u8>)> {
        let workspace = NSWorkspace::sharedWorkspace();
        let file = NSURL::fileURLWithPath(&NSString::from_str(path));
        let app_path = workspace.URLForApplicationToOpenURL(&file)?.path()?;
        let display_name = NSFileManager::defaultManager()
            .displayNameAtPath(&app_path)
            .to_string();
        let icon = png(&workspace.iconForFile(&app_path))?;
        Some((app_display_name(&display_name).to_string(), icon))
    }

    pub fn file_icon(path: &str) -> Option<Vec<u8>> {
        png(&NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path)))
    }

    /// Draws the image's best representation into a square RGBA bitmap.
    fn png(image: &NSImage) -> Option<Vec<u8>> {
        // SAFETY: null planes ask AppKit to allocate the bitmap's memory;
        // the colour space name is an AppKit constant.
        let bitmap = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                ICON_PIXELS,
                ICON_PIXELS,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
        }?;
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)?;
        let side = ICON_PIXELS as f64;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&context));
        image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(side, side)));
        context.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        // SAFETY: an empty property dictionary is valid for every file type.
        let data = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }?;
        Some(data.to_vec())
    }
}

/// The app that opens this file when it is double-clicked in the file
/// manager. None where the platform can't say (Windows, Linux) or when no
/// app claims the file.
#[tauri::command]
#[specta::specta]
pub async fn clb_query_default_app(app: AppHandle, path: String) -> Option<DefaultApp> {
    #[cfg(target_os = "macos")]
    {
        let (name, icon) = on_main_thread(&app, move || macos::default_app(&path)).await?;
        Some(DefaultApp {
            name,
            icon_data_url: png_data_url(&icon),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path);
        None
    }
}

/// The file manager's icon for a file, as a PNG data URL: the image under
/// the pointer while files are dragged out. None off macOS.
#[tauri::command]
#[specta::specta]
pub async fn clb_query_file_icon(app: AppHandle, path: String) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let icon = on_main_thread(&app, move || macos::file_icon(&path)).await?;
        Some(png_data_url(&icon))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path);
        None
    }
}

/// Opens Quick Look on a file (macOS).
#[tauri::command]
#[specta::specta]
pub fn clb_cmd_quick_look(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{path} does not exist."));
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        let mut preview = Command::new("/usr/bin/qlmanage")
            .arg("-p")
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("Quick Look is unavailable: {err}"))?;
        std::thread::spawn(move || {
            let _ = preview.wait();
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Quick Look is only available on macOS.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_names_lose_their_bundle_extension() {
        assert_eq!(app_display_name("Kindle.app"), "Kindle");
        assert_eq!(app_display_name("Books"), "Books");
    }

    #[test]
    fn icons_become_png_data_urls() {
        assert_eq!(png_data_url(&[1, 2, 3]), "data:image/png;base64,AQID");
    }
}
