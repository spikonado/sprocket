use super::*;

#[test]
fn maps_each_provider_to_the_model_and_not_its_variants() {
    let api: Api = serde_json::from_value(serde_json::json!({
        "vercel": {"models": {
            "openai/gpt-6.1-sol-fast": {"canonical_model_id": "openai/gpt-6.1-sol"},
            "openai/gpt-6.1-sol": {"canonical_model_id": "openai/gpt-6.1-sol"},
        }},
        "opencode-go": {"models": {
            "deepseek-v4.1-flash": {"canonical_model_id": "deepseek/deepseek-v4.1-flash"},
            "glm-5.2": {"canonical_model_id": null},
        }},
    }))
    .unwrap();
    let index = index(api);
    assert_eq!(
        index["openai/gpt-6.1-sol"],
        HashMap::from([("vercel", "openai/gpt-6.1-sol".to_string())])
    );
    assert_eq!(
        index["deepseek/deepseek-v4.1-flash"],
        HashMap::from([("opencode-go", "deepseek-v4.1-flash".to_string())])
    );
    assert_eq!(index.len(), 2);
}
