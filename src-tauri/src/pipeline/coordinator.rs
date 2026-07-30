use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pdfium_render::prelude::Pdfium;

use super::collection::{collect_from_source, replace_ticket_output};
use super::discovery::find_source_folders;
use super::images::resize_images;
use super::ipc::{
    LogLevel, PipelineEvent, PipelineStage, PipelineSummary, ProcessingOptions, RunStatus,
    TicketStatus,
};
use super::pdf::convert_pdfs;
use super::types::{CollectionOutcome, NoticeLevel, PipelineNotice, ProcessingOutcome};
use super::videos::{resize_videos, MediaToolRunner};

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
    }

    summary.status = if total_tickets > 0 && summary.successful_tickets == total_tickets {
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
    let mut copied_sources = Vec::new();
    for source in discovery.folders {
        ticket_log(
            events,
            &ticket_name,
            &mut result,
            LogLevel::Info,
            format!("Traversing source: {}", source.display()),
            Some(&source),
        );
        match collect_from_source(&source, &ticket_output) {
            Ok(outcome) => absorb_collection(
                events,
                &ticket_name,
                &mut result,
                &mut copied_sources,
                outcome,
            ),
            Err(error) => {
                result.failed_files += 1;
                ticket_log(
                    events,
                    &ticket_name,
                    &mut result,
                    LogLevel::Error,
                    format!("Source collection failed: {error}"),
                    Some(&source),
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
        let pdf_outcome = {
            let mut on_notice = |notice| absorb_notice(events, &ticket_name, &mut result, notice);
            convert_pdfs(&ticket_output, pdfium, &mut on_notice)
        };
        match pdf_outcome {
            Ok(outcome) => absorb_processing(&mut result, outcome),
            Err(error) => ticket_log(
                events,
                &ticket_name,
                &mut result,
                LogLevel::Error,
                format!("PDF stage failed: {error}"),
                Some(&ticket_output),
            ),
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
        let image_outcome = {
            let mut on_notice = |notice| absorb_notice(events, &ticket_name, &mut result, notice);
            resize_images(&ticket_output, &mut on_notice)
        };
        match image_outcome {
            Ok(outcome) => absorb_processing(&mut result, outcome),
            Err(error) => ticket_log(
                events,
                &ticket_name,
                &mut result,
                LogLevel::Error,
                format!("Image stage failed: {error}"),
                Some(&ticket_output),
            ),
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
        let video_outcome = {
            let mut on_notice = |notice| absorb_notice(events, &ticket_name, &mut result, notice);
            resize_videos(&ticket_output, media_tools, &mut on_notice)
        };
        match video_outcome {
            Ok(outcome) => absorb_processing(&mut result, outcome),
            Err(error) => ticket_log(
                events,
                &ticket_name,
                &mut result,
                LogLevel::Error,
                format!("Video stage failed: {error}"),
                Some(&ticket_output),
            ),
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
    let report_path = ticket_output.join("report.txt");
    let report = copied_sources
        .iter()
        .map(|path: &PathBuf| path.to_string_lossy())
        .collect::<Vec<_>>()
        .join("\n");
    let report = if report.is_empty() {
        report
    } else {
        format!("{report}\n")
    };
    match fs::write(&report_path, report) {
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

    finish_ticket(events, ticket_name, result, started.elapsed())
}

fn absorb_collection(
    events: &impl PipelineEventSink,
    ticket: &str,
    result: &mut TicketResult,
    copied_sources: &mut Vec<PathBuf>,
    outcome: CollectionOutcome,
) {
    result.copied_files += outcome.copied.len();
    result.failed_files += outcome.failed_files;
    copied_sources.extend(outcome.copied.into_iter().map(|asset| asset.source));
    absorb_notices(events, ticket, result, outcome.notices);
}

fn absorb_processing(result: &mut TicketResult, outcome: ProcessingOutcome) {
    result.changed_files += outcome.changed;
    result.failed_files += outcome.failed_files;
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
