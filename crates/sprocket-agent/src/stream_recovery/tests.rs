use super::*;

#[test]
fn recovery_is_bounded_across_calls_and_accepts_relayed_truncation() {
    let mut recovery = StreamRecovery::default();
    let error = PromptError::Report(ProviderError::Truncated.report());
    for seconds in [1, 2, 4] {
        *recovery.input.lock().unwrap() = Some((vec![], Message::user("continue")));
        assert_eq!(recovery.resume(&error).unwrap().2.as_secs(), seconds);
    }
    *recovery.input.lock().unwrap() = Some((vec![], Message::user("continue")));
    assert!(recovery.resume(&error).is_none());
}

#[test]
fn only_truncation_consumes_the_saved_input() {
    let mut recovery = StreamRecovery::default();
    *recovery.input.lock().unwrap() = Some((vec![], Message::user("continue")));
    let cancelled = PromptError::cancelled(Vec::new(), "cancelled");
    assert!(recovery.resume(&cancelled).is_none());
    let rejected = PromptError::Provider(ProviderError::from_provider_body(
        r#"{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}"#,
    ));
    assert!(recovery.resume(&rejected).is_none());
    assert!(
        recovery
            .resume(&PromptError::Provider(ProviderError::Truncated))
            .is_some()
    );
}

#[test]
fn retries_one_gateway_stream_timeout_per_run() {
    let timeout = || {
        ProviderError::from_provider_body(
            r#"{"type":"response.failed","response":{"status":"failed","error":{"code":"gateway_stream_timeout","message":"Stream exceeded maximum duration before function timeout"}}}"#,
        )
    };
    for error in [
        PromptError::Provider(timeout()),
        PromptError::Report(timeout().report()),
    ] {
        let mut recovery = StreamRecovery::default();
        *recovery.input.lock().unwrap() = Some((vec![], Message::user("continue")));
        assert!(recovery.resume(&error).is_some());
        *recovery.input.lock().unwrap() = Some((vec![], Message::user("continue")));
        assert!(recovery.resume(&error).is_none());
        assert!(
            recovery
                .resume(&PromptError::Provider(ProviderError::Truncated))
                .is_some()
        );
    }
}
