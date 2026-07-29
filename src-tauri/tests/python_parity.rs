#![cfg(all(target_os = "macos", target_arch = "aarch64"))]

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use image::imageops::FilterType;
use image::{GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};
use serde::Deserialize;
use tempfile::tempdir;
use x_traversal_lib::pipeline::coordinator::{run_pipeline, PipelineEventSink, PipelinePlan};
use x_traversal_lib::pipeline::ipc::{LogLevel, PipelineEvent, PipelineSummary, RunStatus};
use x_traversal_lib::pipeline::native::resolve_pdfium_library;
use x_traversal_lib::pipeline::pdf::shared_pdfium;
use x_traversal_lib::pipeline::selection::{parse_filter, select_tickets};
use x_traversal_lib::pipeline::videos::{
    probe_video, MediaToolRunner, NativeTool, ToolOutput, ToolRunError,
};

const RUN_ENVIRONMENT: &str = "X_TRAVERSAL_RUN_PYTHON_PARITY";

struct ProcessRunner {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

impl ProcessRunner {
    fn bundled() -> Self {
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        Self {
            ffmpeg: binaries.join("ffmpeg-aarch64-apple-darwin"),
            ffprobe: binaries.join("ffprobe-aarch64-apple-darwin"),
        }
    }

    fn executable(&self, tool: NativeTool) -> &Path {
        match tool {
            NativeTool::Ffmpeg => &self.ffmpeg,
            NativeTool::Ffprobe => &self.ffprobe,
        }
    }
}

impl MediaToolRunner for ProcessRunner {
    fn run(&self, tool: NativeTool, arguments: &[OsString]) -> Result<ToolOutput, ToolRunError> {
        let output = Command::new(self.executable(tool))
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

#[derive(Default)]
struct RecordedEvents(Mutex<Vec<PipelineEvent>>);

impl RecordedEvents {
    fn snapshot(&self) -> Vec<PipelineEvent> {
        self.0.lock().unwrap().clone()
    }
}

impl PipelineEventSink for RecordedEvents {
    fn emit(&self, event: PipelineEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PythonResult {
    tickets: Vec<String>,
    logs: Vec<PythonLog>,
    invalid_filter_accepted: bool,
    ffmpeg: String,
    ffprobe: String,
}

#[derive(Debug, Deserialize)]
struct PythonLog {
    level: String,
    message: String,
}

struct Fixture {
    input: PathBuf,
    first_ticket_sources: BTreeSet<String>,
    linked_source: String,
    later_ticket_source: String,
}

#[test]
#[ignore = "requires uv plus prepared macOS-arm64 FFmpeg, FFprobe, and PDFium"]
fn python_and_rust_outputs_have_semantic_parity_with_only_approved_deltas() {
    assert_eq!(
        env::var(RUN_ENVIRONMENT).as_deref(),
        Ok("1"),
        "run this ignored test through scripts/parity/run-macos-arm64.sh"
    );

    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let runner = ProcessRunner::bundled();
    assert!(runner.ffmpeg.is_file(), "prepare the bundled FFmpeg first");
    assert!(
        runner.ffprobe.is_file(),
        "prepare the bundled FFprobe first"
    );
    let pdfium_library = resolve_pdfium_library(None).expect("prepare PDFium first");
    let pdfium = shared_pdfium(&pdfium_library).unwrap();

    let temporary = tempdir().unwrap();
    let fixture = create_fixture(temporary.path(), &runner);
    let python_output = temporary.path().join("python-output");
    let rust_output = temporary.path().join("rust-output");
    let python_result_path = temporary.path().join("python-result.json");

    let python_result = run_python_reference(
        &repository,
        &fixture.input,
        &python_output,
        &python_result_path,
        &runner,
        temporary.path(),
    );

    let selection = select_tickets(&fixture.input, "P1-P3").unwrap();
    let rust_ticket_names = selection
        .tickets
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        rust_ticket_names, python_result.tickets,
        "both implementations must select the same ordered ticket list"
    );

    // Approved filter delta: Python discarded the trailing empty token while
    // Rust rejects it rather than accidentally selecting every ticket.
    assert!(python_result.invalid_filter_accepted);
    assert!(parse_filter("P1,").is_err());

    assert_eq!(
        fs::canonicalize(&python_result.ffmpeg).unwrap(),
        fs::canonicalize(&runner.ffmpeg).unwrap()
    );
    assert_eq!(
        fs::canonicalize(&python_result.ffprobe).unwrap(),
        fs::canonicalize(&runner.ffprobe).unwrap()
    );

    let events = RecordedEvents::default();
    let summary = run_pipeline(
        PipelinePlan {
            input: fixture.input.clone(),
            output: rust_output.clone(),
            tickets: selection.tickets,
        },
        pdfium,
        &runner,
        &events,
    );
    let rust_events = events.snapshot();

    compare_manifests(&python_output, &rust_output);
    compare_images(&python_output, &rust_output);
    compare_videos(&python_output, &rust_output, &runner);
    compare_reports(&python_output, &rust_output, &fixture);
    compare_classifications(&python_result, &rust_events, &summary);
}

fn create_fixture(root: &Path, runner: &ProcessRunner) -> Fixture {
    let input = root.join("input tickets");
    let comprehensive = input.join("P1 Comprehensive");
    let source = comprehensive.join("Approved Deliverables");
    let no_sources = input.join("P2 No Sources");
    let later_source = input.join("P3 Later/Master.Files");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&no_sources).unwrap();
    fs::create_dir_all(&later_source).unwrap();

    write_visible_pdf(&source.join("brief.pdf"));
    fs::write(source.join("corrupt.pdf"), b"not a PDF").unwrap();
    write_rgba_png(
        &source.join("oversized.png"),
        2_400,
        1_200,
        [20, 80, 160, 255],
    );
    write_rgba_png(&source.join("alpha.png"), 1_300, 1_300, [80, 160, 220, 64]);
    write_rgb_jpeg(&source.join("in-bounds.jpg"), 640, 480, [90, 40, 10]);
    fs::write(source.join("corrupt.png"), b"not an image").unwrap();
    fs::write(source.join("skipped.mov"), b"mov is intentionally skipped").unwrap();

    let older = source.join("Version 1");
    let current = source.join("Version 2");
    fs::create_dir_all(&older).unwrap();
    fs::create_dir_all(current.join("a-first")).unwrap();
    fs::create_dir_all(current.join("b-second")).unwrap();
    fs::create_dir_all(current.join("nested v99")).unwrap();
    fs::write(older.join("legacy.gif"), b"legacy version").unwrap();
    fs::write(current.join("selected.gif"), b"selected version").unwrap();
    fs::write(
        current.join("nested v99/nested-version-kept.gif"),
        b"nested versions are not re-selected",
    )
    .unwrap();
    write_rgba_png(
        &current.join("a-first/duplicate.png"),
        8,
        8,
        [230, 20, 30, 255],
    );
    write_rgba_png(
        &current.join("b-second/duplicate.png"),
        8,
        8,
        [20, 210, 40, 255],
    );

    generate_video(
        runner,
        &source.join("ultra-wide.mp4"),
        "color=c=navy:s=1920x540:r=5",
        true,
    );
    generate_video(
        runner,
        &source.join("in-bounds.mp4"),
        "color=c=teal:s=640x360:r=5",
        false,
    );
    fs::write(source.join("corrupt.mp4"), b"not a video").unwrap();

    fs::write(later_source.join("later.gif"), b"later ticket").unwrap();

    let outside_link_target = root.join("outside-linked.png");
    write_rgba_png(&outside_link_target, 16, 16, [120, 30, 200, 255]);
    symlink(&outside_link_target, source.join("linked.png")).unwrap();

    let first_ticket_sources = [
        source.join("brief.pdf"),
        source.join("corrupt.pdf"),
        source.join("oversized.png"),
        source.join("alpha.png"),
        source.join("in-bounds.jpg"),
        source.join("corrupt.png"),
        source.join("ultra-wide.mp4"),
        source.join("in-bounds.mp4"),
        source.join("corrupt.mp4"),
        current.join("selected.gif"),
        current.join("nested v99/nested-version-kept.gif"),
        current.join("a-first/duplicate.png"),
        current.join("b-second/duplicate.png"),
    ]
    .into_iter()
    .map(canonical_string)
    .collect();

    Fixture {
        input,
        first_ticket_sources,
        linked_source: canonical_string(outside_link_target),
        later_ticket_source: canonical_string(later_source.join("later.gif")),
    }
}

fn canonical_string(path: impl AsRef<Path>) -> String {
    fs::canonicalize(path)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn write_rgba_png(path: &Path, width: u32, height: u32, pixel: [u8; 4]) {
    let image = RgbaImage::from_pixel(width, height, Rgba(pixel));
    image.save(path).unwrap();
}

fn write_rgb_jpeg(path: &Path, width: u32, height: u32, pixel: [u8; 3]) {
    let image = RgbImage::from_pixel(width, height, Rgb(pixel));
    image.save(path).unwrap();
}

fn write_visible_pdf(path: &Path) {
    let drawing = concat!(
        "q\n",
        "0.08 0.32 0.72 rg\n",
        "20 20 160 80 re f\n",
        "1 0.4 0.1 rg\n",
        "40 40 50 40 re f\n",
        "0.1 0.8 0.4 rg\n",
        "110 40 50 40 re f\n",
        "Q\n",
    );
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << >> /Contents 4 0 R >>"
            .to_owned(),
        format!(
            "<< /Length {} >>\nstream\n{drawing}endstream",
            drawing.len()
        ),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
    }
    let xref_offset = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    fs::write(path, pdf).unwrap();
}

fn generate_video(
    runner: &ProcessRunner,
    destination: &Path,
    video_source: &str,
    with_audio: bool,
) {
    let mut arguments = vec![
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        video_source,
    ];
    if with_audio {
        arguments.extend(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100"]);
    }
    arguments.extend(["-t", "0.2"]);
    if with_audio {
        arguments.push("-shortest");
    }
    arguments.extend([
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
    ]);
    if with_audio {
        arguments.extend(["-c:a", "aac"]);
    }
    let mut arguments = arguments
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    arguments.push(destination.as_os_str().to_os_string());
    let output = runner.run(NativeTool::Ffmpeg, &arguments).unwrap();
    assert!(
        output.success,
        "video fixture generation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_python_reference(
    repository: &Path,
    input: &Path,
    output: &Path,
    result_path: &Path,
    runner: &ProcessRunner,
    temporary: &Path,
) -> PythonResult {
    let tool_path = temporary.join("python-native-tools");
    fs::create_dir(&tool_path).unwrap();
    symlink(&runner.ffmpeg, tool_path.join("ffmpeg")).unwrap();
    symlink(&runner.ffprobe, tool_path.join("ffprobe")).unwrap();
    let uv = find_uv();
    let result = Command::new(&uv)
        .current_dir(repository)
        .args([
            "run",
            "--project",
            "python",
            "--locked",
            "--system-certs",
            "python",
        ])
        .arg(repository.join("scripts/parity/python_reference_runner.py"))
        .arg("--repository")
        .arg(repository)
        .arg("--input")
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--result")
        .arg(result_path)
        .arg("--filter")
        .arg("P1-P3")
        .env("PATH", &tool_path)
        .env("X_TRAVERSAL_EXPECT_FFMPEG", &runner.ffmpeg)
        .env("X_TRAVERSAL_EXPECT_FFPROBE", &runner.ffprobe)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "Python reference failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&fs::read(result_path).unwrap()).unwrap()
}

fn find_uv() -> PathBuf {
    if let Some(explicit) = env::var_os("X_TRAVERSAL_UV") {
        let explicit = PathBuf::from(explicit);
        assert!(explicit.is_file(), "X_TRAVERSAL_UV must name a uv binary");
        return explicit;
    }

    let search_path = env::var_os("PATH").expect("PATH must be set to locate uv");
    env::split_paths(&search_path)
        .map(|directory| directory.join("uv"))
        .find(|candidate| candidate.is_file())
        .expect("uv must be installed or X_TRAVERSAL_UV must be set")
}

fn compare_manifests(python_output: &Path, rust_output: &Path) {
    assert_ticket_directories(python_output);
    assert_ticket_directories(rust_output);
    let ticket = "P1 Comprehensive";
    let mut python_files = output_files(python_output, ticket);
    let rust_files = output_files(rust_output, ticket);

    // Approved safe-path delta: Python follows the input symlink, while Rust
    // warns and skips it. No other manifest difference is permitted.
    assert!(python_files.remove("linked.png"));
    assert!(!rust_files.contains("linked.png"));
    assert_eq!(python_files, rust_files);

    assert!(rust_files.contains("selected.gif"));
    assert!(!rust_files.contains("legacy.gif"));
    assert!(rust_files.contains("nested-version-kept.gif"));
    assert!(rust_files.contains("duplicate.png"));
    assert!(rust_files.contains("duplicate_1.png"));
    assert!(!rust_files.contains("skipped.mov"));
    assert!(!rust_files.contains("brief.pdf"));
    assert!(rust_files.contains("brief.png"));
    assert!(rust_files.contains("corrupt.pdf"));

    assert!(output_files(python_output, "P2 No Sources").is_empty());
    assert!(output_files(rust_output, "P2 No Sources").is_empty());
    assert_eq!(
        output_files(python_output, "P3 Later"),
        output_files(rust_output, "P3 Later")
    );

    // Capture collision assignment separately: deterministic ordering is an
    // approved Rust correction, so the comparison below must name any legacy
    // ordering difference rather than hiding it in a set comparison.
    let rust_duplicates = duplicate_pixels(rust_output);
    let python_duplicates = duplicate_pixels(python_output);
    let red = [230, 20, 30, 255];
    let green = [20, 210, 40, 255];
    assert_eq!(rust_duplicates, (red, green));
    assert!(
        python_duplicates == (red, green) || python_duplicates == (green, red),
        "legacy collision assignment may differ only by its filesystem order"
    );
}

fn output_files(output: &Path, ticket: &str) -> BTreeSet<String> {
    fs::read_dir(output.join(ticket))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            assert!(
                entry.file_type().unwrap().is_file(),
                "ticket output must be flat; unexpected entry: {}",
                entry.path().display()
            );
            entry.file_name().to_string_lossy().into_owned()
        })
        .filter(|name| name != "report.txt")
        .collect()
}

fn assert_ticket_directories(output: &Path) {
    let entries = fs::read_dir(output)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            assert!(
                entry.file_type().unwrap().is_dir(),
                "output root may contain only ticket directories: {}",
                entry.path().display()
            );
            entry.file_name().to_string_lossy().into_owned()
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        entries,
        BTreeSet::from([
            "P1 Comprehensive".to_owned(),
            "P2 No Sources".to_owned(),
            "P3 Later".to_owned(),
        ])
    );
}

fn duplicate_pixels(output: &Path) -> ([u8; 4], [u8; 4]) {
    let ticket = output.join("P1 Comprehensive");
    let first = image::open(ticket.join("duplicate.png"))
        .unwrap()
        .to_rgba8();
    let second = image::open(ticket.join("duplicate_1.png"))
        .unwrap()
        .to_rgba8();
    (first.get_pixel(0, 0).0, second.get_pixel(0, 0).0)
}

fn compare_images(python_output: &Path, rust_output: &Path) {
    let names = [
        "alpha.png",
        "brief.png",
        "duplicate.png",
        "duplicate_1.png",
        "in-bounds.jpg",
        "oversized.png",
    ];
    for name in names {
        let python = image::open(python_output.join("P1 Comprehensive").join(name)).unwrap();
        let rust = image::open(rust_output.join("P1 Comprehensive").join(name)).unwrap();
        assert_eq!(
            python.dimensions(),
            rust.dimensions(),
            "image dimensions drifted for {name}"
        );
    }
    assert_eq!(
        image::open(rust_output.join("P1 Comprehensive/oversized.png"))
            .unwrap()
            .dimensions(),
        (1_920, 960)
    );
    let alpha = image::open(rust_output.join("P1 Comprehensive/alpha.png")).unwrap();
    assert_eq!(alpha.dimensions(), (1_080, 1_080));
    assert!(alpha.color().has_alpha());
    compare_pdf_render_content(python_output, rust_output);
    assert_eq!(
        fs::read(python_output.join("P1 Comprehensive/corrupt.png")).unwrap(),
        b"not an image"
    );
    assert_eq!(
        fs::read(rust_output.join("P1 Comprehensive/corrupt.png")).unwrap(),
        b"not an image"
    );
}

fn compare_pdf_render_content(python_output: &Path, rust_output: &Path) {
    let python = image::open(python_output.join("P1 Comprehensive/brief.png"))
        .unwrap()
        .to_rgb8();
    let rust = image::open(rust_output.join("P1 Comprehensive/brief.png"))
        .unwrap()
        .to_rgb8();
    assert_eq!(python.dimensions(), (400, 240));
    assert_eq!(rust.dimensions(), (400, 240));
    let python = image::imageops::resize(&python, 64, 64, FilterType::Triangle);
    let rust = image::imageops::resize(&rust, 64, 64, FilterType::Triangle);

    let mut reference_content = 0_u64;
    let mut absolute_error = 0_u64;
    for (python_pixel, rust_pixel) in python.pixels().zip(rust.pixels()) {
        for (python_channel, rust_channel) in python_pixel.0.into_iter().zip(rust_pixel.0) {
            reference_content += u64::from(255 - python_channel);
            absolute_error += u64::from(python_channel.abs_diff(rust_channel));
        }
    }

    assert!(
        reference_content > 10_000,
        "PDF fixture rendered as an effectively blank page"
    );
    assert!(
        absolute_error * 100 <= reference_content * 10,
        "PDF render content drifted: normalized error {absolute_error}/{reference_content}"
    );
}

fn compare_videos(python_output: &Path, rust_output: &Path, runner: &ProcessRunner) {
    let python_ticket = python_output.join("P1 Comprehensive");
    let rust_ticket = rust_output.join("P1 Comprehensive");
    let python_ultra = probe_video(runner, &python_ticket.join("ultra-wide.mp4")).unwrap();
    let rust_ultra = probe_video(runner, &rust_ticket.join("ultra-wide.mp4")).unwrap();

    // Approved aspect-ratio delta: the legacy long/short clamp stretched this
    // 32:9 source to 16:9; Rust fits it within 1280x720 without distortion.
    assert_eq!(
        (
            python_ultra.dimensions.width,
            python_ultra.dimensions.height
        ),
        (1_280, 720)
    );
    assert_eq!(
        (rust_ultra.dimensions.width, rust_ultra.dimensions.height),
        (1_280, 360)
    );
    assert_eq!(python_ultra.audio_streams, 1);
    assert_eq!(rust_ultra.audio_streams, 1);

    for ticket in [python_ticket, rust_ticket] {
        let in_bounds = probe_video(runner, &ticket.join("in-bounds.mp4")).unwrap();
        assert_eq!(
            (in_bounds.dimensions.width, in_bounds.dimensions.height),
            (640, 360)
        );
        assert_eq!(in_bounds.audio_streams, 0);
        assert_eq!(
            fs::read(ticket.join("corrupt.mp4")).unwrap(),
            b"not a video"
        );
    }
}

fn compare_reports(python_output: &Path, rust_output: &Path, fixture: &Fixture) {
    assert!(!python_output.join("P2 No Sources/report.txt").exists());
    assert!(!rust_output.join("P2 No Sources/report.txt").exists());
    let python_first = report_lines(python_output, "P1 Comprehensive");
    let python_later = report_lines(python_output, "P3 Later");
    let rust_first = report_lines(rust_output, "P1 Comprehensive");
    let rust_later = report_lines(rust_output, "P3 Later");
    let mut expected_python_first = fixture.first_ticket_sources.clone();
    expected_python_first.insert(fixture.linked_source.clone());
    let expected_rust_later = BTreeSet::from([fixture.later_ticket_source.clone()]);
    let mut expected_python_later = expected_python_first.clone();
    expected_python_later.insert(fixture.later_ticket_source.clone());

    assert_report_exact(&rust_first, &fixture.first_ticket_sources);
    assert_report_exact(&python_first, &expected_python_first);
    assert_report_exact(&rust_later, &expected_rust_later);

    // Approved report delta: Python's process-wide list leaked all P1 sources
    // into P3's report. Rust keeps only the current ticket's source paths.
    assert_report_exact(&python_later, &expected_python_later);
}

fn assert_report_exact(actual: &[String], expected: &BTreeSet<String>) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "report contains a missing or duplicate source path"
    );
    assert_eq!(actual.iter().cloned().collect::<BTreeSet<_>>(), *expected);
}

fn report_lines(output: &Path, ticket: &str) -> Vec<String> {
    fs::read_to_string(output.join(ticket).join("report.txt"))
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn compare_classifications(
    python: &PythonResult,
    rust_events: &[PipelineEvent],
    summary: &PipelineSummary,
) {
    let python_warnings = python_messages(python, "WARNING");
    assert_message_classes(
        &python_warnings,
        &[
            ("Skipped .mov", 1),
            ("No 'Master Files' or 'Deliverables'", 1),
        ],
    );
    let python_errors = python_messages(python, "ERROR");
    assert_message_classes(
        &python_errors,
        &[
            ("Failed to convert PDF", 1),
            ("Failed to resize image", 1),
            ("Failed to resize video", 1),
        ],
    );

    let rust_warnings = rust_messages(rust_events, LogLevel::Warning);
    assert_message_classes(
        &rust_warnings,
        &[
            ("Skipped .mov", 1),
            ("No Master Files or Deliverables", 1),
            ("Skipped symlink during discovery", 1),
            ("Skipped symlink during collection", 1),
        ],
    );
    let rust_errors = rust_messages(rust_events, LogLevel::Error);
    assert_message_classes(
        &rust_errors,
        &[
            ("Failed to convert PDF", 1),
            ("Failed to resize image", 1),
            ("Failed to resize video", 1),
        ],
    );

    let ticket_results = rust_events
        .iter()
        .filter_map(|event| match event {
            PipelineEvent::TicketCompleted {
                ticket,
                status,
                copied_files,
                changed_files,
                failed_files,
                warnings,
                errors,
                ..
            } => Some((
                ticket.clone(),
                (
                    *status,
                    *copied_files,
                    *changed_files,
                    *failed_files,
                    *warnings,
                    *errors,
                ),
            )),
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        ticket_results,
        BTreeMap::from([
            (
                "P1 Comprehensive".to_owned(),
                (RunStatus::PartialSuccess, 13, 4, 3, 3, 3),
            ),
            (
                "P2 No Sources".to_owned(),
                (RunStatus::Failed, 0, 0, 0, 1, 0),
            ),
            ("P3 Later".to_owned(), (RunStatus::Success, 1, 0, 0, 0, 0),),
        ])
    );

    // Approved status delta: the Python reference announces success after
    // errors and skipped tickets; Rust returns an accurate partial summary.
    assert!(python_log_contains(
        python,
        "SUCCESS",
        "Pipeline completed successfully"
    ));
    assert_eq!(summary.status, RunStatus::PartialSuccess);
    assert_eq!(summary.successful_tickets, 1);
    assert_eq!(summary.partial_tickets, 1);
    assert_eq!(summary.failed_tickets, 1);
    assert_eq!(summary.total_tickets, 3);
    assert_eq!(summary.copied_files, 14);
    assert_eq!(summary.changed_files, 4);
    assert_eq!(summary.failed_files, 3);
    assert_eq!(summary.warnings, 4);
    assert_eq!(summary.errors, 3);
    assert_eq!(rust_warnings.len(), summary.warnings);
    assert_eq!(rust_errors.len(), summary.errors);

    // The no-source ticket did not terminate the run.
    assert!(ticket_results.contains_key("P3 Later"));
}

fn assert_message_classes(messages: &[&str], expected: &[(&str, usize)]) {
    assert_eq!(
        messages.len(),
        expected.iter().map(|(_, count)| count).sum::<usize>(),
        "unexpected warning/error messages: {messages:?}"
    );
    for (fragment, expected_count) in expected {
        assert_eq!(
            messages
                .iter()
                .filter(|message| message.contains(fragment))
                .count(),
            *expected_count,
            "unexpected count for message class {fragment}: {messages:?}"
        );
    }
}

fn python_messages<'a>(result: &'a PythonResult, level: &str) -> Vec<&'a str> {
    result
        .logs
        .iter()
        .filter(|log| log.level == level)
        .map(|log| log.message.as_str())
        .collect()
}

fn rust_messages(events: &[PipelineEvent], level: LogLevel) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            PipelineEvent::Log {
                level: event_level,
                message,
                ..
            } if *event_level == level => Some(message.as_str()),
            _ => None,
        })
        .collect()
}

fn python_log_contains(result: &PythonResult, level: &str, fragment: &str) -> bool {
    result
        .logs
        .iter()
        .any(|log| log.level == level && log.message.contains(fragment))
}
