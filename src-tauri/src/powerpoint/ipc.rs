use serde::{Deserialize, Serialize};

use crate::pipeline::ipc::LogLevel;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PowerPointRequest {
    pub input_path: String,
    pub output_path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PowerPointStep {
    Inspect,
    Video,
    Layout,
    Compose,
    Save,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PowerPointRunStatus {
    Success,
    PartialSuccess,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PowerPointSummary {
    pub status: PowerPointRunStatus,
    pub total_tickets: usize,
    pub slides_created: usize,
    pub blank_slides: usize,
    pub warnings: usize,
    pub errors: usize,
    pub elapsed_ms: u64,
    pub output_path: Option<String>,
    pub report_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PowerPointEvent {
    PowerpointStarted {
        run_id: String,
        total_tickets: usize,
        total_units: usize,
    },
    PowerpointProgress {
        run_id: String,
        step: PowerPointStep,
        ticket: Option<String>,
        index: Option<usize>,
        total_tickets: usize,
        step_completed: usize,
        step_total: usize,
        completed_units: usize,
        total_units: usize,
        message: String,
    },
    Log {
        run_id: String,
        ticket: Option<String>,
        level: LogLevel,
        message: String,
        path: Option<String>,
        timestamp_ms: u64,
    },
    PowerpointCompleted {
        run_id: String,
        summary: PowerPointSummary,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn request_deserializes_from_frontend_shape() {
        let request: PowerPointRequest = serde_json::from_value(json!({
            "inputPath": "/tickets",
            "outputPath": "/presentations"
        }))
        .unwrap();

        assert_eq!(request.input_path, "/tickets");
        assert_eq!(request.output_path, "/presentations");
    }

    #[test]
    fn progress_event_uses_camel_case_tagged_shape() {
        let event = PowerPointEvent::PowerpointProgress {
            run_id: "run-1".to_owned(),
            step: PowerPointStep::Compose,
            ticket: Some("P1".to_owned()),
            index: Some(1),
            total_tickets: 2,
            step_completed: 1,
            step_total: 2,
            completed_units: 5,
            total_units: 8,
            message: "Building slide".to_owned(),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "type": "powerpointProgress",
                "runId": "run-1",
                "step": "compose",
                "ticket": "P1",
                "index": 1,
                "totalTickets": 2,
                "stepCompleted": 1,
                "stepTotal": 2,
                "completedUnits": 5,
                "totalUnits": 8,
                "message": "Building slide"
            })
        );
    }
}
