use std::fs;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngDecoder, PngEncoder};
use image::imageops::FilterType as ResizeFilter;
use image::{
    DynamicImage, ExtendedColorType, ImageBuffer, ImageDecoder, ImageEncoder, ImageError,
    ImageFormat, Limits, Luma, RgbImage,
};
use jpeg_decoder::{CodingProcess, Decoder as JpegDecoder, PixelFormat as JpegPixelFormat};
use thiserror::Error;

use super::files::{create_temporary_file, remove_if_exists, replace_file};
use super::fs_safety::is_link_like;
use super::types::{PipelineNotice, ProcessingOutcome};

pub const MAX_IMAGE_WIDTH: u32 = 1_920;
pub const MAX_IMAGE_HEIGHT: u32 = 1_080;
pub const JPEG_QUALITY: u8 = 70;
pub const IMAGE_DECODE_ALLOCATION_LIMIT_BYTES: u64 = 1_800 * 1024 * 1024;

const FORMAT_PROBE_BYTES: usize = 32;

struct ResizeChange {
    original: (u32, u32),
    resized: (u32, u32),
    detected_format: ImageFormat,
    destination_format: ImageFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PngDecodePlan {
    dimensions: (u32, u32),
    output_bytes: u64,
    inner_allocation_budget: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct JpegAllocationPlan {
    coefficient_bytes: u64,
    coefficient_work_bytes: u64,
    component_plane_bytes: u64,
    decoded_bytes: u64,
    conversion_bytes: u64,
    total_bytes: u64,
    decoder_output_limit: usize,
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
                outcome.record_failure(path.clone(), error.clone());
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
    let png_plan = if detected_format == ImageFormat::Png {
        Some(inspect_png(path)?)
    } else {
        None
    };
    let original = match png_plan {
        Some(plan) => plan.dimensions,
        None => jpeg_dimensions(path)?,
    };
    let Some(target) = target_dimensions(original.0, original.1) else {
        return Ok(None);
    };
    let image = match detected_format {
        ImageFormat::Jpeg => decode_scaled_jpeg(path, original, target)?,
        ImageFormat::Png => decode_png(
            path,
            &png_plan.ok_or_else(|| "PNG decode plan is unavailable".to_owned())?,
        )?,
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

fn jpeg_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut decoder = JpegDecoder::new(BufReader::new(file));
    decoder.read_info().map_err(|error| error.to_string())?;
    let info = decoder
        .info()
        .ok_or_else(|| "JPEG metadata is unavailable".to_owned())?;
    Ok((u32::from(info.width), u32::from(info.height)))
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

    let allocation = jpeg_allocation_plan(
        original,
        scaled,
        source_info.pixel_format,
        source_info.coding_process,
    )?;
    decoder.set_max_decoding_buffer_size(allocation.decoder_output_limit);
    let pixels = decoder.decode().map_err(|error| {
        format!(
            "JPEG {}x{} reduced decode to {}x{} failed (estimated aggregate allocation {}): {error}",
            original.0,
            original.1,
            scaled.0,
            scaled.1,
            format_mebibytes(allocation.total_bytes)
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

fn inspect_png(path: &Path) -> Result<PngDecodePlan, String> {
    let decoder = open_png_decoder(path, IMAGE_DECODE_ALLOCATION_LIMIT_BYTES)
        .map_err(|error| format_png_error(error, None))?;
    let dimensions = decoder.dimensions();
    let output_bytes = decoder.total_bytes();
    let inner_allocation_budget = png_inner_allocation_budget(output_bytes)?;
    Ok(PngDecodePlan {
        dimensions,
        output_bytes,
        inner_allocation_budget,
    })
}

fn decode_png(path: &Path, plan: &PngDecodePlan) -> Result<DynamicImage, String> {
    let decoder = open_png_decoder(path, plan.inner_allocation_budget)
        .map_err(|error| format_png_error(error, Some(plan)))?;
    if decoder.dimensions() != plan.dimensions || decoder.total_bytes() != plan.output_bytes {
        return Err("PNG changed while it was being inspected for safe decoding".to_owned());
    }
    DynamicImage::from_decoder(decoder).map_err(|error| format_png_error(error, Some(plan)))
}

fn open_png_decoder(
    path: &Path,
    max_alloc: u64,
) -> Result<PngDecoder<BufReader<File>>, ImageError> {
    let file = File::open(path).map_err(ImageError::IoError)?;
    PngDecoder::with_limits(BufReader::new(file), image_decode_limits(max_alloc))
}

fn png_inner_allocation_budget(output_bytes: u64) -> Result<u64, String> {
    IMAGE_DECODE_ALLOCATION_LIMIT_BYTES
        .checked_sub(output_bytes)
        .ok_or_else(|| {
            format!(
                "PNG output requires {}, above the {} aggregate decode allocation budget",
                format_mebibytes(output_bytes),
                format_mebibytes(IMAGE_DECODE_ALLOCATION_LIMIT_BYTES)
            )
        })
}

fn format_png_error(error: ImageError, plan: Option<&PngDecodePlan>) -> String {
    if matches!(error, ImageError::Limits(_)) {
        if let Some(plan) = plan {
            return format!(
                "PNG {}x{} exceeded the {} aggregate decode allocation budget ({} output plus at most {} decoder working memory)",
                plan.dimensions.0,
                plan.dimensions.1,
                format_mebibytes(IMAGE_DECODE_ALLOCATION_LIMIT_BYTES),
                format_mebibytes(plan.output_bytes),
                format_mebibytes(plan.inner_allocation_budget)
            );
        }
        return format!(
            "PNG inspection exceeded the {} aggregate decode allocation budget",
            format_mebibytes(IMAGE_DECODE_ALLOCATION_LIMIT_BYTES)
        );
    }
    error.to_string()
}

fn image_decode_limits(max_alloc: u64) -> Limits {
    let mut limits = Limits::default();
    limits.max_alloc = Some(max_alloc);
    limits
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

fn jpeg_allocation_plan(
    original: (u32, u32),
    scaled: (u32, u32),
    pixel_format: JpegPixelFormat,
    coding_process: CodingProcess,
) -> Result<JpegAllocationPlan, String> {
    let scaled_pixels = u64::from(scaled.0).saturating_mul(u64::from(scaled.1));
    let decoded_bytes = scaled_pixels.saturating_mul(pixel_format.pixel_bytes() as u64);
    let conversion_bytes = match pixel_format {
        JpegPixelFormat::L16 => decoded_bytes,
        JpegPixelFormat::CMYK32 => scaled_pixels.saturating_mul(3),
        JpegPixelFormat::L8 | JpegPixelFormat::RGB24 => 0,
    };
    let coefficient_bytes = if coding_process == CodingProcess::DctProgressive {
        progressive_coefficient_bytes(original.0, original.1, jpeg_component_count(pixel_format))
    } else {
        0
    };
    // The rayon worker can queue copied progressive coefficient rows while the
    // decoder retains the full coefficient planes. One additional full copy is
    // a conservative bound for those simultaneous row tasks.
    let coefficient_work_bytes = coefficient_bytes;
    let component_plane_bytes = padded_component_plane_bytes(
        scaled.0,
        scaled.1,
        jpeg_component_count(pixel_format),
        if pixel_format == JpegPixelFormat::L16 {
            2
        } else {
            1
        },
    );
    let total_bytes = coefficient_bytes
        .saturating_add(coefficient_work_bytes)
        .saturating_add(component_plane_bytes)
        .saturating_add(decoded_bytes)
        .saturating_add(conversion_bytes);
    if total_bytes > IMAGE_DECODE_ALLOCATION_LIMIT_BYTES {
        return Err(format!(
            "JPEG {}x{} reduced decode to {}x{} requires an estimated aggregate allocation of {} ({} coefficients + {} coefficient work + {} component planes + {} decoded output + {} conversion), above the {} budget",
            original.0,
            original.1,
            scaled.0,
            scaled.1,
            format_mebibytes(total_bytes),
            format_mebibytes(coefficient_bytes),
            format_mebibytes(coefficient_work_bytes),
            format_mebibytes(component_plane_bytes),
            format_mebibytes(decoded_bytes),
            format_mebibytes(conversion_bytes),
            format_mebibytes(IMAGE_DECODE_ALLOCATION_LIMIT_BYTES)
        ));
    }

    let decoder_output_limit = IMAGE_DECODE_ALLOCATION_LIMIT_BYTES
        .saturating_sub(coefficient_bytes)
        .saturating_sub(coefficient_work_bytes)
        .saturating_sub(component_plane_bytes)
        .saturating_sub(conversion_bytes)
        .try_into()
        .map_err(|_| "JPEG decoder allocation budget does not fit this platform".to_owned())?;
    Ok(JpegAllocationPlan {
        coefficient_bytes,
        coefficient_work_bytes,
        component_plane_bytes,
        decoded_bytes,
        conversion_bytes,
        total_bytes,
        decoder_output_limit,
    })
}

fn padded_component_plane_bytes(
    width: u32,
    height: u32,
    components: u64,
    bytes_per_sample: u64,
) -> u64 {
    // jpeg-decoder keeps one reduced IDCT plane per component while allocating
    // the interleaved output. Conservatively allow one maximum 32-sample MCU of
    // padding on each axis for supported sampling layouts.
    u64::from(width)
        .saturating_add(31)
        .saturating_mul(u64::from(height).saturating_add(31))
        .saturating_mul(components)
        .saturating_mul(bytes_per_sample)
}

fn progressive_coefficient_bytes(width: u32, height: u32, components: u64) -> u64 {
    // Conservatively include the maximum 32-sample MCU padding on both axes.
    let blocks_wide = u64::from(width).saturating_add(31).div_ceil(8);
    let blocks_high = u64::from(height).saturating_add(31).div_ceil(8);
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
    fn jpeg_budget_aggregates_progressive_coefficients_output_and_conversion() {
        assert_eq!(
            progressive_coefficient_bytes(21_024, 14_882, 3),
            1_884_933_120
        );

        let progressive = jpeg_allocation_plan(
            (8_000, 8_000),
            (2_000, 2_000),
            JpegPixelFormat::RGB24,
            CodingProcess::DctProgressive,
        )
        .unwrap();
        assert_eq!(progressive.coefficient_bytes, 387_078_144);
        assert_eq!(progressive.coefficient_work_bytes, 387_078_144);
        assert_eq!(progressive.component_plane_bytes, 12_374_883);
        assert_eq!(progressive.decoded_bytes, 12_000_000);
        assert_eq!(progressive.conversion_bytes, 0);
        assert_eq!(progressive.total_bytes, 798_531_171);
        assert_eq!(
            progressive.decoder_output_limit as u64,
            IMAGE_DECODE_ALLOCATION_LIMIT_BYTES
                - progressive.coefficient_bytes
                - progressive.coefficient_work_bytes
                - progressive.component_plane_bytes
        );

        let cmyk = jpeg_allocation_plan(
            (4_000, 2_000),
            (2_000, 1_000),
            JpegPixelFormat::CMYK32,
            CodingProcess::DctSequential,
        )
        .unwrap();
        assert_eq!(cmyk.coefficient_work_bytes, 0);
        assert_eq!(cmyk.component_plane_bytes, 8_375_844);
        assert_eq!(cmyk.decoded_bytes, 8_000_000);
        assert_eq!(cmyk.conversion_bytes, 6_000_000);
        assert_eq!(cmyk.total_bytes, 22_375_844);
        assert_eq!(
            cmyk.decoder_output_limit as u64,
            IMAGE_DECODE_ALLOCATION_LIMIT_BYTES
                - cmyk.component_plane_bytes
                - cmyk.conversion_bytes
        );

        let l16 = jpeg_allocation_plan(
            (2_000, 1_000),
            (1_000, 500),
            JpegPixelFormat::L16,
            CodingProcess::DctSequential,
        )
        .unwrap();
        assert_eq!(l16.component_plane_bytes, 1_094_922);
        assert_eq!(l16.decoded_bytes, 1_000_000);
        assert_eq!(l16.conversion_bytes, 1_000_000);
        assert_eq!(l16.total_bytes, 3_094_922);

        let error = jpeg_allocation_plan(
            (21_024, 14_882),
            (3_052, 2_160),
            JpegPixelFormat::RGB24,
            CodingProcess::DctProgressive,
        )
        .unwrap_err();
        assert!(error.contains("estimated aggregate allocation"));
    }

    #[test]
    fn png_output_and_inner_decoder_share_the_1800_mib_budget() {
        assert_eq!(IMAGE_DECODE_ALLOCATION_LIMIT_BYTES, 1_800 * 1024 * 1024);
        let output_bytes = 1_600 * 1024 * 1024;
        let inner_budget = png_inner_allocation_budget(output_bytes).unwrap();
        assert_eq!(inner_budget, 200 * 1024 * 1024);
        assert_eq!(
            image_decode_limits(inner_budget).max_alloc,
            Some(inner_budget)
        );
        assert!(png_inner_allocation_budget(IMAGE_DECODE_ALLOCATION_LIMIT_BYTES + 1).is_err());
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
