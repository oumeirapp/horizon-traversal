use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Default)]
pub struct AppState {
    running: Arc<AtomicBool>,
    last_output: Arc<Mutex<Option<PathBuf>>>,
}

impl AppState {
    pub fn try_begin_run(&self) -> Option<RunPermit> {
        self.running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| RunPermit {
                running: Arc::clone(&self.running),
            })
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn set_last_output(&self, path: PathBuf) {
        if let Ok(mut last_output) = self.last_output.lock() {
            *last_output = Some(path);
        }
    }

    pub fn last_output(&self) -> Option<PathBuf> {
        self.last_output
            .lock()
            .ok()
            .and_then(|last_output| last_output.clone())
    }
}

#[derive(Debug)]
pub struct RunPermit {
    running: Arc<AtomicBool>,
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_run_permit_exists_and_drop_releases_it() {
        let state = AppState::default();
        let permit = state.try_begin_run().unwrap();
        assert!(state.is_running());
        assert!(state.try_begin_run().is_none());

        drop(permit);

        assert!(!state.is_running());
        assert!(state.try_begin_run().is_some());
    }
}
