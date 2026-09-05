use std::collections::BTreeMap;

use convex::Value;
use rig::message::{DocumentSourceKind, Image, ImageMediaType, ToolResultContent};
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, tool_error, tool_failure};
use super::job::{
    execute_tool_job, execute_tool_job_with_persisted_result, run_convex_tool_action,
};

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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserScreenshotResult {
    media_type: String,
    data_base64: String,
    byte_length: u64,
    truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
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
    type Output = rig::tool::ToolOutput;

    fn description(&self) -> String {
        format!(
            "Take a screenshot of the current browser page and attach it as an image, so you can see the page like the user does. Prefer `snapshot -i` via browser_interact when you only need structure or text. {DISABLE_SAVING_DOC}"
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
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job_with_persisted_result(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                run_convex_tool_action(
                    &self.0.runtime,
                    cancellation,
                    "browserAgent:screenshot",
                    browser_action_args(&self.0.run_id, &self.0.claim_id, args.disable_saving),
                )
            },
            screenshot_persisted_result,
        )
        .await
        .and_then(screenshot_tool_output)
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

fn screenshot_persisted_result(output: &serde_json::Value) -> serde_json::Value {
    let mut persisted = output.clone();
    if let Some(object) = persisted.as_object_mut() {
        object.insert(
            "dataBase64".to_string(),
            serde_json::Value::String(String::new()),
        );
    }
    persisted
}

fn parse_screenshot_result(
    value: &serde_json::Value,
) -> Result<BrowserScreenshotResult, ToolExecutionError> {
    let object = value
        .as_object()
        .ok_or_else(|| tool_failure("browser_screenshot returned a non-object result"))?;
    let media_type = required_screenshot_str(object, "mediaType")?.to_string();
    image_media_type(&media_type)?;
    let data_base64 = required_screenshot_str(object, "dataBase64")?.to_string();
    let byte_length = required_screenshot_u64(object, "byteLength")?;
    let truncated = required_screenshot_bool(object, "truncated")?;
    let url = match object.get("url") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| tool_failure("screenshot url must be a string"))?
                .to_string(),
        ),
    };
    if !truncated && data_base64.is_empty() {
        return Err(tool_failure("browser_screenshot returned no image data"));
    }
    Ok(BrowserScreenshotResult {
        media_type,
        data_base64,
        byte_length,
        truncated,
        url,
    })
}

fn required_screenshot_str<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<&'a str, ToolExecutionError> {
    object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| tool_failure(format!("screenshot result missing {field}")))
}

fn required_screenshot_bool(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<bool, ToolExecutionError> {
    object
        .get(field)
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| tool_failure(format!("screenshot result missing {field}")))
}

fn required_screenshot_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<u64, ToolExecutionError> {
    let value = object
        .get(field)
        .ok_or_else(|| tool_failure(format!("screenshot result missing {field}")))?;
    if let Some(n) = value.as_u64() {
        return Ok(n);
    }
    if let Some(n) = value.as_f64() {
        if n.is_finite() && n >= 0.0 && n.fract() == 0.0 {
            return Ok(n as u64);
        }
    }
    Err(tool_failure(format!(
        "screenshot result has invalid {field}"
    )))
}

/// Convert the Convex screenshot result into model content: a compact text
/// block plus the image itself. The durable job result keeps the same shape
/// with `dataBase64` cleared so the transcript never stores the pixels.
fn screenshot_tool_output(
    value: serde_json::Value,
) -> Result<rig::tool::ToolOutput, ToolExecutionError> {
    let shot = parse_screenshot_result(&value)?;
    let mut summary = format!("Screenshot captured ({} bytes)", shot.byte_length);
    if let Some(url) = &shot.url {
        summary.push_str(&format!(" of {url}"));
    }
    if shot.truncated {
        summary.push_str("; too large to attach");
    }

    let mut content = vec![ToolResultContent::Text(rig::message::Text::new(summary))];
    if !shot.truncated {
        content.push(ToolResultContent::Image(Image {
            data: DocumentSourceKind::Base64(shot.data_base64),
            media_type: Some(image_media_type(&shot.media_type)?),
            detail: None,
            additional_params: None,
        }));
    }
    rig::tool::ToolOutput::content(content).map_err(|e| tool_failure(e.to_string()))
}

fn image_media_type(media_type: &str) -> Result<ImageMediaType, ToolExecutionError> {
    match media_type {
        "image/jpeg" => Ok(ImageMediaType::JPEG),
        "image/png" => Ok(ImageMediaType::PNG),
        "image/gif" => Ok(ImageMediaType::GIF),
        "image/webp" => Ok(ImageMediaType::WEBP),
        other => Err(tool_failure(format!(
            "unsupported screenshot media type: {other}"
        ))),
    }
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

    #[test]
    fn screenshot_persistence_strips_only_the_image_payload() {
        let output = serde_json::json!({
            "dataBase64": "aGVsbG8=",
            "mediaType": "image/png",
            "byteLength": 5,
            "truncated": false,
            "url": "https://shop.example/"
        });

        let persisted = screenshot_persisted_result(&output);

        assert_eq!(output["dataBase64"], "aGVsbG8=");
        assert_eq!(persisted["dataBase64"], "");
        assert_eq!(persisted["mediaType"], output["mediaType"]);
        assert_eq!(persisted["byteLength"], output["byteLength"]);
        assert_eq!(persisted["truncated"], output["truncated"]);
        assert_eq!(persisted["url"], output["url"]);
    }

    #[test]
    fn screenshot_output_requires_image_bytes_unless_truncated() {
        let attached = screenshot_tool_output(serde_json::json!({
            "dataBase64": "aGVsbG8=",
            "mediaType": "image/png",
            "byteLength": 5.0,
            "truncated": false,
            "url": "https://shop.example/"
        }))
        .expect("valid screenshot");
        assert!(matches!(
            attached.as_content(),
            [ToolResultContent::Text(_), ToolResultContent::Image(_)]
        ));

        let truncated = screenshot_tool_output(serde_json::json!({
            "dataBase64": "",
            "mediaType": "image/png",
            "byteLength": 2_000_000,
            "truncated": true
        }))
        .expect("truncated screenshot");
        assert!(matches!(
            truncated.as_content(),
            [ToolResultContent::Text(_)]
        ));

        let missing = screenshot_tool_output(serde_json::json!({
            "dataBase64": "",
            "mediaType": "image/png",
            "byteLength": 0,
            "truncated": false
        }))
        .expect_err("empty non-truncated screenshot");
        assert!(missing.to_string().contains("no image data"));

        let bad_type = screenshot_tool_output(serde_json::json!({
            "dataBase64": "aGVsbG8=",
            "mediaType": "image/tiff",
            "byteLength": 5,
            "truncated": false
        }))
        .expect_err("unsupported media type");
        assert!(
            bad_type
                .to_string()
                .contains("unsupported screenshot media type")
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
