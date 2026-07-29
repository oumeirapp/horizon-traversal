use std::env;
use std::path::{Path, PathBuf};

use pdfium_render::prelude::Pdfium;
use thiserror::Error;

pub const PDFIUM_VERSION: &str = "151.0.7920.0";

#[derive(Debug, Error)]
pub enum NativeAssetError {
    #[error("cannot determine the current executable path: {0}")]
    CurrentExecutable(#[source] std::io::Error),
    #[error("bundled PDFium {version} was not found; checked: {candidates}")]
    PdfiumNotFound {
        version: &'static str,
        candidates: String,
    },
}

pub fn resolve_pdfium_library(
    resource_directory: Option<&Path>,
) -> Result<PathBuf, NativeAssetError> {
    let library_name = Pdfium::pdfium_platform_library_name();
    let mut candidates = Vec::new();

    if let Some(resource_directory) = resource_directory {
        #[cfg(target_os = "macos")]
        if let Some(contents_directory) = resource_directory.parent() {
            candidates.push(contents_directory.join("Frameworks").join(&library_name));
        }

        #[cfg(not(target_os = "macos"))]
        candidates.push(resource_directory.join("native").join(&library_name));
    }

    let executable = env::current_exe().map_err(NativeAssetError::CurrentExecutable)?;
    if let Some(executable_directory) = executable.parent() {
        candidates.push(executable_directory.join("Frameworks").join(&library_name));
        if let Some(target_directory) = executable_directory.parent() {
            candidates.push(target_directory.join("Frameworks").join(&library_name));
        }
    }

    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("native")
            .join(&library_name),
    );

    if let Some(candidate) = candidates.iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate.clone());
    }

    Err(NativeAssetError::PdfiumNotFound {
        version: PDFIUM_VERSION,
        candidates: candidates
            .iter()
            .map(|candidate| candidate.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    })
}
