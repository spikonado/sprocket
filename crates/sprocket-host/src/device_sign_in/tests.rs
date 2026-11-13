use super::*;

fn prompt(output: &str) -> Option<SignInStatus> {
    let mut prompt = Prompt::default();
    for line in output.lines() {
        prompt.read(line);
    }
    prompt.status()
}

#[test]
fn reads_the_github_cli_code_and_url() {
    let output = "\n! First copy your one-time code: 5FA1-D4A6\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
    assert_eq!(
        prompt(output),
        Some(SignInStatus::Waiting {
            url: "https://github.com/login/device".to_string(),
            code: Some("5FA1-D4A6".to_string()),
        })
    );
}

#[test]
fn reads_the_vercel_code_from_its_url() {
    let output = "Vercel CLI 65.14.0\n> \n  Visit https://vercel.com/oauth/device?user_code=ZRGV-CPJR\n\nWaiting for authentication...\n";
    assert_eq!(
        prompt(output),
        Some(SignInStatus::Waiting {
            url: "https://vercel.com/oauth/device?user_code=ZRGV-CPJR".to_string(),
            code: Some("ZRGV-CPJR".to_string()),
        })
    );
}
