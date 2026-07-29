use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use image::{DynamicImage, ImageFormat};
use pdfium_render::prelude::{PdfRenderConfig, Pdfium};
use thiserror::Error;

use super::files::{create_temporary_file, remove_if_exists, replace_file};
use super::fs_safety::is_link_like;
use super::types::{PipelineNotice, ProcessingOutcome};

pub const PDF_RENDER_SCALE: f32 = 2.0;

static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

#[derive(Debug, Error)]
pub enum PdfBatchError {
    #[error("cannot read PDF folder {path}: {source}")]
    ReadDirectory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot inspect PDF candidate {path}: {source}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

pub fn shared_pdfium(library: &Path) -> Result<&'static Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            Pdfium::bind_to_library(library)
                .map(Pdfium::new)
                .map_err(|error| {
                    format!(
                        "failed to bind PDFium library at {}: {error}",
                        library.display()
                    )
                })
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn convert_pdfs(folder: &Path, pdfium: &Pdfium) -> Result<ProcessingOutcome, PdfBatchError> {
    let mut entries = fs::read_dir(folder)
        .map_err(|source| PdfBatchError::ReadDirectory {
            path: folder.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| PdfBatchError::ReadDirectory {
            path: folder.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut outcome = ProcessingOutcome::default();
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|source| PdfBatchError::Inspect {
            path: path.clone(),
            source,
        })?;
        if is_link_like(&path, &file_type).map_err(|source| PdfBatchError::Inspect {
            path: path.clone(),
            source,
        })? {
            outcome.notices.push(PipelineNotice::warning(
                format!("Skipped symlink PDF: {}", path.display()),
                Some(path),
            ));
            continue;
        }
        if !file_type.is_file() || !has_pdf_extension(&path) {
            continue;
        }

        match convert_pdf(&path, pdfium) {
            Ok(output) => {
                outcome.processed += 1;
                outcome.changed += 1;
                outcome.notices.push(PipelineNotice::success(
                    format!("PDF converted: {}", entry.file_name().to_string_lossy()),
                    Some(output),
                ));
                outcome.notices.push(PipelineNotice::info(
                    format!(
                        "Removed original PDF: {}",
                        entry.file_name().to_string_lossy()
                    ),
                    Some(path),
                ));
            }
            Err(error) => {
                outcome.failed_files += 1;
                outcome.notices.push(PipelineNotice::error(
                    format!("Failed to convert PDF {}: {error}", path.display()),
                    Some(path),
                ));
            }
        }
    }

    Ok(outcome)
}

fn has_pdf_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn convert_pdf(path: &Path, pdfium: &Pdfium) -> Result<PathBuf, String> {
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|error| error.to_string())?;
    let page = document
        .pages()
        .first()
        .map_err(|error| error.to_string())?;
    let image = page
        .render_with_config(&PdfRenderConfig::new().scale_page_by_factor(PDF_RENDER_SCALE))
        .and_then(|bitmap| bitmap.as_image())
        .map_err(|error| error.to_string())?;
    let output = path.with_extension("png");
    write_png(&output, &image)?;
    fs::remove_file(path).map_err(|error| error.to_string())?;
    Ok(output)
}

fn write_png(path: &Path, image: &DynamicImage) -> Result<(), String> {
    let (temporary_path, temporary_file) =
        create_temporary_file(path).map_err(|error| error.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut writer = BufWriter::new(temporary_file);
        image
            .write_to(&mut writer, ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
        replace_file(&temporary_path, path).map_err(|error| error.to_string())
    })();

    if result.is_err() {
        remove_if_exists(&temporary_path);
    }
    result
}
