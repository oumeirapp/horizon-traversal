use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::imageops::FilterType as ResizeFilter;
use image::{DynamicImage, ExtendedColorType, GenericImageView, ImageEncoder};
use thiserror::Error;

use super::files::{create_temporary_file, remove_if_exists, replace_file};
use super::fs_safety::is_link_like;
use super::types::{PipelineNotice, ProcessingOutcome};

pub const MAX_IMAGE_WIDTH: u32 = 1_920;
pub const MAX_IMAGE_HEIGHT: u32 = 1_080;
pub const JPEG_QUALITY: u8 = 70;

struct ResizeChange {
    original: (u32, u32),
    resized: (u32, u32),
}

#[derive(Debug, Error)]
pub enum ImageBatchError {
    #[error("cannot read image folder {path}: {source}")]
    ReadDirectory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot inspect image candidate {path}: {source}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

pub fn target_dimensions(width: u32, height: u32) -> Option<(u32, u32)> {
    if width <= MAX_IMAGE_WIDTH && height <= MAX_IMAGE_HEIGHT {
        return None;
    }

    let width_ratio = f64::from(MAX_IMAGE_WIDTH) / f64::from(width);
    let height_ratio = f64::from(MAX_IMAGE_HEIGHT) / f64::from(height);
    let ratio = width_ratio.min(height_ratio);
    Some((
        (f64::from(width) * ratio).round().max(1.0) as u32,
        (f64::from(height) * ratio).round().max(1.0) as u32,
    ))
}

pub fn resize_images(folder: &Path) -> Result<ProcessingOutcome, ImageBatchError> {
    let mut entries = fs::read_dir(folder)
        .map_err(|source| ImageBatchError::ReadDirectory {
            path: folder.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| ImageBatchError::ReadDirectory {
            path: folder.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut outcome = ProcessingOutcome::default();
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| ImageBatchError::Inspect {
                path: path.clone(),
                source,
            })?;
        if is_link_like(&path, &file_type).map_err(|source| ImageBatchError::Inspect {
            path: path.clone(),
            source,
        })? {
            outcome.notices.push(PipelineNotice::warning(
                format!("Skipped symlink image: {}", path.display()),
                Some(path),
            ));
            continue;
        }
        if !file_type.is_file() || !is_resizable_image(&path) {
            continue;
        }

        match resize_image(&path) {
            Ok(Some(change)) => {
                outcome.processed += 1;
                outcome.changed += 1;
                outcome.notices.push(PipelineNotice::success(
                    format!(
                        "Image resized: {} ({}x{} -> {}x{})",
                        entry.file_name().to_string_lossy(),
                        change.original.0,
                        change.original.1,
                        change.resized.0,
                        change.resized.1
                    ),
                    Some(path),
                ));
            }
            Ok(None) => {
                outcome.processed += 1;
                outcome.notices.push(PipelineNotice::info(
                    format!(
                        "Image within bounds, skipped: {}",
                        entry.file_name().to_string_lossy()
                    ),
                    Some(path),
                ));
            }
            Err(error) => {
                outcome.failed_files += 1;
                outcome.notices.push(PipelineNotice::error(
                    format!("Failed to resize image {}: {error}", path.display()),
                    Some(path),
                ));
            }
        }
    }

    Ok(outcome)
}

fn is_resizable_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("jpg")
                || extension.eq_ignore_ascii_case("jpeg")
                || extension.eq_ignore_ascii_case("png")
        })
}

fn resize_image(path: &Path) -> Result<Option<ResizeChange>, String> {
    let image = image::open(path).map_err(|error| error.to_string())?;
    let original = image.dimensions();
    let Some(target) = target_dimensions(original.0, original.1) else {
        return Ok(None);
    };
    let resized = image.resize_exact(target.0, target.1, ResizeFilter::Lanczos3);
    write_resized_image(path, &resized).map_err(|error| error.to_string())?;
    Ok(Some(ResizeChange {
        original,
        resized: target,
    }))
}

fn write_resized_image(path: &Path, image: &DynamicImage) -> Result<(), String> {
    let (temporary_path, temporary_file) =
        create_temporary_file(path).map_err(|error| error.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut writer = BufWriter::new(temporary_file);
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();

        if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
            let rgb = image.to_rgb8();
            JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY)
                .encode(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    ExtendedColorType::Rgb8,
                )
                .map_err(|error| error.to_string())?;
        } else {
            PngEncoder::new_with_quality(&mut writer, CompressionType::Best, FilterType::Adaptive)
                .write_image(
                    image.as_bytes(),
                    image.width(),
                    image.height(),
                    image.color().into(),
                )
                .map_err(|error| error.to_string())?;
        }

        writer.flush().map_err(|error| error.to_string())?;
        replace_file(&temporary_path, path).map_err(|error| error.to_string())
    })();

    if result.is_err() {
        remove_if_exists(&temporary_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizing_matches_lanczos_thumbnail_bounds_without_upscaling() {
        let cases = [
            ((800, 600), None),
            ((1_920, 1_080), None),
            ((4_000, 2_000), Some((1_920, 960))),
            ((2_000, 4_000), Some((540, 1_080))),
            ((2_500, 1_400), Some((1_920, 1_075))),
            ((2_000, 2_000), Some((1_080, 1_080))),
        ];

        for ((width, height), expected) in cases {
            assert_eq!(target_dimensions(width, height), expected);
        }
    }
}
