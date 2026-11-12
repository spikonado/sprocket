mod process;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::stream::{self, BoxStream};
use futures::{StreamExt, future};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, watch};
use tokio::time::MissedTickBehavior;

use self::process::{HelperAction, UpdateCommand};

const SUCCESS_CHECK_TTL: Duration = Duration::from_secs(60 * 60);
const FAILED_CHECK_TTL: Duration = Duration::from_secs(5 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    Unavailable,
    Idle,
    Available,
    Installing,
    Installed,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateMethod {
    Package,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdateSnapshot {
    pub status: UpdateStatus,
    pub current_version: String,
    pub version: Option<String>,
    pub error: Option<String>,
    pub method: UpdateMethod,
    pub message: Option<String>,
    #[serde(skip)]
    pub(crate) restart_launcher: Option<String>,
}

impl PackageUpdateSnapshot {
    fn unavailable() -> Self {
        Self {
            status: UpdateStatus::Unavailable,
            current_version: String::new(),
            version: None,
            error: None,
            method: UpdateMethod::Package,
            message: None,
            restart_launcher: None,
        }
    }

    fn error(current_version: String, version: Option<String>, message: impl Into<String>) -> Self {
        let error = message.into();
        Self {
            status: UpdateStatus::Error,
            current_version,
            version,
            error: Some(error.clone()),
            method: UpdateMethod::Package,
            message: Some(error),
            restart_launcher: None,
        }
    }
}

type HelperResult = watch::Receiver<Option<PackageUpdateSnapshot>>;

enum Op {
    None,
    Check {
        then_install: bool,
        result: HelperResult,
    },
    Install,
}

struct Inner {
    snapshot: PackageUpdateSnapshot,
    checked_at: Option<Instant>,
    op: Op,
}

pub struct PackageUpdateManager {
    command: Option<UpdateCommand>,
    restart_file: Option<PathBuf>,
    success_ttl: Duration,
    failure_ttl: Duration,
    check_timeout: Duration,
    install_timeout: Duration,
    inner: Mutex<Inner>,
    changes: watch::Sender<PackageUpdateSnapshot>,
}

impl PackageUpdateManager {
    pub fn from_env(temporary_server: bool) -> Arc<Self> {
        let mut manager = Self::new(
            parse_update_command_from_env(),
            SUCCESS_CHECK_TTL,
            FAILED_CHECK_TTL,
            CHECK_TIMEOUT,
            INSTALL_TIMEOUT,
        );
        if !temporary_server {
            manager.restart_file = std::env::var_os("SPROCKET_RESTART_FILE").map(PathBuf::from);
        }
        Arc::new(manager)
    }

    pub fn disabled() -> Arc<Self> {
        Arc::new(Self::new(
            None,
            SUCCESS_CHECK_TTL,
            FAILED_CHECK_TTL,
            CHECK_TIMEOUT,
            INSTALL_TIMEOUT,
        ))
    }

    fn new(
        command: Option<UpdateCommand>,
        success_ttl: Duration,
        failure_ttl: Duration,
        check_timeout: Duration,
        install_timeout: Duration,
    ) -> Self {
        let snapshot = if command.is_some() {
            PackageUpdateSnapshot {
                status: UpdateStatus::Idle,
                current_version: String::new(),
                version: None,
                error: None,
                method: UpdateMethod::Package,
                message: None,
                restart_launcher: None,
            }
        } else {
            PackageUpdateSnapshot::unavailable()
        };
        let (changes, _) = watch::channel(snapshot.clone());
        Self {
            command,
            restart_file: None,
            success_ttl,
            failure_ttl,
            check_timeout,
            install_timeout,
            inner: Mutex::new(Inner {
                snapshot,
                checked_at: None,
                op: Op::None,
            }),
            changes,
        }
    }

    pub async fn status(self: &Arc<Self>) -> PackageUpdateSnapshot {
        let mut inner = self.inner.lock().await;
        if self.command.is_none() {
            return PackageUpdateSnapshot::unavailable();
        }
        match &inner.op {
            Op::Install
            | Op::Check {
                then_install: true, ..
            } => return inner.snapshot.clone(),
            Op::Check { result, .. } => {
                let mut result = result.clone();
                drop(inner);
                return wait_for_snapshot(&mut result).await;
            }
            Op::None => {}
        }
        if inner.snapshot.status == UpdateStatus::Installed
            || cache_is_fresh(&inner, self.success_ttl, self.failure_ttl)
        {
            return inner.snapshot.clone();
        }
        let mut result = self.start_locked(&mut inner, HelperAction::Check);
        drop(inner);
        wait_for_snapshot(&mut result).await
    }

    /// While the stream is held, it re-runs the freshness check that `status` performs.
    pub fn watch(self: &Arc<Self>) -> BoxStream<'static, PackageUpdateSnapshot> {
        let mut changes = self.changes.subscribe();
        changes.mark_changed();
        let snapshots = stream::unfold(changes, |mut changes| async move {
            changes.changed().await.ok()?;
            let snapshot = changes.borrow_and_update().clone();
            Some((Some(snapshot), changes))
        });
        let mut interval = tokio::time::interval(self.failure_ttl);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let checks = stream::unfold(
            (Arc::clone(self), interval),
            |(manager, mut interval)| async move {
                interval.tick().await;
                manager.status().await;
                Some((None, (manager, interval)))
            },
        );
        stream::select(snapshots, checks)
            .filter_map(future::ready)
            .boxed()
    }

    pub async fn install(self: &Arc<Self>) -> PackageUpdateSnapshot {
        let mut inner = self.inner.lock().await;
        if self.command.is_none() {
            return PackageUpdateSnapshot::unavailable();
        }
        let inner = &mut *inner;
        match &mut inner.op {
            Op::None if inner.snapshot.status != UpdateStatus::Installed => {
                self.start_locked(inner, HelperAction::Install);
            }
            Op::Check { then_install, .. } if !*then_install => {
                *then_install = true;
                mark_installing(&mut inner.snapshot);
                self.publish(&inner.snapshot);
            }
            _ => {}
        }
        inner.snapshot.clone()
    }

    pub async fn prepare_restart(&self) -> anyhow::Result<()> {
        let inner = self.inner.lock().await;
        anyhow::ensure!(
            inner.snapshot.status == UpdateStatus::Installed,
            "Install a package update before restarting Sprocket."
        );
        let (Some(launcher), Some(restart_file)) =
            (&inner.snapshot.restart_launcher, &self.restart_file)
        else {
            anyhow::bail!(
                "This copy of Sprocket cannot restart itself. Stop Sprocket and launch it again."
            );
        };
        tokio::fs::write(restart_file, launcher)
            .await
            .map_err(|error| anyhow::anyhow!("Failed to prepare the restart: {error}"))
    }

    pub async fn discard_restart(&self) {
        if let Some(restart_file) = &self.restart_file {
            let _ = tokio::fs::remove_file(restart_file).await;
        }
    }

    fn start_locked(self: &Arc<Self>, inner: &mut Inner, action: HelperAction) -> HelperResult {
        let (tx, rx) = watch::channel(None);
        inner.op = match action {
            HelperAction::Check => Op::Check {
                then_install: false,
                result: rx.clone(),
            },
            HelperAction::Install => {
                mark_installing(&mut inner.snapshot);
                Op::Install
            }
        };
        self.publish(&inner.snapshot);
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let snapshot = manager.run_helper(action).await;
            let mut inner = manager.inner.lock().await;
            let then_install = matches!(
                inner.op,
                Op::Check {
                    then_install: true,
                    ..
                }
            );
            inner.op = Op::None;
            inner.apply_result(snapshot);
            if then_install && inner.snapshot.status == UpdateStatus::Available {
                manager.start_locked(&mut inner, HelperAction::Install);
            }
            manager.publish(&inner.snapshot);
            let completed = inner.snapshot.clone();
            drop(inner);
            let _ = tx.send(Some(completed));
        });
        rx
    }

    fn publish(&self, snapshot: &PackageUpdateSnapshot) {
        self.changes.send_if_modified(|current| {
            if *current == *snapshot {
                return false;
            }
            *current = snapshot.clone();
            true
        });
    }

    async fn run_helper(&self, action: HelperAction) -> PackageUpdateSnapshot {
        let Some(command) = &self.command else {
            return PackageUpdateSnapshot::unavailable();
        };
        let previous = self.inner.lock().await.snapshot.clone();
        let limit = match action {
            HelperAction::Check => self.check_timeout,
            HelperAction::Install => self.install_timeout,
        };
        process::run_helper(command, action, limit, &previous).await
    }
}

impl Inner {
    fn apply_result(&mut self, mut snapshot: PackageUpdateSnapshot) {
        if snapshot.current_version.is_empty() && !self.snapshot.current_version.is_empty() {
            snapshot.current_version = self.snapshot.current_version.clone();
        }
        if snapshot.status == UpdateStatus::Error && snapshot.version.is_none() {
            snapshot.version = self.snapshot.version.clone();
        }
        self.checked_at = Some(Instant::now());
        self.snapshot = snapshot;
    }
}

fn cache_is_fresh(inner: &Inner, success_ttl: Duration, failure_ttl: Duration) -> bool {
    let Some(checked_at) = inner.checked_at else {
        return false;
    };
    let ttl = if inner.snapshot.status == UpdateStatus::Error {
        failure_ttl
    } else {
        success_ttl
    };
    checked_at.elapsed() < ttl
}

async fn wait_for_snapshot(wait: &mut HelperResult) -> PackageUpdateSnapshot {
    loop {
        if let Some(snapshot) = wait.borrow().clone() {
            return snapshot;
        }
        if wait.changed().await.is_err() {
            return PackageUpdateSnapshot::error(String::new(), None, "update helper task ended");
        }
    }
}

fn parse_update_command_from_env() -> Option<UpdateCommand> {
    parse_update_command(
        std::env::var("SPROCKET_UPDATE_NODE").ok().as_deref(),
        std::env::var("SPROCKET_UPDATE_SCRIPT").ok().as_deref(),
    )
}

fn parse_update_command(node: Option<&str>, script: Option<&str>) -> Option<UpdateCommand> {
    let node = node.map(str::trim).filter(|value| !value.is_empty())?;
    let script = script.map(str::trim).filter(|value| !value.is_empty())?;
    let node = PathBuf::from(node);
    let script = PathBuf::from(script);
    if !node.is_absolute() || !script.is_absolute() {
        tracing::warn!(
            "SPROCKET_UPDATE_NODE and SPROCKET_UPDATE_SCRIPT must be absolute paths; package updates disabled"
        );
        return None;
    }
    Some(UpdateCommand::new(node, script))
}

fn mark_installing(snapshot: &mut PackageUpdateSnapshot) {
    snapshot.status = UpdateStatus::Installing;
    snapshot.error = None;
    snapshot.message = None;
}

#[cfg(any(test, feature = "test-support"))]
mod test_support;
#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod process_tests;
