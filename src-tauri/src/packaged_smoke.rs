//! Opt-in harness for exercising the installed application without exposing a
//! testing command to the webview.
//!
//! This module is compiled only with the packaged-smoke Cargo feature and is
//! dormant unless REQUEST_ENV is set. A caller launches the executable inside
//! the app bundle with a JSON request in that environment variable; the
//! harness uses the same validation, coordinator, PDFium resolver, and Tauri
//! sidecar runner as a normal invocation, then atomically writes one JSON
//! report before requesting application exit.

use std::env;
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Manager, Runtime};

use crate::commands::validate_request;
use crate::pipeline::coordinator::{run_pipeline, PipelineEventSink};
use crate::pipeline::ipc::{
    PipelineEvent, PipelineSummary, ProcessingOptions, RunStatus, SelectionRequest, ValidationIssue,
};
use crate::pipeline::native::resolve_pdfium_library;
use crate::pipeline::pdf::shared_pdfium;
use crate::pipeline::selection::validate_roots;
use crate::pipeline::videos::TauriMediaToolRunner;

pub const REQUEST_ENV: &str = "HORIZON_TRAVERSAL_PACKAGED_SMOKE_REQUEST";

const REPORT_SCHEMA_VERSION: u8 = 1;
const FAILURE_EXIT_CODE: i32 = 2;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackagedSmokeRequest {
    #[serde(flatten)]
    selection: SelectionRequest,
    result_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionSnapshot {
    input_path: String,
    output_path: String,
    ticket_filter: String,
    processing_options: ProcessingOptions,
}

impl From<&SelectionRequest> for SelectionSnapshot {
    fn from(request: &SelectionRequest) -> Self {
        Self {
            input_path: request.input_path.clone(),
            output_path: request.output_path.clone(),
            ticket_filter: request.ticket_filter.clone(),
            processing_options: request.processing_options,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SmokeOutcome {
    Passed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResolvedNativeAssets {
    resource_directory: Option<String>,
    pdfium_library: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SmokeFailure {
    stage: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    validation_issues: Vec<ValidationIssue>,
}

impl SmokeFailure {
    fn new(stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            stage,
            message: message.into(),
            validation_issues: Vec::new(),
        }
    }

    fn validation(issues: Vec<ValidationIssue>) -> Self {
        Self {
            stage: "validation",
            message: "The packaged smoke selection is invalid.".to_owned(),
            validation_issues: issues,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackagedSmokeReport {
    schema_version: u8,
    outcome: SmokeOutcome,
    selection: SelectionSnapshot,
    native_assets: ResolvedNativeAssets,
    events: Vec<PipelineEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<PipelineSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<SmokeFailure>,
}

#[derive(Default)]
struct RecordingEventSink(Mutex<Vec<PipelineEvent>>);

impl RecordingEventSink {
    fn snapshot(&self) -> Vec<PipelineEvent> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl PipelineEventSink for RecordingEventSink {
    fn emit(&self, event: PipelineEvent) {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(event);
    }
}

pub(crate) fn setup<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn Error>> {
    let Some(raw_request) = env::var_os(REQUEST_ENV) else {
        return Ok(());
    };
    let raw_request = raw_request
        .into_string()
        .map_err(|_| format!("{REQUEST_ENV} must contain UTF-8 JSON"))?;
    let request: PackagedSmokeRequest = serde_json::from_str(&raw_request)
        .map_err(|error| format!("invalid {REQUEST_ENV}: {error}"))?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    let app_handle = app.handle().clone();
    std::thread::Builder::new()
        .name("packaged-smoke".to_owned())
        .spawn(move || run_and_exit(app_handle, request))?;
    Ok(())
}

fn run_and_exit<R: Runtime>(app: AppHandle<R>, request: PackagedSmokeRequest) {
    let selection = SelectionSnapshot::from(&request.selection);
    let events = RecordingEventSink::default();
    let mut native_assets = ResolvedNativeAssets::default();

    let execution = execute_pipeline(&app, &request.selection, &events, &mut native_assets);
    let (outcome, summary, error) = match execution {
        Ok(summary) if summary.status == RunStatus::Success => {
            (SmokeOutcome::Passed, Some(summary), None)
        }
        Ok(summary) => {
            let status = serde_json::to_value(summary.status)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "unknown".to_owned());
            (
                SmokeOutcome::Failed,
                Some(summary),
                Some(SmokeFailure::new(
                    "pipeline",
                    format!("The pipeline completed with status {status}."),
                )),
            )
        }
        Err(error) => (SmokeOutcome::Failed, None, Some(error)),
    };
    let exit_code = if outcome == SmokeOutcome::Passed {
        0
    } else {
        FAILURE_EXIT_CODE
    };
    let report = PackagedSmokeReport {
        schema_version: REPORT_SCHEMA_VERSION,
        outcome,
        selection,
        native_assets,
        events: events.snapshot(),
        summary,
        error,
    };

    if let Err(error) = write_report(&request.result_path, &report) {
        eprintln!(
            "failed to write packaged smoke report {}: {error}",
            request.result_path.display()
        );
        app.exit(FAILURE_EXIT_CODE);
        return;
    }

    app.exit(exit_code);
}

fn execute_pipeline<R: Runtime>(
    app: &AppHandle<R>,
    request: &SelectionRequest,
    events: &RecordingEventSink,
    native_assets: &mut ResolvedNativeAssets,
) -> Result<PipelineSummary, SmokeFailure> {
    let (selection, plan) = validate_request(request);
    let mut plan = plan.ok_or_else(|| SmokeFailure::validation(selection.issues))?;

    fs::create_dir_all(&plan.output).map_err(|error| {
        SmokeFailure::new(
            "output",
            format!(
                "Cannot create output folder {}: {error}",
                plan.output.display()
            ),
        )
    })?;
    let roots = validate_roots(&plan.input, &plan.output)
        .map_err(|error| SmokeFailure::new("validation", error.to_string()))?;
    plan.input = roots.input;
    plan.output = roots.output;

    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| SmokeFailure::new("resources", error.to_string()))?;
    native_assets.resource_directory = Some(resource_directory.to_string_lossy().into_owned());
    let pdfium = if plan.processing_options.pdf {
        let pdfium_path = resolve_pdfium_library(Some(&resource_directory))
            .map_err(|error| SmokeFailure::new("pdfium", error.to_string()))?;
        native_assets.pdfium_library = Some(pdfium_path.to_string_lossy().into_owned());
        Some(
            shared_pdfium(&pdfium_path)
                .map_err(|error| SmokeFailure::new("pdfium", error.to_string()))?,
        )
    } else {
        None
    };
    let media_tools = TauriMediaToolRunner::new(app.clone());

    Ok(run_pipeline(plan, pdfium, &media_tools, events))
}

fn write_report(path: &Path, report: &PackagedSmokeReport) -> Result<(), Box<dyn Error>> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("the packaged smoke result path must include a parent directory")?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("the packaged smoke result path must end in a UTF-8 file name")?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));

    let result = (|| -> Result<(), Box<dyn Error>> {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, report)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        fs::rename(&temporary, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn request_uses_the_frontend_selection_shape_plus_a_result_path() {
        let request: PackagedSmokeRequest = serde_json::from_value(json!({
            "inputPath": "/fixtures/input",
            "outputPath": "/fixtures/output",
            "ticketFilter": "P1-P3",
            "processingOptions": {
                "pdf": false,
                "images": true,
                "video": false
            },
            "resultPath": "/tmp/horizon-traversal-smoke.json"
        }))
        .unwrap();

        assert_eq!(request.selection.input_path, "/fixtures/input");
        assert_eq!(request.selection.output_path, "/fixtures/output");
        assert_eq!(request.selection.ticket_filter, "P1-P3");
        assert_eq!(
            request.selection.processing_options,
            ProcessingOptions {
                pdf: false,
                images: true,
                video: false,
            }
        );
        assert_eq!(
            request.result_path,
            PathBuf::from("/tmp/horizon-traversal-smoke.json")
        );
    }

    #[test]
    fn report_is_written_atomically_with_the_versioned_shape() {
        let temporary = tempdir().unwrap();
        let destination = temporary.path().join("result.json");
        let report = PackagedSmokeReport {
            schema_version: REPORT_SCHEMA_VERSION,
            outcome: SmokeOutcome::Failed,
            selection: SelectionSnapshot {
                input_path: "/input".to_owned(),
                output_path: "/output".to_owned(),
                ticket_filter: String::new(),
                processing_options: ProcessingOptions::default(),
            },
            native_assets: ResolvedNativeAssets::default(),
            events: Vec::new(),
            summary: None,
            error: Some(SmokeFailure::new("validation", "invalid fixture")),
        };

        write_report(&destination, &report).unwrap();

        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&destination).unwrap()).unwrap();
        assert_eq!(document["schemaVersion"], 1);
        assert_eq!(document["outcome"], "failed");
        assert_eq!(document["selection"]["inputPath"], "/input");
        assert_eq!(document["selection"]["processingOptions"]["pdf"], true);
        assert_eq!(document["error"]["stage"], "validation");
        assert!(!temporary
            .path()
            .join(format!(".result.json.{}.tmp", std::process::id()))
            .exists());
    }
}
