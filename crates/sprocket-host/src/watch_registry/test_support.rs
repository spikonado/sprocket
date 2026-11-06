use std::hash::Hash;

use super::{WatchRegistry, lock};

impl<K: Eq + Hash, E, S> WatchRegistry<K, E, S> {
    pub fn active_count(&self) -> usize {
        lock(&self.inner).slots.len()
    }

    pub fn task_abort_handle(&self, key: &K) -> Option<tokio::task::AbortHandle> {
        lock(&self.inner)
            .slots
            .get(key)
            .map(|slot| slot.task.abort_handle())
    }

    pub fn send_to(&self, key: &K, event: E)
    where
        E: Clone,
    {
        if let Some(slot) = lock(&self.inner).slots.get(key) {
            let _ = slot.events.send(event);
        }
    }
}
