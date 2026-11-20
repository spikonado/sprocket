use serde_json::json;

use super::*;

#[test]
fn repository_keys_match_the_convex_wire_shape() {
    for keys in [json!("all"), json!(["github.com/acme/robot"])] {
        let args: ListThreadsArgs =
            serde_json::from_value(json!({ "repositoryKeys": keys.clone() })).unwrap();
        assert_eq!(serde_json::to_value(&args).unwrap()["repositoryKeys"], keys);
    }
}
