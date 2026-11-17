use std::sync::Arc;

use futures::FutureExt;
use serde_json::{Value, json};
use sprocket_transcript::TranscriptPart;

use super::thread_rows::{Fetch, ThreadRows, ThreadRowsLease};
use crate::AppState;

pub(super) fn state() -> (AppState, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let auth = crate::auth::AuthState::load(root.path()).unwrap();
    let native_auth = sprocket_host::native_auth::NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".into(),
        },
        crate::auth::desktop_login_callback_url(7731),
    );
    (
        AppState::for_test(
            auth,
            native_auth,
            root.path().to_owned(),
            true,
            sprocket_host::package_update::PackageUpdateManager::disabled(),
        ),
        root,
    )
}

/// Rows of the test thread that download missing parts from `fetch`.
pub(super) fn thread_rows(state: &AppState, fetch: Fetch) -> ThreadRowsLease {
    ThreadRowsLease::new(Arc::new(ThreadRows::new(
        state.clone(),
        "user",
        "thread",
        fetch,
    )))
}

/// A Convex stand-in that serves `part(number)`.
pub(super) fn fetch(
    part: impl Fn(u32) -> anyhow::Result<TranscriptPart> + Send + Sync + 'static,
) -> Fetch {
    Arc::new(move |start: u32, end: u32| {
        let parts = (start..end)
            .rev()
            .map(&part)
            .collect::<anyhow::Result<Vec<_>>>();
        async move { parts }.boxed()
    })
}

pub(super) fn cached() -> Fetch {
    fetch(|number| panic!("part {number} must be cached"))
}

fn part(number: u32, run: &str, source: &str, body: Value) -> TranscriptPart {
    let mut part = json!({"number": number, "sourceKey": source, "runId": run});
    part.as_object_mut()
        .unwrap()
        .extend(body.as_object().unwrap().clone());
    serde_json::from_value(part).unwrap()
}

pub(super) fn prompt(number: u32, run: &str, hidden: Option<&str>) -> TranscriptPart {
    part(
        number,
        run,
        &format!("prompt:{run}:{number}"),
        json!({"kind": "prompt", "prompt": {"text": "prompt", "imageUploads": [], "hidden": hidden}}),
    )
}

pub(super) fn completion(number: u32, run: &str, source: &str, items: Value) -> TranscriptPart {
    part(
        number,
        run,
        source,
        json!({"kind": "completion", "completion": {"items": items}}),
    )
}

pub(super) fn tool(number: u32, run: &str, source: &str, tool: Value) -> TranscriptPart {
    part(number, run, source, json!({"kind": "tool", "tool": tool}))
}

pub(super) fn text(number: u32, run: &str) -> TranscriptPart {
    completion(
        number,
        run,
        &format!("source:{number}"),
        json!([{"type": "text", "text": format!("part {number}")}]),
    )
}

pub(super) fn reasoning(number: u32, run: &str) -> TranscriptPart {
    completion(
        number,
        run,
        &format!("source:{number}"),
        json!([{"type": "reasoning", "text": format!("thinking {number}")}]),
    )
}
