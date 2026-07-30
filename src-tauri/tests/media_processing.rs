use std::fs;
use std::path::Path;

use horizon_traversal_lib::pipeline::images::resize_images;
use horizon_traversal_lib::pipeline::native::{resolve_pdfium_library, PDFIUM_VERSION};
use horizon_traversal_lib::pipeline::pdf::{
    convert_pdfs, shared_pdfium, PDF_RENDER_MAX_HEIGHT, PDF_RENDER_MAX_WIDTH,
};
use horizon_traversal_lib::pipeline::types::NoticeLevel;
use image::{GenericImageView, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use tempfile::tempdir;

fn save_rgb(path: &Path, width: u32, height: u32) {
    RgbImage::from_pixel(width, height, Rgb([24, 88, 120]))
        .save_with_format(path, ImageFormat::Jpeg)
        .unwrap();
}

fn save_empty_pdf(path: &Path, width: u32, height: u32) {
    let mut pdf = b"%PDF-1.4\n%HorizonTraversal\n".to_vec();
    let objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_owned(),
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_owned(),
        format!(
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents 4 0 R >>\nendobj\n"
        ),
        "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n".to_owned(),
    ];
    let mut offsets = Vec::with_capacity(objects.len());
    for object in objects {
        offsets.push(pdf.len());
        pdf.extend_from_slice(object.as_bytes());
    }

    let xref_offset = pdf.len();
    let mut xref = format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1);
    for offset in offsets {
        xref.push_str(&format!("{offset:010} 00000 n \n"));
    }
    xref.push_str(&format!(
        "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n"
    ));
    pdf.extend_from_slice(xref.as_bytes());
    fs::write(path, pdf).unwrap();
}

#[test]
fn image_batch_resizes_landscape_portrait_and_alpha_but_keeps_in_bounds_files() {
    let temp = tempdir().unwrap();
    let folder = temp.path();
    let landscape = folder.join("landscape.jpg");
    let portrait = folder.join("portrait.png");
    let alpha = folder.join("transparent.png");
    let in_bounds = folder.join("small.png");
    let corrupt = folder.join("corrupt.png");

    save_rgb(&landscape, 2_500, 1_400);
    RgbImage::from_pixel(1_000, 3_000, Rgb([20, 120, 80]))
        .save(&portrait)
        .unwrap();
    RgbaImage::from_pixel(2_000, 1_000, Rgba([30, 60, 90, 64]))
        .save(&alpha)
        .unwrap();
    RgbImage::from_pixel(800, 600, Rgb([100, 80, 20]))
        .save(&in_bounds)
        .unwrap();
    fs::write(&corrupt, b"not an image").unwrap();
    let in_bounds_before = fs::read(&in_bounds).unwrap();

    let mut notices = Vec::new();
    let outcome = resize_images(folder, &mut |notice| notices.push(notice)).unwrap();

    assert_eq!(outcome.processed, 4);
    assert_eq!(outcome.changed, 3);
    assert_eq!(outcome.failed_files, 1);
    assert_eq!(notices[0].message, "Processing image: corrupt.png");
    assert!(notices[1].message.starts_with("Failed to resize image "));
    assert_eq!(
        image::open(&landscape).unwrap().dimensions(),
        (1_920, 1_075)
    );
    assert_eq!(image::open(&portrait).unwrap().dimensions(), (360, 1_080));
    assert_eq!(image::open(&alpha).unwrap().dimensions(), (1_920, 960));
    assert_eq!(image::open(&in_bounds).unwrap().dimensions(), (800, 600));
    assert_eq!(fs::read(&in_bounds).unwrap(), in_bounds_before);
    assert_eq!(fs::read(&corrupt).unwrap(), b"not an image");
    assert_eq!(
        image::open(&alpha).unwrap().to_rgba8().get_pixel(10, 10)[3],
        64
    );
}

#[test]
fn pdf_batch_renders_first_page_and_keeps_failed_originals() {
    let temp = tempdir().unwrap();
    let valid_pdf = temp.path().join("one-page.pdf");
    let corrupt_pdf = temp.path().join("corrupt.pdf");
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/one-page.pdf"),
        &valid_pdf,
    )
    .unwrap();
    fs::write(&corrupt_pdf, b"not a PDF").unwrap();

    let library = resolve_pdfium_library(None).unwrap();
    let pdfium = shared_pdfium(&library).unwrap();
    let mut notices = Vec::new();
    let outcome = convert_pdfs(temp.path(), pdfium, &mut |notice| notices.push(notice)).unwrap();

    assert_eq!(PDFIUM_VERSION, "151.0.7920.0");
    assert_eq!(outcome.processed, 1);
    assert_eq!(outcome.changed, 1);
    assert_eq!(outcome.failed_files, 1);
    assert_eq!(notices.len(), 5);
    assert_eq!(
        notices
            .iter()
            .map(|notice| notice.level)
            .collect::<Vec<_>>(),
        [
            NoticeLevel::Info,
            NoticeLevel::Error,
            NoticeLevel::Info,
            NoticeLevel::Success,
            NoticeLevel::Info,
        ]
    );
    assert_eq!(notices[0].message, "Converting PDF: corrupt.pdf");
    assert!(notices[1].message.starts_with("Failed to convert PDF "));
    assert_eq!(notices[2].message, "Converting PDF: one-page.pdf");
    assert_eq!(notices[3].message, "PDF converted: one-page.pdf");
    assert_eq!(notices[4].message, "Removed original PDF: one-page.pdf");
    assert!(!valid_pdf.exists());
    assert!(corrupt_pdf.exists());
    assert!(!temp.path().join("corrupt.png").exists());
    assert_eq!(
        image::open(temp.path().join("one-page.png"))
            .unwrap()
            .dimensions(),
        (1_190, 1_684)
    );
}

#[test]
fn pdf_batch_caps_scale_two_render_dimensions() {
    let temp = tempdir().unwrap();
    let large_pdf = temp.path().join("large-page.pdf");
    save_empty_pdf(&large_pdf, 2_000, 1_125);

    let library = resolve_pdfium_library(None).unwrap();
    let pdfium = shared_pdfium(&library).unwrap();
    let mut notices = Vec::new();
    let outcome = convert_pdfs(temp.path(), pdfium, &mut |notice| notices.push(notice)).unwrap();

    assert_eq!(outcome.processed, 1);
    assert_eq!(outcome.changed, 1);
    assert_eq!(outcome.failed_files, 0);
    assert_eq!(notices.len(), 3);
    assert!(!large_pdf.exists());
    assert_eq!(
        image::open(temp.path().join("large-page.png"))
            .unwrap()
            .dimensions(),
        (PDF_RENDER_MAX_WIDTH as u32, PDF_RENDER_MAX_HEIGHT as u32)
    );
}
