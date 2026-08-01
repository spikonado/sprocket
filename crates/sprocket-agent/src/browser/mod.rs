use std::path::PathBuf;

use anyhow::{Context, anyhow};
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::page::Page;
use futures::StreamExt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentField {
    Number,
    Cvv,
    Expiry,
}

pub struct BrowserSession {
    _browser: Browser,
    page: Page,
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
            _handler_task: handler_task,
        })
    }

    pub async fn fill_payment_field(&self, field: PaymentField, value: &str) -> anyhow::Result<()> {
        if field == PaymentField::Expiry {
            // The executor packs "MM\0YY" so split month/year fields can be
            // filled independently. Fall back to a single combined field when
            // no separate month/year inputs exist.
            let mut parts = value.split('\u{0}');
            let month = parts.next().unwrap_or("");
            let year = parts.next().unwrap_or("");
            return self.fill_expiry(month, year).await;
        }
        let field_name = match field {
            PaymentField::Number => "number",
            PaymentField::Cvv => "cvv",
            PaymentField::Expiry => unreachable!(),
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
        // Clear any existing value so retries never append digits.
        let cleared: bool = self
            .page
            .evaluate_expression(
                r#"(() => {
                  const el = document.querySelector("[data-sprocket-payment-target]");
                  if (!el) return false;
                  el.focus();
                  el.value = "";
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  return true;
                })()"#,
            )
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?
            .into_value()
            .map_err(|_| anyhow!("failed to fill the payment field"))?;
        if !cleared {
            return Err(anyhow!("failed to fill the payment field"));
        }
        element
            .type_str(value)
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?;
        Ok(())
    }

    /// Fill expiry into either split month/year inputs (preferred) or a single
    /// combined field. Values never appear in returns, logs, or errors.
    async fn fill_expiry(&self, month: &str, year: &str) -> anyhow::Result<()> {
        let expression = r#"(() => {
          document.querySelectorAll("[data-sprocket-exp-month],[data-sprocket-exp-year],[data-sprocket-payment-target]")
            .forEach(el => {
              el.removeAttribute("data-sprocket-exp-month");
              el.removeAttribute("data-sprocket-exp-year");
              el.removeAttribute("data-sprocket-payment-target");
            });
          const inputs = Array.from(document.querySelectorAll("input"));
          const meta = (el) => [
            (el.autocomplete || "").toLowerCase(), el.name, el.id,
            el.placeholder, el.getAttribute("aria-label")
          ].filter(Boolean).join(" ").toLowerCase();
          let monthEl = null, yearEl = null;
          for (const el of inputs) {
            const ac = (el.autocomplete || "").toLowerCase();
            const m = meta(el);
            if (ac === "cc-exp-month" || /exp.?month|\bmm\b/.test(m)) monthEl = monthEl || el;
            if (ac === "cc-exp-year" || /exp.?year|\byy\b/.test(m)) yearEl = yearEl || el;
          }
          if (monthEl && yearEl) {
            monthEl.setAttribute("data-sprocket-exp-month", "true");
            yearEl.setAttribute("data-sprocket-exp-year", "true");
            return "split";
          }
          let combined = null, score = 0;
          for (const el of inputs) {
            const ac = (el.autocomplete || "").toLowerCase();
            const m = meta(el);
            let s = 0;
            if (ac === "cc-exp") s = 100;
            else if (/expir|exp.?date|mm.?\/?.?yy/.test(m)) s = 40;
            if (s > score) { score = s; combined = el; }
          }
          if (combined) {
            combined.setAttribute("data-sprocket-payment-target", "true");
            return "combined";
          }
          return "none";
        })()"#;
        let mode: String = self
            .page
            .evaluate_expression(expression)
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?
            .into_value()
            .map_err(|_| anyhow!("failed to fill the payment field"))?;
        match mode.as_str() {
            "split" => {
                self.fill_marked("[data-sprocket-exp-month]", month).await?;
                self.fill_marked("[data-sprocket-exp-year]", year).await?;
                Ok(())
            }
            "combined" => {
                self.fill_marked("[data-sprocket-payment-target]", &format!("{month}/{year}"))
                    .await
            }
            _ => Err(anyhow!("no matching payment field was found")),
        }
    }

    /// Clear then type into the element marked by `selector`. Value is never
    /// echoed into returns, logs, or errors.
    async fn fill_marked(&self, selector: &str, value: &str) -> anyhow::Result<()> {
        let element = self
            .page
            .find_element(selector)
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?;
        let cleared: bool = self
            .page
            .evaluate_expression(format!(
                r#"(() => {{
                  const el = document.querySelector({});
                  if (!el) return false;
                  el.focus();
                  el.value = "";
                  el.dispatchEvent(new Event("input", {{ bubbles: true }}));
                  return true;
                }})()"#,
                serde_json::to_string(selector)?
            ))
            .await
            .map_err(|_| anyhow!("failed to fill the payment field"))?
            .into_value()
            .map_err(|_| anyhow!("failed to fill the payment field"))?;
        if !cleared {
            return Err(anyhow!("failed to fill the payment field"));
        }
        element
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
