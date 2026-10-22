use super::*;

const MAX_YIELD_MS: u64 = 1_770_000;

#[test]
fn action_and_poll_yields_share_a_cap_but_have_different_minimums() {
    for yield_time_ms in [0, 1, MIN_POLL_YIELD_MS - 1, MIN_POLL_YIELD_MS] {
        assert_eq!(
            YieldMode::Action.normalize(yield_time_ms, MAX_YIELD_MS),
            yield_time_ms
        );
    }
    assert_eq!(YieldMode::Poll.normalize(0, MAX_YIELD_MS), 0);
    assert_eq!(
        YieldMode::Poll.normalize(1, MAX_YIELD_MS),
        MIN_POLL_YIELD_MS
    );
    assert_eq!(
        YieldMode::Poll.normalize(MAX_YIELD_MS, MAX_YIELD_MS),
        MAX_YIELD_MS
    );
    for mode in [YieldMode::Action, YieldMode::Poll] {
        assert_eq!(mode.normalize(u64::MAX, MAX_YIELD_MS), MAX_YIELD_MS);
    }
}

#[test]
fn max_yield_ends_30_seconds_before_the_providers_cache_retention() {
    for (provider, ttl, expected_ms) in [
        (CompletionProvider::Spikonado, Some("1h"), 3_570_000),
        (CompletionProvider::Spikonado, Some("30m"), 1_770_000),
        (CompletionProvider::Openai, Some("30m"), 1_770_000),
        (CompletionProvider::Chatgpt, Some("30m"), 270_000),
        (CompletionProvider::Spikonado, None, 270_000),
        (CompletionProvider::Spikonado, Some("soon"), 270_000),
    ] {
        assert_eq!(
            max_yield_ms(provider, ttl),
            expected_ms,
            "{provider:?} {ttl:?}"
        );
    }
}
