use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;
use thiserror::Error;

use super::files::{human_size, remove_if_exists, replace_file};
use super::fs_safety::is_link_like;
use super::types::{PipelineNotice, ProcessingOutcome};

pub const LANDSCAPE_BOUNDS: Dimensions = Dimensions::new(1_280, 720);
pub const PORTRAIT_BOUNDS: Dimensions = Dimensions::new(720, 1_280);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

impl Dimensions {
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoMetadata {
    pub dimensions: Dimensions,
    pub duration_seconds: Option<f64>,
    pub audio_streams: usize,
    pub audio_codecs: Vec<Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioEncoding {
    None,
    Copy,
    Aac192,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeTool {
    Ffmpeg,
    Ffprobe,
}

impl NativeTool {
    pub const fn file_name(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
        }
    }
}

impl fmt::Display for NativeTool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.file_name())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("{tool} failed: {message}")]
pub struct ToolRunError {
    pub tool: NativeTool,
    pub message: String,
}

impl ToolRunError {
    pub fn new(tool: NativeTool, message: impl Into<String>) -> Self {
        Self {
            tool,
            message: message.into(),
        }
    }
}

pub trait MediaToolRunner: Send + Sync {
    fn run(&self, tool: NativeTool, arguments: &[OsString]) -> Result<ToolOutput, ToolRunError>;
}

#[derive(Clone)]
pub struct TauriMediaToolRunner<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriMediaToolRunner<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> MediaToolRunner for TauriMediaToolRunner<R> {
    fn run(&self, tool: NativeTool, arguments: &[OsString]) -> Result<ToolOutput, ToolRunError> {
        let command = self
            .app
            .shell()
            .sidecar(tool.file_name())
            .map_err(|error| ToolRunError::new(tool, error.to_string()))?
            .env_clear()
            .env("LC_ALL", "C")
            .args(arguments);
        let mut command: ProcessCommand = command.into();
        let output = command
            .output()
            .map_err(|error| ToolRunError::new(tool, error.to_string()))?;

        Ok(ToolOutput {
            success: output.status.success(),
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DimensionError {
    #[error("video dimensions must be non-zero")]
    ZeroDimension,
    #[error("video aspect ratio is too extreme for a non-upscaled even H.264 target")]
    TargetTooSmall,
}

#[derive(Debug, Error)]
pub enum VideoBatchError {
    #[error("cannot read video folder {path}: {source}")]
    ReadDirectory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot inspect video candidate {path}: {source}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

pub fn target_dimensions(width: u32, height: u32) -> Result<Option<Dimensions>, DimensionError> {
    if width == 0 || height == 0 {
        return Err(DimensionError::ZeroDimension);
    }

    let bounds = if width >= height {
        LANDSCAPE_BOUNDS
    } else {
        PORTRAIT_BOUNDS
    };
    if width <= bounds.width && height <= bounds.height {
        return Ok(None);
    }

    let width_limited = u128::from(bounds.width) * u128::from(height)
        <= u128::from(bounds.height) * u128::from(width);
    let (scaled_width, scaled_height) = if width_limited {
        (
            u128::from(bounds.width),
            u128::from(height) * u128::from(bounds.width) / u128::from(width),
        )
    } else {
        (
            u128::from(width) * u128::from(bounds.height) / u128::from(height),
            u128::from(bounds.height),
        )
    };

    let target = Dimensions::new((scaled_width as u32) & !1, (scaled_height as u32) & !1);
    if target.width < 2 || target.height < 2 {
        return Err(DimensionError::TargetTooSmall);
    }

    Ok(Some(target))
}

pub fn probe_video(runner: &impl MediaToolRunner, path: &Path) -> Result<VideoMetadata, String> {
    let arguments = vec![
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-print_format"),
        OsString::from("json"),
        OsString::from("-show_streams"),
        OsString::from("-show_format"),
        path.as_os_str().to_os_string(),
    ];
    let output = runner
        .run(NativeTool::Ffprobe, &arguments)
        .map_err(|error| error.to_string())?;
    ensure_success(NativeTool::Ffprobe, &output)?;

    let document: ProbeDocument = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid ffprobe JSON: {error}"))?;
    let video = document
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| "no video stream found".to_owned())?;
    let width = video
        .width
        .filter(|width| *width > 0)
        .ok_or_else(|| "video stream has no valid width".to_owned())?;
    let height = video
        .height
        .filter(|height| *height > 0)
        .ok_or_else(|| "video stream has no valid height".to_owned())?;

    let audio_streams = document
        .streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some("audio"))
        .collect::<Vec<_>>();

    Ok(VideoMetadata {
        dimensions: Dimensions::new(width, height),
        duration_seconds: document.format.duration.and_then(NumberOrString::into_f64),
        audio_streams: audio_streams.len(),
        audio_codecs: audio_streams
            .into_iter()
            .map(|stream| stream.codec_name.clone())
            .collect(),
    })
}

fn audio_encoding(metadata: &VideoMetadata, output: &Path) -> AudioEncoding {
    if metadata.audio_streams == 0 {
        return AudioEncoding::None;
    }

    if !is_mp4_or_mov(output) {
        return AudioEncoding::Copy;
    }

    let can_copy = metadata.audio_codecs.iter().all(|codec| {
        codec.as_deref().is_some_and(|codec| {
            codec.eq_ignore_ascii_case("aac") || codec.eq_ignore_ascii_case("alac")
        })
    });
    if can_copy {
        AudioEncoding::Copy
    } else {
        AudioEncoding::Aac192
    }
}

pub fn ffmpeg_arguments(
    input: &Path,
    output: &Path,
    target: Dimensions,
    audio_encoding: AudioEncoding,
) -> Vec<OsString> {
    let mut arguments = ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    arguments.push(input.as_os_str().to_os_string());
    arguments.extend(
        ["-map", "0:v:0", "-map", "0:a?", "-vf"]
            .into_iter()
            .map(OsString::from),
    );
    arguments.push(OsString::from(format!(
        "scale={}:{}",
        target.width, target.height
    )));
    arguments.extend(
        [
            "-map_metadata",
            "0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
        ]
        .into_iter()
        .map(OsString::from),
    );

    match audio_encoding {
        AudioEncoding::None => {}
        AudioEncoding::Copy => {
            arguments.extend(["-c:a", "copy"].into_iter().map(OsString::from));
        }
        AudioEncoding::Aac192 => {
            arguments.extend(
                ["-c:a", "aac", "-b:a", "192k"]
                    .into_iter()
                    .map(OsString::from),
            );
        }
    }
    if audio_encoding != AudioEncoding::None {
        arguments.extend(
            ["-disposition:a:0", "default"]
                .into_iter()
                .map(OsString::from),
        );
    }
    if is_mp4_or_mov(output) {
        arguments.extend(["-movflags", "+faststart"].into_iter().map(OsString::from));
    }
    arguments.push(output.as_os_str().to_os_string());
    arguments
}

pub fn resize_videos(
    folder: &Path,
    runner: &impl MediaToolRunner,
    on_notice: &mut impl FnMut(PipelineNotice),
) -> Result<ProcessingOutcome, VideoBatchError> {
    let mut entries = fs::read_dir(folder)
        .map_err(|source| VideoBatchError::ReadDirectory {
            path: folder.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| VideoBatchError::ReadDirectory {
            path: folder.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut outcome = ProcessingOutcome::default();
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| VideoBatchError::Inspect {
                path: path.clone(),
                source,
            })?;
        if is_link_like(&path, &file_type).map_err(|source| VideoBatchError::Inspect {
            path: path.clone(),
            source,
        })? {
            on_notice(PipelineNotice::warning(
                format!("Skipped symlink video: {}", path.display()),
                Some(path),
            ));
            continue;
        }
        if !file_type.is_file() || !is_resizable_video(&path) {
            continue;
        }

        on_notice(PipelineNotice::info(
            format!("Processing video: {}", entry.file_name().to_string_lossy()),
            Some(path.clone()),
        ));
        match resize_video(&path, runner) {
            Ok(VideoChange::Skipped(dimensions)) => {
                outcome.processed += 1;
                on_notice(PipelineNotice::info(
                    format!(
                        "Video within HD bounds, skipped: {} ({}x{})",
                        entry.file_name().to_string_lossy(),
                        dimensions.width,
                        dimensions.height
                    ),
                    Some(path),
                ));
            }
            Ok(VideoChange::Resized {
                original,
                target,
                size_before,
                size_after,
                audio_streams,
            }) => {
                outcome.processed += 1;
                outcome.changed += 1;
                on_notice(PipelineNotice::success(
                    format!(
                        "Video resized: {} ({}x{} -> {}x{}) {} -> {}{}",
                        entry.file_name().to_string_lossy(),
                        original.width,
                        original.height,
                        target.width,
                        target.height,
                        human_size(size_before),
                        human_size(size_after),
                        if audio_streams > 0 {
                            " — audio preserved"
                        } else {
                            ""
                        }
                    ),
                    Some(path),
                ));
            }
            Err(error) => {
                outcome.record_failure(path.clone(), error.clone());
                on_notice(PipelineNotice::error(
                    format!("Failed to resize video {}: {error}", path.display()),
                    Some(path),
                ));
            }
        }
    }

    Ok(outcome)
}

enum VideoChange {
    Skipped(Dimensions),
    Resized {
        original: Dimensions,
        target: Dimensions,
        size_before: u64,
        size_after: u64,
        audio_streams: usize,
    },
}

fn resize_video(path: &Path, runner: &impl MediaToolRunner) -> Result<VideoChange, String> {
    let source_metadata = probe_video(runner, path)?;
    let Some(target) = target_dimensions(
        source_metadata.dimensions.width,
        source_metadata.dimensions.height,
    )
    .map_err(|error| error.to_string())?
    else {
        return Ok(VideoChange::Skipped(source_metadata.dimensions));
    };

    let temporary = unique_video_temporary_path(path).map_err(|error| error.to_string())?;
    let result = (|| -> Result<VideoChange, String> {
        let size_before = fs::metadata(path).map_err(|error| error.to_string())?.len();
        let audio_encoding = audio_encoding(&source_metadata, &temporary);
        let arguments = ffmpeg_arguments(path, &temporary, target, audio_encoding);
        let output = runner
            .run(NativeTool::Ffmpeg, &arguments)
            .map_err(|error| error.to_string())?;
        ensure_success(NativeTool::Ffmpeg, &output)?;

        let resized_metadata = probe_video(runner, &temporary)?;
        if resized_metadata.dimensions != target {
            return Err(format!(
                "encoded dimensions are {}x{}, expected {}x{}",
                resized_metadata.dimensions.width,
                resized_metadata.dimensions.height,
                target.width,
                target.height
            ));
        }
        if resized_metadata.audio_streams != source_metadata.audio_streams {
            return Err(format!(
                "encoded audio stream count is {}, expected {}",
                resized_metadata.audio_streams, source_metadata.audio_streams
            ));
        }
        if audio_encoding == AudioEncoding::Copy
            && resized_metadata.audio_codecs != source_metadata.audio_codecs
        {
            return Err(format!(
                "encoded audio codecs are {:?}, expected {:?}",
                resized_metadata.audio_codecs, source_metadata.audio_codecs
            ));
        }

        let size_after = fs::metadata(&temporary)
            .map_err(|error| error.to_string())?
            .len();
        replace_file(&temporary, path).map_err(|error| error.to_string())?;

        Ok(VideoChange::Resized {
            original: source_metadata.dimensions,
            target,
            size_before,
            size_after,
            audio_streams: source_metadata.audio_streams,
        })
    })();

    if result.is_err() {
        remove_if_exists(&temporary);
    }
    result
}

fn unique_video_temporary_path(path: &Path) -> io::Result<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "video path has no parent"))?;
    let stem = path
        .file_stem()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "video path has no stem"))?;

    for counter in 0_u32..1_000 {
        let mut name = OsString::from(".");
        name.push(stem);
        name.push(format!(".horizon-traversal-{counter}.tmp"));
        if let Some(extension) = path.extension() {
            name.push(".");
            name.push(extension);
        }
        let candidate = parent.join(name);
        match candidate.symlink_metadata() {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not reserve a temporary video name",
    ))
}

fn is_resizable_video(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("mp4") || extension.eq_ignore_ascii_case("avi")
        })
}

fn is_mp4_or_mov(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("mp4") || extension.eq_ignore_ascii_case("mov")
        })
}

fn ensure_success(tool: NativeTool, output: &ToolOutput) -> Result<(), String> {
    if output.success {
        return Ok(());
    }

    let mut stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stderr.chars().count() > 4_000 {
        stderr = stderr.chars().take(4_000).collect::<String>();
        stderr.push_str("...");
    }
    if stderr.is_empty() {
        stderr = "no diagnostic output".to_owned();
    }
    Err(format!(
        "{tool} exited with status {:?}: {stderr}",
        output.code
    ))
}

#[derive(Debug, Deserialize)]
struct ProbeDocument {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: ProbeFormat,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct ProbeFormat {
    duration: Option<NumberOrString>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum NumberOrString {
    Number(f64),
    String(String),
}

impl NumberOrString {
    fn into_f64(self) -> Option<f64> {
        match self {
            Self::Number(value) if value.is_finite() => Some(value),
            Self::String(value) => value.parse::<f64>().ok().filter(|value| value.is_finite()),
            Self::Number(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeRunner {
        outputs: Mutex<Vec<ToolOutput>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<ToolOutput>) -> Self {
            Self {
                outputs: Mutex::new(outputs.into_iter().rev().collect()),
            }
        }
    }

    impl MediaToolRunner for FakeRunner {
        fn run(
            &self,
            _tool: NativeTool,
            _arguments: &[OsString],
        ) -> Result<ToolOutput, ToolRunError> {
            Ok(self.outputs.lock().unwrap().pop().unwrap())
        }
    }

    fn successful_output(stdout: impl Into<Vec<u8>>) -> ToolOutput {
        ToolOutput {
            success: true,
            code: Some(0),
            stdout: stdout.into(),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn dimensions_fit_orientation_bounds_without_distortion() {
        let cases = [
            ((1_280, 720), None),
            ((1_920, 1_080), Some((1_280, 720))),
            ((1_080, 1_920), Some((720, 1_280))),
            ((1_000, 1_000), Some((720, 720))),
            ((1_600, 1_200), Some((960, 720))),
            ((3_840, 1_080), Some((1_280, 360))),
            ((1_921, 1_080), Some((1_280, 718))),
            ((1_280, 721), Some((1_278, 720))),
        ];

        for ((width, height), expected) in cases {
            let actual = target_dimensions(width, height).unwrap();
            assert_eq!(
                actual.map(|dimensions| (dimensions.width, dimensions.height)),
                expected
            );
        }
        assert_eq!(
            target_dimensions(0, 720),
            Err(DimensionError::ZeroDimension)
        );
        assert_eq!(
            target_dimensions(10_000, 1),
            Err(DimensionError::TargetTooSmall)
        );
    }

    #[test]
    fn probe_deserializes_video_audio_and_string_duration() {
        let runner = FakeRunner::new(vec![successful_output(
            br#"{"streams":[{"codec_type":"video","width":1920,"height":1080},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"1.25"}}"#,
        )]);

        let metadata = probe_video(&runner, Path::new("clip.mp4")).unwrap();

        assert_eq!(metadata.dimensions, Dimensions::new(1_920, 1_080));
        assert_eq!(metadata.audio_streams, 1);
        assert_eq!(metadata.audio_codecs, vec![Some("aac".to_owned())]);
        assert_eq!(metadata.duration_seconds, Some(1.25));
    }

    #[test]
    fn probe_rejects_missing_video_and_bad_json() {
        let no_video = FakeRunner::new(vec![successful_output(
            br#"{"streams":[{"codec_type":"audio"}],"format":{}}"#,
        )]);
        assert!(probe_video(&no_video, Path::new("audio.mp4"))
            .unwrap_err()
            .contains("no video"));

        let malformed = FakeRunner::new(vec![successful_output(b"{".to_vec())]);
        assert!(probe_video(&malformed, Path::new("bad.mp4"))
            .unwrap_err()
            .contains("invalid ffprobe JSON"));
    }

    #[test]
    fn encode_arguments_preserve_or_transcode_audio_explicitly() {
        let target = Dimensions::new(1_280, 720);
        let copied_mp4 = ffmpeg_arguments(
            Path::new("input with spaces.mp4"),
            Path::new("output.MP4"),
            target,
            AudioEncoding::Copy,
        );
        assert!(copied_mp4.windows(2).any(|pair| pair == ["-c:a", "copy"]));
        assert!(copied_mp4
            .windows(2)
            .any(|pair| pair == ["-disposition:a:0", "default"]));
        assert!(copied_mp4
            .windows(2)
            .any(|pair| pair == ["-movflags", "+faststart"]));
        assert_eq!(copied_mp4.last().unwrap(), "output.MP4");

        let transcoded_mp4 = ffmpeg_arguments(
            Path::new("input.mp4"),
            Path::new("output.mp4"),
            target,
            AudioEncoding::Aac192,
        );
        assert!(transcoded_mp4
            .windows(2)
            .any(|pair| pair == ["-c:a", "aac"]));
        assert!(transcoded_mp4
            .windows(2)
            .any(|pair| pair == ["-b:a", "192k"]));

        let avi = ffmpeg_arguments(
            Path::new("input.avi"),
            Path::new("output.avi"),
            target,
            AudioEncoding::Copy,
        );
        assert!(avi.windows(2).any(|pair| pair == ["-c:a", "copy"]));

        let silent = ffmpeg_arguments(
            Path::new("input.mp4"),
            Path::new("output.mp4"),
            target,
            AudioEncoding::None,
        );
        assert!(!silent.iter().any(|argument| argument == "-c:a"));
    }

    #[test]
    fn compatible_mp4_audio_is_copied_without_reencoding() {
        let metadata = VideoMetadata {
            dimensions: Dimensions::new(1_920, 1_080),
            duration_seconds: Some(1.0),
            audio_streams: 1,
            audio_codecs: vec![Some("aac".to_owned())],
        };
        assert_eq!(
            audio_encoding(&metadata, Path::new("output.mp4")),
            AudioEncoding::Copy
        );

        let mut incompatible = metadata;
        incompatible.audio_codecs = vec![Some("opus".to_owned())];
        assert_eq!(
            audio_encoding(&incompatible, Path::new("output.mp4")),
            AudioEncoding::Aac192
        );
    }
}
