use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use tinker_agent::{
    CompletionProvider, ModelSettings, ResolvedSettings, SettingsOverrides, model_catalog,
    resolve_settings,
};
use tinker_host::Host;
use tinker_host::transcript_client::UserConvexClient;

const RESOLVE_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn gateway_url() -> anyhow::Result<String> {
    let url = std::env::var("PUBLIC_MODEL_GATEWAY_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .or_else(|| {
            crate::repo_env::compile_time_env_var("PUBLIC_MODEL_GATEWAY_URL").map(str::to_owned)
        })
        .filter(|url| !url.trim().is_empty())
        .context("PUBLIC_MODEL_GATEWAY_URL must be set for model discovery")?;
    Ok(url.trim().trim_end_matches('/').to_owned())
}

pub(crate) async fn convex_client(host: &Host, user_id: &str) -> anyhow::Result<UserConvexClient> {
    host.native_auth.require_user(user_id).await?;
    host.convex_client_for(user_id).await
}

pub(crate) async fn resolve(
    rpc: &UserConvexClient,
    saved: Option<&ModelSettings>,
    overrides: &SettingsOverrides,
) -> anyhow::Result<ResolvedSettings> {
    let providers = rpc
        .query::<Vec<CompletionProvider>>("uiPreferences:getMyEnabledProviders", BTreeMap::new());
    let catalog = async { model_catalog(&gateway_url()?).await };
    let (providers, catalog) = tokio::time::timeout(RESOLVE_TIMEOUT, async {
        tokio::try_join!(providers, catalog)
    })
    .await
    .context("timed out choosing run settings")??;
    resolve_settings(&catalog, &providers, saved, overrides)
}
