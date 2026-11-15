use std::future::Future;
use std::time::Duration;

use super::{TranscriptPart, TranscriptStore};

const PAGE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

impl TranscriptStore {
    /// Downloads the newest missing page in `start..end`. Returns `false` when none is missing.
    ///
    /// `fetch(from, to)` returns the newest parts of `from..to`, newest first.
    pub async fn download_missing_page<F, Fut>(
        &self,
        user: &str,
        thread: &str,
        start: u32,
        end: u32,
        fetch: F,
    ) -> anyhow::Result<bool>
    where
        F: FnOnce(u32, u32) -> Fut,
        Fut: Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
    {
        let lock = self.lock_key(format!("download/{user}/{thread}")).await;
        let _guard = lock.lock().await;
        let _lease = self.open_thread(user, thread).await?;
        let Some((from, to)) = self.missing_page(user, thread, start, end).await? else {
            return Ok(false);
        };
        let parts = tokio::time::timeout(PAGE_DOWNLOAD_TIMEOUT, fetch(from, to))
            .await
            .map_err(|_| anyhow::anyhow!("transcript page download timed out"))??;
        anyhow::ensure!(
            !parts.is_empty()
                && parts.len() <= (to - from) as usize
                && parts
                    .iter()
                    .zip((from..to).rev())
                    .all(|(part, number)| part.number == number),
            "invalid transcript page for parts {from}..{to}"
        );
        self.append_parts(user, thread, &parts).await?;
        anyhow::ensure!(
            self.missing_page(user, thread, start, end).await? != Some((from, to)),
            "downloaded transcript parts {from}..{to} conflict with cached parts"
        );
        Ok(true)
    }

    /// Downloads every missing part in `start..end`, newest first.
    pub async fn ensure_parts<F, Fut>(
        &self,
        user: &str,
        thread: &str,
        start: u32,
        end: u32,
        mut fetch: F,
    ) -> anyhow::Result<()>
    where
        F: FnMut(u32, u32) -> Fut,
        Fut: Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
    {
        let _lease = self.open_thread(user, thread).await?;
        while self
            .download_missing_page(user, thread, start, end, &mut fetch)
            .await?
        {
            tokio::task::yield_now().await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
