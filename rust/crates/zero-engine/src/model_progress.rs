//! Best-effort provisional model telemetry, never evidence or execution authority.
use super::*;
use zero_protocol::model::ProviderProgress;

pub(super) fn forwarder(
    events: mpsc::Sender<ExecutionEvent>,
    session: &str,
    operation: &str,
    parent: Option<&str>,
) -> impl FnMut(ProviderProgress) + Send + 'static {
    let session = session.to_owned();
    let operation = operation.to_owned();
    let parent = parent.map(str::to_owned);
    let mut sequence = 0u64;
    move |progress| {
        // Increment even when the bounded observer queue is full or closed.
        // Gaps explicitly reveal lost progress; final receipts remain truth.
        sequence += 1;
        let _ = events.try_send(ExecutionEvent::ModelProgress {
            session_id: session.clone(),
            operation_id: operation.clone(),
            parent_operation_id: parent.clone(),
            sequence,
            progress,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn delta(text: &str) -> ProviderProgress {
        ProviderProgress::TextDelta {
            item_index: 0,
            content_index: 0,
            text: text.into(),
        }
    }
    #[test]
    fn dropped_updates_leave_sequence_gaps_and_closed_observer_is_harmless() {
        let (tx, mut rx) = mpsc::channel(1);
        let mut progress = forwarder(tx, "session", "child", Some("parent"));
        progress(delta("first"));
        progress(delta("dropped"));
        match rx.try_recv().unwrap() {
            ExecutionEvent::ModelProgress {
                session_id,
                operation_id,
                parent_operation_id,
                sequence,
                ..
            } => {
                assert_eq!(session_id, "session");
                assert_eq!(operation_id, "child");
                assert_eq!(parent_operation_id.as_deref(), Some("parent"));
                assert_eq!(sequence, 1);
            }
            other => panic!("{other:?}"),
        }
        progress(delta("third"));
        assert!(matches!(
            rx.try_recv().unwrap(),
            ExecutionEvent::ModelProgress { sequence: 3, .. }
        ));
        drop(rx);
        progress(delta("closed"));
    }
}
