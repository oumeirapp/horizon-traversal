use std::fs;
use std::path::Path;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::pipeline::coordinator::{run_pipeline, PipelineEventSink, PipelinePlan};
use crate::pipeline::fs_safety::metadata_is_link_like;
use crate::pipeline::ipc::{
    AppError, PipelineEvent, PipelineSummary, SelectionRequest, SelectionSummary, TicketMatch,
    ValidationField, ValidationIssue,
};
use crate::pipeline::native::resolve_pdfium_library;
use crate::pipeline::pdf::shared_pdfium;
use crate::pipeline::selection::{parse_filter, select_tickets, validate_roots, SelectionError};
use crate::pipeline::videos::TauriMediaToolRunner;
use crate::state::AppState;

struct ChannelEventSink(Channel<PipelineEvent>);

impl PipelineEventSink for ChannelEventSink {
    fn emit(&self, event: PipelineEvent) {
        let _ = self.0.send(event);
    }
}

#[tauri::command]
pub async fn validate_selection(request: SelectionRequest) -> Result<SelectionSummary, AppError> {
    tauri::async_runtime::spawn_blocking(move || validate_request(&request).0)
        .await
        .map_err(|error| AppError::new("validationWorkerFailed", error.to_string()))
}

#[tauri::command]
pub async fn start_pipeline(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SelectionRequest,
    on_event: Channel<PipelineEvent>,
) -> Result<PipelineSummary, AppError> {
    let permit = state.try_begin_run().ok_or_else(|| {
        AppError::new(
            "runInProgress",
            "Another processing run is already in progress.",
        )
    })?;
    let (selection, plan) = validate_request(&request);
    let mut plan = plan.ok_or_else(|| selection_error(&selection))?;
    let state = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        fs::create_dir_all(&plan.output).map_err(|error| {
            AppError::field(
                "createOutputFailed",
                format!("Cannot create the output folder: {error}"),
                ValidationField::Output,
            )
        })?;
        let roots = validate_roots(&plan.input, &plan.output).map_err(app_error_from_selection)?;
        plan.input = roots.input;
        plan.output = roots.output;

        let resource_directory = app.path().resource_dir().ok();
        let pdfium_path = resolve_pdfium_library(resource_directory.as_deref())
            .map_err(|error| AppError::new("pdfiumUnavailable", error.to_string()))?;
        let pdfium = shared_pdfium(&pdfium_path)
            .map_err(|error| AppError::new("pdfiumUnavailable", error))?;
        let media_tools = TauriMediaToolRunner::new(app);
        let events = ChannelEventSink(on_event);
        let summary = run_pipeline(plan.clone(), pdfium, &media_tools, &events);

        if plan.output.is_dir() {
            state.set_last_output(plan.output);
        }
        Ok(summary)
    })
    .await
    .map_err(|error| AppError::new("pipelineWorkerFailed", error.to_string()))?
}

#[tauri::command]
pub async fn open_last_output(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    if state.is_running() {
        return Err(AppError::new(
            "runInProgress",
            "The output folder can be opened after processing finishes.",
        ));
    }
    let stored = state.last_output().ok_or_else(|| {
        AppError::new(
            "noLastOutput",
            "No completed output folder is available yet.",
        )
    })?;
    let metadata = fs::symlink_metadata(&stored)
        .map_err(|error| AppError::new("outputUnavailable", error.to_string()))?;
    if metadata_is_link_like(&metadata) || !metadata.is_dir() {
        return Err(AppError::new(
            "outputUnavailable",
            "The stored output folder is no longer a safe directory.",
        ));
    }
    let canonical = fs::canonicalize(&stored)
        .map_err(|error| AppError::new("outputUnavailable", error.to_string()))?;
    if canonical != stored {
        return Err(AppError::new(
            "outputUnavailable",
            "The stored output folder has changed since processing completed.",
        ));
    }

    app.opener()
        .open_path(stored.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| AppError::new("openOutputFailed", error.to_string()))
}

pub(crate) fn validate_request(
    request: &SelectionRequest,
) -> (SelectionSummary, Option<PipelinePlan>) {
    let input_text = request.input_path.trim();
    let output_text = request.output_path.trim();
    let mut summary = SelectionSummary {
        valid: false,
        input_path: input_text.to_owned(),
        output_path: output_text.to_owned(),
        tickets: Vec::new(),
        warnings: Vec::new(),
        issues: Vec::new(),
    };

    if input_text.is_empty() {
        summary.issues.push(issue(
            ValidationField::Input,
            "inputRequired",
            "Choose an input folder.",
        ));
    }
    if output_text.is_empty() {
        summary.issues.push(issue(
            ValidationField::Output,
            "outputRequired",
            "Choose an output folder.",
        ));
    }
    if let Err(error) = parse_filter(&request.ticket_filter) {
        summary.issues.push(issue(
            ValidationField::Filter,
            "invalidTicketFilter",
            error.to_string(),
        ));
    }
    if !summary.issues.is_empty() {
        return (summary, None);
    }

    let roots = match validate_roots(Path::new(input_text), Path::new(output_text)) {
        Ok(roots) => roots,
        Err(error) => {
            let app_error = app_error_from_selection(error);
            summary.issues.push(ValidationIssue {
                field: app_error.field.unwrap_or(ValidationField::General),
                code: app_error.code,
                message: app_error.message,
            });
            return (summary, None);
        }
    };
    summary.input_path = roots.input.to_string_lossy().into_owned();
    summary.output_path = roots.output.to_string_lossy().into_owned();

    let selection = match select_tickets(&roots.input, &request.ticket_filter) {
        Ok(selection) => selection,
        Err(error) => {
            let app_error = app_error_from_selection(error);
            summary.issues.push(ValidationIssue {
                field: app_error.field.unwrap_or(ValidationField::General),
                code: app_error.code,
                message: app_error.message,
            });
            return (summary, None);
        }
    };
    summary.warnings = selection
        .notices
        .into_iter()
        .map(|notice| notice.message)
        .collect();
    summary.tickets = selection
        .tickets
        .iter()
        .map(|path| TicketMatch {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: path.to_string_lossy().into_owned(),
        })
        .collect();

    if summary.tickets.is_empty() {
        summary.issues.push(issue(
            ValidationField::Selection,
            "noMatchingTickets",
            "No ticket folders match this selection.",
        ));
        return (summary, None);
    }

    summary.valid = true;
    let plan = PipelinePlan {
        input: roots.input,
        output: roots.output,
        tickets: selection.tickets,
    };
    (summary, Some(plan))
}

fn issue(
    field: ValidationField,
    code: impl Into<String>,
    message: impl Into<String>,
) -> ValidationIssue {
    ValidationIssue {
        field,
        code: code.into(),
        message: message.into(),
    }
}

fn selection_error(summary: &SelectionSummary) -> AppError {
    summary
        .issues
        .first()
        .map(|issue| AppError::field(&issue.code, &issue.message, issue.field))
        .unwrap_or_else(|| AppError::new("invalidSelection", "The selection is not valid."))
}

fn app_error_from_selection(error: SelectionError) -> AppError {
    match error {
        SelectionError::InvalidFilter(_) => AppError::field(
            "invalidTicketFilter",
            error.to_string(),
            ValidationField::Filter,
        ),
        SelectionError::InputMissing(_) | SelectionError::InputNotDirectory(_) => AppError::field(
            "invalidInputPath",
            error.to_string(),
            ValidationField::Input,
        ),
        SelectionError::OutputNotDirectory(_) => AppError::field(
            "invalidOutputPath",
            error.to_string(),
            ValidationField::Output,
        ),
        SelectionError::OverlappingRoots { .. } => AppError::field(
            "overlappingPaths",
            error.to_string(),
            ValidationField::Output,
        ),
        SelectionError::CurrentDirectory(_)
        | SelectionError::Inspect { .. }
        | SelectionError::ReadDirectory { .. }
        | SelectionError::ResolvePath { .. } => {
            AppError::new("selectionUnavailable", error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn request(input: &Path, output: &Path, ticket_filter: &str) -> SelectionRequest {
        SelectionRequest {
            input_path: input.to_string_lossy().into_owned(),
            output_path: output.to_string_lossy().into_owned(),
            ticket_filter: ticket_filter.to_owned(),
        }
    }

    #[test]
    fn validation_reports_field_specific_issues() {
        let temp = tempdir().unwrap();
        let input = temp.path().join("input");
        let output = temp.path().join("output");
        fs::create_dir(&input).unwrap();

        let (invalid_filter, _) = validate_request(&request(&input, &output, "bad"));
        assert_eq!(invalid_filter.issues[0].field, ValidationField::Filter);

        let (no_tickets, _) = validate_request(&request(&input, &output, ""));
        assert_eq!(no_tickets.issues[0].field, ValidationField::Selection);

        let (overlap, _) = validate_request(&request(&input, &input.join("out"), ""));
        assert_eq!(overlap.issues[0].code, "overlappingPaths");
    }

    #[test]
    fn validation_returns_sorted_ticket_matches_and_plan() {
        let temp = tempdir().unwrap();
        let input = temp.path().join("input");
        let output = temp.path().join("output");
        fs::create_dir_all(input.join("P10 Campaign")).unwrap();
        fs::create_dir_all(input.join("P2 Campaign")).unwrap();

        let (summary, plan) = validate_request(&request(&input, &output, "P2,P10"));

        assert!(summary.valid);
        assert_eq!(
            summary
                .tickets
                .iter()
                .map(|ticket| ticket.name.as_str())
                .collect::<Vec<_>>(),
            ["P10 Campaign", "P2 Campaign"]
        );
        assert_eq!(plan.unwrap().tickets.len(), 2);
    }
}
