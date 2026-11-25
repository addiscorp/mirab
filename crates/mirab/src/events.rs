use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use crate::error::Error;
use crate::protocol::Event;

/// Events a reader may fall behind by before its stream is cut. A VM that
/// floods its session can't grow the host's memory without bound.
pub(crate) const MAX_QUEUED: usize = 4096;

#[derive(Default)]
struct State {
    queue: VecDeque<Event>,
    closed: bool,
    lagged: bool,
}

/// One session's queue: filled by the reader task, drained by [`EventStream`].
#[derive(Default)]
pub(crate) struct Queue {
    state: Mutex<State>,
    wake: Notify,
}

impl Queue {
    pub(crate) fn push(&self, event: Event) {
        {
            let mut state = self.state.lock().unwrap();
            if state.closed || state.lagged {
                return;
            }
            if state.queue.len() >= MAX_QUEUED {
                state.lagged = true;
                state.queue.clear();
            } else {
                state.queue.push_back(event);
            }
        }
        self.wake.notify_one();
    }

    pub(crate) fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.wake.notify_one();
    }
}

/// A session's events, in order, from its start. Ends when the session does.
pub struct EventStream {
    queue: Arc<Queue>,
}

impl EventStream {
    pub(crate) fn new(queue: Arc<Queue>) -> Self {
        Self { queue }
    }

    /// The next event; `None` once the session has ended and all were read.
    pub async fn next(&mut self) -> Option<Result<Event, Error>> {
        loop {
            let notified = self.queue.wake.notified();
            {
                let mut state = self.queue.state.lock().unwrap();
                if state.lagged {
                    state.lagged = false;
                    state.closed = true;
                    return Some(Err(Error::EventsLagged(MAX_QUEUED)));
                }
                if let Some(event) = state.queue.pop_front() {
                    return Some(Ok(event));
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(line: &str) -> Event {
        Event::Log {
            session: "s".into(),
            line: line.into(),
        }
    }

    #[tokio::test]
    async fn keeps_order_and_ends_after_the_last_event() {
        let queue = Arc::new(Queue::default());
        let mut stream = EventStream::new(queue.clone());
        queue.push(log("one"));
        queue.push(log("two"));
        queue.close();
        assert_eq!(stream.next().await.unwrap().unwrap(), log("one"));
        assert_eq!(stream.next().await.unwrap().unwrap(), log("two"));
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn a_reader_too_far_behind_is_told_and_cut() {
        let queue = Arc::new(Queue::default());
        let mut stream = EventStream::new(queue.clone());
        for _ in 0..=MAX_QUEUED {
            queue.push(log("flood"));
        }
        assert!(matches!(
            stream.next().await,
            Some(Err(Error::EventsLagged(MAX_QUEUED)))
        ));
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn wakes_a_waiting_reader() {
        let queue = Arc::new(Queue::default());
        let mut stream = EventStream::new(queue.clone());
        let reader = tokio::spawn(async move { stream.next().await });
        tokio::task::yield_now().await;
        queue.push(log("late"));
        let got = reader.await.unwrap().unwrap().unwrap();
        assert_eq!(got, log("late"));
    }
}
