#[cfg(windows)]
use std::fs;
use std::fs::{FileType, Metadata};
use std::io;
use std::path::Path;

pub fn is_link_like(path: &Path, file_type: &FileType) -> io::Result<bool> {
    if file_type.is_symlink() {
        return Ok(true);
    }

    #[cfg(windows)]
    {
        let metadata = fs::symlink_metadata(path)?;
        Ok(metadata_is_link_like(&metadata))
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(false)
    }
}

pub fn metadata_is_link_like(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    #[cfg(not(windows))]
    {
        false
    }
}
