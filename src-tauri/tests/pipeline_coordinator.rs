use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use horizon_traversal_lib::pipeline::asset_log::{
    AssetFailure, AssetFailureCategory, AssetFailureLog, AssetFailureOperation, ASSET_LOG_NAME,
};
use horizon_traversal_lib::pipeline::coordinator::{run_pipeline, PipelineEventSink, PipelinePlan};
use horizon_traversal_lib::pipeline::ipc::{
    LogLevel, PipelineEvent, PipelineStage, PipelineSummary, ProcessingOptions, RunStatus,
};
use horizon_traversal_lib::pipeline::native::resolve_pdfium_library;
use horizon_traversal_lib::pipeline::pdf::shared_pdfium;
use horizon_traversal_lib::pipeline::videos::{
    MediaToolRunner, NativeTool, ToolOutput, ToolRunError,
};
use tempfile::tempdir;

#[derive(Default)]
struct RecordingEvents(Mutex<Vec<PipelineEvent>>);

impl RecordingEvents {
    fn snapshot(&self) -> Vec<PipelineEvent> {
        self.0.lock().unwrap().clone()
    }
}

impl PipelineEventSink for RecordingEvents {
    fn emit(&self, event: PipelineEvent) {
        self.0.lock().unwrap().push(event);
    }
}

struct UnexpectedMediaTools;

impl MediaToolRunner for UnexpectedMediaTools {
    fn run(&self, tool: NativeTool, _arguments: &[OsString]) -> Result<ToolOutput, ToolRunError> {
        Err(ToolRunError::new(
            tool,
            "media tools must not run for coordinator test fixtures",
        ))
    }
}

#[derive(Default)]
struct InBoundsMediaTools(Mutex<Vec<PathBuf>>);

impl InBoundsMediaTools {
    fn probed_paths(&self) -> Vec<PathBuf> {
        self.0.lock().unwrap().clone()
    }
}

impl MediaToolRunner for InBoundsMediaTools {
    fn run(&self, tool: NativeTool, arguments: &[OsString]) -> Result<ToolOutput, ToolRunError> {
        match tool {
            NativeTool::Ffprobe => {
                self.0.lock().unwrap().push(PathBuf::from(
                    arguments
                        .last()
                        .expect("ffprobe arguments include the source path"),
                ));
                Ok(ToolOutput {
                    success: true,
                    code: Some(0),
                    stdout: br#"{"streams":[{"codec_type":"video","width":640,"height":360}],"format":{}}"#
                        .to_vec(),
                    stderr: Vec::new(),
                })
            }
            NativeTool::Ffmpeg => Err(ToolRunError::new(
                tool,
                "in-bounds coordinator fixtures must not be encoded",
            )),
        }
    }
}

fn write(path: &Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

fn copy_fixture(source: &Path, destination: &Path) {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::copy(source, destination).unwrap();
}

fn plan(input: PathBuf, output: PathBuf, tickets: Vec<PathBuf>) -> PipelinePlan {
    PipelinePlan {
        input,
        output,
        tickets,
        processing_options: ProcessingOptions::default(),
    }
}

fn run(plan: PipelinePlan, events: &RecordingEvents) -> PipelineSummary {
    let library = resolve_pdfium_library(None).unwrap();
    let pdfium = shared_pdfium(&library).unwrap();
    run_pipeline(plan, Some(pdfium), &UnexpectedMediaTools, events)
}

fn structural_events(events: &[PipelineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            PipelineEvent::PipelineStarted { total_tickets } => {
                Some(format!("pipeline:start:{total_tickets}"))
            }
            PipelineEvent::TicketStarted { ticket, .. } => Some(format!("ticket:start:{ticket}")),
            PipelineEvent::StageChanged { ticket, stage } => {
                Some(format!("stage:{ticket}:{}", stage_name(*stage)))
            }
            PipelineEvent::TicketCompleted { ticket, status, .. } => {
                Some(format!("ticket:complete:{ticket}:{}", status_name(*status)))
            }
            PipelineEvent::PipelineCompleted { summary } => {
                Some(format!("pipeline:complete:{}", status_name(summary.status)))
            }
            PipelineEvent::Log { .. } => None,
        })
        .collect()
}

fn log_paths(events: &[PipelineEvent], message_prefix: &str) -> Vec<PathBuf> {
    events
        .iter()
        .filter_map(|event| match event {
            PipelineEvent::Log { message, path, .. } if message.starts_with(message_prefix) => {
                path.as_deref().map(PathBuf::from)
            }
            _ => None,
        })
        .collect()
}

fn stage_name(stage: PipelineStage) -> &'static str {
    match stage {
        PipelineStage::Discover => "discover",
        PipelineStage::Copy => "copy",
        PipelineStage::Pdf => "pdf",
        PipelineStage::Images => "images",
        PipelineStage::Video => "video",
        PipelineStage::Report => "report",
    }
}

fn status_name(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Success => "success",
        RunStatus::PartialSuccess => "partialSuccess",
        RunStatus::Failed => "failed",
    }
}

fn expected_ticket_events(ticket: &str, status: &str) -> Vec<String> {
    let mut expected = vec![format!("ticket:start:{ticket}")];
    expected.extend(
        ["discover", "copy", "pdf", "images", "video", "report"]
            .map(|stage| format!("stage:{ticket}:{stage}")),
    );
    expected.push(format!("ticket:complete:{ticket}:{status}"));
    expected
}

#[test]
fn disabled_processing_stages_keep_stage_order_and_skip_all_processors() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let ticket = input.join("P1 Unoptimized");
    let source = ticket.join("Deliverables");
    write(&source.join("Documents/document.pdf"), b"not a PDF fixture");
    write(
        &source.join("Documents B/document.pdf"),
        b"second source fixture",
    );
    write(&source.join("poster.jpg"), b"not a JPEG fixture");
    write(&source.join("clip.mp4"), b"not an MP4 fixture");

    let mut pipeline_plan = plan(input, output.clone(), vec![ticket]);
    pipeline_plan.processing_options = ProcessingOptions {
        pdf: false,
        images: false,
        video: false,
    };
    let events = RecordingEvents::default();
    let summary = run_pipeline(pipeline_plan, None, &UnexpectedMediaTools, &events);
    let recorded = events.snapshot();

    assert_eq!(summary.status, RunStatus::Success);
    assert_eq!(summary.copied_files, 4);
    assert_eq!(summary.changed_files, 0);
    assert_eq!(summary.failed_files, 0);
    let mut expected = vec!["pipeline:start:1".to_owned()];
    expected.extend(expected_ticket_events("P1 Unoptimized", "success"));
    expected.push("pipeline:complete:success".to_owned());
    assert_eq!(structural_events(&recorded), expected);

    let skip_logs = recorded
        .iter()
        .filter_map(|event| match event {
            PipelineEvent::Log {
                level: LogLevel::Info,
                message,
                ..
            } if message.contains("optimization disabled for this run") => Some(message.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        skip_logs,
        [
            "PDF optimization disabled for this run; skipped",
            "Image optimization disabled for this run; skipped",
            "Video optimization disabled for this run; skipped",
        ]
    );
    assert_eq!(
        fs::read(output.join("P1 Unoptimized/Deliverables/document.pdf")).unwrap(),
        b"not a PDF fixture"
    );
    assert_eq!(
        fs::read(output.join("P1 Unoptimized/Deliverables/document_1.pdf")).unwrap(),
        b"second source fixture"
    );
    assert_eq!(
        fs::read(output.join("P1 Unoptimized/Deliverables/poster.jpg")).unwrap(),
        b"not a JPEG fixture"
    );
    assert_eq!(
        fs::read(output.join("P1 Unoptimized/Deliverables/clip.mp4")).unwrap(),
        b"not an MP4 fixture"
    );
    assert_eq!(
        fs::read_to_string(output.join("P1 Unoptimized/report.csv")).unwrap(),
        concat!(
            "Name,Ticket,Folder,Size\n",
            "document.pdf,P1,Documents,Unknown\n",
            "document.pdf,P1,Documents B,Unknown\n",
        )
    );
}

#[test]
fn categories_have_independent_flat_collision_names() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let ticket = input.join("P1 Categories");
    write(&ticket.join("Master Files/A/shared.gif"), b"master first");
    write(&ticket.join("Master Files/B/shared.gif"), b"master second");
    write(
        &ticket.join("Deliverables/A/shared.gif"),
        b"deliverables first",
    );
    write(
        &ticket.join("Deliverables/B/shared.gif"),
        b"deliverables second",
    );

    let mut pipeline_plan = plan(input, output.clone(), vec![ticket]);
    pipeline_plan.processing_options = ProcessingOptions {
        pdf: false,
        images: false,
        video: false,
    };
    let summary = run_pipeline(
        pipeline_plan,
        None,
        &UnexpectedMediaTools,
        &RecordingEvents::default(),
    );

    assert_eq!(summary.status, RunStatus::Success);
    assert_eq!(summary.copied_files, 4);
    assert_eq!(
        fs::read(output.join("P1 Categories/Master/shared.gif")).unwrap(),
        b"master first"
    );
    assert_eq!(
        fs::read(output.join("P1 Categories/Master/shared_1.gif")).unwrap(),
        b"master second"
    );
    assert_eq!(
        fs::read(output.join("P1 Categories/Deliverables/shared.gif")).unwrap(),
        b"deliverables first"
    );
    assert_eq!(
        fs::read(output.join("P1 Categories/Deliverables/shared_1.gif")).unwrap(),
        b"deliverables second"
    );
    assert!(!output.join("P1 Categories/shared.gif").exists());
    assert!(output.join("P1 Categories/report.csv").is_file());
}

#[test]
fn processors_visit_master_then_deliverables_without_recursing_from_ticket_root() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let ticket = input.join("P1 Processing Order");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let pdf_fixture = manifest.join("tests/fixtures/one-page.pdf");
    let image_fixture = manifest.join("icons/128x128@2x.png");

    copy_fixture(
        &pdf_fixture,
        &ticket.join("Master Files/Print/master-document.pdf"),
    );
    copy_fixture(
        &image_fixture,
        &ticket.join("Master Files/Print/master-image.png"),
    );
    write(
        &ticket.join("Master Files/Print/master-video.mp4"),
        b"probe fixture",
    );
    copy_fixture(
        &pdf_fixture,
        &ticket.join("Deliverables/Creative/deliverable-document.pdf"),
    );
    copy_fixture(
        &image_fixture,
        &ticket.join("Deliverables/Creative/deliverable-image.png"),
    );
    write(
        &ticket.join("Deliverables/Creative/deliverable-video.mp4"),
        b"probe fixture",
    );

    let events = RecordingEvents::default();
    let media_tools = InBoundsMediaTools::default();
    let library = resolve_pdfium_library(None).unwrap();
    let pdfium = shared_pdfium(&library).unwrap();
    let summary = run_pipeline(
        plan(input, output.clone(), vec![ticket]),
        Some(pdfium),
        &media_tools,
        &events,
    );
    let recorded = events.snapshot();
    let ticket_output = output.join("P1 Processing Order");

    assert_eq!(summary.status, RunStatus::Success);
    assert_eq!(summary.copied_files, 6);
    assert_eq!(summary.failed_files, 0);
    assert_eq!(summary.errors, 0);
    assert_eq!(
        log_paths(&recorded, "Converting PDF:"),
        [
            ticket_output.join("Master/master-document.pdf"),
            ticket_output.join("Deliverables/deliverable-document.pdf"),
        ]
    );
    assert_eq!(
        log_paths(&recorded, "Processing image:"),
        [
            ticket_output.join("Master/master-document.png"),
            ticket_output.join("Master/master-image.png"),
            ticket_output.join("Deliverables/deliverable-document.png"),
            ticket_output.join("Deliverables/deliverable-image.png"),
        ]
    );
    assert_eq!(
        log_paths(&recorded, "Processing video:"),
        [
            ticket_output.join("Master/master-video.mp4"),
            ticket_output.join("Deliverables/deliverable-video.mp4"),
        ]
    );
    assert_eq!(
        media_tools.probed_paths(),
        [
            ticket_output.join("Master/master-video.mp4"),
            ticket_output.join("Deliverables/deliverable-video.mp4"),
        ]
    );
}

#[test]
fn multi_ticket_run_orders_events_and_keeps_reports_ticket_local() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let first = input.join("P1 First");
    let second = input.join("P2 Second");
    let first_asset = first.join("Deliverables/nested/first_210x297.gif");
    let second_asset = second.join("Deliverables/Nested Master Files/Print/second.gif");
    write(&first_asset, b"first fixture");
    write(&second_asset, b"second fixture");
    write(&output.join("1. report.csv"), b"stale aggregate");

    let events = RecordingEvents::default();
    let summary = run(plan(input, output.clone(), vec![first, second]), &events);
    let recorded = events.snapshot();

    assert_eq!(summary.status, RunStatus::Success);
    assert_eq!(summary.total_tickets, 2);
    assert_eq!(summary.successful_tickets, 2);
    assert_eq!(summary.partial_tickets, 0);
    assert_eq!(summary.failed_tickets, 0);
    assert_eq!(summary.copied_files, 2);

    let mut expected = vec!["pipeline:start:2".to_owned()];
    expected.extend(expected_ticket_events("P1 First", "success"));
    expected.extend(expected_ticket_events("P2 Second", "success"));
    expected.push("pipeline:complete:success".to_owned());
    assert_eq!(structural_events(&recorded), expected);

    assert_eq!(
        fs::read(output.join("P1 First/Deliverables/first_210x297.gif")).unwrap(),
        b"first fixture"
    );
    assert_eq!(
        fs::read(output.join("P2 Second/Master/second.gif")).unwrap(),
        b"second fixture"
    );
    assert!(!output.join("P1 First/first_210x297.gif").exists());
    assert!(!output.join("P2 Second/second.gif").exists());

    assert_eq!(
        fs::read_to_string(output.join("P1 First/report.csv")).unwrap(),
        "Name,Ticket,Folder,Size\nfirst.gif,P1,nested,210x297\n"
    );
    assert_eq!(
        fs::read_to_string(output.join("P2 Second/report.csv")).unwrap(),
        "Name,Ticket,Folder,Size\nsecond.gif,P2,Print,Unknown\n"
    );
    assert_eq!(
        fs::read_to_string(output.join("1. report.csv")).unwrap(),
        concat!(
            "Name,Ticket,Folder,Size\n",
            "first.gif,P1,nested,210x297\n",
            "second.gif,P2,Print,Unknown\n",
        )
    );

    let completed_summary = recorded
        .iter()
        .find_map(|event| match event {
            PipelineEvent::PipelineCompleted { summary } => Some(summary),
            _ => None,
        })
        .unwrap();
    assert_eq!(completed_summary, &summary);
}

#[test]
fn aggregate_report_contains_only_tickets_selected_for_the_current_run() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let first = input.join("P1 First");
    let second = input.join("P2 Second");
    write(
        &first.join("Deliverables/Print/First_210x297.gif"),
        b"first",
    );
    write(
        &second.join("Deliverables/Print/Second_300x400.gif"),
        b"second",
    );

    run(
        plan(
            input.clone(),
            output.clone(),
            vec![first.clone(), second.clone()],
        ),
        &RecordingEvents::default(),
    );
    let summary = run(
        plan(input, output.clone(), vec![second]),
        &RecordingEvents::default(),
    );

    assert_eq!(summary.status, RunStatus::Success);
    assert!(output.join("P1 First/report.csv").is_file());
    assert_eq!(
        fs::read_to_string(output.join("1. report.csv")).unwrap(),
        "Name,Ticket,Folder,Size\nSecond.gif,P2,Print,300x400\n"
    );
}

#[test]
fn reports_creative_sizes_and_excludes_master_video_and_versions() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("TeamX");
    let output = temp.path().join("output");
    let print_ticket = input.join("P132189");
    let video_ticket = input.join("P132446");

    write(
        &print_ticket.join(
            "06. Deliverables/Print/Ver2/Print_260706_P132189_Q3 26 Fleet Publication Print - Fleet World_210x297_V2R0.jpg",
        ),
        b"print fixture",
    );
    write(
        &video_ticket
            .join("02. Master Files/Video/08072026/CLA-C174-Fast-Charging/4x5/Master-20s_4-5.mp4"),
        b"excluded master video",
    );
    write(
        &video_ticket.join("02. Master Files/Print/Version 3/excluded_210x297.jpg"),
        b"excluded master version",
    );
    write(
        &video_ticket.join(
            "06. Deliverables/Video/08072026/140 Years Sources/CLA-C174-Fast-Charging/4x5/C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_4-5_HQMaster_NO-VO_H264.mp4",
        ),
        b"four by five",
    );
    write(
        &video_ticket.join(
            "06. Deliverables/Video/08072026/140 Years Sources/CLA-C174-Fast-Charging/9x16/C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_9-16_HQMaster_NO-VO_H264.mp4",
        ),
        b"nine by sixteen",
    );
    write(
        &video_ticket.join("06. Deliverables/Video/Ver1/old_10s_1-1.mp4"),
        b"old deliverable",
    );
    write(
        &video_ticket.join(
            "06. Deliverables/Video/Ver2/Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide 3_E-class_15sec_Video_1440x1800px_V2R0.mp4",
        ),
        b"latest deliverable",
    );

    let mut pipeline_plan = plan(input, output.clone(), vec![print_ticket, video_ticket]);
    pipeline_plan.processing_options = ProcessingOptions {
        pdf: false,
        images: false,
        video: false,
    };
    let events = RecordingEvents::default();
    let summary = run_pipeline(pipeline_plan, None, &UnexpectedMediaTools, &events);

    assert_eq!(summary.status, RunStatus::Success);
    assert_eq!(summary.copied_files, 4);
    assert_eq!(
        fs::read_to_string(output.join("P132189/report.csv")).unwrap(),
        concat!(
            "Name,Ticket,Folder,Size\n",
            "Print_260706_P132189_Q3 26 Fleet Publication Print - Fleet World-V2R0.jpg,",
            "P132189,Print,210x297\n",
        )
    );
    assert_eq!(
        fs::read_to_string(output.join("P132446/report.csv")).unwrap(),
        concat!(
            "Name,Ticket,Folder,Size\n",
            "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-HQMaster_NO-VO_H264.mp4,",
            "P132446,Video,\"20 sec 4x5,20 sec 9x16\"\n",
            "Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide 3_E-class-V2R0.mp4,",
            "P132446,Video,15 sec 1440x1800\n",
        )
    );
    assert!(output.join("P132446/Master").is_dir());
    assert!(output
        .join("P132446/Deliverables/C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_4-5_HQMaster_NO-VO_H264.mp4")
        .is_file());
    assert!(output
        .join("P132446/Deliverables/C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_9-16_HQMaster_NO-VO_H264.mp4")
        .is_file());
    assert!(output
        .join("P132446/Deliverables/Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide 3_E-class_15sec_Video_1440x1800px_V2R0.mp4")
        .is_file());
    assert!(!output.join("P132446/Master/Master-20s_4-5.mp4").exists());
    assert!(!output.join("P132446/Master/excluded_210x297.jpg").exists());
    assert!(!output.join("P132446/Deliverables/old_10s_1-1.mp4").exists());
}

#[test]
fn warning_only_ticket_and_run_are_successful() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let warning_only = input.join("P1 Missing Sources");
    let successful = input.join("P2 Ready");
    fs::create_dir_all(&warning_only).unwrap();
    let successful_asset = successful.join("Deliverables/ready.gif");
    write(&successful_asset, b"ready fixture");

    let events = RecordingEvents::default();
    let summary = run(
        plan(input, output.clone(), vec![warning_only, successful]),
        &events,
    );
    let recorded = events.snapshot();

    assert_eq!(summary.status, RunStatus::Success);
    assert_eq!(summary.total_tickets, 2);
    assert_eq!(summary.successful_tickets, 2);
    assert_eq!(summary.partial_tickets, 0);
    assert_eq!(summary.failed_tickets, 0);
    assert_eq!(summary.copied_files, 1);
    assert_eq!(summary.warnings, 1);

    let mut expected = vec!["pipeline:start:2".to_owned()];
    expected.extend([
        "ticket:start:P1 Missing Sources".to_owned(),
        "stage:P1 Missing Sources:discover".to_owned(),
        "ticket:complete:P1 Missing Sources:success".to_owned(),
    ]);
    expected.extend(expected_ticket_events("P2 Ready", "success"));
    expected.push("pipeline:complete:success".to_owned());
    assert_eq!(structural_events(&recorded), expected);

    assert!(!output.join("P1 Missing Sources/report.csv").exists());
    assert!(output.join("P2 Ready/report.csv").is_file());
    assert!(output.join("P2 Ready/Deliverables/ready.gif").is_file());
    assert_eq!(
        fs::read_to_string(output.join("P2 Ready/report.csv")).unwrap(),
        "Name,Ticket,Folder,Size\n"
    );
    assert_eq!(
        fs::read_to_string(output.join("1. report.csv")).unwrap(),
        "Name,Ticket,Folder,Size\n"
    );
}

#[test]
fn aggregate_is_header_only_when_no_ticket_has_a_source_folder() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let ticket = input.join("P1 Missing Sources");
    fs::create_dir_all(&ticket).unwrap();
    write(&output.join("1. report.csv"), b"stale row");

    let summary = run(
        plan(input, output.clone(), vec![ticket]),
        &RecordingEvents::default(),
    );

    assert_eq!(summary.status, RunStatus::Success);
    assert!(!output.join("P1 Missing Sources/report.csv").exists());
    assert!(output.join("P1 Missing Sources/Master").is_dir());
    assert!(output.join("P1 Missing Sources/Deliverables").is_dir());
    assert_eq!(
        fs::read_to_string(output.join("1. report.csv")).unwrap(),
        "Name,Ticket,Folder,Size\n"
    );
}

#[test]
fn ticket_error_does_not_block_the_next_ticket_and_is_partial_success() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let missing = input.join("P1 Missing Ticket");
    let successful = input.join("P2 Ready");
    let successful_asset = successful.join("Deliverables/ready.gif");
    write(&successful_asset, b"ready fixture");

    let events = RecordingEvents::default();
    let summary = run(
        plan(input, output.clone(), vec![missing, successful]),
        &events,
    );
    let recorded = events.snapshot();

    assert_eq!(summary.status, RunStatus::PartialSuccess);
    assert_eq!(summary.successful_tickets, 1);
    assert_eq!(summary.partial_tickets, 0);
    assert_eq!(summary.failed_tickets, 1);
    assert_eq!(summary.warnings, 0);
    assert_eq!(summary.errors, 1);

    let mut expected = vec!["pipeline:start:2".to_owned()];
    expected.extend([
        "ticket:start:P1 Missing Ticket".to_owned(),
        "stage:P1 Missing Ticket:discover".to_owned(),
        "ticket:complete:P1 Missing Ticket:failed".to_owned(),
    ]);
    expected.extend(expected_ticket_events("P2 Ready", "success"));
    expected.push("pipeline:complete:partialSuccess".to_owned());
    assert_eq!(structural_events(&recorded), expected);
    assert_eq!(
        fs::read_to_string(output.join("1. report.csv")).unwrap(),
        "Name,Ticket,Folder,Size\n"
    );
}

#[test]
fn aggregate_directory_collision_is_preserved_and_marks_the_run_partial() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let ticket = input.join("P1 Ready");
    write(
        &ticket.join("Deliverables/Print/Poster_210x297.gif"),
        b"poster",
    );
    write(&output.join("1. report.csv/sentinel"), b"keep");
    let events = RecordingEvents::default();

    let summary = run(plan(input, output.clone(), vec![ticket]), &events);

    assert_eq!(summary.status, RunStatus::PartialSuccess);
    assert_eq!(summary.successful_tickets, 1);
    assert_eq!(summary.errors, 1);
    assert_eq!(
        fs::read(output.join("1. report.csv/sentinel")).unwrap(),
        b"keep"
    );
    assert!(output.join("P1 Ready/report.csv").is_file());
    assert!(events.snapshot().iter().any(|event| matches!(
        event,
        PipelineEvent::Log {
            ticket: None,
            level: LogLevel::Error,
            message,
            ..
        } if message.contains("Aggregate report creation failed")
    )));
}

#[test]
fn replaces_a_stale_asset_failure_log_with_an_empty_current_run_log() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    fs::create_dir_all(&input).unwrap();
    fs::create_dir_all(&output).unwrap();
    let stale = AssetFailureLog {
        schema_version: 1,
        failures: vec![AssetFailure::new(
            AssetFailureOperation::ImageResize,
            "P0 Stale",
            AssetFailureCategory::Deliverables,
            &output.join("P0 Stale/Deliverables/stale.png"),
            "previous run",
        )],
    };
    fs::write(output.join(ASSET_LOG_NAME), stale.render().unwrap()).unwrap();

    run_pipeline(
        plan(input, output.clone(), Vec::new()),
        None,
        &UnexpectedMediaTools,
        &RecordingEvents::default(),
    );

    let log: AssetFailureLog =
        serde_json::from_slice(&fs::read(output.join(ASSET_LOG_NAME)).unwrap()).unwrap();
    assert_eq!(log.schema_version, 1);
    assert!(log.failures.is_empty());
}

#[test]
fn unreplaceable_asset_log_aborts_before_any_ticket_output_is_replaced() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let ticket = input.join("P1 Ready");
    write(&ticket.join("Deliverables/Artwork/new.gif"), b"new");
    write(&output.join("P1 Ready/existing.gif"), b"keep");
    write(&output.join(ASSET_LOG_NAME).join("sentinel"), b"keep");
    let events = RecordingEvents::default();

    let summary = run_pipeline(
        plan(input, output.clone(), vec![ticket]),
        None,
        &UnexpectedMediaTools,
        &events,
    );

    assert_eq!(summary.status, RunStatus::Failed);
    assert_eq!(summary.failed_tickets, 1);
    assert_eq!(summary.copied_files, 0);
    assert_eq!(summary.errors, 1);
    assert_eq!(
        fs::read(output.join("P1 Ready/existing.gif")).unwrap(),
        b"keep"
    );
    assert!(!output.join("P1 Ready/Deliverables/new.gif").exists());
    assert_eq!(
        fs::read(output.join(ASSET_LOG_NAME).join("sentinel")).unwrap(),
        b"keep"
    );
    assert_eq!(
        fs::read_to_string(output.join("1. report.csv")).unwrap(),
        "Name,Ticket,Folder,Size\n"
    );
    assert!(!events
        .snapshot()
        .iter()
        .any(|event| matches!(event, PipelineEvent::TicketStarted { .. })));
    assert!(events.snapshot().iter().any(|event| matches!(
        event,
        PipelineEvent::Log {
            ticket: None,
            level: LogLevel::Error,
            message,
            ..
        } if message.contains("pipeline aborted before processing")
    )));
}

#[test]
fn asset_failure_log_contains_only_typed_file_processing_failures_in_stage_order() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let ticket = input.join("P1 Broken Media");
    write(
        &ticket.join("Master Files/Artwork/broken-master.jpg"),
        b"not a JPEG",
    );
    write(
        &ticket.join("Deliverables/Documents/broken.pdf"),
        b"not a PDF",
    );
    write(
        &ticket.join("Deliverables/Digital/broken-deliverable.png"),
        b"not a PNG",
    );
    write(&ticket.join("Deliverables/Video/broken.mp4"), b"not an MP4");

    let summary = run(
        plan(input, output.clone(), vec![ticket]),
        &RecordingEvents::default(),
    );
    let log: AssetFailureLog =
        serde_json::from_slice(&fs::read(output.join(ASSET_LOG_NAME)).unwrap()).unwrap();

    assert_eq!(summary.failed_files, 4);
    assert_eq!(log.schema_version, 1);
    assert_eq!(log.failures.len(), 4);
    let expected = [
        (
            AssetFailureOperation::PdfToImage,
            AssetFailureCategory::Deliverables,
            output
                .join("P1 Broken Media")
                .join("Deliverables")
                .join("broken.pdf")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            AssetFailureOperation::ImageResize,
            AssetFailureCategory::Master,
            output
                .join("P1 Broken Media")
                .join("Master")
                .join("broken-master.jpg")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            AssetFailureOperation::ImageResize,
            AssetFailureCategory::Deliverables,
            output
                .join("P1 Broken Media")
                .join("Deliverables")
                .join("broken-deliverable.png")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            AssetFailureOperation::VideoResize,
            AssetFailureCategory::Deliverables,
            output
                .join("P1 Broken Media")
                .join("Deliverables")
                .join("broken.mp4")
                .to_string_lossy()
                .into_owned(),
        ),
    ];
    assert_eq!(
        log.failures
            .iter()
            .map(|failure| (failure.operation, failure.category, failure.path.clone()))
            .collect::<Vec<_>>(),
        expected
    );
    assert!(log
        .failures
        .iter()
        .all(|failure| failure.ticket == "P1 Broken Media" && !failure.message.is_empty()));

    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(output.join(ASSET_LOG_NAME)).unwrap()).unwrap();
    assert!(value["failures"]
        .as_array()
        .unwrap()
        .iter()
        .all(|failure| failure.as_object().unwrap().len() == 5));
}
