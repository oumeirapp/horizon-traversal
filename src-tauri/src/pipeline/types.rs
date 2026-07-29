use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeLevel {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineNotice {
    pub level: NoticeLevel,
    pub message: String,
    pub path: Option<PathBuf>,
}

impl PipelineNotice {
    pub fn new(level: NoticeLevel, message: impl Into<String>, path: Option<PathBuf>) -> Self {
        Self {
            level,
            message: message.into(),
            path,
        }
    }

    pub fn info(message: impl Into<String>, path: Option<PathBuf>) -> Self {
        Self::new(NoticeLevel::Info, message, path)
    }

    pub fn success(message: impl Into<String>, path: Option<PathBuf>) -> Self {
        Self::new(NoticeLevel::Success, message, path)
    }

    pub fn warning(message: impl Into<String>, path: Option<PathBuf>) -> Self {
        Self::new(NoticeLevel::Warning, message, path)
    }

    pub fn error(message: impl Into<String>, path: Option<PathBuf>) -> Self {
        Self::new(NoticeLevel::Error, message, path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopiedAsset {
    pub source: PathBuf,
    pub destination: PathBuf,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CollectionOutcome {
    pub copied: Vec<CopiedAsset>,
    pub failed_files: usize,
    pub notices: Vec<PipelineNotice>,
}

impl CollectionOutcome {
    pub fn append(&mut self, mut other: Self) {
        self.copied.append(&mut other.copied);
        self.failed_files += other.failed_files;
        self.notices.append(&mut other.notices);
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SourceDiscovery {
    pub folders: Vec<PathBuf>,
    pub notices: Vec<PipelineNotice>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TicketSelection {
    pub tickets: Vec<PathBuf>,
    pub notices: Vec<PipelineNotice>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ProcessingOutcome {
    pub processed: usize,
    pub changed: usize,
    pub failed_files: usize,
    pub notices: Vec<PipelineNotice>,
}
