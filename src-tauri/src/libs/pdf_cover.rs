//! A PDF's first page as its cover, drawn by the operating system where it
//! can: QuickLook on macOS (in its own sandboxed process) and Windows.Data.Pdf
//! on Windows. Elsewhere, poppler's `pdftoppm`.
use std::path::Path;

/// The first page of the PDF at `path` as a JPEG at most 1600 pixels on its
/// longer side, or `None`.
pub fn render(path: &Path) -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    return macos::render(path);
    #[cfg(windows)]
    return windows_pdf::render(path);
    #[cfg(not(any(target_os = "macos", windows)))]
    return citadel_core::pdf_cover::pdftoppm(path);
}

#[cfg(any(target_os = "macos", windows))]
const LONG_SIDE: f64 = 1600.0;

#[cfg(target_os = "macos")]
mod macos {
    use std::{path::Path, sync::mpsc};

    use block2::RcBlock;
    use citadel_core::pdf_cover::RENDER_TIMEOUT;
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSDictionary, NSError, NSString, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator, QLThumbnailRepresentation,
    };

    use super::LONG_SIDE;

    pub fn render(path: &Path) -> Option<Vec<u8>> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        // SAFETY: a file URL, a positive size and scale, and a single
        // representation type are what the initializer documents.
        let request = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                CGSize::new(LONG_SIDE, LONG_SIDE),
                1.0,
                QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
            )
        };
        // SAFETY: plain property setter.
        unsafe { request.setIconMode(false) };
        let (sender, receiver) = mpsc::sync_channel(1);
        let completion = RcBlock::new(
            move |representation: *mut QLThumbnailRepresentation, _error: *mut NSError| {
                // SAFETY: QuickLook passes a valid representation or null.
                let jpeg = unsafe { representation.as_ref() }.and_then(jpeg);
                let _ = sender.try_send(jpeg);
            },
        );
        // SAFETY: the shared generator is thread-safe; the completion runs on
        // one of QuickLook's queues and only sends on the channel.
        let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
        unsafe {
            generator.generateBestRepresentationForRequest_completionHandler(&request, &completion)
        };
        receiver.recv_timeout(RENDER_TIMEOUT).unwrap_or_else(|_| {
            // SAFETY: cancelling a request this generator was given.
            unsafe { generator.cancelRequest(&request) };
            None
        })
    }

    fn jpeg(representation: &QLThumbnailRepresentation) -> Option<Vec<u8>> {
        // SAFETY: a finished thumbnail representation always has an image.
        let image = unsafe { representation.CGImage() };
        let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
        // SAFETY: an empty property dictionary is valid for every file type.
        let data = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::JPEG,
                &NSDictionary::new(),
            )
        }?;
        Some(data.to_vec())
    }
}

/// Windows.Data.Pdf renders in this process, so it runs on its own thread
/// and is abandoned (not waited for) past the timeout.
#[cfg(windows)]
mod windows_pdf {
    use std::{path::Path, sync::mpsc, thread};

    use citadel_core::pdf_cover::RENDER_TIMEOUT;
    use windows::{
        core::{Result, HSTRING},
        Data::Pdf::{PdfDocument, PdfPageRenderOptions},
        Graphics::Imaging::BitmapEncoder,
        Storage::{
            StorageFile,
            Streams::{DataReader, InMemoryRandomAccessStream},
        },
    };

    use super::LONG_SIDE;

    /// Larger files get no cover rather than being parsed in this process.
    const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;

    pub fn render(path: &Path) -> Option<Vec<u8>> {
        if std::fs::metadata(path).ok()?.len() > MAX_PDF_BYTES {
            return None;
        }
        let path = path.to_path_buf();
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let _ = sender.send(render_now(&path).ok().flatten());
        });
        receiver.recv_timeout(RENDER_TIMEOUT).ok().flatten()
    }

    fn render_now(path: &Path) -> Result<Option<Vec<u8>>> {
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.join()?;
        let document = PdfDocument::LoadFromFileAsync(&file)?.join()?;
        if document.PageCount()? == 0 {
            return Ok(None);
        }
        let page = document.GetPage(0)?;
        let size = page.Size()?;
        let (width, height) = (f64::from(size.Width), f64::from(size.Height));
        let scale = LONG_SIDE / width.max(height);
        if !(scale.is_finite() && scale > 0.0) {
            return Ok(None);
        }
        let options = PdfPageRenderOptions::new()?;
        options.SetDestinationWidth(((width * scale).round() as u32).max(1))?;
        options.SetDestinationHeight(((height * scale).round() as u32).max(1))?;
        options.SetBitmapEncoderId(BitmapEncoder::JpegEncoderId()?)?;
        let stream = InMemoryRandomAccessStream::new()?;
        page.RenderWithOptionsToStreamAsync(&stream, &options)?
            .join()?;
        let length = u32::try_from(stream.Size()?).unwrap_or(0);
        if length == 0 {
            return Ok(None);
        }
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        reader.LoadAsync(length)?.join()?;
        let mut jpeg = vec![0; length as usize];
        reader.ReadBytes(&mut jpeg)?;
        Ok(Some(jpeg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-page PDF, 300 by 150 points, painted blue. Windows.Data.Pdf
    /// needs the cross-reference table; poppler and QuickLook do without.
    const BLUE_PAGE: &str = "%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Contents 4 0 R >> endobj
4 0 obj << /Length 25 >> stream
0 0 1 rg 0 0 300 150 re f
endstream endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000202 00000 n 
trailer << /Size 5 /Root 1 0 R >>
startxref
277
%%EOF
";

    /// Runs against the platform's own renderer; without `pdftoppm` on
    /// Linux there is nothing to check.
    #[test]
    fn the_platform_draws_a_pdfs_first_page() {
        #[cfg(not(any(target_os = "macos", windows)))]
        if !citadel_core::pdf_cover::pdftoppm_installed() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.pdf");
        std::fs::write(&path, BLUE_PAGE).unwrap();

        let cover = image::load_from_memory(&render(&path).unwrap())
            .unwrap()
            .to_rgb8();
        assert_eq!(cover.width().max(cover.height()), 1600);
        let [r, g, b] = cover.get_pixel(cover.width() / 2, cover.height() / 2).0;
        assert!(r < 80 && g < 80 && b > 180, "centre is {r},{g},{b}");
    }
}
