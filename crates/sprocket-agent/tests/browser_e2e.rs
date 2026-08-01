use std::io::{Read, Write};
use std::net::TcpListener;

use anyhow::Result;
use sprocket_agent::browser::{BrowserSession, PaymentField, ScrollDirection, find_browser_binary};

const CHECKOUT_HTML: &str = r#"<!doctype html>
<html>
  <head><title>Mock checkout</title></head>
  <body style="min-height: 2400px">
    <main>
      <h1>Checkout</h1>
      <form onsubmit="event.preventDefault(); this.dataset.paid = 'yes'">
        <label>Full name <input name="fullName" autocomplete="name"></label>
        <label>Address <input name="address" autocomplete="street-address"></label>
        <label>Country
          <select name="country">
            <option value="US">United States</option>
            <option value="CA">Canada</option>
          </select>
        </label>
        <label>Card number <input name="cardNumber" autocomplete="cc-number"></label>
        <label>Expiry <input name="expiry" autocomplete="cc-exp"></label>
        <label>CVV <input name="cvv" autocomplete="cc-csc"></label>
        <button type="submit">Pay now</button>
      </form>
      <form id="split">
        <label>Exp month <input name="expMonth" autocomplete="cc-exp-month"></label>
        <label>Exp year <input name="expYear" autocomplete="cc-exp-year"></label>
      </form>
    </main>
  </body>
</html>"#;

#[tokio::test]
async fn drives_mock_checkout_without_exposing_payment_values() -> Result<()> {
    let Some(browser_path) = find_browser_binary() else {
        eprintln!("skipping browser e2e test: no Chromium browser binary found");
        return Ok(());
    };

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let server = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                CHECKOUT_HTML.len(),
                CHECKOUT_HTML
            );
            stream.write_all(response.as_bytes()).unwrap();
        }
    });

    // Rust 2024 makes process-environment mutation unsafe because other threads
    // can read concurrently. This integration test is the sole owner of these
    // Sprocket-specific variables.
    unsafe {
        std::env::set_var("SPROCKET_BROWSER_LOCAL", "1");
        std::env::set_var("SPROCKET_BROWSER_PATH", &browser_path);
        std::env::remove_var("SPROCKET_BROWSER_CONNECT_URL");
    }

    let mut browser = BrowserSession::connect("").await?;
    let snapshot = browser
        .navigate(&format!("http://{address}/checkout"))
        .await?;
    let initial = snapshot.as_str();
    assert!(initial.contains("Mock checkout"));
    assert!(initial.contains("name=\"fullName\""));
    assert!(initial.contains("name=\"cardNumber\""));
    assert!(initial.contains("name=\"expiry\""));
    assert!(initial.contains("name=\"cvv\""));
    assert!(initial.matches("[sensitive]").count() >= 3);

    let address_ref = element_ref(initial, "name=\"address\"");
    let country_ref = element_ref(initial, "name=\"country\"");
    let pay_ref = element_ref(initial, "Pay now");

    browser
        .fill_payment_field(PaymentField::Number, "4111111111111111")
        .await?;
    assert_eq!(
        browser
            .evaluate_json("document.querySelector('[name=cardNumber]').value")
            .await?,
        "4111111111111111"
    );
    let post_fill = browser.snapshot().await?;
    assert!(!post_fill.as_str().contains("4111111111111111"));
    assert!(post_fill.as_str().matches("[sensitive]").count() >= 3);

    browser.type_text(&address_ref, "1 Test Lane").await?;
    assert_eq!(
        browser
            .evaluate_json("document.querySelector('[name=address]').value")
            .await?,
        "1 Test Lane"
    );
    browser.select_option(&country_ref, "CA").await?;
    assert_eq!(
        browser
            .evaluate_json("document.querySelector('[name=country]').value")
            .await?,
        "CA"
    );
    browser.scroll(ScrollDirection::Down).await?;
    assert!(
        browser
            .evaluate_json("window.scrollY")
            .await?
            .as_f64()
            .unwrap_or_default()
            > 0.0
    );
    browser.click(&pay_ref).await?;
    assert_eq!(
        browser
            .evaluate_json("document.querySelector('form').dataset.paid")
            .await?,
        "yes"
    );

    // Split month/year fields: combined expiry "12\034" fills month then year
    // separately, and the year field must not receive the combined value.
    browser
        .fill_payment_field(PaymentField::Expiry, "12\u{0}30")
        .await?;
    assert_eq!(
        browser
            .evaluate_json("document.querySelector('[name=expMonth]').value")
            .await?,
        "12"
    );
    assert_eq!(
        browser
            .evaluate_json("document.querySelector('[name=expYear]').value")
            .await?,
        "30"
    );

    server.join().unwrap();
    Ok(())
}

fn element_ref(snapshot: &str, marker: &str) -> String {
    let line = snapshot
        .lines()
        .find(|line| line.contains(marker))
        .unwrap_or_else(|| panic!("snapshot did not contain {marker:?}"));
    line.strip_prefix('[')
        .and_then(|value| value.split_once(']'))
        .map(|(reference, _)| reference.to_string())
        .unwrap_or_else(|| panic!("snapshot line had no element reference: {line}"))
}
