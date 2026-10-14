use std::future::Future;

use serde::Serialize;

use super::{TRANSCRIPT_CHUNK_SIZE, TranscriptPart, TranscriptStore};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadOrder {
    Asc,
    Desc,
}

impl TranscriptStore {
    pub async fn download_parts_page<F, Fut>(
        &self,
        user: &str,
        thread: &str,
        start: u32,
        end: u32,
        order: DownloadOrder,
        fetch: F,
    ) -> anyhow::Result<(u32, u32)>
    where
        F: FnOnce(u32, u32, DownloadOrder) -> Fut,
        Fut: Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
    {
        anyhow::ensure!(start < end, "invalid transcript download range");
        let lock = self.lock_key(format!("download/{user}/{thread}")).await;
        let _guard = lock.lock().await;
        let (lower, upper) = match order {
            DownloadOrder::Asc => (start, start.saturating_add(TRANSCRIPT_CHUNK_SIZE).min(end)),
            DownloadOrder::Desc => (end.saturating_sub(TRANSCRIPT_CHUNK_SIZE).max(start), end),
        };
        let mut numbers: Vec<_> = (lower..upper).collect();
        if matches!(order, DownloadOrder::Desc) {
            numbers.reverse();
        }
        let mut parts = self.read_parts(user, thread, &numbers).await?;
        let mut missing = numbers
            .iter()
            .copied()
            .filter(|number| !parts.iter().any(|part| part.number == *number));
        let range = missing.next().map(|first| {
            let mut last = first;
            for number in missing {
                if number.abs_diff(last) != 1 {
                    break;
                }
                last = number;
            }
            (first.min(last), first.max(last) + 1)
        });
        let remaining = if let Some((from, to)) = range {
            // A failing user-authenticated watcher must not monopolize the shared download lock.
            let fetched =
                tokio::time::timeout(std::time::Duration::from_secs(30), fetch(from, to, order))
                    .await
                    .map_err(|_| anyhow::anyhow!("transcript page download timed out"))??;
            anyhow::ensure!(
                !fetched.is_empty() && fetched.len() <= (to - from) as usize,
                "incomplete transcript download"
            );
            let valid = match order {
                DownloadOrder::Asc => fetched
                    .iter()
                    .zip(from..to)
                    .all(|(part, number)| part.number == number),
                DownloadOrder::Desc => fetched
                    .iter()
                    .zip((from..to).rev())
                    .all(|(part, number)| part.number == number),
            };
            anyhow::ensure!(valid, "invalid transcript page numbers");
            let last = fetched.last().expect("page is nonempty").number;
            self.append_parts(user, thread, &fetched).await?;
            parts.extend(fetched);
            match order {
                DownloadOrder::Asc => (last + 1, end),
                DownloadOrder::Desc => (start, last),
            }
        } else {
            match order {
                DownloadOrder::Asc => (upper, end),
                DownloadOrder::Desc => (start, lower),
            }
        };
        parts.sort_by_key(|part| part.number);
        let thread_id = thread.to_owned();
        self.with_work_replica(user, thread, move |replica| {
            let mut unindexed = Vec::new();
            for part in parts {
                if !replica.has_part(part.number)? {
                    unindexed.push(part);
                }
            }
            if !unindexed.is_empty() {
                replica.save_parts(&thread_id, &unindexed)?;
            }
            Ok(())
        })
        .await?;
        Ok(remaining)
    }

    pub async fn ensure_parts<F, Fut>(
        &self,
        user: &str,
        thread: &str,
        mut start: u32,
        mut end: u32,
        order: DownloadOrder,
        mut fetch: F,
    ) -> anyhow::Result<()>
    where
        F: FnMut(u32, u32, DownloadOrder) -> Fut,
        Fut: Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
    {
        while start < end {
            (start, end) = self
                .download_parts_page(user, thread, start, end, order, &mut fetch)
                .await?;
            tokio::task::yield_now().await;
        }
        Ok(())
    }
}
