use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

use super::fs_safety::is_link_like;
use super::types::{PipelineNotice, SourceDiscovery};

#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("cannot read folder {path}: {source}")]
    ReadDirectory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot inspect {path}: {source}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

pub fn normalize_folder_name(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        .collect()
}

pub fn is_source_folder_name(name: &str) -> bool {
    let normalized = normalize_folder_name(name);
    normalized.contains("masterfiles") || normalized.contains("deliverables")
}

pub fn find_source_folders(ticket_root: &Path) -> Result<SourceDiscovery, DiscoveryError> {
    let mut discovery = SourceDiscovery::default();
    visit(ticket_root, &mut discovery)?;
    Ok(discovery)
}

fn visit(current: &Path, discovery: &mut SourceDiscovery) -> Result<(), DiscoveryError> {
    let mut entries = fs::read_dir(current)
        .map_err(|source| DiscoveryError::ReadDirectory {
            path: current.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| DiscoveryError::ReadDirectory {
            path: current.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| DiscoveryError::Inspect {
                path: path.clone(),
                source,
            })?;

        if is_link_like(&path, &file_type).map_err(|source| DiscoveryError::Inspect {
            path: path.clone(),
            source,
        })? {
            discovery.notices.push(PipelineNotice::warning(
                format!("Skipped symlink during discovery: {}", path.display()),
                Some(path),
            ));
            continue;
        }
        if !file_type.is_dir() {
            continue;
        }

        if is_source_folder_name(&entry.file_name().to_string_lossy()) {
            discovery.folders.push(path.clone());
        }
        visit(&path, discovery)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_matches_legacy_punctuation_rules() {
        assert_eq!(
            normalize_folder_name("Master_Files (Final)"),
            "masterfilesfinal"
        );
        assert_eq!(normalize_folder_name("Déliverables"), "dliverables");
        assert!(is_source_folder_name("01 — DELIVERABLES!"));
        assert!(!is_source_folder_name("Delivery"));
    }
}
