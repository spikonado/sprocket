use std::collections::BTreeMap;

use serde::Deserialize;
use sprocket_agent::CompletionProvider;

use crate::Host;
use crate::transcript_client::UserConvexClient;

#[derive(Deserialize)]
struct ProviderConfiguration {
    openai: bool,
}

/// The web app's `usableProviders`: enabled providers, in the user's order, that are set up.
/// CLI runs and subagents both choose from this list.
pub async fn usable_providers(
    host: &Host,
    rpc: &UserConvexClient,
    user_id: &str,
) -> anyhow::Result<Vec<CompletionProvider>> {
    let enabled: Vec<CompletionProvider> = rpc
        .query("uiPreferences:getMyEnabledProviders", BTreeMap::new())
        .await?;
    // Like the web app, a failed key lookup only rules out OpenAI.
    let openai = enabled.contains(&CompletionProvider::Openai)
        && rpc
            .act::<ProviderConfiguration>("providerCredentials:getMyConfiguration", BTreeMap::new())
            .await
            .inspect_err(|error| tracing::warn!("failed to check the OpenAI API key: {error:#}"))
            .is_ok_and(|configuration| configuration.openai);
    let chatgpt = enabled.contains(&CompletionProvider::Chatgpt)
        && host
            .chatgpt_credentials
            .for_user(user_id.to_owned())
            .connection()
            .borrow()
            .is_some();
    Ok(enabled
        .into_iter()
        .filter(|provider| match provider {
            CompletionProvider::Spikonado => true,
            CompletionProvider::Openai => openai,
            CompletionProvider::Chatgpt => chatgpt,
        })
        .collect())
}
