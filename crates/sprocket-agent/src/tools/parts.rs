use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::fmt;
use std::num::NonZeroU32;
use std::time::Duration;

use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Semaphore;

use super::context::{AgentToolContext, cancelled_error, tool_error};
use super::job::execute_tool_job;
use super::scrape_files::{exceeds_inline_limit, save_text};

const JLCPCB_SEARCH_URL: &str =
    "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2";
const LCSC_SEARCH_URL: &str = "https://wmsc.lcsc.com/ftps/wm/search/v3/global";
const LCSC_DETAIL_URL: &str = "https://wmsc.lcsc.com/ftps/wm/product/detail";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// JLCPCB answers 429 once more than about two searches are in flight.
const JLCPCB_CONCURRENCY: usize = 2;
const JLCPCB_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
];
const MAX_MATCHES: usize = 5;

#[derive(Clone)]
pub(crate) struct LookupPartsTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct LookupPartsArgs {
    #[schemars(length(min = 1))]
    parts: Vec<PartQuery>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct PartQuery {
    /// MPN or JLCPCB/LCSC code like `C2864583`.
    #[schemars(length(min = 1))]
    part: String,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    quantity: NonZeroU32,
}

fn one() -> NonZeroU32 {
    NonZeroU32::MIN
}

fn is_one(quantity: &NonZeroU32) -> bool {
    *quantity == NonZeroU32::MIN
}

impl rig::tool::Tool for LookupPartsTool {
    const NAME: &'static str = "lookup_parts";
    type Error = ToolExecutionError;
    type Args = LookupPartsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        format!(
            "Check JLCPCB and LCSC stock and USD prices for parts. Returns up to {MAX_MATCHES} exact matches per part, best first."
        )
    }

    fn parameters(&self) -> serde_json::Value {
        parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        validate(&args).map_err(tool_error)?;
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let cache_dir = self.0.transcript_dir.join(Self::NAME);
        let mut saved_file = None;
        let saved = &mut saved_file;
        let output = execute_tool_job(&self.0, Self::NAME, payload, |cancellation| async move {
            let results = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(cancelled_error()),
                results = lookup(&args) => results.map_err(tool_error)?,
            };
            let output = serde_json::to_value(results).map_err(|e| tool_error(e.into()))?;
            if !exceeds_inline_limit(&output.to_string()) {
                return Ok(output);
            }
            let contents =
                serde_json::to_string_pretty(&output).map_err(|e| tool_error(e.into()))?;
            let file = save_text(&cache_dir, &contents, ".json", &cancellation)
                .await
                .map_err(tool_error)?;
            let path = file.path().display().to_string();
            *saved = Some(file);
            Ok(json!({ "savedTo": path }))
        })
        .await?;
        if let Some(file) = saved_file.as_mut() {
            file.disable_cleanup(true);
        }
        Ok(output)
    }
}

/// schemars omits defaults that `skip_serializing_if` would skip.
fn parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(LookupPartsArgs));
    schema["$defs"]["PartQuery"]["properties"]["quantity"]["default"] = json!(1);
    schema
}

/// Results are keyed by `part`, and Convex record keys must be ASCII without a leading `$` or `_`.
fn validate(args: &LookupPartsArgs) -> anyhow::Result<()> {
    anyhow::ensure!(!args.parts.is_empty(), "provide at least one part");
    for PartQuery { part, .. } in &args.parts {
        anyhow::ensure!(
            !part.trim().is_empty() && part.is_ascii() && !part.starts_with(['$', '_']),
            "`{part}` is not a part number; use an ASCII MPN or JLCPCB/LCSC code"
        );
    }
    Ok(())
}

/// Repeated parts are looked up once and priced at their combined quantity.
async fn lookup(args: &LookupPartsArgs) -> anyhow::Result<BTreeMap<String, PartResult>> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("sprocket/", env!("CARGO_PKG_VERSION")))
        .timeout(REQUEST_TIMEOUT)
        .build()?;
    let jlcpcb_limit = Semaphore::new(JLCPCB_CONCURRENCY);
    let mut quantities = BTreeMap::<&str, u64>::new();
    for PartQuery { part, quantity } in &args.parts {
        *quantities.entry(part.as_str()).or_default() += u64::from(quantity.get());
    }
    let (client, jlcpcb_limit) = (&client, &jlcpcb_limit);
    let lookups = quantities.into_iter().map(|(part, quantity)| async move {
        let result = lookup_part(client, jlcpcb_limit, part.trim(), quantity).await;
        (part.to_owned(), result)
    });
    Ok(futures::future::join_all(lookups)
        .await
        .into_iter()
        .collect())
}

async fn lookup_part(
    client: &reqwest::Client,
    jlcpcb_limit: &Semaphore,
    part: &str,
    quantity: u64,
) -> PartResult {
    let (jlcpcb, lcsc) = tokio::join!(
        jlcpcb_rows(client, jlcpcb_limit, part),
        lcsc_products(client, part)
    );
    let mut errors = BTreeMap::new();
    let jlcpcb = jlcpcb.unwrap_or_else(|error| {
        errors.insert("jlcpcb", error.to_string());
        Vec::new()
    });
    let lcsc = lcsc.unwrap_or_else(|error| {
        errors.insert("lcsc", error.to_string());
        Vec::new()
    });
    PartResult {
        matches: merge(jlcpcb, lcsc, quantity),
        errors,
    }
}

enum SourceError {
    RateLimited,
    TimedOut,
    Http(u16),
    Failed,
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RateLimited => f.write_str("rate limited"),
            Self::TimedOut => f.write_str("timed out"),
            Self::Http(status) => write!(f, "failed (HTTP {status})"),
            Self::Failed => f.write_str("failed"),
        }
    }
}

impl From<reqwest::Error> for SourceError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::TimedOut
        } else {
            Self::Failed
        }
    }
}

async fn read_json<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, SourceError> {
    let response = request.send().await?;
    match response.status() {
        reqwest::StatusCode::TOO_MANY_REQUESTS => Err(SourceError::RateLimited),
        status if !status.is_success() => Err(SourceError::Http(status.as_u16())),
        _ => Ok(response.json().await?),
    }
}

async fn jlcpcb_rows(
    client: &reqwest::Client,
    limit: &Semaphore,
    part: &str,
) -> Result<Vec<JlcpcbRow>, SourceError> {
    let body = json!({
        "currentPage": 1,
        "pageSize": 50,
        "keyword": part,
        "searchType": 2,
        "sortMode": "STOCK_SORT",
        "sortASC": "DESC",
    });
    let mut retry_delays = JLCPCB_RETRY_DELAYS.into_iter();
    let response = loop {
        let result = {
            let _permit = limit.acquire().await.map_err(|_| SourceError::Failed)?;
            read_json::<JlcpcbResponse>(client.post(JLCPCB_SEARCH_URL).json(&body)).await
        };
        match (result, retry_delays.next()) {
            (Err(SourceError::RateLimited), Some(delay)) => tokio::time::sleep(delay).await,
            (result, _) => break result?,
        }
    };
    Ok(jlcpcb_matches(response, part))
}

fn jlcpcb_matches(response: JlcpcbResponse, part: &str) -> Vec<JlcpcbRow> {
    let rows = response.data.component_page_info.list.unwrap_or_default();
    rows.into_iter()
        .filter(|row| {
            is_exact(part, &row.component_code, row.component_model_en.as_deref())
                && !row.is_consignment()
        })
        .collect()
}

async fn lcsc_products(
    client: &reqwest::Client,
    part: &str,
) -> Result<Vec<LcscProduct>, SourceError> {
    let search: LcscResponse<LcscSearch> = read_json(
        client
            .post(LCSC_SEARCH_URL)
            .json(&json!({ "keyword": part })),
    )
    .await?;
    let search = search.result.ok_or(SourceError::Failed)?;
    let products = match search.scene.as_str() {
        "FULL_MATCH" => search.exact_match_result.unwrap_or_default(),
        "REDIRECT_PRODUCT_DETAIL" => {
            let url = reqwest::Url::parse_with_params(
                LCSC_DETAIL_URL,
                [("productCode", normalize(part))],
            )
            .map_err(|_| SourceError::Failed)?;
            let detail: LcscResponse<LcscProduct> = read_json(client.get(url)).await?;
            detail.result.into_iter().collect()
        }
        _ => Vec::new(),
    };
    Ok(lcsc_matches(products, part))
}

fn lcsc_matches(products: Vec<LcscProduct>, part: &str) -> Vec<LcscProduct> {
    products
        .into_iter()
        .filter(|product| {
            is_exact(
                part,
                &product.product_code,
                product.product_model.as_deref(),
            )
        })
        .collect()
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

fn is_exact(part: &str, code: &str, mpn: Option<&str>) -> bool {
    let part = normalize(part);
    normalize(code) == part || mpn.is_some_and(|mpn| normalize(mpn) == part)
}

fn merge(jlcpcb: Vec<JlcpcbRow>, lcsc: Vec<LcscProduct>, quantity: u64) -> Vec<PartMatch> {
    let mut by_code = BTreeMap::<String, PartMatch>::new();
    for row in jlcpcb {
        let entry = by_code
            .entry(normalize(&row.component_code))
            .or_insert_with(|| PartMatch::new(&row.component_code));
        let library = match (
            row.preferred_component_flag,
            row.component_library_type.as_deref(),
        ) {
            (Some(true), _) => Library::Preferred,
            (_, Some("base")) => Library::Basic,
            _ => Library::Extended,
        };
        let breaks = row.component_prices.unwrap_or_default().into_iter();
        let (price, price_breaks) = priced(
            breaks
                .map(|p| PriceBreak {
                    quantity: p.start_number,
                    price: p.product_price,
                })
                .collect(),
            quantity,
        );
        entry.jlcpcb = Some(JlcpcbOffer {
            stock: row.stock_count.unwrap_or_default(),
            price,
            price_breaks,
            moq: above_one(row.min_purchase_num),
            library,
            assembly_min: above_one(row.least_patch_number),
        });
        entry.apply(Details {
            mpn: row.component_model_en,
            manufacturer: row.component_brand_en,
            package: row.component_specification_en,
            description: row.describe,
            datasheet: row.data_manual_url,
        });
    }
    for product in lcsc {
        let entry = by_code
            .entry(normalize(&product.product_code))
            .or_insert_with(|| PartMatch::new(&product.product_code));
        let breaks = product.product_price_list.unwrap_or_default().into_iter();
        let (price, price_breaks) = priced(
            breaks
                .filter_map(|p| {
                    Some(PriceBreak {
                        quantity: p.ladder,
                        price: p.usd_price?,
                    })
                })
                .collect(),
            quantity,
        );
        entry.lcsc = Some(LcscOffer {
            stock: product.stock_number.unwrap_or_default(),
            price,
            price_breaks,
            moq: above_one(product.min_buy_number),
            multiple: above_one(product.split),
        });
        entry.apply(Details {
            mpn: product.product_model,
            manufacturer: product.brand_name_en,
            package: product.encap_standard,
            description: product.product_desc_en,
            datasheet: product.pdf_url,
        });
    }
    let mut matches: Vec<_> = by_code.into_values().collect();
    matches.sort_by_key(|m| {
        let jlcpcb_stock = m.jlcpcb.as_ref().map_or(0, |offer| offer.stock);
        let lcsc_stock = m.lcsc.as_ref().map_or(0, |offer| offer.stock);
        (
            m.jlcpcb.is_none(),
            m.jlcpcb.as_ref().map(|offer| offer.library),
            Reverse(jlcpcb_stock + lcsc_stock),
        )
    });
    matches.truncate(MAX_MATCHES);
    matches
}

/// Below the first break, the first break's price applies.
fn priced(mut breaks: Vec<PriceBreak>, quantity: u64) -> (Option<f64>, Vec<PriceBreak>) {
    breaks.sort_by_key(|b| b.quantity);
    let price = breaks
        .iter()
        .rev()
        .find(|b| b.quantity <= quantity)
        .or(breaks.first())
        .map(|b| b.price);
    (price, breaks)
}

fn above_one(value: Option<u64>) -> Option<u64> {
    value.filter(|&value| value > 1)
}

#[derive(Serialize)]
struct PartResult {
    matches: Vec<PartMatch>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    errors: BTreeMap<&'static str, String>,
}

#[derive(Serialize)]
struct PartMatch {
    code: String,
    mpn: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    package: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    datasheet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    jlcpcb: Option<JlcpcbOffer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lcsc: Option<LcscOffer>,
}

struct Details {
    mpn: Option<String>,
    manufacturer: Option<String>,
    package: Option<String>,
    description: Option<String>,
    datasheet: Option<String>,
}

impl PartMatch {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
            mpn: String::new(),
            manufacturer: None,
            package: None,
            description: None,
            datasheet: None,
            jlcpcb: None,
            lcsc: None,
        }
    }

    /// Overwrites with every present value, so applying LCSC after JLCPCB makes LCSC win.
    fn apply(&mut self, details: Details) {
        let present = |value: Option<String>| value.filter(|value| !value.trim().is_empty());
        if let Some(mpn) = present(details.mpn) {
            self.mpn = mpn;
        }
        for (field, value) in [
            (&mut self.manufacturer, details.manufacturer),
            (&mut self.package, details.package),
            (&mut self.description, details.description),
            (&mut self.datasheet, details.datasheet),
        ] {
            if let Some(value) = present(value) {
                *field = Some(value);
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JlcpcbOffer {
    stock: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    price: Option<f64>,
    price_breaks: Vec<PriceBreak>,
    #[serde(skip_serializing_if = "Option::is_none")]
    moq: Option<u64>,
    library: Library,
    #[serde(skip_serializing_if = "Option::is_none")]
    assembly_min: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LcscOffer {
    stock: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    price: Option<f64>,
    price_breaks: Vec<PriceBreak>,
    #[serde(skip_serializing_if = "Option::is_none")]
    moq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    multiple: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
enum Library {
    Preferred,
    Basic,
    Extended,
}

#[derive(Serialize)]
struct PriceBreak {
    quantity: u64,
    price: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JlcpcbResponse {
    data: JlcpcbData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JlcpcbData {
    component_page_info: JlcpcbPage,
}

#[derive(Deserialize)]
struct JlcpcbPage {
    list: Option<Vec<JlcpcbRow>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JlcpcbRow {
    component_code: String,
    component_model_en: Option<String>,
    component_brand_en: Option<String>,
    component_specification_en: Option<String>,
    describe: Option<String>,
    stock_count: Option<u64>,
    component_prices: Option<Vec<JlcpcbPrice>>,
    component_library_type: Option<String>,
    preferred_component_flag: Option<bool>,
    min_purchase_num: Option<u64>,
    least_patch_number: Option<u64>,
    data_manual_url: Option<String>,
    lcsc_goods_url: Option<String>,
}

impl JlcpcbRow {
    /// Consigned stock belongs to other customers; this covers `-YJLTY` and "JLCPCB Assembly" rows.
    fn is_consignment(&self) -> bool {
        self.stock_count.unwrap_or_default() == 0 && self.lcsc_goods_url.is_none()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JlcpcbPrice {
    start_number: u64,
    product_price: f64,
}

#[derive(Deserialize)]
struct LcscResponse<T> {
    result: Option<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LcscSearch {
    scene: String,
    exact_match_result: Option<Vec<LcscProduct>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LcscProduct {
    product_code: String,
    product_model: Option<String>,
    brand_name_en: Option<String>,
    encap_standard: Option<String>,
    product_desc_en: Option<String>,
    stock_number: Option<u64>,
    product_price_list: Option<Vec<LcscPrice>>,
    min_buy_number: Option<u64>,
    split: Option<u64>,
    pdf_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LcscPrice {
    ladder: u64,
    usd_price: Option<f64>,
}

#[cfg(test)]
mod tests;
