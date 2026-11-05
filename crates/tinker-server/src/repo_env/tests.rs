use super::*;

#[test]
fn compile_time_env_var_rejects_private_keys() {
    assert_eq!(compile_time_env_var("OPENAI_API_KEY"), None);
}
