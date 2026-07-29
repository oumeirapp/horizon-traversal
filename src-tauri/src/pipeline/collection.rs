use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use filetime::{set_file_handle_times, FileTime};
use regex::Regex;
use thiserror::Error;

use super::fs_safety::{is_link_like, metadata_is_link_like};
use super::types::{CollectionOutcome, CopiedAsset, PipelineNotice};

pub const SUPPORTED_EXTENSIONS: &[&str] =
    &["jpg", "jpeg", "png", "gif", "pdf", "mp4", "avi", "mov"];

#[derive(Debug, Error)]
pub enum CollectionError {
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
    #[error("cannot copy {source_path} to {destination}: {source}")]
    Copy {
        source_path: PathBuf,
        destination: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("ticket folder has no usable name: {0}")]
    InvalidTicketPath(PathBuf),
    #[error("refusing to replace symlink output: {0}")]
    SymlinkOutput(PathBuf),
    #[error("ticket output exists but is not a folder: {0}")]
    OutputNotDirectory(PathBuf),
    #[error("cannot remove ticket output {path}: {source}")]
    RemoveOutput {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot create ticket output {path}: {source}")]
    CreateOutput {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

fn version_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)v(?:er(?:sion)?)?\s*[_-]?\s*(\d+)").expect("version folder regex is valid")
    })
}

pub fn is_supported_asset(path: &Path) -> bool {
    extension(path).is_some_and(|extension| SUPPORTED_EXTENSIONS.contains(&extension.as_str()))
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
}

pub fn copy_with_collision_suffix(
    source: &Path,
    destination_dir: &Path,
) -> Result<PathBuf, CollectionError> {
    let file_name = source
        .file_name()
        .ok_or_else(|| CollectionError::InvalidTicketPath(source.to_path_buf()))?;
    let mut source_file = File::open(source).map_err(|source_error| CollectionError::Copy {
        source_path: source.to_path_buf(),
        destination: destination_dir.join(file_name),
        source: source_error,
    })?;
    let metadata = source_file
        .metadata()
        .map_err(|source_error| CollectionError::Inspect {
            path: source.to_path_buf(),
            source: source_error,
        })?;
    let accessed = FileTime::from_last_access_time(&metadata);
    let modified = FileTime::from_last_modification_time(&metadata);

    let mut counter = 0_u64;
    loop {
        let destination = destination_dir.join(collision_name(source, counter));
        let destination_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination);

        let mut destination_file = match destination_file {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                counter += 1;
                continue;
            }
            Err(source_error) => {
                return Err(CollectionError::Copy {
                    source_path: source.to_path_buf(),
                    destination,
                    source: source_error,
                });
            }
        };

        let copy_result = (|| -> io::Result<()> {
            io::copy(&mut source_file, &mut destination_file)?;
            set_file_handle_times(&destination_file, Some(accessed), Some(modified))?;
            destination_file.set_permissions(metadata.permissions())?;
            Ok(())
        })();

        if let Err(source_error) = copy_result {
            drop(destination_file);
            let _ = fs::remove_file(&destination);
            return Err(CollectionError::Copy {
                source_path: source.to_path_buf(),
                destination,
                source: source_error,
            });
        }

        return Ok(destination);
    }
}

fn collision_name(source: &Path, counter: u64) -> OsString {
    let file_name = source.file_name().unwrap_or_default();
    if counter == 0 {
        return file_name.to_os_string();
    }

    let mut name = source.file_stem().unwrap_or(file_name).to_os_string();
    name.push(format!("_{counter}"));
    if let Some(extension) = source.extension() {
        name.push(".");
        name.push(extension);
    }
    name
}

pub fn collect_from_source(
    source: &Path,
    destination: &Path,
) -> Result<CollectionOutcome, CollectionError> {
    collect_directory(source, destination, false, source)
}

fn collect_directory(
    current: &Path,
    destination: &Path,
    inside_version: bool,
    traversal_root: &Path,
) -> Result<CollectionOutcome, CollectionError> {
    let mut entries = fs::read_dir(current)
        .map_err(|source| CollectionError::ReadDirectory {
            path: current.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| CollectionError::ReadDirectory {
            path: current.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut outcome = CollectionOutcome::default();
    let mut directories = Vec::new();
    let mut version_directories = Vec::new();

    for entry in &entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| CollectionError::Inspect {
                path: path.clone(),
                source,
            })?;

        if is_link_like(&path, &file_type).map_err(|source| CollectionError::Inspect {
            path: path.clone(),
            source,
        })? {
            outcome.notices.push(PipelineNotice::warning(
                format!("Skipped symlink during collection: {}", path.display()),
                Some(path),
            ));
            continue;
        }

        if file_type.is_file() && is_supported_asset(&path) {
            if extension(&path).as_deref() == Some("mov") {
                outcome.notices.push(PipelineNotice::warning(
                    format!("Skipped .mov file (not supported): {}", path.display()),
                    Some(path),
                ));
                continue;
            }

            match copy_with_collision_suffix(&path, destination) {
                Ok(copied_path) => {
                    let source_path = fs::canonicalize(&path).unwrap_or(path.clone());
                    outcome.notices.push(PipelineNotice::success(
                        format!("Copied {}", entry.file_name().to_string_lossy()),
                        Some(copied_path.clone()),
                    ));
                    outcome.copied.push(CopiedAsset {
                        source: source_path,
                        destination: copied_path,
                    });
                }
                Err(error) => {
                    outcome.failed_files += 1;
                    outcome.notices.push(PipelineNotice::error(
                        format!("Failed to copy {}: {error}", path.display()),
                        Some(path),
                    ));
                }
            }
        } else if file_type.is_dir() {
            directories.push(path.clone());
            if !inside_version {
                if let Some(captures) =
                    version_pattern().captures(&entry.file_name().to_string_lossy())
                {
                    if let Ok(number) = captures[1].parse::<u64>() {
                        let relative = path
                            .strip_prefix(traversal_root.parent().unwrap_or(traversal_root))
                            .unwrap_or(&path);
                        outcome.notices.push(PipelineNotice::info(
                            format!(
                                "Version folder detected: {} (v{number})",
                                relative.display()
                            ),
                            Some(path.clone()),
                        ));
                        version_directories.push((number, path));
                    }
                }
            }
        }
    }

    if !inside_version && !version_directories.is_empty() {
        let (_, selected) = version_directories
            .into_iter()
            .max_by(|(left_number, left_path), (right_number, right_path)| {
                left_number
                    .cmp(right_number)
                    .then_with(|| left_path.file_name().cmp(&right_path.file_name()))
            })
            .expect("non-empty version list has a maximum");
        outcome.notices.push(PipelineNotice::success(
            format!(
                "Latest version selected: {}",
                selected.file_name().unwrap_or_default().to_string_lossy()
            ),
            Some(selected.clone()),
        ));
        outcome.append(collect_directory(
            &selected,
            destination,
            true,
            traversal_root,
        )?);
    } else {
        for directory in directories {
            outcome.append(collect_directory(
                &directory,
                destination,
                inside_version,
                traversal_root,
            )?);
        }
    }

    Ok(outcome)
}

pub fn replace_ticket_output(
    output_root: &Path,
    ticket_folder: &Path,
) -> Result<PathBuf, CollectionError> {
    let ticket_name = ticket_folder
        .file_name()
        .ok_or_else(|| CollectionError::InvalidTicketPath(ticket_folder.to_path_buf()))?;
    let ticket_output = output_root.join(ticket_name);

    if ticket_output.exists() || ticket_output.symlink_metadata().is_ok() {
        let metadata =
            fs::symlink_metadata(&ticket_output).map_err(|source| CollectionError::Inspect {
                path: ticket_output.clone(),
                source,
            })?;
        if metadata_is_link_like(&metadata) {
            return Err(CollectionError::SymlinkOutput(ticket_output));
        }
        if !metadata.is_dir() {
            return Err(CollectionError::OutputNotDirectory(ticket_output));
        }
        fs::remove_dir_all(&ticket_output).map_err(|source| CollectionError::RemoveOutput {
            path: ticket_output.clone(),
            source,
        })?;
    }

    fs::create_dir_all(&ticket_output).map_err(|source| CollectionError::CreateOutput {
        path: ticket_output.clone(),
        source,
    })?;
    Ok(ticket_output)
}
