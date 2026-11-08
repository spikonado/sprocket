use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use anyhow::Context;
use convex::Value;
use rig::message::MimeType;
use serde::Deserialize;

use super::convert::ReplayedImage;
use crate::convex::RuntimeClient;

/// Matches the per-call cap of `imageUploads:toolImageUrlsForRun`.
const MAX_IMAGES_PER_LOOKUP: usize = 100;
const CONCURRENT_UPLOADS: usize = 4;

pub(super) type ImageUrlMap = HashMap<String, Result<String, String>>;

pub(crate) struct ConvexImageUrls<'a> {
    runtime: &'a RuntimeClient,
    run_id: &'a str,
}

impl<'a> ConvexImageUrls<'a> {
    pub(crate) fn new(runtime: &'a RuntimeClient, run_id: &'a str) -> Self {
        Self { runtime, run_id }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredImage {
    Live {
        sha256: String,
        url: String,
    },
    Missing {
        sha256: String,
        #[serde(rename = "uploadUrl")]
        upload_url: String,
    },
}

impl ConvexImageUrls<'_> {
    pub(super) async fn urls(&self, images: &[&ReplayedImage]) -> ImageUrlMap {
        let by_hash: HashMap<&str, &ReplayedImage> = images
            .iter()
            .map(|image| (image.sha256.as_str(), *image))
            .collect();
        let hashes: Vec<&str> = by_hash.keys().copied().collect();
        let mut urls = ImageUrlMap::new();
        let mut uploads = Vec::new();
        for chunk in hashes.chunks(MAX_IMAGES_PER_LOOKUP) {
            match self.lookup(chunk).await {
                Ok(stored) => {
                    for image in stored {
                        match image {
                            StoredImage::Live { sha256, url } => {
                                urls.insert(sha256, Ok(url));
                            }
                            StoredImage::Missing { sha256, upload_url } => {
                                if let Some(image) = by_hash.get(sha256.as_str()) {
                                    uploads.push((*image, upload_url));
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    let error = format!("image URL lookup failed: {error:#}");
                    for sha256 in chunk {
                        urls.insert((*sha256).to_string(), Err(error.clone()));
                    }
                }
            }
        }
        if uploads.is_empty() {
            return urls;
        }
        let client = match upload_client() {
            Ok(client) => client,
            Err(error) => {
                let error = format!("image upload client failed: {error:#}");
                for (image, _) in uploads {
                    urls.insert(image.sha256.clone(), Err(error.clone()));
                }
                return urls;
            }
        };
        // A stream of async closures fails the `Send` check rig's tool futures
        // need (rust-lang/rust#102211).
        for chunk in uploads.chunks(CONCURRENT_UPLOADS) {
            let mut pending = Vec::with_capacity(chunk.len());
            for (image, upload_url) in chunk {
                pending.push(self.upload(&client, image, upload_url));
            }
            let results = futures::future::join_all(pending).await;
            for ((image, _), result) in chunk.iter().zip(results) {
                urls.insert(
                    image.sha256.clone(),
                    result.map_err(|error| format!("image upload failed: {error:#}")),
                );
            }
        }
        urls
    }

    async fn lookup(&self, sha256s: &[&str]) -> anyhow::Result<Vec<StoredImage>> {
        let args = BTreeMap::from([
            ("runId".to_string(), Value::from(self.run_id)),
            (
                "sha256s".to_string(),
                Value::Array(sha256s.iter().map(|sha256| Value::from(*sha256)).collect()),
            ),
        ]);
        self.runtime
            .mutation_json("imageUploads:toolImageUrlsForRun", args)
            .await
    }

    async fn upload(
        &self,
        client: &reqwest::Client,
        image: &ReplayedImage,
        upload_url: &str,
    ) -> anyhow::Result<String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct StorageUpload {
            storage_id: String,
        }
        let uploaded: StorageUpload = client
            .post(upload_url)
            .header(
                reqwest::header::CONTENT_TYPE,
                image.image.media_type.to_mime_type(),
            )
            .body(image.image.bytes.clone())
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(reqwest::Error::without_url)
            .context("image upload rejected")?
            .json()
            .await
            .map_err(reqwest::Error::without_url)
            .context("image upload returned no storage id")?;
        let args = BTreeMap::from([
            ("runId".to_string(), Value::from(self.run_id)),
            ("storageId".to_string(), uploaded.storage_id.into()),
            ("sha256".to_string(), image.sha256.clone().into()),
        ]);
        self.runtime
            .mutation_json("imageUploads:registerToolImageForRun", args)
            .await
    }
}

fn upload_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(120))
        .build()
}
