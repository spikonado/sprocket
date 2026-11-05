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

pub struct WatchRegistry<K: Eq + Hash, E, S = ()> {
    inner: Mutex<Inner<K, E, S>>,
}

pub struct WatchSession<K: Eq + Hash, E, S = ()> {
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
                key,
                generation: slot.generation,
                rx: slot.events.subscribe(),
            };
            return (session, slot.state.clone());
        }
        // Keep the channel's initial receiver so a first publish during spawn
        // is not dropped. Transcript watches have no snapshot fallback; artifact
        // watches skip a queued copy of the snapshot they already emitted.
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

    pub fn send_to(&self, key: &K, event: E)
    where
        E: Clone,
    {
        let inner = lock(&self.inner);
        if let Some(slot) = inner.slots.get(key) {
            let _ = slot.events.send(event);
        }
    }

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
        slot.refs -= 1;
        if slot.refs == 0 {
            slot.task.abort();
            inner.slots.remove(key);
        }
    }
}

impl<K: Eq + Hash, E, S> WatchSession<K, E, S> {
    pub fn receiver(&mut self) -> &mut broadcast::Receiver<E> {
        &mut self.rx
    }
}

impl<K: Eq + Hash, E, S> Drop for WatchSession<K, E, S> {
    fn drop(&mut self) {
        self.registry.close(&self.key, self.generation);
    }
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
