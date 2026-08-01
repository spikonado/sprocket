use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, anyhow};
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::page::Page;
use futures::StreamExt;
use serde::Deserialize;

const SNAPSHOT_LIMIT: usize = 20_000;
const REF_ATTRIBUTE: &str = "data-sprocket-ref";

const SNAPSHOT_SCRIPT: &str = r#"
() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const label = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (el.getAttribute("aria-labelledby")) {
      const text = el.getAttribute("aria-labelledby").split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || "").join(" ");
      if (clean(text)) return clean(text);
    }
    if (el.labels?.length) return clean(Array.from(el.labels).map(x => x.textContent).join(" "));
    return clean(el.textContent || el.getAttribute("title") || el.getAttribute("alt") || "");
  };
  const sensitive = (el) => {
    const haystack = [
      el.getAttribute("autocomplete"), el.name, el.id,
      el.getAttribute("placeholder"), el.getAttribute("aria-label")
    ].filter(Boolean).join(" ");
    return /cc-(number|csc|exp|exp-month|exp-year)/i.test(haystack) ||
      /card.?number|cc.?num|cvv|cvc|csc|security.?code|expir|exp.?date|mm.?\/?.?yy/i.test(haystack);
  };
  document.querySelectorAll("[" + "data-sprocket-ref" + "]")
    .forEach(el => el.removeAttribute("data-sprocket-ref"));
  const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],summary';
  const elements = Array.from(document.querySelectorAll(selector)).filter(visible).map((el, i) => {
    const ref = "e" + (i + 1);
    el.setAttribute("data-sprocket-ref", ref);
    const isSensitive = sensitive(el);
    return {
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      label: label(el),
      href: el.href || null,
      inputType: el.tagName === "INPUT" ? (el.type || "text") : null,
      name: el.getAttribute("name"),
      placeholder: el.getAttribute("placeholder"),
      value: !isSensitive && ("value" in el) ? String(el.value || "") : null,
      sensitive: isSensitive
    };
  });
  const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
    .filter(visible).slice(0, 30).map(el => clean(el.textContent)).filter(Boolean);
  const text = Array.from(document.querySelectorAll("main p,main li,article p,article li,form label"))
    .filter(visible).slice(0, 40).map(el => clean(el.textContent)).filter(Boolean);
  return { title: document.title || "", url: location.href, headings, text, elements };
}
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentField {
    Number,
    Cvv,
    Expiry,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    text: String,
}

impl Snapshot {
    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn into_string(self) -> String {
        self.text
    }
}

impl std::fmt::Display for Snapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.text)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSnapshot {
    title: String,
    url: String,
    headings: Vec<String>,
    text: Vec<String>,
    elements: Vec<RawElement>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawElement {
    #[serde(rename = "ref")]
    reference: String,
    tag: String,
    role: Option<String>,
    label: String,
    href: Option<String>,
    input_type: Option<String>,
    name: Option<String>,
    placeholder: Option<String>,
    value: Option<String>,
    sensitive: bool,
}

pub struct BrowserSession {
    _browser: Browser,
    page: Page,
    locators: HashMap<String, String>,
    _handler_task: tokio::task::JoinHandle<()>,
}

impl BrowserSession {
    pub async fn connect(connect_url: &str) -> anyhow::Result<Self> {
        let override_url = std::env::var("SPROCKET_BROWSER_CONNECT_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let local = std::env::var("SPROCKET_BROWSER_LOCAL").as_deref() == Ok("1");

        let (browser, mut handler) = if let Some(url) = override_url {
            Browser::connect(url)
                .await
                .context("failed to connect to the configured browser")?
        } else if local {
            let executable = find_browser_binary()
                .ok_or_else(|| anyhow!("no local Chromium browser binary was found"))?;
            let config = BrowserConfig::builder()
                .chrome_executable(executable)
                .no_sandbox()
                .build()
                .map_err(|error| anyhow!("invalid local browser configuration: {error}"))?;
            Browser::launch(config)
                .await
                .context("failed to launch local Chromium")?
        } else {
            Browser::connect(connect_url)
                .await
                .context("failed to connect to the remote browser")?
        };

        let handler_task = tokio::spawn(async move {
            while let Some(result) = handler.next().await {
                if result.is_err() {
                    break;
                }
            }
        });
        let page = browser
            .new_page("about:blank")
            .await
            .context("failed to create a browser page")?;

        Ok(Self {
            _browser: browser,
            page,
            locators: HashMap::new(),
            _handler_task: handler_task,
        })
    }

    pub async fn navigate(&mut self, url: &str) -> anyhow::Result<Snapshot> {
        self.page
            .goto(url)
            .await
            .context("browser navigation failed")?;
        self.snapshot().await
    }

    pub async fn snapshot(&mut self) -> anyhow::Result<Snapshot> {
        let raw: RawSnapshot = self
            .page
            .evaluate_function(SNAPSHOT_SCRIPT)
            .await
            .context("failed to inspect the browser page")?
            .into_value()
            .context("browser page returned an invalid snapshot")?;

        self.locators = raw
            .elements
            .iter()
            .map(|element| {
                (
                    element.reference.clone(),
                    format!("[{REF_ATTRIBUTE}=\"{}\"]", element.reference),
                )
            })
            .collect();

        Ok(Snapshot {
            text: render_snapshot(raw),
        })
    }

    pub async fn click(&mut self, reference: &str) -> anyhow::Result<Snapshot> {
        let selector = self.resolve(reference)?;
        let element = self
            .page
            .find_element(selector)
            .await
            .map_err(|_| stale_reference(reference))?;
        element
            .click()
            .await
            .context("failed to click browser element; take a new snapshot")?;
        self.snapshot().await
    }

    pub async fn type_text(&mut self, reference: &str, text: &str) -> anyhow::Result<Snapshot> {
        let selector = self.resolve(reference)?;
        let element = self
            .page
            .find_element(selector)
            .await
            .map_err(|_| stale_reference(reference))?;
        element
            .click()
            .await
            .context("failed to focus browser element; take a new snapshot")?
            .type_str(text)
            .await
            .context("failed to type into browser element; take a new snapshot")?;
        self.snapshot().await
    }

    pub async fn select_option(
        &mut self,
        reference: &str,
        value: &str,
    ) -> anyhow::Result<Snapshot> {
        let selector = self.resolve(reference)?;
        let expression = format!(
            r#"(() => {{
              const el = document.querySelector({});
              if (!el) return false;
              el.value = {};
              el.dispatchEvent(new Event("input", {{ bubbles: true }}));
              el.dispatchEvent(new Event("change", {{ bubbles: true }}));
              return true;
            }})()"#,
            serde_json::to_string(&selector)?,
            serde_json::to_string(value)?
        );
        let selected: bool = self
            .page
            .evaluate_expression(expression)
            .await
            .context("failed to select browser option")?
            .into_value()
            .context("browser returned an invalid selection result")?;
        if !selected {
            return Err(stale_reference(reference));
        }
        self.snapshot().await
    }

    pub async fn scroll(&mut self, direction: ScrollDirection) -> anyhow::Result<Snapshot> {
        let delta = match direction {
            ScrollDirection::Up => -700,
            ScrollDirection::Down => 700,
        };
        self.page
            .evaluate_expression(format!("window.scrollBy(0, {delta})"))
            .await
            .context("failed to scroll browser page")?;
        self.snapshot().await
    }

    pub async fn fill_payment_field(&self, field: PaymentField, value: &str) -> anyhow::Result<()> {
        let field_name = match field {
            PaymentField::Number => "number",
            PaymentField::Cvv => "cvv",
            PaymentField::Expiry => "expiry",
        };
        let expression = format!(
            r#"(() => {{
              const field = {};
              document.querySelectorAll("[data-sprocket-payment-target]")
                .forEach(el => el.removeAttribute("data-sprocket-payment-target"));
              const candidates = Array.from(document.querySelectorAll("input")).map((el, index) => {{
                const autocomplete = (el.autocomplete || "").toLowerCase();
                const haystack = [el.name, el.id, el.placeholder, el.getAttribute("aria-label")]
                  .filter(Boolean).join(" ").toLowerCase();
                let score = 0;
                if (field === "number") {{
                  if (autocomplete === "cc-number") score += 100;
                  if (/card.?number|cc.?num/.test(haystack)) score += 40;
                }} else if (field === "cvv") {{
                  if (autocomplete === "cc-csc") score += 100;
                  if (/cvv|cvc|csc|security.?code/.test(haystack)) score += 40;
                }} else {{
                  if (autocomplete === "cc-exp") score += 100;
                  if (autocomplete === "cc-exp-month" || autocomplete === "cc-exp-year") score += 80;
                  if (/expir|exp.?date|mm.?\/?.?yy/.test(haystack)) score += 40;
                }}
                return {{ el, score, index }};
              }}).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
              if (!candidates.length) return false;
              const el = candidates[0].el;
              el.setAttribute("data-sprocket-payment-target", "true");
              return true;
            }})()"#,
            serde_json::to_string(field_name)?
        );
        let found: bool = self
            .page
            .evaluate_expression(expression)
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?
            .into_value()
            .map_err(|_| anyhow!("failed to fill the payment field"))?;
        if !found {
            return Err(anyhow!("no matching payment field was found"));
        }
        let element = self
            .page
            .find_element("[data-sprocket-payment-target]")
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?;
        element
            .click()
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?
            .type_str(value)
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?;
        Ok(())
    }

    pub async fn evaluate_json(&self, expression: &str) -> anyhow::Result<serde_json::Value> {
        self.page
            .evaluate_expression(expression)
            .await
            .context("browser evaluation failed")?
            .into_value()
            .context("browser evaluation returned an invalid value")
    }

    fn resolve(&self, reference: &str) -> anyhow::Result<String> {
        self.locators
            .get(reference)
            .cloned()
            .ok_or_else(|| stale_reference(reference))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
}

pub fn find_browser_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SPROCKET_BROWSER_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for name in ["chromium", "chromium-browser", "google-chrome", "chrome"] {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn stale_reference(reference: &str) -> anyhow::Error {
    anyhow!("browser element reference '{reference}' is stale; take a new snapshot")
}

fn render_snapshot(raw: RawSnapshot) -> String {
    let mut lines = vec![format!("Title: {}", raw.title), format!("URL: {}", raw.url)];
    if !raw.headings.is_empty() {
        lines.push("Headings:".to_string());
        lines.extend(
            raw.headings
                .into_iter()
                .map(|heading| format!("- {heading}")),
        );
    }
    if !raw.text.is_empty() {
        lines.push("Text:".to_string());
        lines.extend(raw.text.into_iter().map(|text| format!("- {text}")));
    }
    lines.push("Interactive elements:".to_string());
    for element in raw.elements {
        let mut line = format!("[{}] <{}", element.reference, element.tag);
        if let Some(role) = element.role {
            line.push_str(&format!(" role={role}"));
        }
        if let Some(input_type) = element.input_type {
            line.push_str(&format!(" type={input_type}"));
        }
        if let Some(name) = element.name {
            line.push_str(&format!(" name={name:?}"));
        }
        if let Some(placeholder) = element.placeholder {
            line.push_str(&format!(" placeholder={placeholder:?}"));
        }
        line.push('>');
        if !element.label.is_empty() {
            line.push_str(&format!(" {}", element.label));
        }
        if let Some(href) = element.href {
            line.push_str(&format!(" href={href:?}"));
        }
        if element.sensitive {
            line.push_str(" [sensitive]");
        } else if let Some(value) = element.value.filter(|value| !value.is_empty()) {
            line.push_str(&format!(" value={value:?}"));
        }
        lines.push(line);
    }

    let text = lines.join("\n");
    truncate_snapshot(text)
}

fn truncate_snapshot(mut text: String) -> String {
    const MARKER: &str = "\n[... snapshot truncated ...]";
    if text.len() <= SNAPSHOT_LIMIT {
        return text;
    }
    let mut boundary = SNAPSHOT_LIMIT.saturating_sub(MARKER.len());
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    text.truncate(boundary);
    text.push_str(MARKER);
    text
}
