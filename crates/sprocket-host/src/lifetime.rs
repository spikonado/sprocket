use std::sync::{Arc, Mutex};

use sprocket_workspace::WorkspaceCancellation;

struct LifetimeState {
    active_runs: usize,
    accepting: bool,
    restart_requested: bool,
}

/// Tracks the work that keeps the host process alive and its shutdown signal.
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
                accepting: true,
                restart_requested: false,
            }),
        })
    }

    pub fn run_guard(self: &Arc<Self>) -> anyhow::Result<RunGuard> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            state.accepting && !self.shutdown.is_cancelled(),
            "server is shutting down"
        );
        state.active_runs += 1;
        Ok(RunGuard(Arc::clone(self)))
    }

    pub fn is_stopping(&self) -> bool {
        !self.state.lock().unwrap().accepting
    }

    /// Stops accepting work and signals a shutdown that the launcher follows with a restart.
    pub fn request_restart(&self) -> anyhow::Result<()> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            state.accepting && !self.shutdown.is_cancelled(),
            "Sprocket is already shutting down."
        );
        state.restart_requested = true;
        state.accepting = false;
        self.shutdown.cancel();
        Ok(())
    }

    pub fn restart_requested(&self) -> bool {
        self.state.lock().unwrap().restart_requested
    }

    /// Stops accepting work and signals shutdown when no run holds a guard.
    pub fn stop_if_idle(&self) {
        let mut state = self.state.lock().unwrap();
        if state.active_runs == 0 {
            state.accepting = false;
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
