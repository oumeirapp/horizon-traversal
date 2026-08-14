use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use thiserror::Error;

use super::fs_safety::is_link_like;
use super::types::{PipelineNotice, SourceDiscovery, SourceRoot, SourceRootKind};

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

pub fn classify_source_folder_name(name: &str) -> Option<SourceRootKind> {
    let normalized = normalize_folder_name(name);
    if normalized.contains("masterfiles") {
        Some(SourceRootKind::MasterFiles)
    } else if normalized.contains("deliverables") {
        Some(SourceRootKind::Deliverables)
    } else {
        None
    }
}

pub fn is_source_folder_name(name: &str) -> bool {
    classify_source_folder_name(name).is_some()
}

fn version_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)v(?:er(?:sion)?)?\s*[_-]?\s*(\d+)").expect("version folder regex is valid")
    })
}

pub(crate) fn deliverables_version_number(name: &str) -> Option<u64> {
    version_pattern()
        .captures(name)?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}

pub(crate) fn is_master_version_folder_name(name: &str) -> bool {
    if version_pattern().is_match(name) {
        return true;
    }

    let normalized = normalize_folder_name(name);
    matches!(
        normalized.trim_start_matches(|character: char| character.is_ascii_digit()),
        "version" | "versions"
    )
}

pub(crate) fn is_master_video_category_name(name: &str) -> bool {
    let normalized = normalize_folder_name(name);
    normalized.trim_start_matches(|character: char| character.is_ascii_digit()) == "video"
}

pub fn find_source_folders(ticket_root: &Path) -> Result<SourceDiscovery, DiscoveryError> {
    let mut discovery = SourceDiscovery::default();
    visit(
        ticket_root,
        &mut discovery,
        MasterContext::Outside,
        DeliverablesContext::Outside,
    )?;
    Ok(discovery)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MasterContext {
    Outside,
    AtRoot,
    Descendant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeliverablesContext {
    Outside,
    Selecting,
    InsideSelectedVersion,
}

fn visit(
    current: &Path,
    discovery: &mut SourceDiscovery,
    master_context: MasterContext,
    deliverables_context: DeliverablesContext,
) -> Result<(), DiscoveryError> {
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

    let mut directories = Vec::new();
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

        directories.push((path, entry.file_name()));
    }

    let selected_version = if deliverables_context == DeliverablesContext::Selecting {
        directories
            .iter()
            .filter_map(|(path, name)| {
                let name = name.to_string_lossy();
                if classify_source_folder_name(&name).is_some() {
                    return None;
                }
                deliverables_version_number(&name).map(|number| (number, path))
            })
            .max_by(|(left_number, left_path), (right_number, right_path)| {
                left_number
                    .cmp(right_number)
                    .then_with(|| left_path.file_name().cmp(&right_path.file_name()))
            })
            .map(|(_, path)| (*path).clone())
    } else {
        None
    };

    for (path, folder_name) in directories {
        let folder_name = folder_name.to_string_lossy();

        if master_context != MasterContext::Outside
            && (is_master_version_folder_name(&folder_name)
                || (master_context == MasterContext::AtRoot
                    && is_master_video_category_name(&folder_name)))
        {
            continue;
        }

        let kind = classify_source_folder_name(&folder_name);
        let is_deliverables_version = kind.is_none()
            && deliverables_context == DeliverablesContext::Selecting
            && deliverables_version_number(&folder_name).is_some();
        let is_selected_version = selected_version.as_ref() == Some(&path);
        if is_deliverables_version && !is_selected_version {
            continue;
        }

        if let Some(kind) = kind.filter(|_| master_context == MasterContext::Outside) {
            discovery.folders.push(SourceRoot {
                path: path.clone(),
                kind,
            });
        }

        let (nested_master_context, nested_deliverables_context) =
            if master_context != MasterContext::Outside {
                let master = if kind == Some(SourceRootKind::MasterFiles) {
                    MasterContext::AtRoot
                } else {
                    MasterContext::Descendant
                };
                (master, DeliverablesContext::Outside)
            } else {
                match kind {
                    Some(SourceRootKind::MasterFiles) => {
                        (MasterContext::AtRoot, DeliverablesContext::Outside)
                    }
                    Some(SourceRootKind::Deliverables) => {
                        (MasterContext::Outside, DeliverablesContext::Selecting)
                    }
                    None => {
                        let deliverables = if is_selected_version {
                            DeliverablesContext::InsideSelectedVersion
                        } else {
                            deliverables_context
                        };
                        (MasterContext::Outside, deliverables)
                    }
                }
            };
        visit(
            &path,
            discovery,
            nested_master_context,
            nested_deliverables_context,
        )?;
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

    #[test]
    fn master_exclusion_names_are_specific() {
        for name in [
            "Version",
            "Versions",
            "01. Version",
            "01. Versions",
            "Version 2",
            "Ver2",
            "v2",
        ] {
            assert!(is_master_version_folder_name(name), "{name}");
        }
        for name in ["Video", "02 - VIDEO"] {
            assert!(is_master_video_category_name(name), "{name}");
        }

        assert!(!is_master_version_folder_name("Version notes"));
        assert!(!is_master_video_category_name("Video Archive"));
    }
}
