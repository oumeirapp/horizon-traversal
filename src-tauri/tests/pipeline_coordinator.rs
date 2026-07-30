use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

fn write(path: &Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
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
    write(&source.join("document.pdf"), b"not a PDF fixture");
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
    assert_eq!(summary.copied_files, 3);
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
        fs::read(output.join("P1 Unoptimized/document.pdf")).unwrap(),
        b"not a PDF fixture"
    );
    assert_eq!(
        fs::read(output.join("P1 Unoptimized/poster.jpg")).unwrap(),
        b"not a JPEG fixture"
    );
    assert_eq!(
        fs::read(output.join("P1 Unoptimized/clip.mp4")).unwrap(),
        b"not an MP4 fixture"
    );
}

#[test]
fn multi_ticket_run_orders_events_and_keeps_reports_ticket_local() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let output = temp.path().join("output");
    let first = input.join("P1 First");
    let second = input.join("P2 Second");
    let first_asset = first.join("Deliverables/nested/first.gif");
    let second_asset = second.join("Master Files/second.gif");
    write(&first_asset, b"first fixture");
    write(&second_asset, b"second fixture");

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

    let first_source = fs::canonicalize(first_asset).unwrap();
    let second_source = fs::canonicalize(second_asset).unwrap();
    assert_eq!(
        fs::read_to_string(output.join("P1 First/report.txt")).unwrap(),
        format!("{}\n", first_source.display())
    );
    assert_eq!(
        fs::read_to_string(output.join("P2 Second/report.txt")).unwrap(),
        format!("{}\n", second_source.display())
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

    assert!(!output.join("P1 Missing Sources/report.txt").exists());
    assert!(output.join("P2 Ready/report.txt").is_file());
    assert_eq!(
        fs::read_to_string(output.join("P2 Ready/report.txt")).unwrap(),
        format!(
            "{}\n",
            fs::canonicalize(successful_asset).unwrap().display()
        )
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
}
