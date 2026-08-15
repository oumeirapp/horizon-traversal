use std::cmp::Ordering;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::pipeline::fs_safety::is_link_like;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif"];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "avi"];
const MASTER_IMAGE_LIMIT: usize = 2;
const DELIVERABLE_LIMIT: usize = 6;
const DELIVERABLE_VIDEO_LIMIT: usize = 2;
const METADATA_LIMIT_BYTES: u64 = 1_048_576;

#[derive(Debug, Error)]
pub enum ScanError {
    #[error("cannot read ticket folder {path}: {source}")]
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
    #[error("cannot read slide metadata {path}: {message}")]
    Metadata { path: PathBuf, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedImage {
    pub path: PathBuf,
    pub priority: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedVideo {
    pub path: PathBuf,
    pub priority: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedTicket {
    pub name: String,
    pub title: String,
    pub master: Vec<SelectedImage>,
    pub deliverable_images: Vec<SelectedImage>,
    pub deliverable_videos: Vec<SelectedVideo>,
    pub blank_reason: Option<String>,
    pub warnings: Vec<String>,
}

impl ScannedTicket {
    pub fn blank(name: String, reason: impl Into<String>) -> Self {
        Self {
            title: name.clone(),
            name,
            master: Vec::new(),
            deliverable_images: Vec::new(),
            deliverable_videos: Vec::new(),
            blank_reason: Some(reason.into()),
            warnings: Vec::new(),
        }
    }

    pub fn make_blank(&mut self, reason: impl Into<String>) {
        self.title.clone_from(&self.name);
        self.master.clear();
        self.deliverable_images.clear();
        self.deliverable_videos.clear();
        self.blank_reason = Some(reason.into());
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SlideMetadata {
    title: Option<String>,
    priority: PriorityMetadata,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PriorityMetadata {
    master: HashMap<String, u8>,
    deliverables: HashMap<String, u8>,
    adapt: HashMap<String, u8>,
}

#[derive(Debug, Clone)]
struct Candidate {
    path: PathBuf,
    priority: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDocument {
    pub schema_version: u32,
    pub template: PathBuf,
    pub output: PathBuf,
    pub report: PathBuf,
    pub cancel_path: PathBuf,
    pub tickets: Vec<ManifestTicket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTicket {
    pub name: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blank_reason: Option<String>,
    pub master: Vec<ManifestAsset>,
    pub deliverables: Vec<ManifestAsset>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ManifestAsset {
    Image {
        path: PathBuf,
        priority: u8,
    },
    Video {
        path: PathBuf,
        poster_path: PathBuf,
        priority: u8,
        width_px: u32,
        height_px: u32,
        duration_ms: u64,
        extension: String,
        compatibility: String,
        sha256: String,
        warnings: Vec<String>,
    },
}

pub fn sort_ticket_paths_naturally(paths: &mut [PathBuf]) {
    paths.sort_by(|left, right| {
        natural_cmp(
            left.file_name().unwrap_or_default(),
            right.file_name().unwrap_or_default(),
        )
    });
}

pub fn scan_ticket(ticket: &Path) -> Result<ScannedTicket, ScanError> {
    let name = ticket
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let metadata = load_metadata(ticket)?;
    validate_priorities(ticket, &metadata.priority)?;
    let title = metadata
        .title
        .filter(|title| !title.trim().is_empty())
        .map(|title| title.trim().to_owned())
        .unwrap_or_else(|| infer_title(&name));

    let mut warnings = Vec::new();
    let master_folder = find_section(ticket, "Master")?;
    let deliverables_folder = find_section(ticket, "Deliverables")?;
    if master_folder.is_none() {
        warnings.push("Missing Master folder; treated as empty.".to_owned());
    }
    if deliverables_folder.is_none() {
        warnings.push("Missing Deliverables folder; treated as empty.".to_owned());
    }

    let mut master_images = Vec::new();
    if let Some(folder) = master_folder {
        for candidate in section_candidates(&folder, &metadata.priority.master, &mut warnings)? {
            if is_image(&candidate.path) {
                master_images.push(candidate);
            } else if is_video(&candidate.path) {
                warnings.push(format!(
                    "Ignored Master video; Master accepts images only: {}",
                    candidate
                        .path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ));
            }
        }
    }
    sort_candidates(&mut master_images);
    let ignored_master = master_images.len().saturating_sub(MASTER_IMAGE_LIMIT);
    master_images.truncate(MASTER_IMAGE_LIMIT);
    if ignored_master > 0 {
        warnings.push(format!(
            "Ignored {ignored_master} excess Master image(s); limit is {MASTER_IMAGE_LIMIT}."
        ));
    }

    let mut deliverable_images = Vec::new();
    let mut deliverable_videos = Vec::new();
    if let Some(folder) = deliverables_folder {
        let mut priorities = metadata.priority.adapt.clone();
        priorities.extend(metadata.priority.deliverables.clone());
        for candidate in section_candidates(&folder, &priorities, &mut warnings)? {
            if is_image(&candidate.path) {
                deliverable_images.push(candidate);
            } else if is_video(&candidate.path) {
                deliverable_videos.push(candidate);
            }
        }
    }
    sort_candidates(&mut deliverable_images);
    sort_candidates(&mut deliverable_videos);
    let ignored_videos = deliverable_videos
        .len()
        .saturating_sub(DELIVERABLE_VIDEO_LIMIT);
    deliverable_videos.truncate(DELIVERABLE_VIDEO_LIMIT);
    let image_limit = DELIVERABLE_LIMIT.saturating_sub(deliverable_videos.len());
    let ignored_images = deliverable_images.len().saturating_sub(image_limit);
    deliverable_images.truncate(image_limit);
    if ignored_videos + ignored_images > 0 {
        warnings.push(format!(
            "Ignored {} excess Deliverables asset(s); limit is {DELIVERABLE_LIMIT} with at most {DELIVERABLE_VIDEO_LIMIT} videos.",
            ignored_videos + ignored_images
        ));
    }

    let mut scanned = ScannedTicket {
        name,
        title,
        master: master_images
            .into_iter()
            .map(|candidate| SelectedImage {
                path: candidate.path,
                priority: candidate.priority,
            })
            .collect(),
        deliverable_images: deliverable_images
            .into_iter()
            .map(|candidate| SelectedImage {
                path: candidate.path,
                priority: candidate.priority,
            })
            .collect(),
        deliverable_videos: deliverable_videos
            .into_iter()
            .map(|candidate| SelectedVideo {
                path: candidate.path,
                priority: candidate.priority,
            })
            .collect(),
        blank_reason: None,
        warnings,
    };
    if scanned.master.is_empty()
        && scanned.deliverable_images.is_empty()
        && scanned.deliverable_videos.is_empty()
    {
        scanned.make_blank("No usable assets were found in Master or Deliverables.");
    }
    Ok(scanned)
}

fn load_metadata(ticket: &Path) -> Result<SlideMetadata, ScanError> {
    let yaml = [ticket.join("slide.yaml"), ticket.join("slide.yml")]
        .into_iter()
        .find(|path| path.exists());
    let Some(path) = yaml else {
        return Ok(SlideMetadata::default());
    };
    let metadata = fs::symlink_metadata(&path).map_err(|source| ScanError::Inspect {
        path: path.clone(),
        source,
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ScanError::Metadata {
            path,
            message: "metadata must be a regular file".to_owned(),
        });
    }
    if metadata.len() > METADATA_LIMIT_BYTES {
        return Err(ScanError::Metadata {
            path,
            message: "metadata exceeds 1 MiB".to_owned(),
        });
    }
    let text = fs::read_to_string(&path).map_err(|error| ScanError::Metadata {
        path: path.clone(),
        message: error.to_string(),
    })?;
    serde_yaml::from_str(&text).map_err(|error| ScanError::Metadata {
        path,
        message: error.to_string(),
    })
}

fn validate_priorities(ticket: &Path, priority: &PriorityMetadata) -> Result<(), ScanError> {
    for (section, entries) in [
        ("master", &priority.master),
        ("deliverables", &priority.deliverables),
        ("adapt", &priority.adapt),
    ] {
        if let Some((name, value)) = entries
            .iter()
            .find(|(_, value)| !(1_u8..=5).contains(*value))
        {
            return Err(ScanError::Metadata {
                path: ticket.join("slide.yaml"),
                message: format!("priority.{section}.{name} must be between 1 and 5, got {value}"),
            });
        }
    }
    Ok(())
}

fn find_section(ticket: &Path, expected: &str) -> Result<Option<PathBuf>, ScanError> {
    let mut matches = Vec::new();
    for entry in read_entries(ticket)? {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|source| ScanError::Inspect {
            path: path.clone(),
            source,
        })?;
        if is_link_like(&path, &file_type).map_err(|source| ScanError::Inspect {
            path: path.clone(),
            source,
        })? {
            continue;
        }
        if file_type.is_dir()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(expected)
        {
            matches.push(path);
        }
    }
    if matches.len() > 1 {
        return Err(ScanError::Metadata {
            path: ticket.to_path_buf(),
            message: format!("multiple folders match {expected}"),
        });
    }
    Ok(matches.pop())
}

fn section_candidates(
    folder: &Path,
    priorities: &HashMap<String, u8>,
    warnings: &mut Vec<String>,
) -> Result<Vec<Candidate>, ScanError> {
    let mut candidates = Vec::new();
    for entry in read_entries(folder)? {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|source| ScanError::Inspect {
            path: path.clone(),
            source,
        })?;
        if is_link_like(&path, &file_type).map_err(|source| ScanError::Inspect {
            path: path.clone(),
            source,
        })? {
            warnings.push(format!("Skipped symlink asset: {}", path.display()));
            continue;
        }
        if !file_type.is_file() || (!is_image(&path) && !is_video(&path)) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        candidates.push(Candidate {
            path,
            priority: priorities.get(&name).copied().unwrap_or(3),
        });
    }
    Ok(candidates)
}

fn read_entries(folder: &Path) -> Result<Vec<fs::DirEntry>, ScanError> {
    let mut entries = fs::read_dir(folder)
        .map_err(|source| ScanError::ReadDirectory {
            path: folder.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| ScanError::ReadDirectory {
            path: folder.to_path_buf(),
            source,
        })?;
    entries.sort_by(|left, right| natural_cmp(&left.file_name(), &right.file_name()));
    Ok(entries)
}

fn sort_candidates(candidates: &mut [Candidate]) {
    candidates.sort_by(|left, right| {
        right.priority.cmp(&left.priority).then_with(|| {
            natural_cmp(
                left.path.file_name().unwrap_or_default(),
                right.path.file_name().unwrap_or_default(),
            )
        })
    });
}

fn natural_cmp(left: &OsStr, right: &OsStr) -> Ordering {
    let left_text = left.to_string_lossy();
    let right_text = right.to_string_lossy();
    let left_parts = natural_parts(&left_text);
    let right_parts = natural_parts(&right_text);
    for (left_part, right_part) in left_parts.iter().zip(&right_parts) {
        let comparison = match (left_part.parse::<u64>(), right_part.parse::<u64>()) {
            (Ok(left_number), Ok(right_number)) => left_number.cmp(&right_number),
            _ => left_part.to_lowercase().cmp(&right_part.to_lowercase()),
        };
        if comparison != Ordering::Equal {
            return comparison;
        }
    }
    left_parts
        .len()
        .cmp(&right_parts.len())
        .then_with(|| exact_os_cmp(left, right))
}

#[cfg(unix)]
fn exact_os_cmp(left: &OsStr, right: &OsStr) -> Ordering {
    use std::os::unix::ffi::OsStrExt;

    left.as_bytes().cmp(right.as_bytes())
}

#[cfg(windows)]
fn exact_os_cmp(left: &OsStr, right: &OsStr) -> Ordering {
    use std::os::windows::ffi::OsStrExt;

    left.encode_wide().cmp(right.encode_wide())
}

#[cfg(not(any(unix, windows)))]
fn exact_os_cmp(left: &OsStr, right: &OsStr) -> Ordering {
    left.to_string_lossy().cmp(&right.to_string_lossy())
}

fn natural_parts(value: &str) -> Vec<&str> {
    if value.is_empty() {
        return vec![value];
    }
    let mut parts = Vec::new();
    let mut start = 0;
    let mut digits = value.as_bytes()[0].is_ascii_digit();
    for (index, byte) in value.as_bytes().iter().enumerate().skip(1) {
        let next_digits = byte.is_ascii_digit();
        if next_digits != digits {
            parts.push(&value[start..index]);
            start = index;
            digits = next_digits;
        }
    }
    parts.push(&value[start..]);
    parts
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
}

fn is_image(path: &Path) -> bool {
    extension(path).is_some_and(|extension| IMAGE_EXTENSIONS.contains(&extension.as_str()))
}

fn is_video(path: &Path) -> bool {
    extension(path).is_some_and(|extension| VIDEO_EXTENSIONS.contains(&extension.as_str()))
}

fn infer_title(folder_name: &str) -> String {
    let trimmed = folder_name.trim();
    let without_number = trimmed
        .trim_start_matches(|character: char| character.is_ascii_digit())
        .trim_start_matches([' ', '.', '_', '-']);
    if without_number.is_empty() {
        trimmed.to_owned()
    } else {
        without_number.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    fn file(path: &Path) {
        fs::write(path, b"fixture").unwrap();
    }

    #[test]
    fn master_uses_images_and_deliverables_reserves_at_most_two_video_slots() {
        let temp = tempdir().unwrap();
        let ticket = temp.path().join("P1 Campaign");
        fs::create_dir_all(ticket.join("Master")).unwrap();
        fs::create_dir_all(ticket.join("Deliverables")).unwrap();
        for name in ["master1.jpg", "master2.png", "ignored.mp4"] {
            file(&ticket.join("Master").join(name));
        }
        for name in [
            "video10.mp4",
            "video2.avi",
            "video3.mp4",
            "image1.jpg",
            "image2.jpg",
            "image3.jpg",
            "image4.jpg",
            "image5.jpg",
        ] {
            file(&ticket.join("Deliverables").join(name));
        }

        let scanned = scan_ticket(&ticket).unwrap();

        assert_eq!(scanned.master.len(), 2);
        assert_eq!(
            scanned
                .deliverable_videos
                .iter()
                .map(|video| video.path.file_name().unwrap().to_string_lossy())
                .collect::<Vec<_>>(),
            ["video2.avi", "video3.mp4"]
        );
        assert_eq!(scanned.deliverable_images.len(), 4);
        assert!(scanned
            .warnings
            .iter()
            .any(|warning| warning.contains("Master video")));
    }

    #[test]
    fn empty_ticket_becomes_blank_and_uses_ticket_name() {
        let temp = tempdir().unwrap();
        let ticket = temp.path().join("P10 Empty");
        fs::create_dir_all(ticket.join("Master")).unwrap();
        fs::create_dir_all(ticket.join("Deliverables")).unwrap();

        let scanned = scan_ticket(&ticket).unwrap();

        assert_eq!(scanned.title, "P10 Empty");
        assert!(scanned.blank_reason.is_some());
    }

    #[test]
    fn deliverables_priority_overrides_legacy_adapt_priority() {
        let temp = tempdir().unwrap();
        let ticket = temp.path().join("P2");
        fs::create_dir_all(ticket.join("Deliverables")).unwrap();
        file(&ticket.join("Deliverables/a.jpg"));
        file(&ticket.join("Deliverables/b.jpg"));
        fs::write(
            ticket.join("slide.yaml"),
            "priority:\n  adapt:\n    a.jpg: 5\n  deliverables:\n    b.jpg: 5\n",
        )
        .unwrap();

        let scanned = scan_ticket(&ticket).unwrap();

        assert_eq!(
            scanned.deliverable_images[0].path.file_name().unwrap(),
            "a.jpg"
        );
        assert_eq!(
            scanned.deliverable_images[1].path.file_name().unwrap(),
            "b.jpg"
        );
    }

    #[test]
    fn natural_order_has_an_exact_tie_breaker() {
        let mut names = [
            PathBuf::from("asset2"),
            PathBuf::from("asset02"),
            PathBuf::from("Asset2"),
        ];

        sort_ticket_paths_naturally(&mut names);

        assert_eq!(
            names,
            [
                PathBuf::from("Asset2"),
                PathBuf::from("asset02"),
                PathBuf::from("asset2"),
            ]
        );
        assert_ne!(
            natural_cmp(OsStr::new("asset2"), OsStr::new("asset02")),
            Ordering::Equal
        );
    }
}
