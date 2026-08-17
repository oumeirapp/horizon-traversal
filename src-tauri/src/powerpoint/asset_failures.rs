use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::pipeline::asset_log::{
    AssetFailure, AssetFailureCategory, AssetFailureLog, ASSET_LOG_NAME,
};
use crate::pipeline::fs_safety::metadata_is_link_like;

const MAX_ASSET_LOG_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct LoadedAssetFailures {
    pub failures: Vec<AssetFailure>,
    pub warnings: Vec<String>,
}

pub fn load_asset_failures(input_root: &Path) -> LoadedAssetFailures {
    let log_path = input_root.join(ASSET_LOG_NAME);
    let metadata = match fs::symlink_metadata(&log_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return LoadedAssetFailures::default();
        }
        Err(error) => {
            return load_warning(format!(
                "Could not inspect {}: {error}. Continuing without recorded asset failures.",
                log_path.display()
            ));
        }
    };
    if metadata_is_link_like(&metadata) || !metadata.is_file() {
        return load_warning(format!(
            "Ignored {} because it is not a regular, non-link file. Continuing without recorded asset failures.",
            log_path.display()
        ));
    }
    if metadata.len() > MAX_ASSET_LOG_BYTES {
        return load_warning(format!(
            "Ignored {} because it exceeds the 64 MiB safety limit. Continuing without recorded asset failures.",
            log_path.display()
        ));
    }
    let bytes = match fs::read(&log_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return load_warning(format!(
                "Could not read {}: {error}. Continuing without recorded asset failures.",
                log_path.display()
            ));
        }
    };
    let document: AssetFailureLog = match serde_json::from_slice(&bytes) {
        Ok(document) => document,
        Err(error) => {
            return load_warning(format!(
                "Ignored malformed {}: {error}. Continuing without recorded asset failures.",
                log_path.display()
            ));
        }
    };
    if document.schema_version != 1 {
        return load_warning(format!(
            "Ignored {} because schemaVersion {} is unsupported; expected 1. Continuing without recorded asset failures.",
            log_path.display(),
            document.schema_version
        ));
    }

    let mut loaded = LoadedAssetFailures::default();
    for (index, failure) in document.failures.into_iter().enumerate() {
        if let Err(reason) = validate_failure(input_root, &failure) {
            loaded.warnings.push(format!(
                "Ignored {} failure entry {}: {reason}",
                log_path.display(),
                index + 1
            ));
            continue;
        }
        loaded.failures.push(failure);
    }
    loaded
}

fn validate_failure(input_root: &Path, failure: &AssetFailure) -> Result<(), String> {
    if !is_single_component(&failure.ticket) {
        return Err("ticket must name one immediate ticket folder".to_owned());
    }
    if failure.message.trim().is_empty() {
        return Err("message must not be empty".to_owned());
    }
    let path = Path::new(&failure.path);
    if !path.is_absolute() {
        return Err("path must be absolute".to_owned());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err("path must not contain traversal components".to_owned());
    }
    let expected_ticket_root = input_root.join(&failure.ticket);
    let relative = path
        .strip_prefix(&expected_ticket_root)
        .map_err(|_| format!("path must be inside {}", expected_ticket_root.display()))?;
    let mut components = relative.components();
    let section = match components.next() {
        Some(Component::Normal(section)) => section.to_string_lossy(),
        _ => return Err("path must include a direct Master or Deliverables section".to_owned()),
    };
    let expected_section = match failure.category {
        AssetFailureCategory::Master => "Master",
        AssetFailureCategory::Deliverables => "Deliverables",
    };
    if !section.eq_ignore_ascii_case(expected_section) {
        return Err(format!(
            "path section {section:?} does not match category {expected_section}"
        ));
    }
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => {
            return Err(
                "path must identify one flat asset directly inside its category".to_owned(),
            );
        }
    }
    Ok(())
}

fn is_single_component(value: &str) -> bool {
    let path = PathBuf::from(value);
    let mut components = path.components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn load_warning(message: String) -> LoadedAssetFailures {
    LoadedAssetFailures {
        failures: Vec::new(),
        warnings: vec![message],
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use crate::pipeline::asset_log::{AssetFailureCategory, AssetFailureOperation, ASSET_LOG_NAME};

    use super::*;

    #[test]
    fn loads_valid_failures_from_the_selected_input_root() {
        let temp = tempdir().unwrap();
        let ticket = temp.path().join("P1");
        let asset = ticket.join("Deliverables/failed.png");
        fs::create_dir_all(asset.parent().unwrap()).unwrap();
        let document = AssetFailureLog {
            schema_version: 1,
            failures: vec![AssetFailure::new(
                AssetFailureOperation::ImageResize,
                "P1",
                AssetFailureCategory::Deliverables,
                &asset,
                "allocation failed",
            )],
        };
        fs::write(temp.path().join(ASSET_LOG_NAME), document.render().unwrap()).unwrap();

        let loaded = load_asset_failures(temp.path());

        assert!(loaded.warnings.is_empty());
        assert_eq!(loaded.failures, document.failures);
    }

    #[test]
    fn malformed_logs_warn_and_do_not_abort_powerpoint() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join(ASSET_LOG_NAME), b"{not JSON").unwrap();

        let loaded = load_asset_failures(temp.path());

        assert!(loaded.failures.is_empty());
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].contains("Ignored malformed"));
    }

    #[test]
    fn invalid_entries_do_not_hide_valid_failures() {
        let temp = tempdir().unwrap();
        let valid_path = temp.path().join("P2/Master/valid.jpg");
        let document = AssetFailureLog {
            schema_version: 1,
            failures: vec![
                AssetFailure::new(
                    AssetFailureOperation::ImageResize,
                    "P2",
                    AssetFailureCategory::Master,
                    &valid_path,
                    "valid failure",
                ),
                AssetFailure::new(
                    AssetFailureOperation::VideoResize,
                    "../outside",
                    AssetFailureCategory::Deliverables,
                    &temp.path().join("outside.mp4"),
                    "invalid failure",
                ),
                AssetFailure::new(
                    AssetFailureOperation::ImageResize,
                    "P2",
                    AssetFailureCategory::Master,
                    &temp.path().join("P2/Master/nested/invalid.jpg"),
                    "nested failure",
                ),
            ],
        };
        fs::write(temp.path().join(ASSET_LOG_NAME), document.render().unwrap()).unwrap();

        let loaded = load_asset_failures(temp.path());

        assert_eq!(loaded.failures, vec![document.failures[0].clone()]);
        assert_eq!(loaded.warnings.len(), 2);
        assert!(loaded.warnings[0].contains("entry 2"));
        assert!(loaded.warnings[1].contains("entry 3"));
    }
}
