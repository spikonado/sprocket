use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use sprocket_workspace::{REMOTE_ATTACHMENT_KEY_PREFIX, pull_fast_forward};
use tokio::task::JoinHandle;

use crate::Host;
use crate::project_attachments::WorkspaceAvailability;

const PULL_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    #[serde(default)]
    auto_pull_checkouts: bool,
}

pub(crate) fn spawn(host: Host) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(PULL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = pull_checkouts(&host).await {
                tracing::warn!("couldn't pull project checkouts: {error:#}");
            }
        }
    })
}

async fn pull_checkouts(host: &Host) -> anyhow::Result<()> {
    if !enabled(host).await? {
        return Ok(());
    }
    for project in host.project_attachments.list().await? {
        if project.availability != WorkspaceAvailability::Available
            || !project
                .attachment_key
                .starts_with(REMOTE_ATTACHMENT_KEY_PREFIX)
        {
            continue;
        }
        let checkout = Path::new(&project.workspace_path);
        if let Err(error) = pull_fast_forward(checkout, host.tool_environment()).await {
            tracing::warn!("couldn't pull {}: {error:#}", checkout.display());
        }
    }
    Ok(())
}

async fn enabled(host: &Host) -> anyhow::Result<bool> {
    let Some(session) = host.native_auth.browser_session(false).await? else {
        return Ok(false);
    };
    let preferences: Option<Preferences> = host
        .convex_client_for(&session.user.id)
        .await?
        .query("uiPreferences:getMine", BTreeMap::new())
        .await?;
    Ok(preferences.is_some_and(|preferences| preferences.auto_pull_checkouts))
}
