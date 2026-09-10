use std::path::Path;

use anyhow::Context;
use base64::Engine;
use rig::message::{ImageMediaType, MimeType};
use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use super::job::{action_args_from_payload, execute_tool_job};
use super::parse_file::{decode_image_info, persist_image_bytes, replay_image_tool_output};

#[derive(Clone)]
pub(crate) struct BrowserInteractTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct BrowserScreenshotTool(pub(super) AgentToolContext);

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct BrowserInteractArgs {
    command: String,
    /// Set to true to ensure that cookies and login state that you change are preserved across the user's conversations with other agents in Sprocket. Recommended when you know for sure you are going to be changing login state on websites.
    #[serde(default, skip_serializing_if = "is_false")]
    enforce_saving: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct BrowserScreenshotArgs {}

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
        "Run an agent-browser (a CLI tool) command in a persistent browser session in the cloud. Omit the `agent-browser` prefix. Run `help` to learn more about the CLI. This session may retain cookies and login state on websites used by the user with other agents in Sprocket.".to_string()
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
        let action_args = action_args_from_payload(&self.0.run_id, &self.0.claim_id, &payload)?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                super::firecrawl::run(
                    &self.0.runtime,
                    cancellation,
                    action_args,
                    "browser_interact",
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
        "Take a screenshot of the current browser page in the persistent browser session controlled through `browser_interact`. Prefer `snapshot -i` via `browser_interact` when you don't need the image.".to_string()
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
        let action_args = action_args_from_payload(&self.0.run_id, &self.0.claim_id, &payload)?;
        let result = execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| async move {
                let result = super::firecrawl::run(
                    &self.0.runtime,
                    cancellation.clone(),
                    action_args,
                    "browser_screenshot",
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
    fn saving_enforcement_is_opt_in_and_only_on_interact() {
        let interact: BrowserInteractArgs =
            serde_json::from_value(serde_json::json!({ "command": "snapshot -i" }))
                .expect("minimal interact args");
        assert!(!interact.enforce_saving);
        assert_eq!(
            serde_json::to_value(&interact).unwrap(),
            serde_json::json!({ "command": "snapshot -i" })
        );

        let screenshot: BrowserScreenshotArgs =
            serde_json::from_value(serde_json::json!({})).expect("minimal screenshot args");
        assert_eq!(
            serde_json::to_value(&screenshot).unwrap(),
            serde_json::json!({})
        );

        let interact = BrowserInteractArgs {
            command: "help".to_string(),
            enforce_saving: true,
        };
        let payload = serde_json::to_value(interact).unwrap();
        assert_eq!(payload, json!({"command": "help", "enforce_saving": true}));
        let args = action_args_from_payload("run-1", "claim-1", &payload).unwrap();
        assert_eq!(args.get("enforce_saving"), Some(&Value::Boolean(true)));
        let schema = json!(schemars::schema_for!(BrowserInteractArgs));
        assert!(schema["properties"].get("disable_saving").is_none());
        assert!(schema["properties"]["command"].get("description").is_none());
        assert_eq!(schema["required"], json!(["command"]));
        let screenshot_schema = json!(schemars::schema_for!(BrowserScreenshotArgs));
        assert!(
            screenshot_schema
                .get("properties")
                .is_none_or(|properties| properties == &json!({}))
        );
        assert!(
            serde_json::from_value::<BrowserInteractArgs>(
                json!({"command": "help", "disable_saving": true})
            )
            .is_err()
        );
        for field in ["enforce_saving", "disable_saving"] {
            assert!(serde_json::from_value::<BrowserScreenshotArgs>(json!({field: true})).is_err());
        }
    }
}
