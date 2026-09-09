use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Context;
use base64::Engine;
use convex::Value;
use rig::message::{ImageMediaType, MimeType};
use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use super::job::{execute_tool_job, run_convex_tool_action};
use super::parse_file::{decode_image_info, persist_image_bytes, replay_image_tool_output};

#[derive(Clone)]
pub(crate) struct BrowserInteractTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct BrowserScreenshotTool(pub(super) AgentToolContext);

fn is_false(value: &bool) -> bool {
    !*value
}

const DISABLE_SAVING_DOC: &str = "Each conversation has a live session sharing your user's saved profile. Saving is chosen at creation; a non-saving session stays non-saving. The user's saving-off preference overrides requests for new sessions. profile_in_use means another conversation holds the writer. Retry with disable_saving: true to load the last saved profile without saving changes, or wait. disable_saving: true on an existing saving session is rejected. Non-saving does not undo purchases, messages, or website changes. Sessions survive runs, with a 7.5-minute provider idle timeout and one-hour hard limit. Unsaved state and tabs are lost on expiry. When the user has control, ask them to give it back before browsing.";

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct BrowserInteractArgs {
    /// An agent-browser command to run in the current browser session, without the `agent-browser` prefix. Examples: 'open https://example.com', 'snapshot -i', 'click @e5', 'fill @e3 "search query"', 'get url'. Run `snapshot -i` first to discover element refs.
    command: String,
    /// Saving is chosen when the browser session is created. A non-saving session stays non-saving. profile_in_use means another conversation holds the writer; retry with disable_saving true to load the last saved profile without persisting changes. disable_saving true on an existing saving session is rejected rather than ignored.
    #[serde(default, skip_serializing_if = "is_false")]
    disable_saving: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct BrowserScreenshotArgs {
    /// Saving is chosen when the browser session is created. A non-saving session stays non-saving. profile_in_use means another conversation holds the writer; retry with disable_saving true to load the last saved profile without persisting changes. disable_saving true on an existing saving session is rejected rather than ignored.
    #[serde(default, skip_serializing_if = "is_false")]
    disable_saving: bool,
}

const MAX_SCREENSHOT_BYTES: usize = 600_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserScreenshotResult {
    media_type: String,
    data_base64: String,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    byte_length: u64,
    truncated: bool,
}

/// Screenshots must go through browser_screenshot; capture them from here and
/// the transcript loses the image block and the size cap that comes with it.
fn screenshot_subcommand(command: &str) -> bool {
    let mut tokens = command.split_whitespace();
    if tokens.next() == Some("agent-browser") {
        return tokens.next() == Some("screenshot");
    }
    command.split_whitespace().next() == Some("screenshot")
}

fn is_json_command(command: &str) -> bool {
    command.trim_start().starts_with('{')
}

impl rig::tool::Tool for BrowserInteractTool {
    const NAME: &'static str = "browser_interact";
    type Error = ToolExecutionError;
    type Args = BrowserInteractArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        format!(
            "Run an agent-browser command in a persistent browser session. Use `snapshot -i` to get an accessibility tree with element refs (@e1, @e2, ...), then act on refs (`click @e5`, `fill @e3 \"text\"`, `press Enter`, `scroll down 500`, `get text @e1`, `get url`, `wait --load networkidle`). Use for all web browsing and checkout steps, including typing the payment credential returned by mandate_charge. Screenshots must go through browser_screenshot. {DISABLE_SAVING_DOC}"
        )
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(BrowserInteractArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        if is_json_command(&args.command) {
            return Err(tool_failure(
                "command must be a plain agent-browser command string like 'open https://example.com' or 'snapshot -i', not JSON."
                    .to_string(),
            ));
        }
        if screenshot_subcommand(&args.command) {
            return Err(tool_failure(
                "Use the browser_screenshot tool instead of `agent-browser screenshot`."
                    .to_string(),
            ));
        }
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let mut action_args =
                    browser_action_args(&self.0.run_id, &self.0.claim_id, args.disable_saving);
                action_args.insert("command".to_string(), args.command.clone().into());
                run_convex_tool_action(
                    &self.0.runtime,
                    cancellation,
                    "browserAgent:interact",
                    action_args,
                )
            },
        )
        .await
    }
}

impl rig::tool::Tool for BrowserScreenshotTool {
    const NAME: &'static str = "browser_screenshot";
    type Error = ToolExecutionError;
    type Args = BrowserScreenshotArgs;
    type Output = ToolOutput;

    fn description(&self) -> String {
        format!(
            "Take a screenshot of the current browser page and return its saved local path and image. Prefer `snapshot -i` via browser_interact when you only need structure or text. {DISABLE_SAVING_DOC}"
        )
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(BrowserScreenshotArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        if !self.0.supports_images {
            return Err(tool_failure("The selected model cannot view images."));
        }
        let cache_dir = self.0.transcript_dir.join(Self::NAME);
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let result = execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| async move {
                let result = run_convex_tool_action(
                    &self.0.runtime,
                    cancellation.clone(),
                    "browserAgent:screenshot",
                    browser_action_args(&self.0.run_id, &self.0.claim_id, args.disable_saving),
                )
                .await?;
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(cancelled_error()),
                    result = save_screenshot(result, &cache_dir) => result.map_err(tool_error),
                }
            },
        )
        .await?;
        if result.get("truncated").and_then(serde_json::Value::as_bool) == Some(true) {
            return Ok(ToolOutput::text(format!(
                "Screenshot captured ({} bytes); too large to attach or save",
                result["byteLength"]
            )));
        }
        replay_image_tool_output(&result).await.map_err(tool_error)
    }
}

fn browser_action_args(
    run_id: &str,
    claim_id: &str,
    disable_saving: bool,
) -> BTreeMap<String, Value> {
    let mut action_args = BTreeMap::new();
    action_args.insert("runId".to_string(), run_id.to_string().into());
    action_args.insert("claimId".to_string(), claim_id.to_string().into());
    if disable_saving {
        action_args.insert("disable_saving".to_string(), Value::Boolean(true));
    }
    action_args
}

async fn save_screenshot(
    value: serde_json::Value,
    cache_dir: &Path,
) -> anyhow::Result<serde_json::Value> {
    let shot: BrowserScreenshotResult =
        serde_json::from_value(value).context("invalid browser screenshot response")?;
    anyhow::ensure!(
        shot.media_type == "image/png",
        "browser screenshot must be a PNG"
    );
    if shot.truncated {
        anyhow::ensure!(
            shot.byte_length > MAX_SCREENSHOT_BYTES as u64 && shot.data_base64.is_empty(),
            "invalid truncated browser screenshot"
        );
        return Ok(json!({
            "mediaType": shot.media_type, "dataBase64": "",
            "byteLength": shot.byte_length, "truncated": true,
        }));
    }
    anyhow::ensure!(
        shot.byte_length <= MAX_SCREENSHOT_BYTES as u64
            && shot.data_base64.len() <= MAX_SCREENSHOT_BYTES.div_ceil(3) * 4,
        "browser screenshot exceeds the 600,000 byte limit"
    );
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&shot.data_base64)
        .context("invalid browser screenshot base64")?;
    anyhow::ensure!(
        bytes.len() as u64 == shot.byte_length,
        "browser screenshot size mismatch"
    );
    let (media_type, width, height) = decode_image_info(&bytes)?;
    anyhow::ensure!(
        media_type == ImageMediaType::PNG,
        "browser screenshot must be a PNG"
    );
    let path = persist_image_bytes(cache_dir, &bytes, &media_type).await?;
    Ok(json!({
        "outputType": "image", "path": path,
        "mediaType": media_type.to_mime_type(), "byteSize": bytes.len(), "width": width, "height": height,
    }))
}

#[cfg(test)]
mod tests {
    use convex::Value;
    use rig::message::ToolResultContent;

    use super::*;

    #[test]
    fn json_object_commands_are_detected_for_guidance_errors() {
        assert!(is_json_command(r#"{"instruction": "go to robu.in"}"#));
        assert!(is_json_command("  {\"startUrl\": \"https://x\"}"));
        assert!(!is_json_command("open https://example.com"));
        assert!(!is_json_command("snapshot -i"));
    }

    #[test]
    fn screenshot_subcommand_is_detected_with_or_without_cli_prefix() {
        assert!(screenshot_subcommand("screenshot"));
        assert!(screenshot_subcommand("screenshot --full-page"));
        assert!(screenshot_subcommand("agent-browser screenshot"));
        assert!(!screenshot_subcommand("snapshot -i"));
        assert!(!screenshot_subcommand("agent-browser snapshot"));
        assert!(!screenshot_subcommand("open https://example.com"));
        // Only the dedicated subcommand is routed away; other commands may
        // legitimately mention the word in an argument.
        assert!(!screenshot_subcommand("find text \"screenshot\" click"));
    }

    fn png() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    fn screenshot_response() -> serde_json::Value {
        json!({
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(png()),
            "mediaType": "image/png",
            "byteLength": png().len() as f64,
            "truncated": false,
            "url": "https://shop.example/reset?token=secret#credential"
        })
    }

    #[tokio::test]
    async fn screenshot_saves_validated_pixels_and_replays_them_without_page_urls() {
        use crate::types::{AgentHistoryContent, AgentHistoryToolResultItem};

        let cache = tempfile::tempdir().unwrap();
        let store = crate::transcript::TranscriptStore::new(cache.path().join("transcripts"));
        let directory = store
            .thread_dir("user", "thread")
            .join("browser_screenshot");
        let metadata = save_screenshot(screenshot_response(), &directory)
            .await
            .unwrap();
        let path = Path::new(metadata["path"].as_str().unwrap());
        assert_eq!(path.parent().unwrap(), directory.canonicalize().unwrap());
        assert!(!directory.with_file_name("parse_file").exists());
        assert_eq!(tokio::fs::read(path).await.unwrap(), png());
        assert_eq!(metadata["width"], 1);
        assert_eq!(metadata["height"], 1);
        assert_eq!(metadata["byteSize"], png().len());
        assert!(metadata.get("url").is_none());
        assert!(metadata.get("dataBase64").is_none());

        let output = replay_image_tool_output(&metadata).await.unwrap();
        let saved_path = format!("Image saved to: {}", path.display());
        let expected = ToolResultContent::image_base64(
            base64::engine::general_purpose::STANDARD.encode(png()),
            Some(ImageMediaType::PNG),
            None,
        );
        assert_eq!(
            serde_json::to_value(output.into_content()).unwrap(),
            json!([ToolResultContent::text(saved_path.clone()), expected])
        );

        let part = serde_json::from_value(json!({
            "number": 1, "sourceKey": "tool:1", "kind": "tool", "runId": "run",
            "tool": {"callId": "call", "name": "browser_screenshot", "status": "completed", "output": metadata}
        }))
        .unwrap();
        let mut history: Vec<crate::types::AgentHistoryMessage> = serde_json::from_value(json!([{
            "role": "user", "contents": [{
                "type": "toolResult", "id": "call", "callId": "call",
                "items": [{"type": "text", "text": metadata.to_string()}]
            }]
        }]))
        .unwrap();
        super::super::hydrate_tool_history(&mut history, std::slice::from_ref(&part), true).await;
        let AgentHistoryContent::ToolResult { items, .. } = &history[0].contents[0] else {
            panic!("missing tool result")
        };
        let [
            AgentHistoryToolResultItem::Text { text },
            AgentHistoryToolResultItem::Image { image_json },
        ] = items.as_slice()
        else {
            panic!("missing saved path and replayed screenshot")
        };
        assert_eq!(text, &saved_path);
        let ToolResultContent::Image(expected) = expected else {
            unreachable!()
        };
        assert_eq!(image_json, &serde_json::to_string(&expected).unwrap());
        assert!(!serde_json::to_string(&history).unwrap().contains("secret"));

        super::super::hydrate_tool_history(&mut history, std::slice::from_ref(&part), false).await;
        assert!(
            serde_json::to_string(&history)
                .unwrap()
                .contains("Image omitted")
        );
        tokio::fs::remove_file(path).await.unwrap();
        super::super::hydrate_tool_history(&mut history, &[part], true).await;
        assert!(
            serde_json::to_string(&history)
                .unwrap()
                .contains("not available in the local cache")
        );
    }

    #[tokio::test]
    async fn invalid_screenshots_are_not_saved() {
        let cache = tempfile::tempdir().unwrap();
        for (field, value) in [
            ("mediaType", json!("image/tiff")),
            ("dataBase64", json!("not base64!")),
            ("dataBase64", json!("")),
            ("byteLength", json!(0)),
            ("byteLength", json!(1.5)),
            ("byteLength", json!(-1)),
            ("byteLength", json!(MAX_SCREENSHOT_BYTES + 1)),
            ("truncated", json!(true)),
        ] {
            let mut response = screenshot_response();
            response[field] = value;
            assert!(
                save_screenshot(response, cache.path()).await.is_err(),
                "{field}"
            );
        }
        let bytes = b"not a PNG";
        let mut response = screenshot_response();
        response["dataBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        response["byteLength"] = json!(bytes.len());
        assert!(save_screenshot(response, cache.path()).await.is_err());
        assert!(
            tokio::fs::read_dir(cache.path())
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn truncated_screenshots_keep_only_size_metadata() {
        let cache = tempfile::tempdir().unwrap();
        let mut response = screenshot_response();
        response["dataBase64"] = json!("");
        response["byteLength"] = json!(MAX_SCREENSHOT_BYTES + 1);
        response["truncated"] = json!(true);
        let metadata = save_screenshot(response, cache.path()).await.unwrap();
        assert_eq!(
            metadata,
            json!({"dataBase64": "", "mediaType": "image/png", "byteLength": MAX_SCREENSHOT_BYTES + 1, "truncated": true})
        );
        assert!(
            tokio::fs::read_dir(cache.path())
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn disable_saving_is_omitted_from_payload_unless_set() {
        let interact: BrowserInteractArgs =
            serde_json::from_value(serde_json::json!({ "command": "snapshot -i" }))
                .expect("minimal interact args");
        assert!(!interact.disable_saving);
        assert_eq!(
            serde_json::to_value(&interact).unwrap(),
            serde_json::json!({ "command": "snapshot -i" })
        );

        let screenshot: BrowserScreenshotArgs =
            serde_json::from_value(serde_json::json!({})).expect("minimal screenshot args");
        assert!(!screenshot.disable_saving);
        assert_eq!(
            serde_json::to_value(&screenshot).unwrap(),
            serde_json::json!({})
        );

        let args = browser_action_args("run-1", "claim-1", true);
        assert_eq!(args.get("disable_saving"), Some(&Value::Boolean(true)));
        assert!(
            browser_action_args("run-1", "claim-1", false)
                .get("disable_saving")
                .is_none()
        );
    }
}
