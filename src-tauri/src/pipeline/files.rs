use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

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
        temporary_name.push(format!(".x-traversal-{counter}.tmp"));
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
            backup_name.push(format!(".x-traversal-backup-{counter}"));
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
    use super::human_size;

    #[test]
    fn formats_file_sizes_with_binary_units() {
        assert_eq!(human_size(24), "24.0 B");
        assert_eq!(human_size(1_536), "1.5 KB");
        assert_eq!(human_size(25_480_396), "24.3 MB");
    }
}
