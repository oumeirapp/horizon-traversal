use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRequest {
    pub input_path: String,
    pub output_path: String,
    #[serde(default)]
    pub ticket_filter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub field: ValidationField,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ValidationField {
    Input,
    Output,
    Filter,
    Selection,
    General,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TicketMatch {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSummary {
    pub valid: bool,
    pub input_path: String,
    pub output_path: String,
    pub tickets: Vec<TicketMatch>,
    pub warnings: Vec<String>,
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PipelineStage {
    Discover,
    Copy,
    Pdf,
    Images,
    Video,
    Report,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Success,
    PartialSuccess,
    Failed,
}

pub type TicketStatus = RunStatus;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSummary {
    pub status: RunStatus,
    pub total_tickets: usize,
    pub successful_tickets: usize,
    pub partial_tickets: usize,
    pub failed_tickets: usize,
    pub copied_files: usize,
    pub changed_files: usize,
    pub failed_files: usize,
    pub warnings: usize,
    pub errors: usize,
    pub elapsed_ms: u64,
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PipelineEvent {
    PipelineStarted {
        total_tickets: usize,
    },
    TicketStarted {
        ticket: String,
        index: usize,
        total_tickets: usize,
    },
    StageChanged {
        ticket: String,
        stage: PipelineStage,
    },
    Log {
        ticket: Option<String>,
        level: LogLevel,
        message: String,
        path: Option<String>,
        timestamp_ms: u64,
    },
    TicketCompleted {
        ticket: String,
        status: TicketStatus,
        copied_files: usize,
        changed_files: usize,
        failed_files: usize,
        warnings: usize,
        errors: usize,
        elapsed_ms: u64,
    },
    PipelineCompleted {
        summary: PipelineSummary,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<ValidationField>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            field: None,
        }
    }

    pub fn field(
        code: impl Into<String>,
        message: impl Into<String>,
        field: ValidationField,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            field: Some(field),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn request_deserializes_from_the_camel_case_frontend_shape() {
        let request: SelectionRequest = serde_json::from_value(json!({
            "inputPath": "/tickets",
            "outputPath": "/exports",
            "ticketFilter": "P1-P3"
        }))
        .unwrap();

        assert_eq!(request.input_path, "/tickets");
        assert_eq!(request.output_path, "/exports");
        assert_eq!(request.ticket_filter, "P1-P3");
    }

    #[test]
    fn events_serialize_as_flat_camel_case_tagged_unions() {
        let event = PipelineEvent::TicketCompleted {
            ticket: "P1 Campaign".to_owned(),
            status: RunStatus::PartialSuccess,
            copied_files: 4,
            changed_files: 2,
            failed_files: 1,
            warnings: 1,
            errors: 1,
            elapsed_ms: 250,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "type": "ticketCompleted",
                "ticket": "P1 Campaign",
                "status": "partialSuccess",
                "copiedFiles": 4,
                "changedFiles": 2,
                "failedFiles": 1,
                "warnings": 1,
                "errors": 1,
                "elapsedMs": 250
            })
        );
    }

    #[test]
    fn app_errors_omit_an_absent_field() {
        assert_eq!(
            serde_json::to_value(AppError::new("runInProgress", "Already running")).unwrap(),
            json!({
                "code": "runInProgress",
                "message": "Already running"
            })
        );
        assert_eq!(
            serde_json::to_value(AppError::field(
                "invalidInputPath",
                "Choose an input folder",
                ValidationField::Input,
            ))
            .unwrap(),
            json!({
                "code": "invalidInputPath",
                "message": "Choose an input folder",
                "field": "input"
            })
        );
    }
}
