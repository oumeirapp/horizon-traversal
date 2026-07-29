use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use thiserror::Error;

use super::fs_safety::is_link_like;
use super::types::{PipelineNotice, TicketSelection};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterRule {
    pub prefix: String,
    pub first: u64,
    pub last: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRoots {
    pub input: PathBuf,
    pub output: PathBuf,
}

#[derive(Debug, Error)]
pub enum SelectionError {
    #[error("invalid ticket filter token: '{0}'")]
    InvalidFilter(String),
    #[error("input folder does not exist: {0}")]
    InputMissing(PathBuf),
    #[error("input path is not a folder: {0}")]
    InputNotDirectory(PathBuf),
    #[error("output path exists but is not a folder: {0}")]
    OutputNotDirectory(PathBuf),
    #[error("input and output folders must not overlap: {input} and {output}")]
    OverlappingRoots { input: PathBuf, output: PathBuf },
    #[error("cannot resolve the current directory: {0}")]
    CurrentDirectory(#[source] io::Error),
    #[error("cannot inspect {path}: {source}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot read folder {path}: {source}")]
    ReadDirectory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot resolve path {path}: {source}")]
    ResolvePath {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

fn range_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^([A-Za-z]*)(\d+)\s*-\s*[A-Za-z]*(\d+)$").expect("ticket range regex is valid")
    })
}

fn single_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^([A-Za-z]*)(\d+)$").expect("ticket number regex is valid"))
}

fn folder_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^([A-Za-z]*)(\d+)(.*)$").expect("ticket folder regex is valid")
    })
}

pub fn parse_filter(text: &str) -> Result<Vec<FilterRule>, SelectionError> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }

    text.split([',', ';'])
        .map(str::trim)
        .map(|token| {
            if token.is_empty() {
                return Err(SelectionError::InvalidFilter(token.to_owned()));
            }

            if let Some(captures) = range_pattern().captures(token) {
                let prefix = captures[1].to_ascii_uppercase();
                let mut first = parse_ticket_number(token, &captures[2])?;
                let mut last = parse_ticket_number(token, &captures[3])?;
                if first > last {
                    std::mem::swap(&mut first, &mut last);
                }
                return Ok(FilterRule {
                    prefix,
                    first,
                    last,
                });
            }

            if let Some(captures) = single_pattern().captures(token) {
                let number = parse_ticket_number(token, &captures[2])?;
                return Ok(FilterRule {
                    prefix: captures[1].to_ascii_uppercase(),
                    first: number,
                    last: number,
                });
            }

            Err(SelectionError::InvalidFilter(token.to_owned()))
        })
        .collect()
}

fn parse_ticket_number(token: &str, number: &str) -> Result<u64, SelectionError> {
    number
        .parse::<u64>()
        .map_err(|_| SelectionError::InvalidFilter(token.to_owned()))
}

pub fn folder_matches(name: &str, rules: &[FilterRule]) -> bool {
    if rules.is_empty() {
        return true;
    }

    let Some(captures) = folder_pattern().captures(name) else {
        return false;
    };
    let Ok(number) = captures[2].parse::<u64>() else {
        return false;
    };
    let prefix = captures[1].to_ascii_uppercase();

    rules.iter().any(|rule| {
        (rule.prefix.is_empty() || rule.prefix == prefix)
            && (rule.first..=rule.last).contains(&number)
    })
}

pub fn select_tickets(
    input_root: &Path,
    filter_text: &str,
) -> Result<TicketSelection, SelectionError> {
    let rules = parse_filter(filter_text)?;
    let mut entries = fs::read_dir(input_root)
        .map_err(|source| SelectionError::ReadDirectory {
            path: input_root.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| SelectionError::ReadDirectory {
            path: input_root.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut selection = TicketSelection::default();
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| SelectionError::Inspect {
                path: path.clone(),
                source,
            })?;

        if is_link_like(&path, &file_type).map_err(|source| SelectionError::Inspect {
            path: path.clone(),
            source,
        })? {
            selection.notices.push(PipelineNotice::warning(
                format!("Skipped symlink ticket entry: {}", path.display()),
                Some(path),
            ));
            continue;
        }
        if !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        if folder_matches(&name, &rules) {
            selection.tickets.push(path);
        }
    }

    Ok(selection)
}

pub fn validate_roots(input: &Path, output: &Path) -> Result<ValidatedRoots, SelectionError> {
    if !input.exists() {
        return Err(SelectionError::InputMissing(input.to_path_buf()));
    }
    if !input.is_dir() {
        return Err(SelectionError::InputNotDirectory(input.to_path_buf()));
    }
    if output.exists() && !output.is_dir() {
        return Err(SelectionError::OutputNotDirectory(output.to_path_buf()));
    }

    let input = fs::canonicalize(input).map_err(|source| SelectionError::ResolvePath {
        path: input.to_path_buf(),
        source,
    })?;
    let output = canonicalize_allow_missing(output)?;

    if is_same_or_ancestor(&input, &output) || is_same_or_ancestor(&output, &input) {
        return Err(SelectionError::OverlappingRoots { input, output });
    }

    Ok(ValidatedRoots { input, output })
}

fn canonicalize_allow_missing(path: &Path) -> Result<PathBuf, SelectionError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(SelectionError::CurrentDirectory)?
            .join(path)
    };

    if absolute.exists() {
        return fs::canonicalize(&absolute).map_err(|source| SelectionError::ResolvePath {
            path: absolute,
            source,
        });
    }

    let mut existing = absolute.as_path();
    let mut missing = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            return Err(SelectionError::InputMissing(absolute));
        };
        missing.push(name.to_os_string());
        let Some(parent) = existing.parent() else {
            return Err(SelectionError::InputMissing(absolute));
        };
        existing = parent;
    }

    let mut resolved =
        fs::canonicalize(existing).map_err(|source| SelectionError::ResolvePath {
            path: existing.to_path_buf(),
            source,
        })?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn is_same_or_ancestor(ancestor: &Path, descendant: &Path) -> bool {
    let ancestor = ancestor.components().collect::<Vec<_>>();
    let descendant = descendant.components().collect::<Vec<_>>();

    ancestor.len() <= descendant.len()
        && ancestor
            .iter()
            .zip(descendant.iter())
            .all(|(left, right)| components_equal(*left, *right))
}

fn components_equal(left: Component<'_>, right: Component<'_>) -> bool {
    os_strings_equal(left.as_os_str(), right.as_os_str())
}

#[cfg(windows)]
fn os_strings_equal(left: &OsStr, right: &OsStr) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(windows))]
fn os_strings_equal(left: &OsStr, right: &OsStr) -> bool {
    left == right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blank_single_lists_and_reversed_ranges() {
        assert!(parse_filter("  ").unwrap().is_empty());
        assert_eq!(
            parse_filter("P5, q9; 12-10").unwrap(),
            vec![
                FilterRule {
                    prefix: "P".into(),
                    first: 5,
                    last: 5,
                },
                FilterRule {
                    prefix: "Q".into(),
                    first: 9,
                    last: 9,
                },
                FilterRule {
                    prefix: String::new(),
                    first: 10,
                    last: 12,
                },
            ]
        );
    }

    #[test]
    fn invalid_filters_are_rejected() {
        for text in ["P1,", "P", "1..4", "P1-Q"] {
            assert!(parse_filter(text).is_err(), "{text} should be invalid");
        }
    }

    #[test]
    fn folders_match_prefix_number_and_any_suffix() {
        let rules = parse_filter("P2-P4, 8").unwrap();
        assert!(folder_matches("P3 Campaign", &rules));
        assert!(folder_matches("Q8-anything", &rules));
        assert!(!folder_matches("Q3 Campaign", &rules));
        assert!(!folder_matches("Campaign P3", &rules));
    }
}
