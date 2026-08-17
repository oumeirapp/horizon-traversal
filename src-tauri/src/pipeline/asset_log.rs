use std::path::Path;

use serde::{Deserialize, Serialize};

pub const ASSET_LOG_NAME: &str = "horizon_asset_log.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetFailureOperation {
    PdfToImage,
    ImageResize,
    VideoResize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssetFailureCategory {
    Master,
    Deliverables,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFailure {
    pub operation: AssetFailureOperation,
    pub ticket: String,
    pub category: AssetFailureCategory,
    pub path: String,
    pub message: String,
}

impl AssetFailure {
    pub fn new(
        operation: AssetFailureOperation,
        ticket: impl Into<String>,
        category: AssetFailureCategory,
        path: &Path,
        message: impl Into<String>,
    ) -> Self {
        Self {
            operation,
            ticket: ticket.into(),
            category,
            path: path.to_string_lossy().into_owned(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFailureLog {
    pub schema_version: u32,
    pub failures: Vec<AssetFailure>,
}

impl Default for AssetFailureLog {
    fn default() -> Self {
        Self {
            schema_version: 1,
            failures: Vec::new(),
        }
    }
}

impl AssetFailureLog {
    pub fn render(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self).map(|mut json| {
            json.push('\n');
            json
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_stable_powerpoint_failure_contract() {
        let log = AssetFailureLog {
            schema_version: 1,
            failures: vec![AssetFailure::new(
                AssetFailureOperation::ImageResize,
                "P123 Campaign",
                AssetFailureCategory::Deliverables,
                Path::new("/output/P123 Campaign/Deliverables/hero.png"),
                "decode allocation exceeded",
            )],
        };

        let value: serde_json::Value = serde_json::from_str(&log.render().unwrap()).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["failures"].as_array().unwrap().len(), 1);
        assert_eq!(value["failures"][0]["operation"], "imageResize");
        assert_eq!(value["failures"][0]["ticket"], "P123 Campaign");
        assert_eq!(value["failures"][0]["category"], "Deliverables");
        assert_eq!(
            value["failures"][0]["path"],
            "/output/P123 Campaign/Deliverables/hero.png"
        );
        assert_eq!(
            value["failures"][0]["message"],
            "decode allocation exceeded"
        );
    }

    #[test]
    fn empty_log_contains_no_unrelated_activity() {
        let value: serde_json::Value =
            serde_json::from_str(&AssetFailureLog::default().render().unwrap()).unwrap();

        assert_eq!(
            value,
            serde_json::json!({"schemaVersion": 1, "failures": []})
        );
    }
}
