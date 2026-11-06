use super::*;

const URL: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=abc";

#[test]
fn finds_the_sign_in_link() {
    let raw = format!(
        "\x1b]8;id=1;https://example.com\x07docs\x1b]8;;\x07\r\n\x1b]8;id=1cn7z5o;{URL}\x07\x1b[38;5;246m{URL}\x1b[39m\x1b]8;;\x07\r\r\n"
    );
    assert_eq!(authorize_url(&raw).as_deref(), Some(URL));
}

#[test]
fn reads_cursor_moves_as_spaces() {
    let raw = "\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b]8;;\x07\r\r\n\x1b[38;5;153mPress \x1b[1mEnter\x1b[22m to retry.";
    assert_eq!(screen_text(raw), "Paste code here Press Enter to retry.");
}

#[test]
fn reads_the_token_once_it_arrived_whole() {
    let token = "sk-ant-oat01-Ab_9-xY";
    assert_eq!(oauth_token(&format!("\x1b[2G{token}")), None);
    assert_eq!(
        oauth_token(&format!("\x1b[2G{token}\r\n")).as_deref(),
        Some(token)
    );
}

#[test]
fn reads_the_oauth_error() {
    let raw = "\x1b[38;5;211mOAuth error: That code wasn't accepted.\r\x1b[2B\x1b[39m\x1b[K\r\x1b[1C\x1b[1B\x1b[38;5;153mPress \x1b[1mEnter\x1b[22m to retry.";
    assert_eq!(
        oauth_error(raw).as_deref(),
        Some("That code wasn't accepted.")
    );
}
