use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use jsonwebtoken::{EncodingKey, Header, encode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

impl ChatGptService {
    fn test_load(data_dir: &Path, issuer: &str) -> Arc<Self> {
        Self::load_with_issuer(data_dir, issuer).unwrap()
    }
}

const GRANTED: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const RSA_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCrZ9ZLr29AUzPN\nLs0LovbC5x+v4WOaQX9Eo4Bc709L0ShbuJx5ji/Da20c95Q1fvSMtsH7TGcKP+39\noYbghsbmZoCLp58DyyRbXlEU5/lfPefy0vuqZtIY3Ofe/89Ofe0TfxxWdRGyYn2y\n6rwWysR1jsigVFHoW7E0UKcXq24ZocAd0vWQfxABH1ydUfAMzk71PH3lMFsTbusy\nRSkrXdyHkcvPHpwEXJlsSQTr6E7RCLbtwXVuIsF6kD+NXlIjx50rCZX/gcpltAht\nRWsxrq3iKoUnnxWfCm4/Oh/20SgHoShbNEmNRcE2QIeDLdWC75tzq8IZE8p4/Yts\nUfHIC8htAgMBAAECggEAA7G6vCndT3kbmjYChFgwUlYR6EQG1gnIWO3fM+GSh3NM\nF+H8OWB3phIYKXIqlxaT5b6Aos5sQBvNoNRM6GTvP4MBDUGBG19S+scnHzi6trNK\nXwDuHKeXqqKEOtmvmaT8KZnpPfHK/lnCFMubXzBimJgJue7nTwc+4/5DA68Vseay\nCVsMLsamqTduCYPtUIDp0Qp95/qR9MQuzSluOVACgVOOBCahDP8QiSUvOI4tP/Mk\njhxv7a6FREbDPQUVZFgLxVRFwKWCz8POX8wKAr8qht85BmbhNri8ga/hdirjmEod\nowzv1wnva0agPo7EHFdvS8UYtd9DDU2B0yqzlqF1XwKBgQDXUi8qxwEeOh3z7hSu\n6wCo/bIzbmAxO43yFU4+KTZnE9dV9GRSfyeQFdSiPRLwqVzI660tArbpADu0q6fv\n/b7TYp1+mWFjtBwL0yKqqAQKveKzpHe6BwwrQjFPptT8q5c54eXDuOHIHDcRCH/w\nipz99LSIQKe/dZhmMxgnSI39PwKBgQDLybi34Sx9LJLOpDCwbOK0YjvqJBT0lrK+\nsRXXBy+8+wMqa/bgBDwZVt4po8vjV7gplvfpbclfzzxA+cJFQQzYZS+iJurDE1nL\n67V/9wMfdviLiBCAL4Sb5mZljdCIqku8Dy2On8gGSzw0vy+KVL8P0hVQr+uO8YhI\nWjTZ7wkTUwKBgDzOzNs70CkFKKhWuCid3VXcL5MuvKOque9/7NTJNr/tboaruhlC\nJ54dTCt1LAAjFDz5sbJgbd9nXXUsdQTlmBqCYw/5qPNLThBY1BV11Y5jCb7J17YF\nf35H9z0TVFr26oJCNW0MrVaiATsiN19rBeMCVGmWOMltIFjcXRna955pAoGAC6H3\nLl/nJzoNI0iSEvAUPNHCs8ndfFzB1UrMgVrCqdn2Q0yoaf8z4wpnYh8ce1y9gXpB\nqox+yz5MJTVclpFxB0U3Y90u13XaUV6iHKzf+8LRyz04G+kae7+6Jp/iwHpgGlsP\nca3DQEC5LhWfxBi0U1Xdq55vJti4u9CSZcJUVUsCgYBWOm2Ws0VruHWj4WGqylfV\nuURcTGoADEkkAohtILu9zzqh21Il0irSQVRLvxY36h4rR4w+RH9VjQi0Vg0lmmAT\nKKzQgjnyGdgHclULok7DUtZwjZ7TYOqFWp2O2al7As/uivowpvTlV2AAR7zNVcRV\n12gHMJ6qoYyS2u/dU5hR7Q==\n-----END PRIVATE KEY-----\n";

struct Shared {
    requests: Vec<String>,
    token: (u16, String),
    revoke_status: u16,
    hold_token: bool,
    hold_revoke: bool,
}

#[derive(Clone)]
struct TestProvider {
    issuer: String,
    jwks: String,
    shared: Arc<StdMutex<Shared>>,
    arrivals: Arc<AtomicUsize>,
}

impl TestProvider {
    fn requests(&self) -> Vec<String> {
        self.shared.lock().unwrap().requests.clone()
    }

    fn posts(&self, path: &str) -> Vec<String> {
        self.requests()
            .into_iter()
            .filter(|request| request.starts_with(&format!("POST {path}")))
            .collect()
    }

    fn set_token(&self, status: u16, body: String) {
        self.shared.lock().unwrap().token = (status, body);
    }

    fn set_revoke_status(&self, status: u16) {
        self.shared.lock().unwrap().revoke_status = status;
    }

    fn hold_token(&self, hold: bool) {
        self.shared.lock().unwrap().hold_token = hold;
    }

    async fn await_token_requests(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.arrivals.load(Ordering::SeqCst) < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

fn signing_key() -> EncodingKey {
    let der = pem_der(RSA_KEY);
    // This fixture has a 26-byte PKCS8 wrapper around the PKCS1 key.
    EncodingKey::from_rsa_der(&der[26..])
}

fn pem_der(pem: &str) -> Vec<u8> {
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .unwrap()
}

fn id_token(
    issuer: &str,
    client_id: &str,
    subject: &str,
    nonce: Option<&str>,
    expires_at: u64,
) -> String {
    #[derive(Serialize)]
    struct Claims<'a> {
        iss: &'a str,
        aud: &'a str,
        sub: &'a str,
        exp: u64,
        email: Option<&'a str>,
        nonce: Option<&'a str>,
    }
    let header = Header {
        alg: Algorithm::RS256,
        kid: Some("test-key".into()),
        ..Default::default()
    };
    encode(
        &header,
        &Claims {
            iss: issuer,
            aud: client_id,
            sub: subject,
            exp: expires_at,
            email: Some("agent@example.com"),
            nonce,
        },
        &signing_key(),
    )
    .unwrap()
}

fn test_jwk() -> Jwk {
    let mut jwk = Jwk::from_encoding_key(&signing_key(), Algorithm::RS256).unwrap();
    jwk.common.key_id = Some("test-key".into());
    jwk
}

async fn serve(listener: tokio::net::TcpListener, provider: TestProvider) {
    loop {
        let (mut stream, _) = listener.accept().await.unwrap();
        let provider = provider.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0; 16384];
            let mut request = Vec::new();
            let header_end = loop {
                let read = stream.read(&mut buffer).await.unwrap();
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..read]);
                if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
            let line = headers.lines().next().unwrap().to_owned();
            let path = line.split(' ').nth(1).unwrap().to_owned();
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + length {
                let read = stream.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let body = String::from_utf8_lossy(&request[header_end..]).into_owned();
            let (status, response_body) = {
                let mut shared = provider.shared.lock().unwrap();
                shared.requests.push(format!("{line}\n{body}"));
                match path.as_str() {
                    "/.well-known/openid-configuration" => (
                        200,
                        format!(
                            r#"{{"issuer":"{0}","revocation_endpoint":"{0}/revoke"}}"#,
                            provider.issuer
                        ),
                    ),
                    "/.well-known/jwks.json" => (200, provider.jwks.clone()),
                    "/api/accounts/oauth/token" => shared.token.clone(),
                    "/revoke" => (shared.revoke_status, String::new()),
                    _ => panic!("unexpected provider request path {path}"),
                }
            };
            if path == "/api/accounts/oauth/token" {
                provider.arrivals.fetch_add(1, Ordering::SeqCst);
                while provider.shared.lock().unwrap().hold_token {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
            if path == "/revoke" {
                while provider.shared.lock().unwrap().hold_revoke {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
            let reason = match status {
                200 => "OK",
                400 => "Bad Request",
                429 => "Too Many Requests",
                500 => "Internal Server Error",
                _ => "Error",
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
    }
}

struct Fixture {
    service: Arc<ChatGptService>,
    provider: TestProvider,
    directory: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let provider = TestProvider {
        issuer: issuer.clone(),
        jwks: serde_json::to_string(&jsonwebtoken::jwk::JwkSet {
            keys: vec![test_jwk()],
        })
        .unwrap(),
        shared: Arc::new(StdMutex::new(Shared {
            requests: Vec::new(),
            token: (500, String::new()),
            revoke_status: 200,
            hold_token: false,
            hold_revoke: false,
        })),
        arrivals: Arc::new(AtomicUsize::new(0)),
    };
    tokio::spawn(serve(listener, provider.clone()));
    let service = ChatGptService::test_load(directory.path(), &issuer);
    Fixture {
        service,
        provider,
        directory,
    }
}

fn tokens(
    _fixture: &Fixture,
    client_id: &str,
    subject: &str,
    access: &str,
    refresh: &str,
    expires_at: u64,
) -> Tokens {
    Tokens {
        access_token: access.into(),
        refresh_token: refresh.into(),
        id_token: id_token(ISSUER, client_id, subject, None, expires_at + 3600),
        scopes: scopes(GRANTED),
        expires_at,
        earliest_refresh_at: 0,
        refresh_in_flight: false,
    }
}

fn account(connection: &str, client_id: &str, subject: &str, tokens: Option<Tokens>) -> Account {
    Account {
        connection_id: connection.into(),
        client_id: client_id.into(),
        subject: subject.into(),
        email: Some("agent@example.com".into()),
        session_id: Uuid::new_v4().to_string(),
        tokens,
        retired_refresh_tokens: Vec::new(),
    }
}

async fn insert(service: &ChatGptService, user: &str, account: Account) {
    let mut state = service.state.lock().await;
    let accounts = state.users.entry(user.to_owned()).or_default();
    if accounts.active.is_none() {
        accounts.active = Some(account.connection_id.clone());
    }
    accounts.accounts.push(account);
    let accounts = state.users.get(user).unwrap().clone();
    service.notify(user, &accounts);
    service.persist(&state).await.unwrap();
}

fn token_response(
    access: &str,
    refresh: &str,
    id_token: Option<String>,
    scope: Option<&str>,
    expires_in: u64,
) -> String {
    serde_json::json!({
        "access_token": access,
        "refresh_token": refresh,
        "id_token": id_token,
        "token_type": "Bearer",
        "expires_in": expires_in,
        "scope": scope,
    })
    .to_string()
}

async fn stored_account(service: &ChatGptService, user: &str, connection: &str) -> Account {
    let state = service.state.lock().await;
    state.users[user]
        .accounts
        .iter()
        .find(|account| account.connection_id == connection)
        .unwrap()
        .clone()
}

#[test]
fn issued_client_resolves_dynamic_and_returning_registrations() {
    assert_eq!(issued_client(None, Some("client-1")).unwrap(), "client-1");
    assert_eq!(issued_client(Some("client-1"), None).unwrap(), "client-1");
    assert_eq!(
        issued_client(Some("client-1"), Some("client-1")).unwrap(),
        "client-1"
    );
    assert!(issued_client(Some("client-1"), Some("client-2")).is_err());
    assert!(issued_client(None, None).is_err());
    assert!(issued_client(None, Some(DYNAMIC_CLIENT)).is_err());
    assert!(issued_client(None, Some("")).is_err());
}

#[test]
fn token_tuple_requires_scopes_and_inherits_them_on_refresh() {
    let response = || TokenResponse {
        access_token: "access".into(),
        refresh_token: "refresh".into(),
        id_token: Some("id".into()),
        token_type: "Bearer".into(),
        expires_in: 3600,
        scope: Some(GRANTED.into()),
        earliest_refresh_at: None,
    };
    let issued = token_tuple(response(), None, 1000).unwrap();
    assert_eq!(issued.expires_at, 4600);
    assert_eq!(issued.scopes, scopes(GRANTED));

    let mut refreshed = response();
    refreshed.scope = None;
    refreshed.id_token = None;
    let refreshed = token_tuple(refreshed, Some(&issued), 2000).unwrap();
    assert_eq!(refreshed.scopes, issued.scopes);
    assert_eq!(refreshed.id_token, issued.id_token);

    let mut missing = response();
    missing.scope = None;
    assert!(token_tuple(missing, None, 1000).is_err());

    let mut narrowed = response();
    narrowed.scope = Some("openid profile email".into());
    let error = token_tuple(narrowed, Some(&issued), 2000)
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("plan usage was not authorized"), "{error}");

    let mut bad_type = response();
    bad_type.token_type = "MAC".into();
    assert!(token_tuple(bad_type, None, 1000).is_err());

    let mut expired = response();
    expired.expires_in = 0;
    assert!(token_tuple(expired, None, 1000).is_err());
}

#[test]
fn identity_verification_enforces_signature_issuer_audience_and_nonce() {
    let keys = &[test_jwk()];
    let expiry = now() + 3600;

    let token = id_token(ISSUER, "client-1", "subject-1", Some("nonce-1"), expiry);
    let identity = verify_identity(&token, keys, "client-1", Some("nonce-1")).unwrap();
    assert_eq!(identity.sub, "subject-1");
    assert_eq!(identity.email.as_deref(), Some("agent@example.com"));
    verify_identity(&token, keys, "client-1", None).unwrap();

    assert!(verify_identity(&token, keys, "client-1", Some("nonce-2")).is_err());
    assert!(verify_identity(&token, keys, "client-2", None).is_err());
    let wrong_issuer = id_token("https://example.com", "client-1", "subject-1", None, expiry);
    assert!(verify_identity(&wrong_issuer, keys, "client-1", None).is_err());
    let expired = id_token(ISSUER, "client-1", "subject-1", None, now() - 10);
    assert!(verify_identity(&expired, keys, "client-1", None).is_err());
    let mut unknown_key = test_jwk();
    unknown_key.common.key_id = Some("other-key".into());
    assert!(verify_identity(&token, &[unknown_key], "client-1", None).is_err());
    assert!(verify_identity(&token, &[], "client-1", None).is_err());
}

#[tokio::test]
async fn load_recovers_refresh_cancellation_markers_and_protects_storage() {
    let directory = tempfile::tempdir().unwrap();
    let service = ChatGptService::load(directory.path()).unwrap();
    let stale = account(
        "connection-1",
        "client-1",
        "subject-1",
        Some(Tokens {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            id_token: "id".into(),
            scopes: scopes(GRANTED),
            expires_at: now() - 10,
            earliest_refresh_at: 0,
            refresh_in_flight: true,
        }),
    );
    let mut healthy = account(
        "connection-2",
        "client-1",
        "subject-1",
        Some(Tokens {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            id_token: "id".into(),
            scopes: scopes(GRANTED),
            expires_at: now() + 3600,
            earliest_refresh_at: 0,
            refresh_in_flight: false,
        }),
    );
    healthy.session_id = "healthy-session".into();
    insert(&service, "user-a", stale).await;
    insert(&service, "user-a", healthy).await;

    let reloaded = ChatGptService::load(directory.path()).unwrap();
    let state = reloaded.state.lock().await;
    let accounts = &state.users["user-a"];
    assert_eq!(accounts.accounts.len(), 2);
    assert_eq!(accounts.active, None);
    let recovered = &accounts.accounts[0];
    assert!(recovered.tokens.is_none());
    assert_eq!(recovered.retired_refresh_tokens, vec!["refresh"]);
    let healthy = &accounts.accounts[1];
    assert_eq!(healthy.connection_id, "connection-2");
    assert!(healthy.tokens.is_some());
    assert_eq!(healthy.session_id, "healthy-session");
    drop(state);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(directory.path().join("chatgpt-siwc.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "credential store must be owner-only");
    }

    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("chatgpt-siwc.json"),
        br#"{"version":2,"hostId":"urn:uuid:25e57611-c2cb-4934-8142-fde1a3644a46","users":{}}"#,
    )
    .unwrap();
    assert!(ChatGptService::load(directory.path()).is_err());
    std::fs::write(
        directory.path().join("chatgpt-siwc.json"),
        br#"{"version":1,"hostId":"host","users":{}}"#,
    )
    .unwrap();
    assert!(ChatGptService::load(directory.path()).is_err());
}

#[tokio::test]
async fn exchange_and_commit_round_trip_persists_and_notifies() {
    let fixture = fixture().await;
    let nonce = Uuid::new_v4().to_string();
    let user_credentials = fixture.service.for_user("user-a".into());
    let mut watch = user_credentials.connection();
    assert_eq!(*watch.borrow(), None);

    let code_id_token = id_token(ISSUER, "client-1", "subject-1", Some(&nonce), now() + 3600);
    fixture.provider.set_token(
        200,
        token_response(
            "access-1",
            "refresh-1",
            Some(code_id_token),
            Some(GRANTED),
            3600,
        ),
    );
    let grant = fixture
        .service
        .exchange(
            "user-a",
            None,
            "http://127.0.0.1:1/auth/callback",
            &nonce,
            "verifier",
            "code-1",
            Some("client-1"),
        )
        .await
        .unwrap();
    fixture.service.commit("user-a", grant).await.unwrap();

    watch.changed().await.unwrap();
    let session_id = watch.borrow().clone().unwrap();
    assert!(!session_id.is_empty());
    let account = fixture.service.state.lock().await.users["user-a"].accounts[0].clone();
    assert_eq!(account.session_id, session_id);
    assert_eq!(account.client_id, "client-1");
    assert_eq!(account.subject, "subject-1");
    assert_eq!(account.tokens.as_ref().unwrap().refresh_token, "refresh-1");

    let exchanges = fixture.provider.posts("/api/accounts/oauth/token");
    assert_eq!(exchanges.len(), 1);
    assert!(exchanges[0].contains("grant_type=authorization_code"));
    assert!(exchanges[0].contains("code_verifier=verifier"));
    assert!(exchanges[0].contains("client_id=client-1"));

    let reloaded = ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
    assert_eq!(
        reloaded.state.lock().await.users["user-a"].accounts[0].subject,
        "subject-1"
    );
}

#[tokio::test]
async fn commit_rejects_another_sprocket_account_and_revokes_the_grant() {
    let fixture = fixture().await;
    let grant = PendingGrant {
        user: "user-a".into(),
        expected_connection: None,
        expected_session: None,
        client_id: "client-1".into(),
        subject: "subject-1".into(),
        email: None,
        tokens: tokens(
            &fixture,
            "client-1",
            "subject-1",
            "access",
            "refresh-1",
            now() + 3600,
        ),
    };
    let error = fixture
        .service
        .commit("user-b", grant)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("another Sprocket account"), "{error}");
    assert!(fixture.service.state.lock().await.users.is_empty());
    let revocations = fixture.provider.posts("/revoke");
    assert_eq!(
        revocations.len(),
        1,
        "mismatched commit must revoke the grant"
    );
    assert!(revocations[0].contains("token=refresh-1"));
}

#[tokio::test]
async fn access_returns_fresh_token_without_persisting_and_converts_units() {
    let fixture = fixture().await;
    let mut account = account(
        "connection-1",
        "client-1",
        "subject-1",
        Some(tokens(
            &fixture,
            "client-1",
            "subject-1",
            "access-1",
            "refresh-1",
            now() + 3600,
        )),
    );
    account.session_id = "session-1".into();
    insert(&fixture.service, "user-a", account).await;
    let before = std::fs::read(fixture.directory.path().join("chatgpt-siwc.json")).unwrap();

    let credentials = fixture.service.for_user("user-a".into());
    let access = credentials.credential().await.unwrap();
    assert_eq!(access.access_token, "access-1");
    assert_eq!(access.connection_id, "session-1");
    assert_eq!(access.expires_at % 1000, 0, "trait expiry is milliseconds");
    assert!(access.expires_at > crate::now_ms());
    assert_eq!(
        std::fs::read(fixture.directory.path().join("chatgpt-siwc.json")).unwrap(),
        before
    );
    assert!(
        fixture
            .provider
            .posts("/api/accounts/oauth/token")
            .is_empty()
    );
}

#[tokio::test]
async fn access_refreshes_expired_tokens_and_persists_the_new_tuple() {
    let fixture = fixture().await;
    let mut account = account(
        "connection-1",
        "client-1",
        "subject-1",
        Some(tokens(
            &fixture,
            "client-1",
            "subject-1",
            "access-old",
            "refresh-old",
            now() - 10,
        )),
    );
    account.session_id = "session-1".into();
    insert(&fixture.service, "user-a", account).await;

    let refreshed_id = id_token(ISSUER, "client-1", "subject-1", None, now() + 7200);
    fixture.provider.set_token(
        200,
        token_response("access-new", "refresh-new", Some(refreshed_id), None, 3600),
    );
    let access = fixture
        .service
        .for_user("user-a".into())
        .credential()
        .await
        .unwrap();
    assert_eq!(access.access_token, "access-new");
    assert_eq!(access.connection_id, "session-1");

    let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
    let stored_tokens = stored.tokens.unwrap();
    assert_eq!(stored_tokens.refresh_token, "refresh-new");
    assert!(!stored_tokens.refresh_in_flight);
    assert!(stored_tokens.expires_at > now());
    let reloaded = ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
    assert_eq!(
        reloaded.state.lock().await.users["user-a"].accounts[0]
            .tokens
            .as_ref()
            .unwrap()
            .access_token,
        "access-new"
    );

    let refreshes = fixture.provider.posts("/api/accounts/oauth/token");
    assert_eq!(refreshes.len(), 1);
    assert!(refreshes[0].contains("grant_type=refresh_token"));
    assert!(refreshes[0].contains("refresh_token=refresh-old"));
}

#[tokio::test]
async fn refresh_server_error_keeps_the_old_tuple_for_retry() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        ),
    )
    .await;
    fixture.provider.set_token(500, String::new());
    let error = fixture
        .service
        .for_user("user-a".into())
        .credential()
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("temporarily unavailable"), "{error}");
    let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
    let tokens = stored.tokens.unwrap();
    assert_eq!(tokens.access_token, "access-old");
    assert!(!tokens.refresh_in_flight);
}

#[tokio::test]
async fn refresh_terminal_error_disconnects_and_rotates_the_session() {
    let fixture = fixture().await;
    let user_credentials = fixture.service.for_user("user-a".into());
    let mut watch = user_credentials.connection();
    let original = account(
        "connection-1",
        "client-1",
        "subject-1",
        Some(tokens(
            &fixture,
            "client-1",
            "subject-1",
            "access-old",
            "refresh-old",
            now() - 10,
        )),
    );
    let original_session = original.session_id.clone();
    insert(&fixture.service, "user-a", original).await;
    watch.borrow_and_update();
    fixture.provider.set_token(
        400,
        serde_json::json!({"error": "invalid_grant"}).to_string(),
    );

    let error = user_credentials
        .credential()
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("Reconnect"), "{error}");
    let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
    assert!(stored.tokens.is_none());
    assert_ne!(stored.session_id, original_session);
    assert_eq!(*watch.borrow_and_update(), None);
}

#[tokio::test]
async fn refresh_rejects_a_different_returned_identity() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        ),
    )
    .await;
    let other_id = id_token(ISSUER, "client-1", "subject-2", None, now() + 3600);
    fixture.provider.set_token(
        200,
        token_response(
            "access-new",
            "refresh-new",
            Some(other_id),
            Some(GRANTED),
            3600,
        ),
    );
    let error = fixture
        .service
        .for_user("user-a".into())
        .credential()
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("another identity"), "{error}");
    let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
    assert!(
        stored.tokens.is_none(),
        "identity mismatch must not retain the old grant"
    );
}

#[tokio::test]
async fn exchange_rejects_a_different_subject_for_a_returning_account() {
    let fixture = fixture().await;
    let nonce = Uuid::new_v4().to_string();
    insert(
        &fixture.service,
        "user-a",
        account("connection-1", "client-1", "subject-1", None),
    )
    .await;
    let other_id = id_token(ISSUER, "client-1", "subject-2", Some(&nonce), now() + 3600);
    fixture.provider.set_token(
        200,
        token_response("access-1", "refresh-1", Some(other_id), Some(GRANTED), 3600),
    );
    let error = fixture
        .service
        .exchange(
            "user-a",
            Some("connection-1"),
            "http://127.0.0.1:1/auth/callback",
            &nonce,
            "verifier",
            "code-1",
            Some("client-1"),
        )
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("different account"), "{error}");
    assert!(
        !fixture.provider.posts("/revoke").is_empty(),
        "failed exchange must revoke the issued grant"
    );
}

#[tokio::test]
async fn sprocket_accounts_have_separate_state_and_watch_sessions() {
    let fixture = fixture().await;
    let credentials_a = fixture.service.for_user("user-a".into());
    let credentials_b = fixture.service.for_user("user-b".into());
    let watch_a = credentials_a.connection();
    let watch_b = credentials_b.connection();
    assert_eq!(*watch_a.borrow(), None);
    assert_eq!(*watch_b.borrow(), None);

    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-a",
                "refresh-a",
                now() + 3600,
            )),
        ),
    )
    .await;
    insert(
        &fixture.service,
        "user-b",
        account(
            "connection-2",
            "client-1",
            "subject-2",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-2",
                "access-b",
                "refresh-b",
                now() + 3600,
            )),
        ),
    )
    .await;

    let session_a = watch_a.borrow().clone().unwrap();
    let session_b = watch_b.borrow().clone().unwrap();
    assert_ne!(session_a, session_b);
    assert_eq!(
        credentials_a.credential().await.unwrap().connection_id,
        session_a
    );
    assert_eq!(
        credentials_b.credential().await.unwrap().connection_id,
        session_b
    );

    fixture
        .service
        .disconnect("user-a", "connection-1")
        .await
        .unwrap();
    assert_eq!(*watch_a.borrow(), None);
    assert_eq!(watch_b.borrow().as_deref(), Some(session_b.as_str()));
    let error = credentials_a.credential().await.err().unwrap().to_string();
    assert!(error.contains("Connect ChatGPT locally"), "{error}");
    assert_eq!(
        credentials_b.credential().await.unwrap().access_token,
        "access-b"
    );
}

#[tokio::test]
async fn select_rotates_the_watch_session_and_persists_it() {
    let fixture = fixture().await;
    let mut first = account(
        "connection-1",
        "client-1",
        "subject-1",
        Some(tokens(
            &fixture,
            "client-1",
            "subject-1",
            "access-1",
            "refresh-1",
            now() + 3600,
        )),
    );
    first.session_id = "first-session".into();
    let mut second = account(
        "connection-2",
        "client-1",
        "subject-2",
        Some(tokens(
            &fixture,
            "client-1",
            "subject-2",
            "access-2",
            "refresh-2",
            now() + 3600,
        )),
    );
    second.session_id = "second-session".into();
    insert(&fixture.service, "user-a", first).await;
    insert(&fixture.service, "user-a", second).await;
    let credentials = fixture.service.for_user("user-a".into());
    let mut watch = credentials.connection();
    assert_eq!(watch.borrow_and_update().as_deref(), Some("first-session"));

    fixture
        .service
        .select("user-a", "connection-2")
        .await
        .unwrap();
    watch.changed().await.unwrap();
    let session_id = watch.borrow().clone().unwrap();
    assert_ne!(
        session_id, "second-session",
        "selection rotates the session id"
    );
    assert_ne!(session_id, "first-session");
    assert_eq!(
        credentials.credential().await.unwrap().connection_id,
        session_id
    );

    let reloaded = ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
    let state = reloaded.state.lock().await;
    assert_eq!(
        state.users["user-a"].active.as_deref(),
        Some("connection-2")
    );
    assert_eq!(
        session(&state.users["user-a"]).as_deref(),
        Some(session_id.as_str())
    );
}

#[tokio::test]
async fn load_forgets_legacy_signed_out_accounts_and_preserves_other_users() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account("signed-out", "client-old", "subject-old", None),
    )
    .await;
    insert(
        &fixture.service,
        "user-b",
        account(
            "connected",
            "client-current",
            "subject-current",
            Some(tokens(
                &fixture,
                "client-current",
                "subject-current",
                "access-current",
                "refresh-current",
                now() + 3600,
            )),
        ),
    )
    .await;
    let before = fixture.service.state.lock().await.clone();
    let reloaded = ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
    let state = reloaded.state.lock().await;
    assert_eq!(state.host_id, before.host_id);
    assert_eq!(state.users.len(), 1);
    assert_eq!(
        serde_json::to_value(&state.users["user-b"]).unwrap(),
        serde_json::to_value(&before.users["user-b"]).unwrap()
    );
    let disk: Store = serde_json::from_slice(
        &std::fs::read(fixture.directory.path().join("chatgpt-siwc.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(disk.users.len(), 1);
    assert_eq!(disk.host_id, before.host_id);
    assert_eq!(
        serde_json::to_value(&disk.users["user-b"]).unwrap(),
        serde_json::to_value(&before.users["user-b"]).unwrap()
    );
}

#[tokio::test]
async fn status_revokes_retained_tokens_before_forgetting_legacy_accounts() {
    for revoke_status in [200, 500] {
        let fixture = fixture().await;
        fixture.provider.set_revoke_status(revoke_status);
        let mut signed_out = account("signed-out", "client-old", "subject-old", None);
        signed_out.retired_refresh_tokens = vec!["refresh-retired".into()];
        insert(&fixture.service, "user-a", signed_out).await;

        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert_eq!(
            stored_account(&reloaded, "user-a", "signed-out")
                .await
                .retired_refresh_tokens,
            vec!["refresh-retired"]
        );
        let status = reloaded.status("user-a").await.unwrap();
        assert!(status.accounts.is_empty());
        assert_eq!(status.active_connection_id, None);
        assert_eq!(status.error.is_some(), revoke_status != 200);
        let posts = fixture.provider.posts("/revoke");
        assert!(posts[0].contains("token=refresh-retired"));
        assert!(posts[0].contains("client_id=client-old"));
        let restarted =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert!(restarted.state.lock().await.users.is_empty());
    }
}

#[tokio::test]
async fn cleanup_warning_preserves_healthy_account_status() {
    let fixture = fixture().await;
    fixture.provider.set_revoke_status(500);
    insert(
        &fixture.service,
        "user-a",
        account(
            "healthy",
            "client-current",
            "subject-current",
            Some(tokens(
                &fixture,
                "client-current",
                "subject-current",
                "access-current",
                "refresh-current",
                now() + 3600,
            )),
        ),
    )
    .await;
    let mut signed_out = account("signed-out", "client-old", "subject-old", None);
    signed_out.retired_refresh_tokens = vec!["refresh-retired".into()];
    insert(&fixture.service, "user-a", signed_out).await;
    let status = fixture.service.status("user-a").await.unwrap();
    assert_eq!(status.accounts.len(), 1);
    assert_eq!(status.active_connection_id.as_deref(), Some("healthy"));
    assert!(status.accounts[0].connected);
    assert!(status.error.unwrap().contains("could not be confirmed"));
}

#[tokio::test]
async fn sign_out_keeps_interrupted_revocations_durable_and_hidden() {
    for revoke_status in [200, 500] {
        let fixture = fixture().await;
        fixture.provider.set_revoke_status(revoke_status);
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-1",
                    "refresh-1",
                    now() + 3600,
                )),
            ),
        )
        .await;
        let watch = fixture.service.for_user("user-a".into()).connection();
        fixture.provider.shared.lock().unwrap().hold_revoke = true;
        let sign_out = tokio::spawn({
            let service = Arc::clone(&fixture.service);
            async move { service.disconnect("user-a", "connection-1").await }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.provider.posts("/revoke").is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*watch.borrow(), None);
        let restarted =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        let marker = stored_account(&restarted, "user-a", "connection-1").await;
        assert!(marker.tokens.is_none());
        assert_eq!(marker.subject, "signed-out");
        assert_eq!(marker.email, None);
        assert_eq!(marker.retired_refresh_tokens, vec!["refresh-1"]);
        assert!(restarted.select("user-a", "connection-1").await.is_err());
        let interrupted =
            std::fs::read(fixture.directory.path().join("chatgpt-siwc.json")).unwrap();
        fixture.provider.shared.lock().unwrap().hold_revoke = false;
        sign_out.await.unwrap().unwrap();
        crate::profile::write_private_file(
            &fixture.directory.path().join("chatgpt-siwc.json"),
            &interrupted,
        )
        .unwrap();
        let restarted =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        let status = restarted.status("user-a").await.unwrap();
        assert!(status.accounts.is_empty());
        assert_eq!(status.active_connection_id, None);
        assert_eq!(status.error.is_some(), revoke_status != 200);
        assert!(fixture.provider.posts("/revoke").len() >= 2);
        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert!(reloaded.state.lock().await.users.is_empty());
    }
}

#[tokio::test]
async fn sign_out_revokes_when_account_removal_cannot_be_saved() {
    for revoke_status in [200, 500] {
        let fixture = fixture().await;
        fixture.provider.set_revoke_status(revoke_status);
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-1",
                    "refresh-1",
                    now() + 3600,
                )),
            ),
        )
        .await;
        let watch = fixture.service.for_user("user-a".into()).connection();
        *fixture.service.persist_failure_after.lock().unwrap() = Some(1);
        let error = fixture
            .service
            .disconnect("user-a", "connection-1")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("Could not save local ChatGPT credentials"));
        assert_eq!(
            error.contains("could not be confirmed"),
            revoke_status != 200
        );
        assert_eq!(*watch.borrow(), None);
        let revocations = fixture.provider.posts("/revoke");
        assert!(revocations[0].contains("token=refresh-1"));
        let status = fixture.service.status("user-a").await.unwrap();
        assert!(status.accounts.is_empty());
        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert!(reloaded.state.lock().await.users.is_empty());
    }
}

#[tokio::test]
async fn credential_refresh_failure_preserves_legacy_revocation_guidance() {
    let fixture = fixture().await;
    fixture.provider.set_revoke_status(500);
    insert(
        &fixture.service,
        "user-a",
        account(
            "healthy",
            "client-current",
            "subject-current",
            Some(tokens(
                &fixture,
                "client-current",
                "subject-current",
                "access-current",
                "refresh-current",
                now() - 10,
            )),
        ),
    )
    .await;
    let mut signed_out = account("signed-out", "client-old", "subject-old", None);
    signed_out.retired_refresh_tokens = vec!["refresh-retired".into()];
    insert(&fixture.service, "user-a", signed_out).await;
    let status = fixture.service.status("user-a").await.unwrap();
    assert_eq!(status.accounts.len(), 1);
    assert!(status.accounts[0].connected);
    let error = status.error.unwrap();
    assert!(error.contains("ChatGPT refresh is temporarily unavailable"));
    assert!(error.contains("OpenAI revocation could not be confirmed"));
    assert!(error.contains("Remove the agent in ChatGPT settings"));
}

#[tokio::test]
async fn legacy_revocation_does_not_block_other_users_credentials() {
    let fixture = fixture().await;
    let mut signed_out = account("signed-out", "client-old", "subject-old", None);
    signed_out.retired_refresh_tokens = vec!["refresh-retired".into()];
    insert(&fixture.service, "user-a", signed_out).await;
    insert(
        &fixture.service,
        "user-b",
        account(
            "healthy",
            "client-current",
            "subject-current",
            Some(tokens(
                &fixture,
                "client-current",
                "subject-current",
                "access-current",
                "refresh-current",
                now() + 3600,
            )),
        ),
    )
    .await;
    fixture.provider.shared.lock().unwrap().hold_revoke = true;
    let cleanup = tokio::spawn({
        let service = Arc::clone(&fixture.service);
        async move { service.status("user-a").await }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.provider.posts("/revoke").is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let access = tokio::time::timeout(Duration::from_secs(1), fixture.service.access("user-b"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(access.access_token, "access-current");
    fixture.provider.shared.lock().unwrap().hold_revoke = false;
    assert!(cleanup.await.unwrap().unwrap().accounts.is_empty());
}

#[tokio::test]
async fn disconnect_preserves_other_accounts_without_selecting_one() {
    let fixture = fixture().await;
    for connection in ["connection-1", "connection-2", "connection-3"] {
        insert(
            &fixture.service,
            "user-a",
            account(
                connection,
                connection,
                connection,
                Some(tokens(
                    &fixture,
                    connection,
                    connection,
                    connection,
                    connection,
                    now() + 3600,
                )),
            ),
        )
        .await;
    }
    let credentials = fixture.service.for_user("user-a".into());
    let watch = credentials.connection();
    let session = watch.borrow().clone();
    fixture
        .service
        .disconnect("user-a", "connection-2")
        .await
        .unwrap();
    assert_eq!(*watch.borrow(), session);
    let before = fixture.service.state.lock().await.users["user-a"].clone();
    assert_eq!(before.accounts.len(), 2);
    assert_eq!(before.active.as_deref(), Some("connection-1"));

    fixture
        .service
        .disconnect("user-a", "connection-1")
        .await
        .unwrap();
    assert_eq!(*watch.borrow(), None);
    let reloaded = ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
    let state = reloaded.state.lock().await;
    let accounts = &state.users["user-a"];
    assert_eq!(accounts.active, None);
    assert_eq!(accounts.accounts.len(), 1);
    assert_eq!(
        serde_json::to_value(&accounts.accounts[0]).unwrap(),
        serde_json::to_value(&before.accounts[1]).unwrap()
    );
    let status = fixture.service.status("user-a").await.unwrap();
    assert_eq!(status.accounts.len(), 1);
    assert_eq!(status.accounts[0].connection_id, "connection-3");
}

#[tokio::test]
async fn disconnect_revokes_and_forgets_the_account_across_restart() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-1",
                "refresh-1",
                now() + 3600,
            )),
        ),
    )
    .await;
    let credentials = fixture.service.for_user("user-a".into());
    let mut watch = credentials.connection();
    watch.borrow_and_update();

    let warning = fixture
        .service
        .disconnect("user-a", "connection-1")
        .await
        .unwrap();
    assert_eq!(warning, None);
    assert_eq!(*watch.borrow(), None);
    assert!(fixture.service.state.lock().await.users.is_empty());
    let status = fixture.service.status("user-a").await.unwrap();
    assert!(status.accounts.is_empty());
    assert_eq!(status.active_connection_id, None);

    let revocations = fixture.provider.posts("/revoke");
    assert_eq!(revocations.len(), 1, "disconnect must attempt revocation");
    assert!(revocations[0].contains("token=refresh-1"));
    assert!(revocations[0].contains("client_id=client-1"));
    let reloaded = ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
    assert!(reloaded.state.lock().await.users.is_empty());
}

#[tokio::test]
async fn disconnect_warns_when_revocation_is_not_confirmed() {
    let fixture = fixture().await;
    fixture.provider.set_revoke_status(500);
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-1",
                "refresh-1",
                now() + 3600,
            )),
        ),
    )
    .await;
    let warning = fixture
        .service
        .disconnect("user-a", "connection-1")
        .await
        .unwrap()
        .unwrap();
    assert!(warning.contains("could not be confirmed"), "{warning}");
    let reloaded = ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
    assert!(reloaded.state.lock().await.users.is_empty());
}

#[tokio::test]
async fn authorization_builds_pkce_urls_for_dynamic_and_returning_clients() {
    let fixture = fixture().await;
    let nonce = Uuid::new_v4().to_string();
    let url = fixture
        .service
        .authorization(
            "user-a",
            None,
            "http://127.0.0.1:1/auth/callback",
            "state-1",
            &nonce,
            "verifier-1",
        )
        .await
        .unwrap();
    let url = url::Url::parse(&url).unwrap();
    let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs["client_id"], DYNAMIC_CLIENT);
    assert_eq!(pairs["agent_name_hint"], "Sprocket");
    assert_eq!(pairs["state"], "state-1");
    assert_eq!(pairs["nonce"], nonce);
    assert_eq!(pairs["scope"], SCOPES);
    assert_eq!(pairs["redirect_uri"], "http://127.0.0.1:1/auth/callback");
    let expected =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(b"verifier-1"));
    assert_eq!(pairs["code_challenge"], expected);
    assert_eq!(pairs["code_challenge_method"], "S256");
    assert!(pairs["ext_agent_host_id"].starts_with("urn:uuid:"));

    insert(
        &fixture.service,
        "user-a",
        account("connection-1", "client-1", "subject-1", None),
    )
    .await;
    let nonce = Uuid::new_v4().to_string();
    let url = fixture
        .service
        .authorization(
            "user-a",
            Some("connection-1"),
            "http://127.0.0.1:1/auth/callback",
            "state-2",
            &nonce,
            "verifier-2",
        )
        .await
        .unwrap();
    let pairs: HashMap<_, _> = url::Url::parse(&url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    assert_eq!(pairs["client_id"], "client-1");
    assert!(!pairs.contains_key("agent_name_hint"));
}

#[tokio::test]
async fn status_reports_a_connected_account_with_fresh_credentials() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access",
                "refresh",
                now() + 3600,
            )),
        ),
    )
    .await;
    let status = fixture.service.status("user-a").await.unwrap();
    assert_eq!(
        serde_json::to_value(status).unwrap(),
        serde_json::json!({
            "accounts": [{
                "connectionId": "connection-1",
                "label": "agent@example.com",
                "connected": true
            }],
            "activeConnectionId": "connection-1"
        })
    );
}

#[tokio::test]
async fn status_refreshes_expired_credentials() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        ),
    )
    .await;
    fixture.provider.set_token(
        200,
        token_response("access-new", "refresh-new", None, None, 3600),
    );
    let status = fixture.service.status("user-a").await.unwrap();
    assert_eq!(status.active_connection_id.as_deref(), Some("connection-1"));
    assert!(status.accounts[0].connected);
    assert_eq!(status.error, None);
    let refreshed = stored_account(&fixture.service, "user-a", "connection-1")
        .await
        .tokens
        .unwrap();
    assert_eq!(refreshed.access_token, "access-new");
    assert_eq!(refreshed.refresh_token, "refresh-new");
}

#[tokio::test]
async fn status_reports_revoked_credentials_as_disconnected() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        ),
    )
    .await;
    fixture.provider.set_token(
        400,
        serde_json::json!({"error": "invalid_grant"}).to_string(),
    );
    let status = fixture.service.status("user-a").await.unwrap();
    assert!(status.accounts.is_empty());
    assert!(status.error.unwrap().contains("session expired"));
    assert!(
        stored_account(&fixture.service, "user-a", "connection-1")
            .await
            .tokens
            .is_none()
    );
}

#[tokio::test]
async fn unavailable_storage_preserves_the_file_and_reports_repair_guidance() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("chatgpt-siwc.json");
    std::fs::write(&path, b"unreadable credential state").unwrap();
    let service = ChatGptService::load_or_unavailable(directory.path()).unwrap();
    assert!(!service.available());
    let status = service.status("user-a").await.unwrap();
    assert!(status.error.unwrap().contains("repair or restore"));
    let nonce = Uuid::new_v4().to_string();
    assert!(
        service
            .authorization("user-a", None, "callback", "state", &nonce, "verifier")
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(path).unwrap(), b"unreadable credential state");
}

#[tokio::test]
async fn reconnect_tracks_and_revokes_replaced_grants() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() + 3600,
            )),
        ),
    )
    .await;
    let old = stored_account(&fixture.service, "user-a", "connection-1").await;
    fixture.provider.set_revoke_status(400);
    let grant = PendingGrant {
        user: "user-a".into(),
        expected_connection: Some("connection-1".into()),
        expected_session: Some(old.session_id),
        client_id: "client-1".into(),
        subject: "subject-1".into(),
        email: None,
        tokens: tokens(
            &fixture,
            "client-1",
            "subject-1",
            "access-new",
            "refresh-new",
            now() + 3600,
        ),
    };
    fixture.service.commit("user-a", grant).await.unwrap();
    assert!(fixture.provider.posts("/revoke")[0].contains("token=refresh-old"));
    assert_eq!(
        stored_account(&fixture.service, "user-a", "connection-1")
            .await
            .retired_refresh_tokens,
        vec!["refresh-old"]
    );
    fixture.provider.set_revoke_status(200);
    fixture
        .service
        .disconnect("user-a", "connection-1")
        .await
        .unwrap();
    let posts = fixture.provider.posts("/revoke");
    assert!(posts[1].contains("token=refresh-old"));
    assert!(posts[2].contains("token=refresh-new"));
}

#[tokio::test]
async fn connection_failure_preserves_refresh_credentials_for_retry() {
    let mut fixture = fixture().await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!(
        "http://{}/api/accounts/oauth/token",
        listener.local_addr().unwrap()
    );
    drop(listener);
    Arc::get_mut(&mut fixture.service).unwrap().token_endpoint = endpoint;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        ),
    )
    .await;
    assert!(
        fixture
            .service
            .access("user-a")
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("connect")
    );
    let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
    assert_eq!(stored.tokens.as_ref().unwrap().refresh_token, "refresh-old");
    assert!(!stored.tokens.unwrap().refresh_in_flight);
}

#[tokio::test]
async fn rotated_credentials_retry_persistence_before_use() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        ),
    )
    .await;
    fixture.provider.set_token(
        200,
        token_response("access-new", "refresh-new", None, None, 3600),
    );
    fixture.provider.hold_token(true);
    let credentials = fixture.service.for_user("user-a".into());
    let refresh = tokio::spawn({
        let credentials = Arc::clone(&credentials);
        async move { credentials.credential().await }
    });
    fixture.provider.await_token_requests(1).await;
    let path = fixture.directory.path().join("chatgpt-siwc.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    fixture.provider.hold_token(false);
    assert!(refresh.await.unwrap().is_err());
    assert!(credentials.credential().await.is_err());
    std::fs::remove_dir(&path).unwrap();
    assert_eq!(
        credentials.credential().await.unwrap().access_token,
        "access-new"
    );
    let reloaded = ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
    assert_eq!(
        stored_account(&reloaded, "user-a", "connection-1")
            .await
            .tokens
            .unwrap()
            .refresh_token,
        "refresh-new"
    );
    assert_eq!(fixture.provider.posts("/api/accounts/oauth/token").len(), 1);
}

#[tokio::test]
async fn concurrent_refresh_requests_serialize_on_the_state_lock() {
    let fixture = fixture().await;
    insert(
        &fixture.service,
        "user-a",
        account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        ),
    )
    .await;
    fixture.provider.set_token(
        200,
        token_response("access-new", "refresh-new", None, None, 3600),
    );
    fixture.provider.hold_token(true);

    let credentials = fixture.service.for_user("user-a".into());
    let first = tokio::spawn({
        let credentials = Arc::clone(&credentials);
        async move { credentials.credential().await }
    });
    fixture.provider.await_token_requests(1).await;
    let second = tokio::spawn({
        let credentials = Arc::clone(&credentials);
        async move { credentials.credential().await }
    });
    tokio::task::yield_now().await;
    fixture.provider.hold_token(false);

    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.unwrap().unwrap().access_token, "access-new");
    assert_eq!(second.unwrap().unwrap().access_token, "access-new");
    assert_eq!(
        fixture.provider.posts("/api/accounts/oauth/token").len(),
        1,
        "a single refresh must satisfy concurrent callers"
    );
}
