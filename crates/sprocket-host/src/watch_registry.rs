use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::broadcast;
use tokio::task::JoinHandle;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

struct Slot<E, S> {
    refs: usize,
    events: broadcast::Sender<E>,
    state: S,
    task: JoinHandle<()>,
}

struct Inner<K, E, S> {
    slots: HashMap<K, Slot<E, S>>,
}

pub struct WatchRegistry<K: Eq + Hash, E, S = ()> {
    inner: Mutex<Inner<K, E, S>>,
}

pub struct WatchSession<K: Eq + Hash, E, S = ()> {
    registry: Arc<WatchRegistry<K, E, S>>,
    key: K,
    rx: broadcast::Receiver<E>,
}

impl<K: Eq + Hash, E, S> WatchRegistry<K, E, S> {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                slots: HashMap::new(),
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
                rx: slot.events.subscribe(),
            };
            return (session, slot.state.clone());
        }
        // Keep the initial receiver so a publish during `spawn` isn't lost.
        let (events, rx) = broadcast::channel(capacity);
        let state = make_state();
        let task = spawn(events.clone(), state.clone());
        inner.slots.insert(
            key.clone(),
            Slot {
                refs: 1,
                events,
                state: state.clone(),
                task,
            },
        );
        let session = WatchSession {
            registry: Arc::clone(self),
            key,
            rx,
        };
        (session, state)
    }

    fn close(&self, key: &K) {
        let mut inner = lock(&self.inner);
        let Some(slot) = inner.slots.get_mut(key) else {
            return;
        };
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
        self.registry.close(&self.key);
    }
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
