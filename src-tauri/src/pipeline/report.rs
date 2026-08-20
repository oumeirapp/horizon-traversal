use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use super::discovery::deliverables_version_number;
use super::types::SourceRootKind;

const UNKNOWN_SIZE: &str = "Unknown";
const REPORT_HEADER: &str = "Name,Ticket,Folder,Size\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportAsset {
    pub source_root: PathBuf,
    pub relative_source: PathBuf,
    pub source_kind: SourceRootKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SizeMatch {
    value: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SizeToken {
    value: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReportGroup {
    source_root: PathBuf,
    folder: String,
    project_key: String,
    name_key: String,
    name: String,
    sizes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VersionFolder {
    parent: PathBuf,
    name: OsString,
    number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SelectedVersion {
    source_root: PathBuf,
    parent: PathBuf,
    name: OsString,
    number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TicketReport {
    ticket: String,
    groups: Vec<ReportGroup>,
}

fn ticket_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"^([A-Za-z]*\d+)").expect("ticket identifier regex is valid"))
}

fn duration_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)").expect("duration regex is valid")
    })
}

fn geometry_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(x|×|-|:)\s*(\d+(?:\.\d+)?)(?:\s*(px|mm|cm|in))?")
            .expect("geometry regex is valid")
    })
}

pub(crate) fn build_ticket_report(ticket_folder: &str, assets: &[ReportAsset]) -> TicketReport {
    let ticket = ticket_identifier(ticket_folder);
    let mut groups: Vec<ReportGroup> = Vec::new();
    let selected_versions = selected_versions(assets);

    for asset in assets {
        if asset.source_kind != SourceRootKind::Deliverables
            || !uses_selected_version(asset, &selected_versions)
        {
            continue;
        }

        let Some((folder, project_key, file_name)) = report_location(&asset.relative_source) else {
            continue;
        };
        let size_match = extract_size(&file_name);
        let size = size_match
            .as_ref()
            .map(|matched| matched.value.clone())
            .unwrap_or_else(|| UNKNOWN_SIZE.to_owned());
        let name = cleaned_name(&file_name, size_match.as_ref());
        let name_key = normalize_identity(&name);

        if let Some(group) = groups.iter_mut().find(|group| {
            group.source_root == asset.source_root
                && group.folder == folder
                && group.project_key == project_key
                && group.name_key == name_key
        }) {
            if !group.sizes.contains(&size) {
                group.sizes.push(size);
            }
            continue;
        }

        groups.push(ReportGroup {
            source_root: asset.source_root.clone(),
            folder,
            project_key,
            name_key,
            name,
            sizes: vec![size],
        });
    }

    TicketReport { ticket, groups }
}

fn selected_versions(assets: &[ReportAsset]) -> Vec<SelectedVersion> {
    let mut selected = Vec::<SelectedVersion>::new();

    for asset in assets {
        if asset.source_kind != SourceRootKind::Deliverables {
            continue;
        }
        let Some(candidate) = first_version_folder(&asset.relative_source) else {
            continue;
        };

        if let Some(current) = selected.iter_mut().find(|current| {
            current.source_root == asset.source_root && current.parent == candidate.parent
        }) {
            if candidate.number > current.number
                || (candidate.number == current.number && candidate.name > current.name)
            {
                current.name = candidate.name;
                current.number = candidate.number;
            }
        } else {
            selected.push(SelectedVersion {
                source_root: asset.source_root.clone(),
                parent: candidate.parent,
                name: candidate.name,
                number: candidate.number,
            });
        }
    }

    selected
}

fn uses_selected_version(asset: &ReportAsset, selected: &[SelectedVersion]) -> bool {
    let Some(candidate) = first_version_folder(&asset.relative_source) else {
        return true;
    };

    selected.iter().any(|selection| {
        selection.source_root == asset.source_root
            && selection.parent == candidate.parent
            && selection.name == candidate.name
    })
}

fn first_version_folder(relative_source: &Path) -> Option<VersionFolder> {
    let mut parent = PathBuf::new();
    for component in relative_source.parent()?.iter() {
        let name = component.to_os_string();
        if let Some(number) = deliverables_version_number(&component.to_string_lossy()) {
            return Some(VersionFolder {
                parent,
                name,
                number,
            });
        }
        parent.push(component);
    }
    None
}

impl TicketReport {
    fn append_rows(&self, report: &mut String) {
        for group in &self.groups {
            report.push_str(&csv_field(&group.name));
            report.push(',');
            report.push_str(&csv_field(&self.ticket));
            report.push(',');
            report.push_str(&csv_field(&group.folder));
            report.push(',');
            report.push_str(&csv_field(&group.sizes.join(",")));
            report.push('\n');
        }
    }

    pub(crate) fn render(&self) -> String {
        let mut report = String::from(REPORT_HEADER);
        self.append_rows(&mut report);
        report
    }
}

pub(crate) fn render_aggregate_report(reports: &[TicketReport]) -> String {
    let mut report = String::from(REPORT_HEADER);
    for ticket_report in reports {
        ticket_report.append_rows(&mut report);
    }
    report
}

pub fn render_ticket_report(ticket_folder: &str, assets: &[ReportAsset]) -> String {
    build_ticket_report(ticket_folder, assets).render()
}

fn ticket_identifier(ticket_folder: &str) -> String {
    ticket_pattern()
        .captures(ticket_folder)
        .and_then(|captures| captures.get(1))
        .map_or_else(
            || ticket_folder.to_owned(),
            |matched| matched.as_str().to_owned(),
        )
}

fn report_location(relative_source: &Path) -> Option<(String, String, String)> {
    let components = relative_source
        .iter()
        .map(|component| component.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if components.len() < 2 {
        return None;
    }

    let folder = components[0].clone();
    let file_name = components.last()?.clone();
    let project_key = components[1..components.len() - 1]
        .iter()
        .filter(|component| !is_pure_size_component(component))
        .map(|component| normalize_identity(component))
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>()
        .join("/");

    Some((folder, project_key, file_name))
}

fn extract_size(file_name: &str) -> Option<SizeMatch> {
    let stem = Path::new(file_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();

    extract_size_text(&stem)
}

fn extract_size_text(text: &str) -> Option<SizeMatch> {
    let duration = valid_duration_matches(text).into_iter().next();
    let geometries = valid_geometry_matches(text);

    if let Some(duration) = duration {
        let geometry = geometries.into_iter().min_by_key(|geometry| {
            if geometry.end <= duration.start {
                duration.start - geometry.end
            } else {
                geometry.start.saturating_sub(duration.end)
            }
        });
        let (value, start, end) = geometry.map_or_else(
            || (duration.value.clone(), duration.start, duration.end),
            |geometry| {
                (
                    format!("{} {}", duration.value, geometry.value),
                    duration.start.min(geometry.start),
                    duration.end.max(geometry.end),
                )
            },
        );
        return Some(SizeMatch { value, start, end });
    }

    geometries.into_iter().next().map(|geometry| SizeMatch {
        value: geometry.value,
        start: geometry.start,
        end: geometry.end,
    })
}

fn valid_duration_matches(text: &str) -> Vec<SizeToken> {
    duration_pattern()
        .captures_iter(text)
        .filter_map(|captures| {
            let matched = captures.get(0)?;
            if !has_token_boundaries(text, matched.start(), matched.end()) {
                return None;
            }
            let number = captures.get(1)?.as_str();
            Some(SizeToken {
                value: format!("{number} sec"),
                start: matched.start(),
                end: matched.end(),
            })
        })
        .collect()
}

fn valid_geometry_matches(text: &str) -> Vec<SizeToken> {
    let mut matches = Vec::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(captures) = geometry_pattern().captures_at(text, cursor) else {
            break;
        };
        let Some(matched) = captures.get(0) else {
            break;
        };

        let left_text = captures.get(1).map(|value| value.as_str());
        let right_text = captures.get(3).map(|value| value.as_str());
        let valid = has_token_boundaries(text, matched.start(), matched.end())
            && left_text
                .and_then(|value| value.parse::<f64>().ok())
                .zip(right_text.and_then(|value| value.parse::<f64>().ok()))
                .is_some_and(|(left, right)| {
                    let separator = captures.get(2).map_or("", |value| value.as_str());
                    let unit = captures.get(4).map(|value| value.as_str());
                    let has_px = unit.is_some_and(|unit| unit.eq_ignore_ascii_case("px"));
                    let supported_unit = unit.is_none() || has_px;
                    let positive = left > 0.0 && right > 0.0;
                    let aspect = left <= 32.0 && right <= 32.0;
                    let x_separated = matches!(separator, "x" | "X" | "×");
                    positive && supported_unit && (has_px || x_separated || aspect)
                });

        if valid {
            matches.push(SizeToken {
                value: format!(
                    "{}x{}",
                    left_text.expect("valid geometry has a left number"),
                    right_text.expect("valid geometry has a right number")
                ),
                start: matched.start(),
                end: matched.end(),
            });
            cursor = matched.end();
        } else {
            let advance = text[matched.start()..]
                .chars()
                .next()
                .map_or(1, char::len_utf8);
            cursor = matched.start() + advance;
        }
    }
    matches
}

fn has_token_boundaries(text: &str, start: usize, end: usize) -> bool {
    let before_is_alphanumeric = text[..start]
        .chars()
        .next_back()
        .is_some_and(char::is_alphanumeric);
    let after_is_alphanumeric = text[end..]
        .chars()
        .next()
        .is_some_and(char::is_alphanumeric);
    !before_is_alphanumeric && !after_is_alphanumeric
}

fn cleaned_name(file_name: &str, size_match: Option<&SizeMatch>) -> String {
    let Some(size_match) = size_match else {
        return file_name.to_owned();
    };

    let path = Path::new(file_name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let prefix = stem[..size_match.start].trim_end_matches(is_name_connector);
    let suffix = stem[size_match.end..].trim_start_matches(is_name_connector);
    let cleaned_stem = match (prefix.is_empty(), suffix.is_empty()) {
        (false, false) => format!("{prefix}-{suffix}"),
        (false, true) => prefix.to_owned(),
        (true, false) => suffix.to_owned(),
        (true, true) => return file_name.to_owned(),
    };

    path.extension().map_or(cleaned_stem.clone(), |extension| {
        format!("{cleaned_stem}.{}", extension.to_string_lossy())
    })
}

fn is_name_connector(character: char) -> bool {
    matches!(character, '-' | '_') || character.is_whitespace()
}

fn is_pure_size_component(component: &str) -> bool {
    let trimmed = component.trim();
    let durations = valid_duration_matches(trimmed);
    let geometries = valid_geometry_matches(trimmed);

    if durations
        .iter()
        .chain(geometries.iter())
        .any(|matched| size_token_fills(trimmed, matched.start, matched.end))
    {
        return true;
    }

    durations.iter().any(|duration| {
        geometries.iter().any(|geometry| {
            let (first, second) = if duration.start <= geometry.start {
                (duration, geometry)
            } else {
                (geometry, duration)
            };
            only_size_separators(&trimmed[..first.start])
                && only_size_separators(&trimmed[first.end..second.start])
                && only_size_separators(&trimmed[second.end..])
        })
    })
}

fn size_token_fills(text: &str, start: usize, end: usize) -> bool {
    only_size_separators(&text[..start]) && only_size_separators(&text[end..])
}

fn only_size_separators(text: &str) -> bool {
    text.chars().all(|character| !character.is_alphanumeric())
}

fn normalize_identity(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(root: &str, relative: &str) -> ReportAsset {
        ReportAsset {
            source_root: PathBuf::from(root),
            relative_source: PathBuf::from(relative),
            source_kind: SourceRootKind::Deliverables,
        }
    }

    fn master_asset(root: &str, relative: &str) -> ReportAsset {
        ReportAsset {
            source_root: PathBuf::from(root),
            relative_source: PathBuf::from(relative),
            source_kind: SourceRootKind::MasterFiles,
        }
    }

    #[test]
    fn excludes_master_assets_and_keeps_a_master_only_report_header_only() {
        let report = render_ticket_report(
            "P1 Campaign",
            &[
                master_asset("Master Files", "Print/Master_210x297.jpg"),
                asset("Deliverables", "Print/Deliverable_300x400.jpg"),
            ],
        );

        assert_eq!(
            report,
            "Name,Ticket,Folder,Size\nDeliverable.jpg,P1,Print,300x400\n"
        );
        assert_eq!(
            render_ticket_report(
                "P2 Master Only",
                &[master_asset("Master Files", "Print/Master_210x297.jpg")],
            ),
            "Name,Ticket,Folder,Size\n"
        );
    }

    #[test]
    fn selects_versions_per_source_root_and_parent_without_reordering_assets() {
        let report = render_ticket_report(
            "P2 Versions",
            &[
                asset("source-a", "Video/Source Materials/First_210x297.jpg"),
                asset("source-a", "Video/Ver1/OldVideo_1x1.jpg"),
                asset("source-b", "Video/Ver1/SourceB_2x2.jpg"),
                asset("source-a", "Print/version 4/LatestPrint_4x5.jpg"),
                asset("source-a", "Video/Ver3/LatestVideo_9x16.jpg"),
                asset("source-a", "Print/Working/Last_300x400.jpg"),
                asset("source-a", "Print/v2/OldPrint_3x4.jpg"),
            ],
        );

        assert_eq!(
            report,
            concat!(
                "Name,Ticket,Folder,Size\n",
                "First.jpg,P2,Video,210x297\n",
                "SourceB.jpg,P2,Video,2x2\n",
                "LatestPrint.jpg,P2,Print,4x5\n",
                "LatestVideo.jpg,P2,Video,9x16\n",
                "Last.jpg,P2,Print,300x400\n",
            )
        );
    }

    #[test]
    fn ignores_nested_versions_after_the_selected_version_folder() {
        let report = render_ticket_report(
            "P3 Nested Versions",
            &[
                asset("Deliverables", "Video/Ver1/version 100/Old_1x1.jpg"),
                asset("Deliverables", "Video/Ver2/version 99/NestedHigh_4x5.jpg"),
                asset("Deliverables", "Video/Ver2/version 1/NestedLow_9x16.jpg"),
            ],
        );

        assert_eq!(
            report,
            concat!(
                "Name,Ticket,Folder,Size\n",
                "NestedHigh.jpg,P3,Video,4x5\n",
                "NestedLow.jpg,P3,Video,9x16\n",
            )
        );
    }

    #[test]
    fn equal_version_numbers_use_the_existing_name_tiebreaker() {
        let report = render_ticket_report(
            "P4 Version Tie",
            &[
                asset("Deliverables", "Print/version 2 alpha/Alpha_210x297.jpg"),
                asset("Deliverables", "Print/version 2 zulu/Zulu_300x400.jpg"),
            ],
        );

        assert_eq!(
            report,
            "Name,Ticket,Folder,Size\nZulu.jpg,P4,Print,300x400\n"
        );
    }

    #[test]
    fn version_tokens_in_filenames_do_not_trigger_folder_selection() {
        let report = render_ticket_report(
            "P5 Filename Versions",
            &[
                asset("Deliverables", "Print/Poster_version 99_210x297.jpg"),
                asset("Deliverables", "Print/Asset_v100.jpg"),
            ],
        );

        assert_eq!(
            report,
            concat!(
                "Name,Ticket,Folder,Size\n",
                "Poster_version 99.jpg,P5,Print,210x297\n",
                "Asset_v100.jpg,P5,Print,Unknown\n",
            )
        );
    }

    #[test]
    fn renders_print_example() {
        let report = render_ticket_report(
            "P132189 Campaign",
            &[asset(
                "Deliverables",
                "Print/Ver2/Print_260706_P132189_Q3 26 Fleet Publication Print - Fleet World_210x297_V2R0.jpg",
            )],
        );

        assert_eq!(
            report,
            concat!(
                "Name,Ticket,Folder,Size\n",
                "Print_260706_P132189_Q3 26 Fleet Publication Print - Fleet World-V2R0.jpg,",
                "P132189,Print,210x297\n",
            )
        );
    }

    #[test]
    fn groups_creative_variants_and_keeps_distinct_creatives() {
        let root = "06. Deliverables";
        let report = render_ticket_report(
            "P132446",
            &[
                asset(
                    root,
                    "Video/08072026/140 Years Sources/CLA-C174-Fast-Charging/4x5/C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_4-5_HQMaster_NO-VO_H264.mp4",
                ),
                asset(
                    root,
                    "Video/08072026/140 Years Sources/CLA-C174-Fast-Charging/9x16/C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_9-16_HQMaster_NO-VO_H264.mp4",
                ),
                asset(
                    root,
                    "Video/Ver2/Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide 3_E-class_15sec_Video_1440x1800px_V2R0.mp4",
                ),
            ],
        );

        assert_eq!(
            report,
            concat!(
                "Name,Ticket,Folder,Size\n",
                "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-HQMaster_NO-VO_H264.mp4,",
                "P132446,Video,\"20 sec 4x5,20 sec 9x16\"\n",
                "Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide 3_E-class-V2R0.mp4,",
                "P132446,Video,15 sec 1440x1800\n",
            )
        );
    }

    #[test]
    fn does_not_merge_matching_names_from_different_project_paths_or_roots() {
        let report = render_ticket_report(
            "P7",
            &[
                asset("Deliverables A", "Video/Campaign A/4x5/Spot_20s_4-5.mp4"),
                asset("Deliverables A", "Video/Campaign B/9x16/Spot_20s_9-16.mp4"),
                asset("Deliverables B", "Video/Campaign A/9x16/Spot_20s_9-16.mp4"),
            ],
        );

        assert_eq!(report.lines().count(), 4);
    }

    #[test]
    fn keeps_distinct_folders_and_file_extensions_separate() {
        let report = render_ticket_report(
            "P7",
            &[
                asset("Deliverables", "Print-A/Poster_210x297.jpg"),
                asset("Deliverables", "Print A/Poster_210x297.jpg"),
                asset("Deliverables", "Print-A/Poster_210x297.png"),
            ],
        );

        assert_eq!(report.lines().count(), 4);
    }

    #[test]
    fn canonicalizes_supported_sizes_and_rejects_non_size_fragments() {
        let cases = [
            ("Spot_20s_4-5.mp4", Some("20 sec 4x5")),
            ("Spot_15sec_Video_1440x1800px.mp4", Some("15 sec 1440x1800")),
            ("Spot_1080x1920px_15s.mp4", Some("15 sec 1080x1920")),
            ("Poster_210x297.jpg", Some("210x297")),
            ("Poster_50x70.jpg", Some("50x70")),
            ("Poster_4:5.jpg", Some("4x5")),
            ("Spot_v2-1080x1920.jpg", Some("1080x1920")),
            ("Campaign_2026-08.jpg", None),
            ("Asset_123-456.jpg", None),
            ("Slide_3Slides.jpg", None),
            ("Poster_210x297mm.jpg", None),
            ("Poster_210x297 mm.jpg", None),
            ("Poster_210x297cm.jpg", None),
            ("Poster_210x297 cm.jpg", None),
            ("Poster_8.5x11in.jpg", None),
            ("Poster_8.5x11 in.jpg", None),
        ];

        for (file_name, expected) in cases {
            assert_eq!(
                extract_size(file_name)
                    .as_ref()
                    .map(|matched| matched.value.as_str()),
                expected,
                "{file_name}"
            );
        }
    }

    #[test]
    fn canonicalizes_duration_spellings_geometry_separators_orientation_and_scale() {
        let cases = [
            ("Clip_20s.mp4", "20 sec"),
            ("Clip_20 S.mp4", "20 sec"),
            ("Clip_20SEC.mp4", "20 sec"),
            ("Clip_20 secs.mp4", "20 sec"),
            ("Clip_20Second.mp4", "20 sec"),
            ("Clip_20 SECONDS.mp4", "20 sec"),
            ("Clip_0.20s.mp4", "0.20 sec"),
            ("Poster_1-1.jpg", "1x1"),
            ("Poster_4:5.jpg", "4x5"),
            ("Poster_9X16.jpg", "9x16"),
            ("Poster_16×9.jpg", "16x9"),
            ("Poster_1440 x 1800 PX.jpg", "1440x1800"),
            ("Poster_210-297px.jpg", "210x297"),
            ("Poster_8.5x11.jpg", "8.5x11"),
            ("Poster_2x4.jpg", "2x4"),
            ("Poster_4x2.jpg", "4x2"),
            ("Poster_01080x01920px.jpg", "01080x01920"),
            ("Spot_4-5_20secs.mp4", "20 sec 4x5"),
        ];

        for (file_name, expected) in cases {
            assert_eq!(
                extract_size(file_name).map(|matched| matched.value),
                Some(expected.to_owned()),
                "{file_name}"
            );
        }
    }

    #[test]
    fn cleans_display_names_at_the_removed_size_boundary() {
        let cases = [
            (
                "Fast-Charging-20s_1-1_Clean_NO-VO_H264.mp4",
                "Fast-Charging-Clean_NO-VO_H264.mp4",
            ),
            (
                "E-class_15sec_Video_1440x1800px_V2R0.mp4",
                "E-class-V2R0.mp4",
            ),
            ("20s_4x5__Leading.MP4", "Leading.MP4"),
            ("Trailing---20s_4x5.mp4", "Trailing.mp4"),
            ("Left -_ 20s_4x5 __ Right.mp4", "Left-Right.mp4"),
            (
                "A.B_(Final)-20s_4x5_[Clean]!.MP4",
                "A.B_(Final)-[Clean]!.MP4",
            ),
            ("Original_Name.MP4", "Original_Name.MP4"),
            ("210x297.jpg", "210x297.jpg"),
        ];

        for (file_name, expected) in cases {
            let size_match = extract_size(file_name);
            assert_eq!(
                cleaned_name(file_name, size_match.as_ref()),
                expected,
                "{file_name}"
            );
        }
    }

    #[test]
    fn renders_all_twenty_name_examples_as_sixteen_strict_groups() {
        let files = [
            "13650517_C.B.GB.140Y_VOD_Moment-CLA-C174-MBUX-Virtual-Assistant-20s_16-9_HQMaster_NO-VO_H264 original.mp4",
            "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_1-1_Clean_NO-VO_H264.mp4",
            "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_1-1_HQMaster_NO-VO_H264.mp4",
            "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_4-5_Clean_NO-VO_H264.mp4",
            "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_4-5_HQMaster_NO-VO_H264.mp4",
            "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_9-16_HQMaster_NO-VO_H264.mp4",
            "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_16-9_Clean_NO-VO_H264_Webmix.mp4",
            "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-20s_16-9_HQMaster_NO-VO_H264_Webmix.mp4",
            "C.B.GB.140Y_VOD_Moment-GLC-X540-Airmatic-Air-Suspension-20s_9-16_HQMaster_NO-VO_H264.mp4",
            "C.B.GB.140Y_VOD_Moment-GLC-X540-Airmatic-Air-Suspension-20s_16-9_Clean_NO-VO_H264_Webmix.mp4",
            "C.B.GB.140Y_VOD_Moment-GLC-X540-Airmatic-Air-Suspension-20s_16-9_HQMaster_NO-VO_H264_Webmix.mp4",
            "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-Acoustic-Glass-20s_16-9_Clean_NO-VO_H264_Webmix (1).mp4",
            "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-Acoustic-Glass-20s_16-9_HQMaster_NO-VO_H264_Webmix (1).mp4",
            "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-In-Car-Office-20s_9-16_HQMaster_NO-VO_H264.mp4",
            "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-In-Car-Office-20s_16-9_Clean_NO-VO_H264_Webmix.mp4",
            "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-In-Car-Office-20s_16-9_HQMaster_NO-VO_H264_Webmix.mp4",
            "Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide 3_E-class_15sec_Video_1440x1800px_V2R0.mp4",
            "Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide7_Airmatic Suspension-GLC_20Sec_Video_1080x1920px_V2RO.mp4",
            "Video_260713_P132446_ (3 JUL) 2026_MBPC_140YOI_Slide7_Airmatic Suspension-GLC_20Sec_Video_1440×1800px_V2RO.mp4",
            "Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide7_Airmatic Suspension-GLC_20Sec_Video_1440x2560px_V2R0.mp4",
        ];
        let assets = files
            .iter()
            .map(|file_name| asset("06. Deliverables", &format!("Video/{file_name}")))
            .collect::<Vec<_>>();

        let report = render_ticket_report("P132446 Campaign", &assets);

        assert_eq!(
            report,
            concat!(
                "Name,Ticket,Folder,Size\n",
                "13650517_C.B.GB.140Y_VOD_Moment-CLA-C174-MBUX-Virtual-Assistant-HQMaster_NO-VO_H264 original.mp4,P132446,Video,20 sec 16x9\n",
                "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-Clean_NO-VO_H264.mp4,P132446,Video,\"20 sec 1x1,20 sec 4x5\"\n",
                "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-HQMaster_NO-VO_H264.mp4,P132446,Video,\"20 sec 1x1,20 sec 4x5,20 sec 9x16\"\n",
                "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-Clean_NO-VO_H264_Webmix.mp4,P132446,Video,20 sec 16x9\n",
                "C.B.GB.140Y_VOD_Moment-CLA-C174-Fast-Charging-HQMaster_NO-VO_H264_Webmix.mp4,P132446,Video,20 sec 16x9\n",
                "C.B.GB.140Y_VOD_Moment-GLC-X540-Airmatic-Air-Suspension-HQMaster_NO-VO_H264.mp4,P132446,Video,20 sec 9x16\n",
                "C.B.GB.140Y_VOD_Moment-GLC-X540-Airmatic-Air-Suspension-Clean_NO-VO_H264_Webmix.mp4,P132446,Video,20 sec 16x9\n",
                "C.B.GB.140Y_VOD_Moment-GLC-X540-Airmatic-Air-Suspension-HQMaster_NO-VO_H264_Webmix.mp4,P132446,Video,20 sec 16x9\n",
                "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-Acoustic-Glass-Clean_NO-VO_H264_Webmix (1).mp4,P132446,Video,20 sec 16x9\n",
                "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-Acoustic-Glass-HQMaster_NO-VO_H264_Webmix (1).mp4,P132446,Video,20 sec 16x9\n",
                "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-In-Car-Office-HQMaster_NO-VO_H264.mp4,P132446,Video,20 sec 9x16\n",
                "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-In-Car-Office-Clean_NO-VO_H264_Webmix.mp4,P132446,Video,20 sec 16x9\n",
                "C.B.GB.140Y_VOD_Moment-S-CLASS-V223-In-Car-Office-HQMaster_NO-VO_H264_Webmix.mp4,P132446,Video,20 sec 16x9\n",
                "Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide 3_E-class-V2R0.mp4,P132446,Video,15 sec 1440x1800\n",
                "Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide7_Airmatic Suspension-GLC-V2RO.mp4,P132446,Video,\"20 sec 1080x1920,20 sec 1440x1800\"\n",
                "Video_260713_P132446_(3 JUL) 2026_MBPC_140YOI_Slide7_Airmatic Suspension-GLC-V2R0.mp4,P132446,Video,20 sec 1440x2560\n",
            )
        );
        assert_eq!(report.lines().count(), 17);
    }

    #[test]
    fn groups_dimension_before_duration_variants() {
        let report = render_ticket_report(
            "P8",
            &[
                asset("Deliverables", "Video/Spot_1080x1920px_15s.mp4"),
                asset("Deliverables", "Video/Spot_720x1280px_15s.mp4"),
            ],
        );

        assert_eq!(
            report,
            "Name,Ticket,Folder,Size\nSpot.mp4,P8,Video,\"15 sec 1080x1920,15 sec 720x1280\"\n"
        );
    }

    #[test]
    fn deduplicates_equivalent_sizes_and_retains_unknown_in_first_seen_order() {
        let report = render_ticket_report(
            "P8",
            &[
                asset("Deliverables", "Video/Spot.mp4"),
                asset("Deliverables", "Video/Spot_20s_4-5.mp4"),
                asset("Deliverables", "Video/Spot_20 SEC_4x5.mp4"),
                asset("Deliverables", "Video/Spot_20seconds_4:5.mp4"),
            ],
        );

        assert_eq!(
            report,
            "Name,Ticket,Folder,Size\nSpot.mp4,P8,Video,\"Unknown,20 sec 4x5\"\n"
        );
    }

    #[test]
    fn removes_only_pure_size_path_components() {
        assert!(is_pure_size_component("20s_4x5"));
        assert!(is_pure_size_component("(9x16)"));
        assert!(!is_pure_size_component("15s Teaser 4x5"));

        let report = render_ticket_report(
            "P8",
            &[
                asset(
                    "Deliverables",
                    "Video/Campaign/15s Teaser 4x5/Spot_20s_4-5.mp4",
                ),
                asset(
                    "Deliverables",
                    "Video/Campaign/20s Teaser 9x16/Spot_20s_4-5.mp4",
                ),
            ],
        );
        assert_eq!(report.lines().count(), 3);
    }

    #[test]
    fn omits_direct_files_uses_unknown_and_deduplicates_sizes() {
        let report = render_ticket_report(
            "Campaign Without Number",
            &[
                asset("Deliverables", "direct.pdf"),
                asset("Deliverables", "Print/brief.pdf"),
                asset("Deliverables", "Print/brief.pdf"),
            ],
        );

        assert_eq!(
            report,
            "Name,Ticket,Folder,Size\nbrief.pdf,Campaign Without Number,Print,Unknown\n"
        );
    }

    #[test]
    fn retains_unknown_with_known_sizes_and_uses_the_first_display_name() {
        let report = render_ticket_report(
            "P10",
            &[
                asset("Deliverables", "Print/Poster.JPG"),
                asset("Deliverables", "Print/poster_210x297.jpg"),
                asset("Deliverables", "Print/POSTER_210x297.JPG"),
            ],
        );

        assert_eq!(
            report,
            "Name,Ticket,Folder,Size\nPoster.JPG,P10,Print,\"Unknown,210x297\"\n"
        );
    }

    #[test]
    fn escapes_csv_fields() {
        let report = render_ticket_report(
            "P9",
            &[asset(
                "Deliverables",
                "Print, O\"OH/Poster, O\"OH_210x297.jpg",
            )],
        );

        assert_eq!(
            report,
            "Name,Ticket,Folder,Size\n\"Poster, O\"\"OH.jpg\",P9,\"Print, O\"\"OH\",210x297\n"
        );
    }

    #[test]
    fn header_is_written_when_no_assets_are_reportable() {
        assert_eq!(
            render_ticket_report("P1", &[asset("Deliverables", "direct.pdf")]),
            "Name,Ticket,Folder,Size\n"
        );
    }

    #[test]
    fn aggregate_has_one_header_and_keeps_ticket_order() {
        let reports = vec![
            build_ticket_report(
                "P2 Second",
                &[asset("Deliverables", "Print/Poster_210x297.jpg")],
            ),
            build_ticket_report(
                "P1 First",
                &[asset("Deliverables", "Video/Clip_20s_4-5.mp4")],
            ),
        ];

        assert_eq!(
            render_aggregate_report(&reports),
            concat!(
                "Name,Ticket,Folder,Size\n",
                "Poster.jpg,P2,Print,210x297\n",
                "Clip.mp4,P1,Video,20 sec 4x5\n",
            )
        );
        assert_eq!(render_aggregate_report(&[]), "Name,Ticket,Folder,Size\n");
    }
}
