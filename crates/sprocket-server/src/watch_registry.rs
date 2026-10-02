//! Shared lifecycle for refcounted server-side broadcast watches.
//!
//! The transcript and artifact watchers used to hand-roll the same bookkeeping:
//! one background task per key, a subscriber count, and abort-on-last-drop.
//! Keeping that logic here means lifecycle fixes apply once. Each slot also
//! carries a generation id so a stale session dropped after an abort (or after
//! its slot was replaced) cannot cancel the replacement.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::broadcast;
use tokio::task::JoinHandle;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

struct Slot<E, S> {
    generation: u64,
    refs: usize,
    events: broadcast::Sender<E>,
    state: S,
    task: JoinHandle<()>,
}

struct Inner<K, E, S> {
    slots: HashMap<K, Slot<E, S>>,
    next_generation: u64,
}

/// A refcounted map of watch keys to a shared background task and broadcast
/// channel. Always construct as an `Arc`; sessions hold one back so `close`
/// works from `Drop` without a runtime.
pub(crate) struct WatchRegistry<K: Eq + Hash, E, S = ()> {
    inner: Mutex<Inner<K, E, S>>,
}

/// Handle to one open watch. Dropping the last handle for a key aborts the
/// background task.
pub(crate) struct WatchSession<K: Eq + Hash, E, S = ()> {
    registry: Arc<WatchRegistry<K, E, S>>,
    key: K,
    generation: u64,
    rx: broadcast::Receiver<E>,
}

impl<K: Eq + Hash, E, S> WatchRegistry<K, E, S> {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                slots: HashMap::new(),
                next_generation: 0,
            }),
        })
    }

    /// Returns the open session plus the slot's shared state, creating both on
    /// first open. `spawn` runs only when a new slot is inserted; it receives
    /// the broadcast sender and the fresh state for the background task to own.
    pub fn open_with(
        self: &Arc<Self>,
        key: K,
        capacity: usize,
        make_state: impl FnOnce() -> S,
        spawn: impl FnOnce(broadcast::Sender<E>, S) -> JoinHandle<()>,
    ) -> (WatchSession<K, E, S>, S)
    where
        K: Clone,
        E: Clone,
        S: Clone,
    {
        let mut inner = lock(&self.inner);
        if let Some(slot) = inner.slots.get_mut(&key) {
            slot.refs += 1;
            let session = WatchSession {
                registry: Arc::clone(self),
                key: key.clone(),
                generation: slot.generation,
                rx: slot.events.subscribe(),
            };
            return (session, slot.state.clone());
        }
        // Keep the channel's initial receiver so a first publish during spawn
        // is not dropped. Transcript SSE has no snapshot fallback; artifact
        // SSE skips a queued copy of the snapshot it already emitted.
        let (events, rx) = broadcast::channel(capacity);
        let state = make_state();
        let task = spawn(events.clone(), state.clone());
        let generation = inner.next_generation;
        inner.next_generation += 1;
        inner.slots.insert(
            key.clone(),
            Slot {
                generation,
                refs: 1,
                events,
                state: state.clone(),
                task,
            },
        );
        let session = WatchSession {
            registry: Arc::clone(self),
            key,
            generation,
            rx,
        };
        (session, state)
    }

    /// Sends to the open slot for `key`, if any. Lagged or absent receivers
    /// are the caller's normal case, so delivery failures are ignored.
    pub fn send_to(&self, key: &K, event: E)
    where
        E: Clone,
    {
        let inner = lock(&self.inner);
        if let Some(slot) = inner.slots.get(key) {
            let _ = slot.events.send(event);
        }
    }

    /// Drops the slot for `key` and aborts its task regardless of open
    /// sessions. Sessions dropped afterwards see a generation mismatch and
    /// leave any replacement slot alone.
    pub fn abort(&self, key: &K) {
        let mut inner = lock(&self.inner);
        if let Some(slot) = inner.slots.remove(key) {
            slot.task.abort();
        }
    }

    fn close(&self, key: &K, generation: u64) {
        let mut inner = lock(&self.inner);
        let Some(slot) = inner.slots.get_mut(key) else {
            return;
        };
        if slot.generation != generation {
            return;
        }
        slot.refs = slot.refs.saturating_sub(1);
        if slot.refs > 0 {
            return;
        }
        let Some(slot) = inner.slots.remove(key) else {
            return;
        };
        slot.task.abort();
    }

    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        lock(&self.inner).slots.len()
    }

    #[cfg(test)]
    pub fn task_abort_handle(&self, key: &K) -> Option<tokio::task::AbortHandle> {
        lock(&self.inner)
            .slots
            .get(key)
            .map(|slot| slot.task.abort_handle())
    }
}

impl<K: Eq + Hash, E, S> WatchSession<K, E, S> {
    pub fn receiver(&mut self) -> &mut broadcast::Receiver<E> {
        &mut self.rx
    }
}

impl<K: Eq + Hash, E, S> Drop for WatchSession<K, E, S> {
    fn drop(&mut self) {
        // Sync close so shutdown / no-runtime drops still release the slot.
        self.registry.close(&self.key, self.generation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_session_does_not_close_its_replacement() {
        let registry: Arc<WatchRegistry<String, u32>> = WatchRegistry::new();
        let spawn = |events: broadcast::Sender<u32>, ()| {
            let _ = events;
            tokio::spawn(std::future::pending())
        };
        let (old, ()) = registry.open_with("key".to_string(), 4, || (), spawn);
        registry.abort(&"key".to_string());
        let (mut replacement, ()) = registry.open_with(
            "key".to_string(),
            4,
            || (),
            |events, ()| {
                let _ = events;
                tokio::spawn(std::future::pending())
            },
        );
        drop(old);
        assert_eq!(registry.active_count(), 1);
        registry.send_to(&"key".to_string(), 7);
        assert_eq!(replacement.receiver().recv().await.unwrap(), 7);
        drop(replacement);
        assert_eq!(registry.active_count(), 0);
    }

    #[tokio::test]
    async fn first_open_receiver_sees_events_sent_during_spawn() {
        let registry: Arc<WatchRegistry<String, u32>> = WatchRegistry::new();
        let (mut session, ()) = registry.open_with(
            "key".to_string(),
            4,
            || (),
            |events, ()| {
                let _ = events.send(1);
                tokio::spawn(std::future::pending())
            },
        );
        assert_eq!(session.receiver().try_recv().unwrap(), 1);
    }

    #[tokio::test]
    async fn last_drop_aborts_the_task() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let registry: Arc<WatchRegistry<String, u32>> = WatchRegistry::new();
        let live = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let spawn = {
            let live = Arc::clone(&live);
            move |events: broadcast::Sender<u32>, ()| {
                let _ = events;
                let live = Arc::clone(&live);
                tokio::spawn(async move {
                    struct DropLive(Arc<AtomicUsize>);
                    impl Drop for DropLive {
                        fn drop(&mut self) {
                            self.0.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    live.fetch_add(1, Ordering::SeqCst);
                    let _live = DropLive(live);
                    let _ = started_tx.send(());
                    std::future::pending::<()>().await;
                })
            }
        };
        let (first, ()) = registry.open_with("key".to_string(), 4, || (), spawn);
        let (second, ()) = registry.open_with(
            "key".to_string(),
            4,
            || (),
            |_, ()| panic!("existing slot should not spawn"),
        );
        started_rx.await.expect("watch task started");
        assert_eq!(live.load(Ordering::SeqCst), 1);
        drop(first);
        assert_eq!(registry.active_count(), 1);
        drop(second);
        assert_eq!(registry.active_count(), 0);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if live.load(Ordering::SeqCst) == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("watch task dropped after last session");
    }
}
