use super::{ImageUrlMap, ImageUrlSource};
use crate::tools::parse_file::ReplayedImage;

impl ImageUrlSource for ImageUrlMap {
    async fn urls(&self, images: &[&ReplayedImage]) -> ImageUrlMap {
        images
            .iter()
            .filter_map(|image| Some((image.sha256.clone(), self.get(&image.sha256)?.clone())))
            .collect()
    }
}
