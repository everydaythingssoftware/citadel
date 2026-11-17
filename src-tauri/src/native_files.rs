//! What the system knows about a book's files: the app that opens them, the
//! icons it shows for them, and the Quick Look panel.

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

/// The system Quick Look panel (QuickLookUI's `QLPreviewPanel`), driven
/// directly: the library window can't join the responder chain the panel
/// looks for a controller in, so a data source of our own is set on the
/// shared panel. Everything here runs on the main thread.
///
/// AppKit logs that driving the panel without a controller "will raise
/// soon". Every call on the panel therefore runs inside an Objective-C
/// `@try`, and a raised exception becomes an error, on which the command
/// opens the file in its default app instead. This is deliberately not
/// gated on the macOS version: an allow-list would switch Quick Look off on
/// every new release until someone bumped it, while catching the exception
/// guards against exactly this failure on any release.
#[cfg(target_os = "macos")]
mod quick_look {
    use std::cell::RefCell;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use objc2::exception::Exception;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSWindowDelegate};
    use objc2_foundation::{NSInteger, NSString, NSURL};
    use objc2_quick_look_ui::{
        QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource, QLPreviewPanelDelegate,
    };

    pub const UNAVAILABLE: &str = "Quick Look is unavailable.";

    const KEY_SPACE: u16 = 49;
    const KEY_ESCAPE: u16 = 53;

    /// Runs calls on the panel, turning an Objective-C exception into an
    /// error.
    fn guarded<R>(work: impl FnOnce() -> R) -> Result<R, String> {
        // AssertUnwindSafe: `work` leaves nothing half done that is read
        // again; `toggle` keeps the panel's previous source alive.
        objc2::exception::catch(AssertUnwindSafe(work)).map_err(|exception| {
            log::warn!("Quick Look raised {}", describe(exception.as_deref()));
            UNAVAILABLE.to_string()
        })
    }

    fn describe(exception: Option<&Exception>) -> String {
        let Some(exception) = exception else {
            return "a nil exception".to_string();
        };
        // Reading the name and reason is itself a message send.
        objc2::exception::catch(AssertUnwindSafe(|| format!("{exception:?}")))
            .unwrap_or_else(|_| "an exception".to_string())
    }

    pub struct Ivars {
        url: Retained<NSURL>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and
        // `PreviewSource` does not implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        pub struct PreviewSource;

        unsafe impl NSObjectProtocol for PreviewSource {}

        // AppKit calls these: a Rust panic must not unwind into it, so each
        // one that could reach a panic path is caught and answered with a
        // harmless default.
        unsafe impl QLPreviewPanelDataSource for PreviewSource {
            #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
            fn number_of_preview_items(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
                1
            }

            #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
            fn preview_item(
                &self,
                _panel: Option<&QLPreviewPanel>,
                _index: NSInteger,
            ) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
                catch_unwind(AssertUnwindSafe(|| {
                    ProtocolObject::from_retained(self.ivars().url.clone())
                }))
                .ok()
            }
        }

        unsafe impl NSWindowDelegate for PreviewSource {}

        unsafe impl QLPreviewPanelDelegate for PreviewSource {
            /// Space closes the panel, as in Finder, if the panel itself
            /// left it unhandled; Escape too.
            #[unsafe(method(previewPanel:handleEvent:))]
            fn handle_event(
                &self,
                panel: Option<&QLPreviewPanel>,
                event: Option<&NSEvent>,
            ) -> bool {
                catch_unwind(AssertUnwindSafe(|| {
                    guarded(|| close_on_key(panel, event)).unwrap_or(false)
                }))
                .unwrap_or(false)
            }
        }
    );

    fn close_on_key(panel: Option<&QLPreviewPanel>, event: Option<&NSEvent>) -> bool {
        let (Some(panel), Some(event)) = (panel, event) else {
            return false;
        };
        // keyCode raises for anything but a key event.
        if event.r#type() != NSEventType::KeyDown {
            return false;
        }
        let modifiers = event.modifierFlags()
            & NSEventModifierFlags::DeviceIndependentFlagsMask
            & !(NSEventModifierFlags::CapsLock
                | NSEventModifierFlags::NumericPad
                | NSEventModifierFlags::Function);
        if !modifiers.is_empty() || !matches!(event.keyCode(), KEY_SPACE | KEY_ESCAPE) {
            return false;
        }
        panel.orderOut(None);
        true
    }

    impl PreviewSource {
        fn new(mtm: MainThreadMarker, url: Retained<NSURL>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { url });
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    type Shown = (String, Retained<PreviewSource>);

    thread_local! {
        /// The panel holds its data source and delegate unretained: this
        /// keeps the current one (and the path it shows) alive. Only ever
        /// touched on the main thread.
        static CURRENT: RefCell<Option<Shown>> = const { RefCell::new(None) };
    }

    /// Shows `path` in the Quick Look panel; closes the panel if it is
    /// already showing that file (Space toggles, as in Finder), and switches
    /// to `path` if it is showing another. Errs if the panel raises an
    /// Objective-C exception.
    pub fn toggle(mtm: MainThreadMarker, path: &str) -> Result<(), String> {
        let mut replaced: Option<Shown> = None;
        let result = guarded(|| show(mtm, path, &mut replaced)).and_then(|shown| shown);
        if result.is_err() {
            // The panel may still point at the source it was given before
            // the exception: keep that one alive for good.
            std::mem::forget(replaced);
        }
        result
    }

    fn show(mtm: MainThreadMarker, path: &str, replaced: &mut Option<Shown>) -> Result<(), String> {
        // SAFETY: called on the main thread (the marker).
        let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }
            .ok_or_else(|| UNAVAILABLE.to_string())?;
        let visible = panel.isVisible();
        let showing_path = CURRENT
            .try_with(|current| {
                current
                    .try_borrow()
                    .ok()
                    .and_then(|current| current.as_ref().map(|(shown, _)| shown == path))
            })
            .ok()
            .flatten()
            .unwrap_or(false);
        if visible && showing_path {
            panel.orderOut(None);
            return Ok(());
        }

        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let source = PreviewSource::new(mtm, url);
        let stored = CURRENT
            .try_with(|current| {
                current
                    .try_borrow_mut()
                    .map(|mut current| {
                        *replaced = current.replace((path.to_string(), source.clone()));
                    })
                    .is_ok()
            })
            .unwrap_or(false);
        if !stored {
            return Err(UNAVAILABLE.to_string());
        }
        // SAFETY: `source` stays alive in CURRENT until the next file
        // replaces it, and it is set again on the panel at that point; the
        // one it replaces lives in `replaced` until the panel lets go of it.
        unsafe {
            panel.setDataSource(Some(ProtocolObject::from_ref(&*source)));
            panel.setDelegate(Some(&source));
            panel.reloadData();
        }
        if !visible {
            panel.makeKeyAndOrderFront(None);
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
async fn preview(app: &AppHandle, path: String) -> Result<(), String> {
    on_main_thread(app, move || {
        Some(
            objc2::MainThreadMarker::new()
                .ok_or_else(|| quick_look::UNAVAILABLE.to_string())
                .and_then(|mtm| quick_look::toggle(mtm, &path)),
        )
    })
    .await
    .unwrap_or_else(|| Err(quick_look::UNAVAILABLE.to_string()))
}

#[cfg(not(target_os = "macos"))]
async fn preview(_app: &AppHandle, _path: String) -> Result<(), String> {
    Err("Quick Look is only available on macOS.".to_string())
}

/// Shows a file in the system Quick Look panel (macOS). Asked again for the
/// file it is showing, it closes the panel; for another file, it switches.
/// Where the panel fails, the file opens in its default app instead.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_quick_look(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{path} does not exist."));
    }
    if let Err(err) = preview(&app, path.clone()).await {
        log::warn!("Opening {path} in its default app: {err}");
        app.opener()
            .open_path(&path, None::<&str>)
            .map_err(|err| err.to_string())?;
    }
    Ok(())
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
