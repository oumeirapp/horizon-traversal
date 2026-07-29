use std::env;
use std::ffi::OsStr;
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
    let executable = env::current_exe().map_err(NativeAssetError::CurrentExecutable)?;
    let candidates = packaged_pdfium_candidates(resource_directory, &executable, &library_name);

    // Development may load the checksum-pinned library prepared in the source
    // tree. Release builds deliberately do not compile this fallback, so a
    // packaged application cannot silently depend on a developer checkout.
    #[cfg(debug_assertions)]
    let candidates = {
        let mut development_candidates = candidates;
        development_candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("native")
                .join(&library_name),
        );
        development_candidates
    };

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

fn packaged_pdfium_candidates(
    resource_directory: Option<&Path>,
    executable: &Path,
    library_name: &OsStr,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(resource_directory) = resource_directory {
        #[cfg(target_os = "macos")]
        if let Some(contents_directory) = resource_directory.parent() {
            candidates.push(contents_directory.join("Frameworks").join(library_name));
        }

        #[cfg(not(target_os = "macos"))]
        candidates.push(resource_directory.join("native").join(library_name));
    }

    if let Some(executable_directory) = executable.parent() {
        #[cfg(target_os = "macos")]
        {
            if let Some(contents_directory) = executable_directory.parent() {
                candidates.push(contents_directory.join("Frameworks").join(library_name));
            }
        }

        #[cfg(not(target_os = "macos"))]
        candidates.push(executable_directory.join("native").join(library_name));
    }

    candidates.dedup();
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_candidates_use_the_macos_frameworks_directory() {
        let resource_directory = Path::new("/Applications/X Traversal.app/Contents/Resources");
        let executable = Path::new("/Applications/X Traversal.app/Contents/MacOS/X Traversal");

        let candidates = packaged_pdfium_candidates(
            Some(resource_directory),
            executable,
            OsStr::new("libpdfium.dylib"),
        );

        #[cfg(target_os = "macos")]
        assert_eq!(
            candidates,
            vec![PathBuf::from(
                "/Applications/X Traversal.app/Contents/Frameworks/libpdfium.dylib"
            )]
        );

        #[cfg(not(target_os = "macos"))]
        assert_eq!(
            candidates,
            vec![
                PathBuf::from(
                    "/Applications/X Traversal.app/Contents/Resources/native/libpdfium.dylib"
                ),
                PathBuf::from(
                    "/Applications/X Traversal.app/Contents/MacOS/native/libpdfium.dylib"
                ),
            ]
        );
    }

    #[test]
    fn packaged_candidates_never_include_the_source_tree() {
        let candidates = packaged_pdfium_candidates(
            None,
            Path::new("/Applications/X Traversal.app/Contents/MacOS/X Traversal"),
            OsStr::new("libpdfium.dylib"),
        );
        let manifest_directory = Path::new(env!("CARGO_MANIFEST_DIR"));

        assert!(
            candidates
                .iter()
                .all(|candidate| !candidate.starts_with(manifest_directory)),
            "release candidates must not depend on the repository"
        );
    }
}
