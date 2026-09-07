pub mod agent;
mod api_error;
mod attachment_upload;
pub mod auth;
pub mod config;
pub mod health;
pub mod threads;
pub mod transcript;
pub mod workspace;

#[derive(Debug)]
pub(crate) enum ExclusiveId<T> {
    Storage(T),
    LegacyUpload(T),
}

pub(crate) fn exclusive_id<T>(
    storage: Option<T>,
    image_upload: Option<T>,
    storage_name: &'static str,
    upload_name: &'static str,
) -> anyhow::Result<ExclusiveId<T>> {
    match (storage, image_upload) {
        (Some(storage), None) => Ok(ExclusiveId::Storage(storage)),
        (None, Some(image_upload)) => Ok(ExclusiveId::LegacyUpload(image_upload)),
        (Some(_), Some(_)) => anyhow::bail!("provide {storage_name} or {upload_name}, not both"),
        (None, None) => anyhow::bail!("provide {storage_name} or {upload_name}"),
    }
}

pub(crate) fn exclusive_id_or_storage_default<T: Default>(
    storage: Option<T>,
    image_upload: Option<T>,
    storage_name: &'static str,
    upload_name: &'static str,
) -> anyhow::Result<ExclusiveId<T>> {
    if storage.is_none() && image_upload.is_none() {
        return Ok(ExclusiveId::Storage(T::default()));
    }
    exclusive_id(storage, image_upload, storage_name, upload_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusive_id_rejects_both_and_keeps_each_legacy_path_separate() {
        assert!(matches!(
            exclusive_id(Some("storage"), None, "storageId", "imageUploadId").unwrap(),
            ExclusiveId::Storage("storage")
        ));
        assert!(matches!(
            exclusive_id(None, Some("upload"), "storageId", "imageUploadId").unwrap(),
            ExclusiveId::LegacyUpload("upload")
        ));
        assert!(
            exclusive_id(
                Some("storage"),
                Some("upload"),
                "storageId",
                "imageUploadId"
            )
            .unwrap_err()
            .to_string()
            .contains("not both")
        );
        assert!(
            exclusive_id::<&str>(None, None, "storageId", "imageUploadId")
                .unwrap_err()
                .to_string()
                .contains("provide storageId or imageUploadId")
        );
        assert!(matches!(
            exclusive_id_or_storage_default::<Vec<String>>(
                None,
                None,
                "storageIds",
                "imageUploadIds"
            )
            .unwrap(),
            ExclusiveId::Storage(ids) if ids.is_empty()
        ));
    }
}
