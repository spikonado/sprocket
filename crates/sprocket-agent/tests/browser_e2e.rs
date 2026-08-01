use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use anyhow::Result;
use sprocket_agent::browser::{BrowserSession, PaymentField, find_browser_binary};

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
async fn fills_payment_fields_in_mock_checkout() -> Result<()> {
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

    let browser = BrowserSession::connect("").await?;
    let checkout_url = serde_json::to_string(&format!("http://{address}/checkout"))?;
    let _ = browser
        .evaluate_json(&format!("window.location.href = {checkout_url}"))
        .await;
    let mut loaded = false;
    for _ in 0..100 {
        if browser
            .evaluate_json("document.title === 'Mock checkout'")
            .await
            .ok()
            .and_then(|value| value.as_bool())
            == Some(true)
        {
            loaded = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(loaded, "mock checkout did not load");

    browser
        .fill_payment_field(PaymentField::Number, "4111111111111111")
        .await?;
    browser.fill_payment_field(PaymentField::Cvv, "123").await?;
    browser
        .fill_payment_field(PaymentField::Expiry, "12\u{0}30")
        .await?;
    assert_eq!(
        browser
            .evaluate_json(
                r#"({
                  cardNumber: document.querySelector("[name=cardNumber]").value,
                  cvv: document.querySelector("[name=cvv]").value,
                  expMonth: document.querySelector("[name=expMonth]").value,
                  expYear: document.querySelector("[name=expYear]").value,
                })"#,
            )
            .await?,
        serde_json::json!({
            "cardNumber": "4111111111111111",
            "cvv": "123",
            "expMonth": "12",
            "expYear": "30",
        })
    );

    server.join().unwrap();
    Ok(())
}
