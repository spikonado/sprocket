use std::sync::{Arc, Mutex};

use sprocket_workspace::WorkspaceCancellation;

struct LifetimeState {
    active_runs: usize,
    restart_requested: bool,
}

pub struct HostLifetime {
    pub shutdown: WorkspaceCancellation,
    state: Mutex<LifetimeState>,
}

impl HostLifetime {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            shutdown: WorkspaceCancellation::new(),
            state: Mutex::new(LifetimeState {
                active_runs: 0,
                restart_requested: false,
            }),
        })
    }

    pub fn run_guard(self: &Arc<Self>) -> anyhow::Result<RunGuard> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(!self.is_stopping(), "server is shutting down");
        state.active_runs += 1;
        Ok(RunGuard(Arc::clone(self)))
    }

    pub fn is_stopping(&self) -> bool {
        self.shutdown.is_cancelled()
    }

    pub fn request_restart(&self) -> anyhow::Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.restart_requested {
            return Ok(());
        }
        anyhow::ensure!(!self.is_stopping(), "Sprocket is already shutting down.");
        state.restart_requested = true;
        self.shutdown.cancel();
        Ok(())
    }

    pub fn restart_requested(&self) -> bool {
        self.state.lock().unwrap().restart_requested
    }

    pub fn stop_if_idle(&self) {
        let state = self.state.lock().unwrap();
        if state.active_runs == 0 {
            self.shutdown.cancel();
        }
    }
}

pub struct RunGuard(Arc<HostLifetime>);

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().active_runs -= 1;
    }
}

#[cfg(test)]
mod tests;
