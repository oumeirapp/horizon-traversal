use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use tempfile::tempdir;
use x_traversal_lib::pipeline::videos::{
    probe_video, resize_videos, MediaToolRunner, NativeTool, ToolOutput, ToolRunError,
};

struct ProcessRunner {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

impl ProcessRunner {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn bundled() -> Self {
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        Self {
            ffmpeg: binaries.join("ffmpeg-aarch64-apple-darwin"),
            ffprobe: binaries.join("ffprobe-aarch64-apple-darwin"),
        }
    }
}

impl MediaToolRunner for ProcessRunner {
    fn run(&self, tool: NativeTool, arguments: &[OsString]) -> Result<ToolOutput, ToolRunError> {
        let executable = match tool {
            NativeTool::Ffmpeg => &self.ffmpeg,
            NativeTool::Ffprobe => &self.ffprobe,
        };
        let output = Command::new(executable)
            .env_clear()
            .env("LC_ALL", "C")
            .args(arguments)
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

fn run_ffmpeg(runner: &ProcessRunner, arguments: &[&str]) {
    let arguments = arguments.iter().map(OsString::from).collect::<Vec<_>>();
    let output = runner.run(NativeTool::Ffmpeg, &arguments).unwrap();
    assert!(
        output.success,
        "fixture generation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn bundled_tools_resize_audio_and_silent_video_and_leave_failures_untouched() {
    let runner = ProcessRunner::bundled();
    assert!(
        runner.ffmpeg.is_file() && runner.ffprobe.is_file(),
        "run scripts/build-native-macos-arm64.sh before Rust tests"
    );

    let temp = tempdir().unwrap();
    let folder = temp.path().join("video fixtures");
    fs::create_dir(&folder).unwrap();
    let with_audio = folder.join("a-with-audio.mp4");
    let silent = folder.join("b-silent.mp4");
    let in_bounds = folder.join("c-in-bounds.mp4");
    let corrupt = folder.join("z-corrupt.mp4");

    run_ffmpeg(
        &runner,
        &[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:sample_rate=44100",
            "-t",
            "0.2",
            "-shortest",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            with_audio.to_str().unwrap(),
        ],
    );
    run_ffmpeg(
        &runner,
        &[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=1080x1920:r=10",
            "-t",
            "0.2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            silent.to_str().unwrap(),
        ],
    );
    run_ffmpeg(
        &runner,
        &[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=green:s=640x360:r=10",
            "-t",
            "0.2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            in_bounds.to_str().unwrap(),
        ],
    );
    fs::write(&corrupt, b"not a video").unwrap();
    let in_bounds_before = fs::read(&in_bounds).unwrap();
    let corrupt_before = fs::read(&corrupt).unwrap();

    let outcome = resize_videos(&folder, &runner).unwrap();

    assert_eq!(outcome.processed, 3);
    assert_eq!(outcome.changed, 2);
    assert_eq!(outcome.failed_files, 1);
    let audio_metadata = probe_video(&runner, &with_audio).unwrap();
    assert_eq!(
        (
            audio_metadata.dimensions.width,
            audio_metadata.dimensions.height
        ),
        (1_280, 720)
    );
    assert_eq!(audio_metadata.audio_streams, 1);
    let silent_metadata = probe_video(&runner, &silent).unwrap();
    assert_eq!(
        (
            silent_metadata.dimensions.width,
            silent_metadata.dimensions.height
        ),
        (720, 1_280)
    );
    assert_eq!(silent_metadata.audio_streams, 0);
    assert_eq!(fs::read(&in_bounds).unwrap(), in_bounds_before);
    assert_eq!(fs::read(&corrupt).unwrap(), corrupt_before);
    assert!(!fs::read_dir(&folder).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("x-traversal")));
}

struct FailingEncodeRunner;

impl MediaToolRunner for FailingEncodeRunner {
    fn run(&self, tool: NativeTool, arguments: &[OsString]) -> Result<ToolOutput, ToolRunError> {
        match tool {
            NativeTool::Ffprobe => Ok(ToolOutput {
                success: true,
                code: Some(0),
                stdout: br#"{"streams":[{"codec_type":"video","width":1920,"height":1080}],"format":{}}"#.to_vec(),
                stderr: Vec::new(),
            }),
            NativeTool::Ffmpeg => {
                let temporary = PathBuf::from(arguments.last().unwrap());
                assert_eq!(temporary.extension().unwrap(), "mp4");
                fs::write(temporary, b"partial output").unwrap();
                Ok(ToolOutput {
                    success: false,
                    code: Some(1),
                    stdout: Vec::new(),
                    stderr: b"intentional encode failure".to_vec(),
                })
            }
        }
    }
}

#[test]
fn failed_encoding_preserves_source_and_removes_partial_output() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("source.mp4");
    fs::write(&source, b"original source bytes").unwrap();

    let outcome = resize_videos(temp.path(), &FailingEncodeRunner).unwrap();

    assert_eq!(outcome.failed_files, 1);
    assert_eq!(fs::read(&source).unwrap(), b"original source bytes");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

struct MissingAudioRunner {
    probe_count: AtomicUsize,
}

impl MediaToolRunner for MissingAudioRunner {
    fn run(&self, tool: NativeTool, arguments: &[OsString]) -> Result<ToolOutput, ToolRunError> {
        match tool {
            NativeTool::Ffprobe => {
                let source_probe = self.probe_count.fetch_add(1, Ordering::SeqCst) == 0;
                let stdout = if source_probe {
                    br#"{"streams":[{"codec_type":"video","width":1920,"height":1080},{"codec_type":"audio"}],"format":{}}"#.to_vec()
                } else {
                    br#"{"streams":[{"codec_type":"video","width":1280,"height":720}],"format":{}}"#
                        .to_vec()
                };
                Ok(ToolOutput {
                    success: true,
                    code: Some(0),
                    stdout,
                    stderr: Vec::new(),
                })
            }
            NativeTool::Ffmpeg => {
                fs::write(
                    PathBuf::from(arguments.last().unwrap()),
                    b"encoded without audio",
                )
                .unwrap();
                Ok(ToolOutput {
                    success: true,
                    code: Some(0),
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                })
            }
        }
    }
}

#[test]
fn missing_post_encode_audio_rolls_back_to_the_source() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("source.mp4");
    fs::write(&source, b"source with audio").unwrap();
    let runner = MissingAudioRunner {
        probe_count: AtomicUsize::new(0),
    };

    let outcome = resize_videos(temp.path(), &runner).unwrap();

    assert_eq!(outcome.failed_files, 1);
    assert_eq!(fs::read(&source).unwrap(), b"source with audio");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}
