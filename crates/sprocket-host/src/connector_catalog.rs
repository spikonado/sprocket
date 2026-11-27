use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct Connector {
    pub id: String,
    pub name: String,
    pub description: String,
}

pub(crate) static CATALOG: LazyLock<Vec<Connector>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../connector-catalog.json"))
        .expect("valid reviewed connector catalog")
});

pub(crate) fn find(id: &str) -> Option<&'static Connector> {
    CATALOG.iter().find(|connector| connector.id == id)
}
