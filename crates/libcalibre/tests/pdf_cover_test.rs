//! Runs without libtest: `main` must opt in to the PDF cover worker before
//! anything else, and a libtest binary started as the worker would parse the
//! worker's arguments as test filters.

mod common;

use std::time::{Duration, Instant};

use common::{setup_with_library, standard_test_book};
use libcalibre::{book_file, BookAdd};

/// A one-page PDF of the given size in points, painted by `content`, with
/// any extra objects appended from number 5 and the page resources given.
fn pdf(media_box: &str, content: &str, resources: &str, extra: &[String]) -> Vec<u8> {
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [{media_box}] /Contents 4 0 R /Resources << {resources} >> >>"
        ),
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        ),
    ];
    objects.extend_from_slice(extra);
    let mut pdf = "%PDF-1.4\n".to_string();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
    }
    let xref = pdf.len();
    pdf.push_str(&format!(
        "xref\n0 {}\n0000000000 65535 f \n",
        objects.len() + 1
    ));
    for offset in offsets {
        pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    ));
    pdf.into_bytes()
}

/// A one-page PDF, 300 by 150 points, painted blue.
fn one_page_pdf() -> Vec<u8> {
    pdf("0 0 300 150", "0 0 1 rg 0 0 300 150 re f", "", &[])
}

/// A page showing an image that claims two billion pixels a side, which
/// aborts a renderer on allocation.
fn hostile_pdf() -> Vec<u8> {
    let pixels = "\0".repeat(30);
    let image = format!(
        "<< /Type /XObject /Subtype /Image /ColorSpace /DeviceRGB /BitsPerComponent 8 \
         /Width 2000000000 /Height 2000000000 /Length {} >>\nstream\n{pixels}\nendstream",
        pixels.len()
    );
    pdf(
        "0 0 200 400",
        "200 0 0 400 0 0 cm /I Do",
        "/XObject << /I 5 0 R >>",
        &[image],
    )
}

fn a_pdf_reads_its_first_page_as_its_cover() {
    let source = tempfile::tempdir().unwrap();
    let file = source.path().join("The Odyssey.pdf");
    std::fs::write(&file, one_page_pdf()).unwrap();

    let metadata = book_file::read_metadata(&file).unwrap();
    assert_eq!(metadata.title.as_deref(), Some("The Odyssey"));
    assert!(metadata.has_cover);
    let cover = book_file::cover_image_data(&file).unwrap();
    let image = image::load_from_memory(&cover).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (1600, 800));
}

fn adding_a_pdf_stores_its_first_page_as_the_cover() {
    let (temp, mut library) = setup_with_library();
    let source = tempfile::tempdir().unwrap();
    let file = source.path().join("report.pdf");
    std::fs::write(&file, one_page_pdf()).unwrap();

    let book = library
        .add_book(BookAdd {
            file_paths: vec![file],
            ..standard_test_book()
        })
        .unwrap();

    assert!(book.has_cover);
    assert!(library.get_book(book.id).unwrap().has_cover);
    let cover = temp.path().join(&book.book_dir_path).join("cover.jpg");
    let image = image::open(&cover).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (1600, 800));
    let [r, g, b] = image.get_pixel(800, 400).0;
    assert!(r < 60 && g < 60 && b > 200, "centre is {r},{g},{b}");
    assert_eq!(
        library.get_book_cover(book.id).unwrap(),
        std::fs::read(cover).unwrap()
    );
}

fn a_broken_pdf_is_added_without_a_cover() {
    let (temp, mut library) = setup_with_library();
    let source = tempfile::tempdir().unwrap();
    let file = source.path().join("broken.pdf");
    std::fs::write(&file, b"%PDF-1.7\nnot really").unwrap();

    let book = library
        .add_book(BookAdd {
            file_paths: vec![file],
            ..standard_test_book()
        })
        .unwrap();

    assert!(!book.has_cover);
    assert!(!temp
        .path()
        .join(&book.book_dir_path)
        .join("cover.jpg")
        .exists());
}

fn a_pdf_that_kills_its_worker_has_no_cover() {
    let (temp, mut library) = setup_with_library();
    let source = tempfile::tempdir().unwrap();
    let file = source.path().join("hostile.pdf");
    std::fs::write(&file, hostile_pdf()).unwrap();

    let start = Instant::now();
    let metadata = book_file::read_metadata(&file).unwrap();
    assert_eq!(metadata.title.as_deref(), Some("hostile"));
    assert!(!metadata.has_cover);
    assert_eq!(book_file::cover_image_data(&file), None);
    let book = library
        .add_book(BookAdd {
            file_paths: vec![file],
            ..standard_test_book()
        })
        .unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(10),
        "{:?}",
        start.elapsed()
    );

    assert!(!book.has_cover);
    assert!(!temp
        .path()
        .join(&book.book_dir_path)
        .join("cover.jpg")
        .exists());
}

fn main() {
    book_file::run_pdf_cover_worker();

    let tests: [(&str, fn()); 4] = [
        (
            "a_pdf_reads_its_first_page_as_its_cover",
            a_pdf_reads_its_first_page_as_its_cover,
        ),
        (
            "adding_a_pdf_stores_its_first_page_as_the_cover",
            adding_a_pdf_stores_its_first_page_as_the_cover,
        ),
        (
            "a_broken_pdf_is_added_without_a_cover",
            a_broken_pdf_is_added_without_a_cover,
        ),
        (
            "a_pdf_that_kills_its_worker_has_no_cover",
            a_pdf_that_kills_its_worker_has_no_cover,
        ),
    ];
    for (name, test) in tests {
        test();
        println!("test {name} ... ok");
    }
    println!("test result: ok. {} passed", tests.len());
}
