use std::fs;
use std::path::Path;

use filetime::{set_file_mtime, FileTime};
use horizon_traversal_lib::pipeline::collection::{
    collect_from_source, copy_with_collision_suffix, replace_ticket_output,
};
use horizon_traversal_lib::pipeline::discovery::find_source_folders;
use horizon_traversal_lib::pipeline::selection::{select_tickets, validate_roots, SelectionError};
use horizon_traversal_lib::pipeline::types::NoticeLevel;
use tempfile::tempdir;

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

fn names(folder: &Path) -> Vec<String> {
    let mut result = fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    result.sort();
    result
}

#[test]
fn selection_is_immediate_filtered_and_deterministic() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    fs::create_dir_all(input.join("P10 Campaign")).unwrap();
    fs::create_dir_all(input.join("P2 Campaign")).unwrap();
    fs::create_dir_all(input.join("P1 Campaign/nested/P3 Hidden")).unwrap();
    write(&input.join("P4.txt"), "not a ticket");

    let selected = select_tickets(&input, "P10, P2-P1").unwrap();
    let selected_names = selected
        .tickets
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    assert_eq!(
        selected_names,
        ["P1 Campaign", "P10 Campaign", "P2 Campaign"]
    );
}

#[test]
fn invalid_filter_does_not_fall_back_to_all_tickets() {
    let temp = tempdir().unwrap();
    fs::create_dir_all(temp.path().join("P1")).unwrap();

    assert!(matches!(
        select_tickets(temp.path(), "not-a-ticket"),
        Err(SelectionError::InvalidFilter(_))
    ));
}

#[test]
fn overlapping_roots_are_rejected_even_when_output_is_missing() {
    let temp = tempdir().unwrap();
    let input = temp.path().join("tickets");
    fs::create_dir_all(&input).unwrap();

    assert!(matches!(
        validate_roots(&input, &input.join("new-output")),
        Err(SelectionError::OverlappingRoots { .. })
    ));
    assert!(matches!(
        validate_roots(&input, temp.path()),
        Err(SelectionError::OverlappingRoots { .. })
    ));
}

#[test]
fn discovery_matches_punctuation_and_uses_stable_depth_first_order() {
    let temp = tempdir().unwrap();
    let ticket = temp.path().join("P1");
    fs::create_dir_all(ticket.join("A/Deliverables/Nested Master-Files")).unwrap();
    fs::create_dir_all(ticket.join("B/02_master files")).unwrap();

    let discovered = find_source_folders(&ticket).unwrap();
    let relative = discovered
        .folders
        .iter()
        .map(|path| path.strip_prefix(&ticket).unwrap().to_path_buf())
        .collect::<Vec<_>>();

    assert_eq!(
        relative,
        [
            Path::new("A").join("Deliverables"),
            Path::new("A")
                .join("Deliverables")
                .join("Nested Master-Files"),
            Path::new("B").join("02_master files")
        ]
    );
}

#[test]
fn collection_selects_highest_version_and_stops_selecting_inside_it() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("Deliverables");
    let output = temp.path().join("output");
    fs::create_dir_all(&output).unwrap();
    write(&source.join("top.jpg"), "top");
    write(&source.join("version 1/old.jpg"), "old");
    write(&source.join("version 2/new.jpg"), "new");
    write(&source.join("version 2/version 99/nested.jpg"), "nested");
    write(&source.join("ordinary/skipped.jpg"), "skipped");

    let outcome = collect_from_source(&source, &output).unwrap();

    assert_eq!(outcome.copied.len(), 3);
    assert_eq!(names(&output), ["nested.jpg", "new.jpg", "top.jpg"]);
}

#[test]
fn equal_version_numbers_use_a_deterministic_name_tiebreaker() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("Deliverables");
    let output = temp.path().join("output");
    fs::create_dir_all(&output).unwrap();
    write(&source.join("v2 alpha/alpha.jpg"), "alpha");
    write(&source.join("version 2 zulu/zulu.jpg"), "zulu");

    collect_from_source(&source, &output).unwrap();

    assert_eq!(names(&output), ["zulu.jpg"]);
}

#[test]
fn flat_collection_suffixes_collisions_and_warns_for_mov() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("Deliverables");
    let output = temp.path().join("output");
    fs::create_dir_all(&output).unwrap();
    write(&source.join("A/asset.jpg"), "first");
    write(&source.join("B/asset.jpg"), "second");
    write(&source.join("B/clip.MOV"), "movie");

    let outcome = collect_from_source(&source, &output).unwrap();

    assert_eq!(names(&output), ["asset.jpg", "asset_1.jpg"]);
    assert!(outcome
        .notices
        .iter()
        .any(|notice| { notice.level == NoticeLevel::Warning && notice.message.contains(".mov") }));
}

#[test]
fn copied_files_keep_mtime_and_permissions() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("asset.jpg");
    let output = temp.path().join("output");
    fs::create_dir_all(&output).unwrap();
    write(&source, "asset");
    let expected_mtime = FileTime::from_unix_time(1_700_000_000, 0);
    set_file_mtime(&source, expected_mtime).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
    }

    let copied = copy_with_collision_suffix(&source, &output).unwrap();
    let copied_metadata = fs::metadata(copied).unwrap();
    assert_eq!(
        FileTime::from_last_modification_time(&copied_metadata),
        expected_mtime
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(copied_metadata.permissions().mode() & 0o777, 0o640);
    }
}

#[test]
fn replacing_ticket_output_removes_only_that_ticket() {
    let temp = tempdir().unwrap();
    let output = temp.path().join("output");
    let ticket = temp.path().join("P1 Campaign");
    fs::create_dir_all(&ticket).unwrap();
    write(&output.join("P1 Campaign/stale.jpg"), "stale");
    write(&output.join("P2 Campaign/keep.jpg"), "keep");

    let prepared = replace_ticket_output(&output, &ticket).unwrap();

    assert!(prepared.is_dir());
    assert!(names(&prepared).is_empty());
    assert!(output.join("P2 Campaign/keep.jpg").is_file());
}

#[cfg(unix)]
#[test]
fn symlinks_are_skipped_in_selection_discovery_and_collection() {
    use std::os::unix::fs::symlink;

    let temp = tempdir().unwrap();
    let input = temp.path().join("input");
    let real_ticket = input.join("P1");
    let external = temp.path().join("external");
    fs::create_dir_all(real_ticket.join("Deliverables")).unwrap();
    fs::create_dir_all(external.join("Master Files")).unwrap();
    write(&external.join("outside.jpg"), "outside");
    symlink(&external, input.join("P2 link")).unwrap();
    symlink(&external, real_ticket.join("linked source")).unwrap();
    symlink(
        external.join("outside.jpg"),
        real_ticket.join("Deliverables/linked.jpg"),
    )
    .unwrap();

    let selected = select_tickets(&input, "").unwrap();
    assert_eq!(selected.tickets.len(), 1);
    assert_eq!(selected.notices.len(), 1);

    let discovery = find_source_folders(&real_ticket).unwrap();
    assert_eq!(discovery.folders.len(), 1);
    assert_eq!(discovery.notices.len(), 2);

    let output = temp.path().join("output");
    fs::create_dir_all(&output).unwrap();
    let collected = collect_from_source(&real_ticket.join("Deliverables"), &output).unwrap();
    assert!(collected.copied.is_empty());
    assert_eq!(collected.notices.len(), 1);
}
