use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Default)]
pub struct PowerPointState {
    active: Arc<Mutex<Option<ActiveRun>>>,
    last_output: Arc<Mutex<Option<PathBuf>>>,
}

#[derive(Debug)]
struct ActiveRun {
    run_id: String,
    cancelled: Arc<AtomicBool>,
    cancel_path: Option<PathBuf>,
    committing: bool,
}

#[derive(Debug, Clone)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl PowerPointState {
    pub fn begin(&self, run_id: &str) -> Option<CancellationToken> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active.is_some() {
            return None;
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveRun {
            run_id: run_id.to_owned(),
            cancelled: Arc::clone(&cancelled),
            cancel_path: None,
            committing: false,
        });
        Some(CancellationToken { cancelled })
    }

    pub fn attach_cancel_path(&self, run_id: &str, path: &Path) -> io::Result<()> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(run) = active.as_mut().filter(|run| run.run_id == run_id) else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "PowerPoint run is no longer active",
            ));
        };
        run.cancel_path = Some(path.to_path_buf());
        if run.cancelled.load(Ordering::Acquire) {
            fs::write(path, b"cancel\n")?;
        }
        Ok(())
    }

    pub fn cancel(&self, run_id: &str) -> io::Result<bool> {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(run) = active.as_ref().filter(|run| run.run_id == run_id) else {
            return Ok(false);
        };
        if run.committing {
            return Ok(false);
        }
        run.cancelled.store(true, Ordering::Release);
        if let Some(path) = &run.cancel_path {
            fs::write(path, b"cancel\n")?;
        }
        Ok(true)
    }

    pub fn begin_commit(&self, run_id: &str) -> bool {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(run) = active.as_mut().filter(|run| run.run_id == run_id) else {
            return false;
        };
        if run.committing || run.cancelled.load(Ordering::Acquire) {
            return false;
        }
        run.committing = true;
        true
    }

    pub fn finish(&self, run_id: &str) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active.as_ref().is_some_and(|run| run.run_id == run_id) {
            *active = None;
        }
    }

    pub fn set_last_output(&self, path: PathBuf) {
        let mut output = self
            .last_output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *output = Some(path);
    }

    pub fn last_output(&self) -> Option<PathBuf> {
        self.last_output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn cancellation_before_staging_is_written_when_path_is_attached() {
        let state = PowerPointState::default();
        let token = state.begin("run-1").unwrap();
        assert!(state.cancel("run-1").unwrap());
        assert!(token.is_cancelled());

        let temp = tempdir().unwrap();
        let marker = temp.path().join("cancel");
        state.attach_cancel_path("run-1", &marker).unwrap();
        assert!(marker.is_file());

        state.finish("run-1");
        assert!(!state.cancel("run-1").unwrap());
    }

    #[test]
    fn cancellation_wins_when_requested_before_commit() {
        let state = PowerPointState::default();
        state.begin("run-1").unwrap();

        assert!(state.cancel("run-1").unwrap());
        assert!(!state.begin_commit("run-1"));
    }

    #[test]
    fn commit_gate_makes_later_cancellation_unavailable() {
        let state = PowerPointState::default();
        let token = state.begin("run-1").unwrap();

        assert!(state.begin_commit("run-1"));
        assert!(!state.cancel("run-1").unwrap());
        assert!(!token.is_cancelled());
        assert!(!state.begin_commit("run-1"));
    }
}
