use std::fs;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::imageops::FilterType as ResizeFilter;
use image::{
    DynamicImage, ExtendedColorType, ImageBuffer, ImageEncoder, ImageError, ImageFormat,
    ImageReader, Luma, RgbImage,
};
use jpeg_decoder::{CodingProcess, Decoder as JpegDecoder, PixelFormat as JpegPixelFormat};
use thiserror::Error;

use super::files::{create_temporary_file, remove_if_exists, replace_file};
use super::fs_safety::is_link_like;
use super::types::{PipelineNotice, ProcessingOutcome};

pub const MAX_IMAGE_WIDTH: u32 = 1_920;
pub const MAX_IMAGE_HEIGHT: u32 = 1_080;
pub const JPEG_QUALITY: u8 = 70;
pub const JPEG_DECODE_BUFFER_LIMIT_BYTES: usize = 128 * 1024 * 1024;
pub const PROGRESSIVE_JPEG_LIMIT_BYTES: u64 = 256 * 1024 * 1024;
pub const PNG_DECODE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;

const FORMAT_PROBE_BYTES: usize = 32;

struct ResizeChange {
    original: (u32, u32),
    resized: (u32, u32),
    detected_format: ImageFormat,
    destination_format: ImageFormat,
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

pub fn resize_images(
    folder: &Path,
    on_notice: &mut impl FnMut(PipelineNotice),
) -> Result<ProcessingOutcome, ImageBatchError> {
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
            on_notice(PipelineNotice::warning(
                format!("Skipped symlink image: {}", path.display()),
                Some(path),
            ));
            continue;
        }
        if !file_type.is_file() || !is_resizable_image(&path) {
            continue;
        }

        on_notice(PipelineNotice::info(
            format!("Processing image: {}", entry.file_name().to_string_lossy()),
            Some(path.clone()),
        ));
        match resize_image(&path) {
            Ok(Some(change)) => {
                outcome.processed += 1;
                outcome.changed += 1;
                on_notice(PipelineNotice::success(
                    format!(
                        "Image resized: {} ({}x{} -> {}x{})",
                        entry.file_name().to_string_lossy(),
                        change.original.0,
                        change.original.1,
                        change.resized.0,
                        change.resized.1
                    ),
                    Some(path.clone()),
                ));
                if change.detected_format != change.destination_format {
                    on_notice(PipelineNotice::info(
                        format!(
                            "Normalized {} content to {}: {}",
                            format_name(change.detected_format),
                            format_name(change.destination_format),
                            entry.file_name().to_string_lossy()
                        ),
                        Some(path),
                    ));
                }
            }
            Ok(None) => {
                outcome.processed += 1;
                on_notice(PipelineNotice::info(
                    format!(
                        "Image within bounds, skipped: {}",
                        entry.file_name().to_string_lossy()
                    ),
                    Some(path),
                ));
            }
            Err(error) => {
                outcome.failed_files += 1;
                on_notice(PipelineNotice::error(
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
    let detected_format = detect_image_format(path)?;
    let destination_format = destination_format(path)?;
    let original = image_dimensions(path, detected_format)?;
    let Some(target) = target_dimensions(original.0, original.1) else {
        return Ok(None);
    };
    let image = match detected_format {
        ImageFormat::Jpeg => decode_scaled_jpeg(path, original, target)?,
        ImageFormat::Png => decode_png(path, original)?,
        format => {
            return Err(format!(
                "unsupported image content format {}; only JPEG and PNG are supported",
                format_name(format)
            ))
        }
    };
    let resized = image.resize_exact(target.0, target.1, ResizeFilter::Lanczos3);
    write_resized_image(path, &resized).map_err(|error| error.to_string())?;
    Ok(Some(ResizeChange {
        original,
        resized: target,
        detected_format,
        destination_format,
    }))
}

fn detect_image_format(path: &Path) -> Result<ImageFormat, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut header = [0_u8; FORMAT_PROBE_BYTES];
    let length = file.read(&mut header).map_err(|error| error.to_string())?;
    let format = image::guess_format(&header[..length])
        .map_err(|error| format!("cannot detect image content from its signature: {error}"))?;
    match format {
        ImageFormat::Jpeg | ImageFormat::Png => Ok(format),
        unsupported => Err(format!(
            "detected unsupported {} content; only JPEG and PNG are supported",
            format_name(unsupported)
        )),
    }
}

fn destination_format(path: &Path) -> Result<ImageFormat, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => Ok(ImageFormat::Jpeg),
        Some("png") => Ok(ImageFormat::Png),
        _ => Err("image destination must have a JPEG or PNG extension".to_owned()),
    }
}

fn image_dimensions(path: &Path, format: ImageFormat) -> Result<(u32, u32), String> {
    if format == ImageFormat::Jpeg {
        let file = File::open(path).map_err(|error| error.to_string())?;
        let mut decoder = JpegDecoder::new(BufReader::new(file));
        decoder.read_info().map_err(|error| error.to_string())?;
        let info = decoder
            .info()
            .ok_or_else(|| "JPEG metadata is unavailable".to_owned())?;
        return Ok((u32::from(info.width), u32::from(info.height)));
    }

    let mut reader = ImageReader::open(path).map_err(|error| error.to_string())?;
    reader.set_format(format);
    reader.into_dimensions().map_err(|error| error.to_string())
}

fn decode_scaled_jpeg(
    path: &Path,
    original: (u32, u32),
    target: (u32, u32),
) -> Result<DynamicImage, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut decoder = JpegDecoder::new(BufReader::new(file));
    decoder.read_info().map_err(|error| error.to_string())?;
    let source_info = decoder
        .info()
        .ok_or_else(|| "JPEG metadata is unavailable".to_owned())?;

    if source_info.coding_process == CodingProcess::DctProgressive {
        let estimated = progressive_coefficient_bytes(
            original.0,
            original.1,
            jpeg_component_count(source_info.pixel_format),
        );
        if estimated > PROGRESSIVE_JPEG_LIMIT_BYTES {
            return Err(format!(
                "progressive JPEG {}x{} requires an estimated {} coefficient buffer, above the {} safeguard",
                original.0,
                original.1,
                format_mebibytes(estimated),
                format_mebibytes(PROGRESSIVE_JPEG_LIMIT_BYTES)
            ));
        }
    }

    let requested_width = target.0.saturating_mul(2).min(original.0).max(target.0) as u16;
    let requested_height = target.1.saturating_mul(2).min(original.1).max(target.1) as u16;
    let (scaled_width, scaled_height) = decoder
        .scale(requested_width, requested_height)
        .map_err(|error| error.to_string())?;
    let scaled = (u32::from(scaled_width), u32::from(scaled_height));
    if scaled.0 < target.0 || scaled.1 < target.1 {
        return Err(format!(
            "JPEG reduced decode produced {}x{}, below the required {}x{} output",
            scaled.0, scaled.1, target.0, target.1
        ));
    }

    let decoded_bytes = u64::from(scaled.0)
        .saturating_mul(u64::from(scaled.1))
        .saturating_mul(source_info.pixel_format.pixel_bytes() as u64);
    if decoded_bytes > JPEG_DECODE_BUFFER_LIMIT_BYTES as u64 {
        return Err(format!(
            "JPEG {}x{} would use {} for its reduced {}x{} decode, above the {} safeguard",
            original.0,
            original.1,
            format_mebibytes(decoded_bytes),
            scaled.0,
            scaled.1,
            format_mebibytes(JPEG_DECODE_BUFFER_LIMIT_BYTES as u64)
        ));
    }

    decoder.set_max_decoding_buffer_size(JPEG_DECODE_BUFFER_LIMIT_BYTES);
    let pixels = decoder.decode().map_err(|error| {
        format!(
            "JPEG {}x{} reduced decode to {}x{} failed (estimated {}): {error}",
            original.0,
            original.1,
            scaled.0,
            scaled.1,
            format_mebibytes(decoded_bytes)
        )
    })?;
    let decoded_info = decoder
        .info()
        .ok_or_else(|| "decoded JPEG metadata is unavailable".to_owned())?;
    dynamic_image_from_jpeg(
        pixels,
        u32::from(decoded_info.width),
        u32::from(decoded_info.height),
        decoded_info.pixel_format,
    )
}

fn decode_png(path: &Path, dimensions: (u32, u32)) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::open(path).map_err(|error| error.to_string())?;
    reader.set_format(ImageFormat::Png);
    reader.decode().map_err(|error| {
        if matches!(error, ImageError::Limits(_)) {
            let estimate = u64::from(dimensions.0)
                .saturating_mul(u64::from(dimensions.1))
                .saturating_mul(4);
            format!(
                "PNG {}x{} exceeded the {} decode safeguard (RGBA output alone is approximately {}; decoder working memory may be higher); larger PNG files require tiled processing",
                dimensions.0,
                dimensions.1,
                format_mebibytes(PNG_DECODE_LIMIT_BYTES),
                format_mebibytes(estimate)
            )
        } else {
            error.to_string()
        }
    })
}

fn dynamic_image_from_jpeg(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    pixel_format: JpegPixelFormat,
) -> Result<DynamicImage, String> {
    match pixel_format {
        JpegPixelFormat::L8 => ImageBuffer::from_raw(width, height, pixels)
            .map(DynamicImage::ImageLuma8)
            .ok_or_else(|| "JPEG grayscale buffer has an invalid length".to_owned()),
        JpegPixelFormat::L16 => {
            if !pixels.len().is_multiple_of(2) {
                return Err("16-bit JPEG buffer has an invalid length".to_owned());
            }
            let samples = pixels
                .chunks_exact(2)
                .map(|sample| u16::from_ne_bytes([sample[0], sample[1]]))
                .collect::<Vec<_>>();
            ImageBuffer::<Luma<u16>, Vec<u16>>::from_raw(width, height, samples)
                .map(DynamicImage::ImageLuma16)
                .ok_or_else(|| "16-bit JPEG grayscale buffer has an invalid length".to_owned())
        }
        JpegPixelFormat::RGB24 => RgbImage::from_raw(width, height, pixels)
            .map(DynamicImage::ImageRgb8)
            .ok_or_else(|| "JPEG RGB buffer has an invalid length".to_owned()),
        JpegPixelFormat::CMYK32 => {
            if !pixels.len().is_multiple_of(4) {
                return Err("JPEG CMYK buffer has an invalid length".to_owned());
            }
            let mut rgb = Vec::with_capacity(pixels.len() / 4 * 3);
            for pixel in pixels.chunks_exact(4) {
                let c = u16::from(pixel[0]);
                let m = u16::from(pixel[1]);
                let y = u16::from(pixel[2]);
                let k = u16::from(pixel[3]);
                rgb.push((((255 - c) * (255 - k) + 127) / 255) as u8);
                rgb.push((((255 - m) * (255 - k) + 127) / 255) as u8);
                rgb.push((((255 - y) * (255 - k) + 127) / 255) as u8);
            }
            RgbImage::from_raw(width, height, rgb)
                .map(DynamicImage::ImageRgb8)
                .ok_or_else(|| "JPEG CMYK buffer has an invalid length".to_owned())
        }
    }
}

fn progressive_coefficient_bytes(width: u32, height: u32, components: u64) -> u64 {
    let blocks_wide = u64::from(width).div_ceil(8);
    let blocks_high = u64::from(height).div_ceil(8);
    blocks_wide
        .saturating_mul(blocks_high)
        .saturating_mul(64)
        .saturating_mul(2)
        .saturating_mul(components)
}

fn jpeg_component_count(format: JpegPixelFormat) -> u64 {
    match format {
        JpegPixelFormat::L8 | JpegPixelFormat::L16 => 1,
        JpegPixelFormat::RGB24 => 3,
        JpegPixelFormat::CMYK32 => 4,
    }
}

fn format_mebibytes(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

fn format_name(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "JPEG",
        ImageFormat::Png => "PNG",
        _ => "unsupported image",
    }
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
    use image::{ImageFormat, Rgb};
    use tempfile::tempdir;

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

    #[test]
    fn progressive_memory_estimate_accounts_for_full_coefficient_planes() {
        assert_eq!(
            progressive_coefficient_bytes(21_024, 14_882, 3),
            1_878_031_872
        );
        assert!(progressive_coefficient_bytes(21_024, 14_882, 3) > PROGRESSIVE_JPEG_LIMIT_BYTES);
    }

    #[test]
    fn jpeg_content_with_png_extension_is_resized_and_normalized() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("mislabeled.png");
        RgbImage::from_pixel(1_000, 1_081, Rgb([24, 88, 120]))
            .save_with_format(&path, ImageFormat::Jpeg)
            .unwrap();

        let mut notices = Vec::new();
        let outcome = resize_images(temp.path(), &mut |notice| notices.push(notice)).unwrap();

        assert_eq!(outcome.processed, 1);
        assert_eq!(outcome.changed, 1);
        assert_eq!(outcome.failed_files, 0);
        assert_eq!(image::image_dimensions(&path).unwrap(), (999, 1_080));
        assert_eq!(&fs::read(&path).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
        assert!(notices
            .iter()
            .any(|notice| notice.message.contains("Normalized JPEG content to PNG")));
    }
}
