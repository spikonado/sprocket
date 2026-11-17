use super::*;

#[tokio::test]
async fn sign_out_drops_every_cached_client() {
    let native_auth = NativeAuthManager::configured_for_test(
        crate::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".into(),
        },
        "http://127.0.0.1/callback".into(),
    );
    let convex = ConvexClients::new("http://127.0.0.1:1".into(), Arc::clone(&native_auth));
    for user in ["alice", "bob"] {
        convex.client_for(user).await.unwrap();
    }
    assert_eq!(convex.cache.lock().await.clients.len(), 2);

    native_auth.sign_out().await.unwrap();
    convex.client_for("alice").await.unwrap();

    let cache = convex.cache.lock().await;
    assert_eq!(cache.clients.len(), 1);
    assert!(cache.clients.contains_key("alice"));
}
