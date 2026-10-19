use super::{ImageUrlMap, ImageUrlSource};
use crate::tools::parse_file::ReplayedImage;

impl ImageUrlSource for ImageUrlMap {
    async fn urls(&self, _: &[&ReplayedImage]) -> ImageUrlMap {
        self.clone()
    }
}
