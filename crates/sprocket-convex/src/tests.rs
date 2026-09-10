use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use convex::base_client::BaseConvexClient;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio::time;

use crate::{AuthSignedOut, AuthTokenFetcher, Client, auth::AuthState, sdk_fetcher};

fn scripted_fetcher(
    outcomes: Vec<anyhow::Result<String>>,
) -> (AuthTokenFetcher, Arc<Mutex<Vec<bool>>>) {
    let outcomes = Arc::new(Mutex::new(VecDeque::from(outcomes)));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let fetcher: AuthTokenFetcher = {
        let calls = Arc::clone(&calls);
        Arc::new(move |force_refresh| {
            let outcomes = Arc::clone(&outcomes);
            let calls = Arc::clone(&calls);
            Box::pin(async move {
                calls.lock().await.push(force_refresh);
                outcomes.lock().await.pop_front().expect("script exhausted")
            })
        })
    };
    (fetcher, calls)
}

fn next_message(client: &mut BaseConvexClient) -> Value {
    client
        .pop_next_message()
        .expect("outgoing message")
        .try_into()
        .expect("message JSON")
}

fn assert_authenticate(client: &mut BaseConvexClient, token: &str) {
    assert_eq!(
        next_message(client),
        json!({
            "type": "Authenticate",
            "baseVersion": 0,
            "tokenType": "User",
            "value": token,
        })
    );
}

#[tokio::test(start_paused = true)]
async fn initial_token_failure_does_not_send_an_anonymous_transcript_mutation() {
    let auth = AuthState::new();
    let (fetcher, calls) = scripted_fetcher(vec![
        Err(anyhow::anyhow!("provider unavailable")),
        Ok("user-token".into()),
    ]);
    let generation = auth.install(fetcher).await;
    let mut client = BaseConvexClient::new();
    client
        .set_auth_fetcher(Some(sdk_fetcher(Arc::downgrade(&auth), generation)))
        .await;
    let _result = client.mutation(
        "transcript:ensureMigrated".parse().expect("function path"),
        BTreeMap::new(),
    );

    assert_authenticate(&mut client, "user-token");
    assert_eq!(next_message(&mut client)["type"], "Mutation");
    assert_eq!(*calls.lock().await, vec![false, false]);
    auth.shutdown();
}

#[tokio::test(start_paused = true)]
async fn reconnect_token_failures_do_not_replay_requests_without_authentication() {
    let auth = AuthState::new();
    let (fetcher, calls) = scripted_fetcher(vec![
        Ok("old-token".into()),
        Err(anyhow::anyhow!("provider unavailable")),
        Err(anyhow::anyhow!("provider still unavailable")),
        Ok("refreshed-token".into()),
    ]);
    let generation = auth.install(fetcher).await;
    let mut client = BaseConvexClient::new();
    client
        .set_auth_fetcher(Some(sdk_fetcher(Arc::downgrade(&auth), generation)))
        .await;
    client.subscribe(
        "transcript:getState".parse().expect("function path"),
        BTreeMap::new(),
    );
    let _result = client.mutation(
        "transcript:ensureMigrated".parse().expect("function path"),
        BTreeMap::new(),
    );
    while client.pop_next_message().is_some() {}

    client.resend_ongoing_queries_mutations().await;

    assert_authenticate(&mut client, "refreshed-token");
    assert_eq!(next_message(&mut client)["type"], "ModifyQuerySet");
    assert_eq!(next_message(&mut client)["type"], "Mutation");
    assert_eq!(*calls.lock().await, vec![false, true, true, true]);
    auth.shutdown();
}

#[tokio::test(start_paused = true)]
async fn terminal_sign_out_does_not_retry() {
    let auth = AuthState::new();
    let (fetcher, calls) = scripted_fetcher(vec![Err(AuthSignedOut.into())]);
    let generation = auth.install(fetcher).await;
    let callback = sdk_fetcher(Arc::downgrade(&auth), generation);

    assert_eq!(
        callback(false).await.expect("signed out"),
        convex::AuthenticationToken::None
    );
    assert_eq!(*calls.lock().await, vec![false]);
    auth.shutdown();
}

#[tokio::test(start_paused = true)]
async fn clear_cancels_a_hung_sdk_token_fetch() {
    let auth = AuthState::new();
    let generation = auth
        .install(Arc::new(|_| Box::pin(std::future::pending())))
        .await;
    let callback = sdk_fetcher(Arc::downgrade(&auth), generation);
    let pending = tokio::spawn(callback(false));
    tokio::task::yield_now().await;

    auth.clear().await;

    let error = time::timeout(Duration::from_secs(1), pending)
        .await
        .expect("clear must unblock the SDK worker")
        .expect("join")
        .expect_err("stale callback");
    assert!(!error.is::<AuthSignedOut>());
}

#[tokio::test(start_paused = true)]
async fn retries_back_off_and_cap_the_delay() {
    let auth = AuthState::new();
    let mut outcomes: Vec<_> = (0..7)
        .map(|_| Err(anyhow::anyhow!("provider unavailable")))
        .collect();
    outcomes.push(Ok("user-token".into()));
    let (fetcher, calls) = scripted_fetcher(outcomes);
    let generation = auth.install(fetcher).await;
    let callback = sdk_fetcher(Arc::downgrade(&auth), generation);
    let start = time::Instant::now();

    assert_eq!(
        callback(true).await.expect("recovered"),
        convex::AuthenticationToken::User("user-token".into())
    );
    assert_eq!(
        start.elapsed(),
        Duration::from_secs(1 + 2 + 4 + 8 + 16 + 30 + 30)
    );
    assert_eq!(*calls.lock().await, vec![true; 8]);
    auth.shutdown();
}

#[tokio::test(start_paused = true)]
async fn replacement_cancels_retry_backoff_without_using_the_new_fetcher() {
    let auth = AuthState::new();
    let (fetcher, calls) = scripted_fetcher(vec![Err(anyhow::anyhow!("provider unavailable"))]);
    let generation = auth.install(fetcher).await;
    let callback = sdk_fetcher(Arc::downgrade(&auth), generation);
    let pending = tokio::spawn(callback(false));
    tokio::task::yield_now().await;
    assert_eq!(*calls.lock().await, vec![false]);
    assert!(!pending.is_finished());

    let (replacement, replacement_calls) = scripted_fetcher(vec![Ok("new-user-token".into())]);
    let new_generation = auth.install(replacement).await;
    let error = time::timeout(Duration::from_millis(100), pending)
        .await
        .expect("replacement must not wait for retry backoff")
        .expect("join")
        .expect_err("stale callback");
    assert!(!error.is::<AuthSignedOut>());
    assert!(replacement_calls.lock().await.is_empty());

    let callback = sdk_fetcher(Arc::downgrade(&auth), new_generation);
    assert_eq!(
        callback(false).await.expect("replacement token"),
        convex::AuthenticationToken::User("new-user-token".into())
    );
    auth.shutdown();
}

#[tokio::test(start_paused = true)]
async fn last_client_drop_cancels_a_hung_sdk_token_fetch() {
    let client = Client::new("http://127.0.0.1:1").await.expect("client");
    let clone = client.clone();
    let auth = Arc::downgrade(&client.inner.auth);
    let generation = client
        .inner
        .auth
        .install(Arc::new(|_| Box::pin(std::future::pending())))
        .await;
    let callback = sdk_fetcher(auth.clone(), generation);
    let pending = tokio::spawn(callback(false));
    tokio::task::yield_now().await;
    drop(client);
    assert!(!pending.is_finished());

    drop(clone);

    time::timeout(Duration::from_secs(1), pending)
        .await
        .expect("client drop must unblock the SDK worker")
        .expect("join")
        .expect_err("client dropped");
    assert!(auth.upgrade().is_none());
}

#[tokio::test(start_paused = true)]
async fn persistent_auth_failure_closes_the_connection_and_fails_all_pending_operations() {
    let client = Client::new("http://127.0.0.1:1").await.expect("client");
    client
        .set_auth_token_fetcher(Arc::new(|_| {
            Box::pin(async { anyhow::bail!("credential store unavailable") })
        }))
        .await
        .expect("install fetcher");
    let start = time::Instant::now();

    let (query, mutation, action, subscription) = tokio::join!(
        client.query("transcript:getState", BTreeMap::new()),
        client.mutation("transcript:ensureMigrated", BTreeMap::new()),
        client.action("example:action", BTreeMap::new()),
        client.subscribe("transcript:getState", BTreeMap::new()),
    );

    for error in [
        query.expect_err("query must fail locally"),
        mutation.expect_err("mutation must fail locally"),
        action.expect_err("action must fail locally"),
        subscription.expect_err("subscription must fail locally"),
    ] {
        assert!(error.to_string().contains("credential store unavailable"));
        assert!(error.to_string().contains("120 seconds"));
    }
    assert_eq!(start.elapsed(), Duration::from_secs(120));
    assert!(client.inner.convex.lock().await.is_none());
    let start = time::Instant::now();
    client
        .query("transcript:getState", BTreeMap::new())
        .await
        .expect_err("closed connection must reject new work");
    assert_eq!(start.elapsed(), Duration::ZERO);
    client.clear_auth().await;
    assert!(client.inner.convex.lock().await.is_none());
    client
        .set_auth_token_fetcher(Arc::new(|_| Box::pin(async { Ok("new-token".into()) })))
        .await
        .expect_err("recovery requires a new connection");
}

#[tokio::test(start_paused = true)]
async fn auth_deadline_never_releases_the_sdk_to_send_anonymous_requests() {
    let client = Client::new("http://127.0.0.1:1").await.expect("client");
    let generation = client
        .inner
        .auth
        .install(Arc::new(|_| Box::pin(std::future::pending())))
        .await;
    let mut sdk = BaseConvexClient::new();
    let error = {
        let mut authenticate = Box::pin(sdk.set_auth_fetcher(Some(sdk_fetcher(
            Arc::downgrade(&client.inner.auth),
            generation,
        ))));
        let error = time::timeout(Duration::from_secs(121), async {
            tokio::select! {
                error = client.inner.auth.wait_for_failure() => error,
                _ = &mut authenticate => panic!("failed auth resumed the SDK worker"),
            }
        })
        .await
        .expect("auth failure deadline");
        client.clear_auth().await;
        assert!(
            time::timeout(Duration::from_secs(1), authenticate)
                .await
                .is_err(),
            "clearing failed auth must not release queued requests"
        );
        error
    };
    assert!(sdk.pop_next_message().is_none());
    assert!(client.inner.convex.lock().await.is_none());
    assert!(error.contains("token fetch did not complete"));
}

#[tokio::test(start_paused = true)]
async fn scheduled_auth_failure_closes_the_idle_connection() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let client = Client::new("http://127.0.0.1:1").await.expect("client");
    let calls = Arc::new(AtomicUsize::new(0));
    let fetcher: AuthTokenFetcher = {
        let calls = Arc::clone(&calls);
        Arc::new(move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { anyhow::bail!("provider misconfigured") })
        })
    };
    let generation = client.inner.auth.install(fetcher).await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("unix time")
        .as_secs();
    use base64::Engine as _;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(json!({ "iat": now, "exp": now + 11 }).to_string());
    client
        .inner
        .auth
        .arm(generation, &format!("header.{payload}.sig"))
        .await;
    let error = client.inner.auth.wait_for_failure().await;

    assert!(error.contains("provider misconfigured"));
    assert!(client.inner.convex.lock().await.is_none());
    let attempts = calls.load(Ordering::SeqCst);
    time::advance(Duration::from_secs(300)).await;
    assert_eq!(calls.load(Ordering::SeqCst), attempts);
}

#[tokio::test(start_paused = true)]
async fn stale_auth_failure_cannot_close_a_replacement_session() {
    let client = Client::new("http://127.0.0.1:1").await.expect("client");
    let fetcher: AuthTokenFetcher = Arc::new(|_| Box::pin(async { Ok("user-token".into()) }));
    let previous = client.inner.auth.install(Arc::clone(&fetcher)).await;
    client.inner.auth.install(fetcher).await;

    crate::close_failed_connection(
        Arc::downgrade(&client.inner),
        previous,
        "old failure".into(),
    )
    .await;

    assert!(client.inner.convex.lock().await.is_some());
    client
        .with_auth_failure(async { Ok(()) })
        .await
        .expect("current session is healthy");
}
