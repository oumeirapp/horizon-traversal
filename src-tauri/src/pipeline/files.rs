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
    let mut backup_name = OsString::from(".");
    backup_name.push(file_name);
    backup_name.push(".x-traversal-backup");
    let backup = parent.join(backup_name);

    if backup.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("replacement backup already exists: {}", backup.display()),
        ));
    }

    fs::rename(destination, &backup)?;
    match fs::rename(temporary, destination) {
        Ok(()) => {
            fs::remove_file(backup)?;
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&backup, destination);
            Err(error)
        }
    }
}

pub fn remove_if_exists(path: &Path) {
    if path.symlink_metadata().is_ok() {
        let _ = fs::remove_file(path);
    }
}
