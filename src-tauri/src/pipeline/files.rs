use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::fs_safety::metadata_is_link_like;

pub fn create_temporary_file(destination: &Path) -> io::Result<(PathBuf, File)> {
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination has no parent directory",
        )
    })?;
    let file_name = destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?;

    for counter in 0_u32..1_000 {
        let mut temporary_name = OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(".horizon-traversal-{counter}.tmp"));
        let temporary_path = parent.join(temporary_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => return Ok((temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not reserve a temporary output name",
    ))
}

#[cfg(not(windows))]
pub fn replace_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
pub fn replace_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    if !destination.exists() {
        return fs::rename(temporary, destination);
    }

    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination has no parent directory",
        )
    })?;
    let file_name = destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?;
    let backup = (0_u32..1_000)
        .map(|counter| {
            let mut backup_name = OsString::from(".");
            backup_name.push(file_name);
            backup_name.push(format!(".horizon-traversal-backup-{counter}"));
            parent.join(backup_name)
        })
        .find(|candidate| candidate.symlink_metadata().is_err())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "could not reserve a replacement backup name",
            )
        })?;

    fs::rename(destination, &backup)?;
    match fs::rename(temporary, destination) {
        Ok(()) => {
            let _ = fs::remove_file(backup);
            Ok(())
        }
        Err(error) => {
            if let Err(restore_error) = fs::rename(&backup, destination) {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "replacement failed ({error}); original remains at {} because rollback failed ({restore_error})",
                        backup.display()
                    ),
                ));
            }
            Err(error)
        }
    }
}

pub fn remove_if_exists(path: &Path) {
    if path.symlink_metadata().is_ok() {
        let _ = fs::remove_file(path);
    }
}

pub fn remove_regular_file_if_exists(path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if metadata_is_link_like(&metadata) || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing to remove non-regular file at {}", path.display()),
        ));
    }
    fs::remove_file(path)?;
    Ok(true)
}

pub fn write_utf8_atomic(destination: &Path, contents: &str) -> io::Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "refusing to replace non-regular file at {}",
                    destination.display()
                ),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let (temporary_path, mut temporary_file) = create_temporary_file(destination)?;
    let write_result = temporary_file
        .write_all(contents.as_bytes())
        .and_then(|()| temporary_file.flush())
        .and_then(|()| temporary_file.sync_all());
    drop(temporary_file);

    if let Err(error) = write_result {
        remove_if_exists(&temporary_path);
        return Err(error);
    }
    if let Err(error) = replace_file(&temporary_path, destination) {
        remove_if_exists(&temporary_path);
        return Err(error);
    }
    Ok(())
}

pub fn human_size(bytes: u64) -> String {
    let mut size = bytes as f64;
    for unit in ["B", "KB", "MB", "GB"] {
        if size < 1_024.0 {
            return format!("{size:.1} {unit}");
        }
        size /= 1_024.0;
    }
    format!("{size:.1} TB")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{human_size, remove_regular_file_if_exists, write_utf8_atomic};

    #[test]
    fn formats_file_sizes_with_binary_units() {
        assert_eq!(human_size(24), "24.0 B");
        assert_eq!(human_size(1_536), "1.5 KB");
        assert_eq!(human_size(25_480_396), "24.3 MB");
    }

    #[test]
    fn atomically_replaces_a_regular_utf8_file() {
        let temp = tempdir().unwrap();
        let destination = temp.path().join("1. report.csv");
        fs::write(&destination, "stale").unwrap();

        write_utf8_atomic(&destination, "Name\nCréatif\n").unwrap();

        assert_eq!(fs::read_to_string(destination).unwrap(), "Name\nCréatif\n");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_write_rejects_a_directory_without_moving_it() {
        let temp = tempdir().unwrap();
        let destination = temp.path().join("1. report.csv");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("sentinel"), "keep").unwrap();

        assert!(write_utf8_atomic(&destination, "replacement").is_err());

        assert_eq!(
            fs::read_to_string(destination.join("sentinel")).unwrap(),
            "keep"
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn removes_only_regular_files() {
        let temp = tempdir().unwrap();
        let file = temp.path().join("file");
        let directory = temp.path().join("directory");
        fs::write(&file, "old").unwrap();
        fs::create_dir(&directory).unwrap();

        assert!(remove_regular_file_if_exists(&file).unwrap());
        assert!(!remove_regular_file_if_exists(&file).unwrap());
        assert!(remove_regular_file_if_exists(&directory).is_err());
        assert!(directory.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn report_helpers_reject_symlinks_without_touching_the_target() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("1. report.csv");
        fs::write(&target, "keep").unwrap();
        symlink(&target, &link).unwrap();

        assert!(remove_regular_file_if_exists(&link).is_err());
        assert!(write_utf8_atomic(&link, "replacement").is_err());
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(target).unwrap(), "keep");
    }
}
