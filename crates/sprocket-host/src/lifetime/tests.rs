use super::*;

#[test]
fn shutdown_rejects_new_run_guards() {
    let lifetime = HostLifetime::new();
    lifetime.shutdown.cancel();
    assert!(lifetime.run_guard().is_err());
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
