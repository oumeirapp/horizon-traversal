use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pdfium_render::prelude::Pdfium;

use super::asset_log::{
    AssetFailure, AssetFailureCategory, AssetFailureLog, AssetFailureOperation, ASSET_LOG_NAME,
};
use super::collection::{
    category_output_path, collect_from_source, replace_ticket_output, OUTPUT_CATEGORY_ORDER,
};
use super::discovery::find_source_folders;
use super::files::{remove_regular_file_if_exists, write_utf8_atomic};
use super::images::resize_images;
use super::ipc::{
    LogLevel, PipelineEvent, PipelineStage, PipelineSummary, ProcessingOptions, RunStatus,
    TicketStatus,
};
use super::pdf::convert_pdfs;
use super::report::{build_ticket_report, render_aggregate_report, ReportAsset, TicketReport};
use super::types::{
    CollectionOutcome, NoticeLevel, PipelineNotice, ProcessingOutcome, SourceRootKind,
};
use super::videos::{resize_videos, MediaToolRunner};

const AGGREGATE_REPORT_NAME: &str = "1. report.csv";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelinePlan {
    pub input: PathBuf,
    pub output: PathBuf,
    pub tickets: Vec<PathBuf>,
    pub processing_options: ProcessingOptions,
}

pub trait PipelineEventSink: Send + Sync {
    fn emit(&self, event: PipelineEvent);
}

impl<F> PipelineEventSink for F
where
    F: Fn(PipelineEvent) + Send + Sync,
{
    fn emit(&self, event: PipelineEvent) {
        self(event);
    }
}

pub fn run_pipeline(
    plan: PipelinePlan,
    pdfium: Option<&Pdfium>,
    media_tools: &impl MediaToolRunner,
    events: &impl PipelineEventSink,
) -> PipelineSummary {
    let started = Instant::now();
    let total_tickets = plan.tickets.len();
    events.emit(PipelineEvent::PipelineStarted { total_tickets });
    emit_log(
        events,
        None,
        LogLevel::Info,
        format!("Input: {}", plan.input.display()),
        Some(&plan.input),
    );

    emit_log(
        events,
        None,
        LogLevel::Info,
        format!("Output: {}", plan.output.display()),
        Some(&plan.output),
    );

    let mut summary = PipelineSummary {
        status: RunStatus::Failed,
        total_tickets,
        successful_tickets: 0,
        partial_tickets: 0,
        failed_tickets: 0,
        copied_files: 0,
        changed_files: 0,
        failed_files: 0,
        warnings: 0,
        errors: 0,
        elapsed_ms: 0,
        output_path: plan.output.to_string_lossy().into_owned(),
    };

    let aggregate_report_path = plan.output.join(AGGREGATE_REPORT_NAME);
    let asset_log_path = plan.output.join(ASSET_LOG_NAME);
    if let Err(error) = initialize_asset_failure_log(&plan.output, &asset_log_path) {
        summary.failed_tickets = total_tickets;
        summary.errors += 1;
        emit_log(
            events,
            None,
            LogLevel::Error,
            format!(
                "Asset failure log initialization failed; pipeline aborted before processing: {error}"
            ),
            Some(&asset_log_path),
        );
        write_aggregate_report(&aggregate_report_path, &[], events, &mut summary);
        summary.elapsed_ms = duration_ms(started.elapsed());
        events.emit(PipelineEvent::PipelineCompleted {
            summary: summary.clone(),
        });
        return summary;
    }
    let _ = remove_regular_file_if_exists(&aggregate_report_path);
    let mut ticket_reports = Vec::new();
    let mut asset_failures = Vec::new();

    for (offset, ticket) in plan.tickets.iter().enumerate() {
        let name = ticket_name(ticket);
        events.emit(PipelineEvent::TicketStarted {
            ticket: name.clone(),
            index: offset + 1,
            total_tickets,
        });
        let result = process_ticket(
            ticket,
            &plan.output,
            plan.processing_options,
            pdfium,
            media_tools,
            events,
        );
        match result.status {
            RunStatus::Success => summary.successful_tickets += 1,
            RunStatus::PartialSuccess => summary.partial_tickets += 1,
            RunStatus::Failed => summary.failed_tickets += 1,
        }
        summary.copied_files += result.copied_files;
        summary.changed_files += result.changed_files;
        summary.failed_files += result.failed_files;
        summary.warnings += result.warnings;
        summary.errors += result.errors;
        if let Some(report) = result.report {
            ticket_reports.push(report);
        }
        asset_failures.extend(result.asset_failures);
    }

    write_aggregate_report(
        &aggregate_report_path,
        &ticket_reports,
        events,
        &mut summary,
    );

    let asset_log = AssetFailureLog {
        schema_version: 1,
        failures: asset_failures,
    };
    match write_asset_failure_log(&asset_log_path, &asset_log) {
        Ok(()) => emit_log(
            events,
            None,
            LogLevel::Success,
            format!(
                "Asset failure log created with {} failure(s)",
                asset_log.failures.len()
            ),
            Some(&asset_log_path),
        ),
        Err(error) => {
            summary.errors += 1;
            emit_log(
                events,
                None,
                LogLevel::Error,
                format!("Asset failure log creation failed: {error}"),
                Some(&asset_log_path),
            );
        }
    }

    summary.status = if total_tickets > 0
        && summary.successful_tickets == total_tickets
        && summary.errors == 0
    {
        RunStatus::Success
    } else if summary.successful_tickets + summary.partial_tickets > 0 {
        RunStatus::PartialSuccess
    } else {
        RunStatus::Failed
    };
    summary.elapsed_ms = duration_ms(started.elapsed());
    events.emit(PipelineEvent::PipelineCompleted {
        summary: summary.clone(),
    });
    summary
}

#[derive(Debug)]
struct TicketResult {
    status: TicketStatus,
    copied_files: usize,
    changed_files: usize,
    failed_files: usize,
    warnings: usize,
    errors: usize,
    report_written: bool,
    report: Option<TicketReport>,
    asset_failures: Vec<AssetFailure>,
}

impl Default for TicketResult {
    fn default() -> Self {
        Self {
            status: RunStatus::Failed,
            copied_files: 0,
            changed_files: 0,
            failed_files: 0,
            warnings: 0,
            errors: 0,
            report_written: false,
            report: None,
            asset_failures: Vec::new(),
        }
    }
}

fn process_ticket(
    ticket: &Path,
    output_root: &Path,
    processing_options: ProcessingOptions,
    pdfium: Option<&Pdfium>,
    media_tools: &impl MediaToolRunner,
    events: &impl PipelineEventSink,
) -> TicketResult {
    let started = Instant::now();
    let ticket_name = ticket_name(ticket);
    let mut result = TicketResult::default();

    let ticket_output = match replace_ticket_output(output_root, ticket) {
        Ok(path) => path,
        Err(error) => {
            ticket_log(
                events,
                &ticket_name,
                &mut result,
                LogLevel::Error,
                format!("Cannot prepare ticket output: {error}"),
                None,
            );
            return finish_ticket(events, ticket_name, result, started.elapsed());
        }
    };
    let category_outputs =
        OUTPUT_CATEGORY_ORDER.map(|source_kind| category_output_path(&ticket_output, source_kind));

    stage(events, &ticket_name, PipelineStage::Discover);
    ticket_log(
        events,
        &ticket_name,
        &mut result,
        LogLevel::Info,
        "Scanning for source folders".to_owned(),
        Some(ticket),
    );
    let discovery = match find_source_folders(ticket) {
        Ok(discovery) => discovery,
        Err(error) => {
            ticket_log(
                events,
                &ticket_name,
                &mut result,
                LogLevel::Error,
                format!("Source discovery failed: {error}"),
                Some(ticket),
            );
            return finish_ticket(events, ticket_name, result, started.elapsed());
        }
    };
    absorb_notices(events, &ticket_name, &mut result, discovery.notices);
    if discovery.folders.is_empty() {
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Warning,
            "No Master Files or Deliverables folders found".to_owned(),
            Some(ticket),
        );
        return finish_ticket(events, ticket_name, result, started.elapsed());
    }

    stage(events, &ticket_name, PipelineStage::Copy);
    let mut report_assets = Vec::new();
    for source in discovery.folders {
        let category_output = category_output_path(&ticket_output, source.kind);
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Info,
            format!("Traversing source: {}", source.path.display()),
            Some(&source.path),
        );
        match collect_from_source(&source, &category_output) {
            Ok(outcome) => {
                report_assets.extend(outcome.copied.iter().map(|asset| ReportAsset {
                    source_root: source.path.clone(),
                    relative_source: asset.relative_source.clone(),
                    source_kind: source.kind,
                }));
                absorb_collection(events, &ticket_name, &mut result, outcome);
            }
            Err(error) => {
                result.failed_files += 1;
                ticket_log(
                    events,
                    &ticket_name,
                    &mut result,
                    LogLevel::Error,
                    format!("Source collection failed: {error}"),
                    Some(&source.path),
                );
            }
        }
    }
    if result.copied_files == 0 {
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Warning,
            "No supported assets were copied".to_owned(),
            Some(&ticket_output),
        );
    } else {
        let copied_files = result.copied_files;
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Success,
            format!("Copied {copied_files} asset(s)"),
            Some(&ticket_output),
        );
    }

    stage(events, &ticket_name, PipelineStage::Pdf);
    if !processing_options.pdf {
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Info,
            "PDF optimization disabled for this run; skipped".to_owned(),
            Some(&ticket_output),
        );
    } else if let Some(pdfium) = pdfium {
        for (source_kind, category_output) in
            OUTPUT_CATEGORY_ORDER.into_iter().zip(&category_outputs)
        {
            let pdf_outcome = {
                let mut on_notice =
                    |notice| absorb_notice(events, &ticket_name, &mut result, notice);
                convert_pdfs(category_output, pdfium, &mut on_notice)
            };
            match pdf_outcome {
                Ok(outcome) => absorb_processing(
                    &ticket_name,
                    &mut result,
                    outcome,
                    AssetFailureOperation::PdfToImage,
                    failure_category(source_kind),
                ),
                Err(error) => ticket_log(
                    events,
                    &ticket_name,
                    &mut result,
                    LogLevel::Error,
                    format!("PDF stage failed: {error}"),
                    Some(category_output),
                ),
            }
        }
    } else {
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Error,
            "PDF optimization is enabled, but PDFium is unavailable".to_owned(),
            Some(&ticket_output),
        );
    }

    stage(events, &ticket_name, PipelineStage::Images);
    if processing_options.images {
        for (source_kind, category_output) in
            OUTPUT_CATEGORY_ORDER.into_iter().zip(&category_outputs)
        {
            let image_outcome = {
                let mut on_notice =
                    |notice| absorb_notice(events, &ticket_name, &mut result, notice);
                resize_images(category_output, &mut on_notice)
            };
            match image_outcome {
                Ok(outcome) => absorb_processing(
                    &ticket_name,
                    &mut result,
                    outcome,
                    AssetFailureOperation::ImageResize,
                    failure_category(source_kind),
                ),
                Err(error) => ticket_log(
                    events,
                    &ticket_name,
                    &mut result,
                    LogLevel::Error,
                    format!("Image stage failed: {error}"),
                    Some(category_output),
                ),
            }
        }
    } else {
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Info,
            "Image optimization disabled for this run; skipped".to_owned(),
            Some(&ticket_output),
        );
    }

    stage(events, &ticket_name, PipelineStage::Video);
    if processing_options.video {
        for (source_kind, category_output) in
            OUTPUT_CATEGORY_ORDER.into_iter().zip(&category_outputs)
        {
            let video_outcome = {
                let mut on_notice =
                    |notice| absorb_notice(events, &ticket_name, &mut result, notice);
                resize_videos(category_output, media_tools, &mut on_notice)
            };
            match video_outcome {
                Ok(outcome) => absorb_processing(
                    &ticket_name,
                    &mut result,
                    outcome,
                    AssetFailureOperation::VideoResize,
                    failure_category(source_kind),
                ),
                Err(error) => ticket_log(
                    events,
                    &ticket_name,
                    &mut result,
                    LogLevel::Error,
                    format!("Video stage failed: {error}"),
                    Some(category_output),
                ),
            }
        }
    } else {
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Info,
            "Video optimization disabled for this run; skipped".to_owned(),
            Some(&ticket_output),
        );
    }

    stage(events, &ticket_name, PipelineStage::Report);
    let report_path = ticket_output.join("report.csv");
    let report = build_ticket_report(&ticket_name, &report_assets);
    match fs::write(&report_path, report.render()) {
        Ok(()) => {
            result.report_written = true;
            ticket_log(
                events,
                &ticket_name,
                &mut result,
                LogLevel::Success,
                "Report created".to_owned(),
                Some(&report_path),
            );
        }
        Err(error) => {
            ticket_log(
                events,
                &ticket_name,
                &mut result,
                LogLevel::Error,
                format!("Report creation failed: {error}"),
                Some(&report_path),
            );
        }
    }
    result.report = Some(report);

    finish_ticket(events, ticket_name, result, started.elapsed())
}

fn absorb_collection(
    events: &impl PipelineEventSink,
    ticket: &str,
    result: &mut TicketResult,
    outcome: CollectionOutcome,
) {
    result.copied_files += outcome.copied.len();
    result.failed_files += outcome.failed_files;
    absorb_notices(events, ticket, result, outcome.notices);
}

fn absorb_processing(
    ticket: &str,
    result: &mut TicketResult,
    outcome: ProcessingOutcome,
    operation: AssetFailureOperation,
    category: AssetFailureCategory,
) {
    result.changed_files += outcome.changed;
    result.failed_files += outcome.failed_files;
    result
        .asset_failures
        .extend(outcome.failures.into_iter().map(|failure| {
            AssetFailure::new(operation, ticket, category, &failure.path, failure.message)
        }));
}

fn failure_category(source_kind: SourceRootKind) -> AssetFailureCategory {
    match source_kind {
        SourceRootKind::MasterFiles => AssetFailureCategory::Master,
        SourceRootKind::Deliverables => AssetFailureCategory::Deliverables,
    }
}

fn initialize_asset_failure_log(output_root: &Path, path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(output_root)?;
    remove_regular_file_if_exists(path)?;
    write_asset_failure_log(path, &AssetFailureLog::default())
}

fn write_asset_failure_log(path: &Path, log: &AssetFailureLog) -> std::io::Result<()> {
    let contents = log
        .render()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_utf8_atomic(path, &contents)
}

fn write_aggregate_report(
    path: &Path,
    reports: &[TicketReport],
    events: &impl PipelineEventSink,
    summary: &mut PipelineSummary,
) {
    let aggregate_report = render_aggregate_report(reports);
    match write_utf8_atomic(path, &aggregate_report) {
        Ok(()) => emit_log(
            events,
            None,
            LogLevel::Success,
            "Aggregate report created".to_owned(),
            Some(path),
        ),
        Err(error) => {
            summary.errors += 1;
            emit_log(
                events,
                None,
                LogLevel::Error,
                format!("Aggregate report creation failed: {error}"),
                Some(path),
            );
        }
    }
}

fn absorb_notices(
    events: &impl PipelineEventSink,
    ticket: &str,
    result: &mut TicketResult,
    notices: Vec<PipelineNotice>,
) {
    for notice in notices {
        absorb_notice(events, ticket, result, notice);
    }
}

fn absorb_notice(
    events: &impl PipelineEventSink,
    ticket: &str,
    result: &mut TicketResult,
    notice: PipelineNotice,
) {
    let level = match notice.level {
        NoticeLevel::Info => LogLevel::Info,
        NoticeLevel::Success => LogLevel::Success,
        NoticeLevel::Warning => LogLevel::Warning,
        NoticeLevel::Error => LogLevel::Error,
    };
    ticket_log(
        events,
        ticket,
        result,
        level,
        notice.message,
        notice.path.as_deref(),
    );
}

fn finish_ticket(
    events: &impl PipelineEventSink,
    ticket: String,
    mut result: TicketResult,
    elapsed: Duration,
) -> TicketResult {
    result.status = if result.errors == 0 {
        RunStatus::Success
    } else if result.report_written {
        RunStatus::PartialSuccess
    } else {
        RunStatus::Failed
    };
    events.emit(PipelineEvent::TicketCompleted {
        ticket,
        status: result.status,
        copied_files: result.copied_files,
        changed_files: result.changed_files,
        failed_files: result.failed_files,
        warnings: result.warnings,
        errors: result.errors,
        elapsed_ms: duration_ms(elapsed),
    });
    result
}

fn stage(events: &impl PipelineEventSink, ticket: &str, stage: PipelineStage) {
    events.emit(PipelineEvent::StageChanged {
        ticket: ticket.to_owned(),
        stage,
    });
}

fn ticket_log(
    events: &impl PipelineEventSink,
    ticket: &str,
    result: &mut TicketResult,
    level: LogLevel,
    message: String,
    path: Option<&Path>,
) {
    match level {
        LogLevel::Warning => result.warnings += 1,
        LogLevel::Error => result.errors += 1,
        LogLevel::Info | LogLevel::Success => {}
    }
    emit_log(events, Some(ticket), level, message, path);
}

fn emit_log(
    events: &impl PipelineEventSink,
    ticket: Option<&str>,
    level: LogLevel,
    message: String,
    path: Option<&Path>,
) {
    events.emit(PipelineEvent::Log {
        ticket: ticket.map(str::to_owned),
        level,
        message,
        path: path.map(|path| path.to_string_lossy().into_owned()),
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    });
}

fn ticket_name(ticket: &Path) -> String {
    ticket
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}
