use super::*;

#[test]
fn shutdown_rejects_new_run_guards() {
    let lifetime = HostLifetime::new();
    lifetime.shutdown.cancel();
    assert!(lifetime.run_guard().is_err());
}

#[test]
fn restart_requests_are_idempotent_but_rejected_after_shutdown() {
    let lifetime = HostLifetime::new();
    lifetime.request_restart().unwrap();
    lifetime.request_restart().unwrap();
    assert!(lifetime.shutdown.is_cancelled());

    let stopped = HostLifetime::new();
    stopped.shutdown.cancel();
    assert!(stopped.request_restart().is_err());
}

#[test]
fn active_runs_keep_an_idle_stop_from_happening() {
    let lifetime = HostLifetime::new();
    let run = lifetime.run_guard().unwrap();
    lifetime.stop_if_idle();
    assert!(!lifetime.is_stopping());
    drop(run);
    lifetime.stop_if_idle();
    assert!(lifetime.is_stopping());
    assert!(lifetime.shutdown.is_cancelled());
}
