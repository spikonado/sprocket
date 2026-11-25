use serde_json::json;

use super::*;

#[test]
fn redacts_known_formats_and_random_tokens() {
    for (input, expected) in [
        (
            "OPENAI_API_KEY=sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5",
            "OPENAI_API_KEY=[redacted:openai-key]",
        ),
        (
            "token ghp_YQKG3NZUybE8CJqHhfmRxpysOBgPfmNd9wzM",
            "token [redacted:github-token]",
        ),
        ("aws AKIAIOSFODNN7EXAMPLE", "aws [redacted:aws-access-key]"),
        (
            "-SLACK=x\n-xoxb-123456789012-ab12cd34ef56",
            "-SLACK=x\n-[redacted:slack-token]",
        ),
        (
            "postgres://app:s3cr3tPass@db:5432/app",
            "postgres://app:[redacted:password]@db:5432/app",
        ),
        (
            "key Zx7Qp2Lm9Vb4Nc8Rt1Ws6Yh3Kd5Jf0",
            "key [redacted:high-entropy]",
        ),
        (
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
            "[redacted:private-key]",
        ),
    ] {
        assert_eq!(redact_secrets(input), expected, "{input}");
    }
}

#[test]
fn keeps_ids_hashes_and_code_that_look_random() {
    let text = [
        "commit f59964f3a1b2c3d4e5f60718293a4b5c6d7e8f90",
        "thread js724ftx3y7e6d5e1n73egy7t58jw025",
        "user user_01KXVEGKXJPVMPPVEAWY4T7DWB",
        "uuid 25e57611-c2cb-4934-8142-fde1a3644a46",
        "\"sha512-1Duyg48TdJNdyhEB8Xn1L36bT9Pv6GUtlKjHxOys8xkaF/rQq3XJE+bAurSK/AgIz5mGFsb77cn9Pb20+WCScw==\"",
        "narHash = \"sha256-Zx7Qp2Lm9Vb4Nc8Rt1Ws6Yh3Kd5Jf0Aa/Q3v9xYb2LmN8pR4tW6zA1cD5=\"",
        "useTranscriptRowsVirtualizer2 attachmentDownloadByStorageId",
        "password: process.env.DB_PASSWORD",
        "let token = uuid::Uuid::new_v4();",
        "max_tokens: Option<u64>,",
    ]
    .join("\n");
    assert_eq!(redact_secrets(&text), text);
}

#[test]
fn redacts_reply_text_and_tool_input_but_keeps_reasoning() {
    let text = "use sk-proj-Q3v9xYb2LmN8pR4tW6zA1cD5";
    let reasoning = json!({
        "type": "reasoning",
        "id": "r",
        "text": text,
        "providerMetadata": { "rigNative": { "type": "thinking", "signature": "sig" } },
    });
    let mut items = [
        reasoning.clone(),
        json!({ "type": "text", "id": "t", "text": text }),
        json!({ "type": "tool-call", "input": { "cmd": [text] } }),
    ];
    items.iter_mut().for_each(redact_completion_item);
    let redacted = "use [redacted:openai-key]";
    assert_eq!(
        items,
        [
            reasoning,
            json!({ "type": "text", "id": "t", "text": redacted }),
            json!({ "type": "tool-call", "input": { "cmd": [redacted] } }),
        ]
    );
}
