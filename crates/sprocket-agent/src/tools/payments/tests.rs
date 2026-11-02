use super::*;

fn recognizers() -> Vec<Recognizer> {
    let specs: Vec<RecognizerSpec> = serde_json::from_value(json!([
        {
            "psp": "stripe",
            "hosts": ["^api\\.stripe\\.com$"],
            "match": "api\\.stripe\\.com/v1/(payment_methods|tokens|payment_intents/pi_\\w+/confirm)",
        },
        {
            "psp": "cybersource_flex",
            "hosts": ["^flex\\.cybersource\\.com$"],
            "match": "(?:test)?flex\\.cybersource\\.com/flex/v2/tokens(?![\\w/-])",
        },
    ]))
    .unwrap();
    compile_recognizers(&specs)
}

#[test]
fn recognizes_processor_requests_by_host_and_whole_path() {
    let recognizers = recognizers();
    for (url, psp) in [
        ("https://api.stripe.com/v1/tokens", Some("stripe")),
        (
            "https://api.stripe.com/v1/payment_intents/pi_123/confirm?key=x",
            Some("stripe"),
        ),
        (
            "https://flex.cybersource.com/flex/v2/tokens",
            Some("cybersource_flex"),
        ),
        ("https://api.stripe.com/v1/tokens/extra", None),
        ("https://api.stripe.com/v1/customers", None),
        ("https://evil.example/?next=api.stripe.com/v1/tokens", None),
        ("https://api.stripe.com.evil.example/v1/tokens", None),
        ("not a url", None),
    ] {
        assert_eq!(recognize(&recognizers, url), psp, "{url}");
    }
}

#[test]
fn checkout_origin_is_the_exact_https_origin() {
    for (url, origin) in [
        (
            "https://Shop.Example.com/checkout?step=pay",
            Some("https://shop.example.com"),
        ),
        (
            "https://shop.example.com:443/checkout",
            Some("https://shop.example.com"),
        ),
        (
            "https://shop.example.com:8443/checkout",
            Some("https://shop.example.com:8443"),
        ),
        ("http://shop.example.com/checkout", None),
        ("about:blank", None),
    ] {
        assert_eq!(checkout_origin(url).as_deref(), origin, "{url}");
    }
}

#[test]
fn fulfilled_headers_allow_the_requesting_origin() {
    let response = BTreeMap::from([
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Access-Control-Allow-Origin".to_string(), "*".to_string()),
        ("Content-Length".to_string(), "999".to_string()),
    ]);
    assert_eq!(
        fulfilled_headers(&response, Some("https://js.stripe.com")),
        [
            ("Content-Type", "application/json"),
            ("access-control-allow-origin", "https://js.stripe.com"),
            ("access-control-allow-credentials", "true"),
        ]
        .map(|(name, value)| (name.to_string(), value.to_string()))
    );
}

#[tokio::test(start_paused = true)]
async fn checkout_waits_pass_approval_until_the_checkout_finishes() {
    let (progress, receiver) = watch::channel(CheckoutProgress::Starting);
    let waiting = tokio::spawn(wait_for_checkout(receiver.clone(), 0));
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished());

    progress.send_replace(CheckoutProgress::AwaitingApproval {
        purchase_id: "purchase".into(),
        merchant: "shop.example.com".into(),
    });
    assert_eq!(
        waiting.await.unwrap().unwrap(),
        json!({ "status": "awaiting_approval", "purchaseId": "purchase", "merchant": "shop.example.com" })
    );

    progress.send_replace(CheckoutProgress::Finished(Ok(
        json!({ "status": "approved" }),
    )));
    assert_eq!(
        wait_for_checkout(receiver, 10_000).await.unwrap(),
        json!({ "status": "approved" })
    );
}
