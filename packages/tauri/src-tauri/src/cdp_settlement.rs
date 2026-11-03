//! A response belongs to the original native page, including when that page
//! closes immediately before a caller adds its pending response entry.
use std::future::Future;
use tokio::sync::{oneshot, watch};

/// A lost observer is not a native close receipt. Keep that uncertainty distinct
/// even though both cases must release a caller waiting for a response.
pub(crate) async fn wait_closed(mut receipt: watch::Receiver<bool>) -> Result<(), String> {
    while !*receipt.borrow_and_update() {
        receipt.changed().await.map_err(|_| {
            "Original native page close observation was lost; termination is unknown".to_owned()
        })?;
    }
    Ok(())
}

/// Observe the document captured when a request starts, not a replacement that
/// happens to occupy the same Webview when its delayed response is polled.
pub(crate) async fn wait_original(
    close: impl Future<Output = Result<(), String>>,
    mut document: watch::Receiver<()>,
) -> Result<(), String> {
    tokio::select! {
        result = close => result,
        changed = document.changed() => {
            Err(if changed.is_ok() {
                "Original native document changed; effect outcome is unknown"
            } else {
                "Original native document observation was lost; termination is unknown"
            }.to_owned())
        }
    }
}

pub(crate) async fn settle<T>(
    response: oneshot::Receiver<Result<T, String>>,
    original_close: impl Future<Output = Result<(), String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        // A response already received from the original owner is a known fact.
        // A subsequent close cannot turn that receipt back into an unknown effect.
        result = response => result.map_err(|_| "Native page response was lost; outcome is unknown".to_owned())?,
        result = original_close => match result {
            Ok(()) => Err("Original native page closed; effect outcome is unknown".into()),
            Err(error) => Err(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::watch;

    #[tokio::test]
    async fn prior_close_settles_a_late_pending_entry_without_another_callback() {
        let (close, receipt) = watch::channel(false);
        close.send_replace(true);
        let (_original_sender, response) = oneshot::channel::<Result<(), String>>();
        assert!(
            settle(response, wait_closed(receipt))
                .await
                .unwrap_err()
                .contains("unknown")
        );
    }

    #[tokio::test]
    async fn close_during_request_settles_only_its_original_generation() {
        let (close, receipt) = watch::channel(false);
        let (_replacement_close, replacement) = watch::channel(false);
        let (_sender, response) = oneshot::channel::<Result<(), String>>();
        let pending = tokio::spawn(settle(response, wait_closed(receipt)));
        close.send_replace(true);
        assert!(pending.await.unwrap().is_err());
        assert!(!*replacement.borrow());
    }

    #[tokio::test]
    async fn actual_response_is_preserved_while_the_original_page_remains_open() {
        let (_close, receipt) = watch::channel(false);
        let (sender, response) = oneshot::channel();
        sender.send(Ok(42)).unwrap();
        assert_eq!(settle(response, wait_closed(receipt)).await.unwrap(), 42);
    }

    #[tokio::test]
    async fn lost_owner_or_lost_response_is_not_a_successful_operation() {
        let (close, receipt) = watch::channel(false);
        let (_sender, response) = oneshot::channel::<Result<(), String>>();
        drop(close);
        let error = settle(response, wait_closed(receipt)).await.unwrap_err();
        assert!(error.contains("termination is unknown"));
        assert!(!error.contains("page closed"));
        let (_close, receipt) = watch::channel(false);
        let (sender, response) = oneshot::channel::<Result<(), String>>();
        drop(sender);
        assert!(
            settle(response, wait_closed(receipt))
                .await
                .unwrap_err()
                .contains("unknown")
        );
    }

    #[tokio::test]
    async fn received_effect_receipt_survives_a_later_close_before_caller_resumes() {
        for expected in [Ok(42), Err("original operation rejected".to_owned())] {
            let (close, receipt) = watch::channel(false);
            let (sender, response) = oneshot::channel();
            sender.send(expected.clone()).unwrap();
            close.send_replace(true);
            assert_eq!(settle(response, wait_closed(receipt)).await, expected);
        }
    }

    #[tokio::test]
    async fn closed_receipt_still_proves_close_after_its_sender_is_dropped() {
        let (close, receipt) = watch::channel(false);
        close.send_replace(true);
        drop(close);
        assert_eq!(wait_closed(receipt).await, Ok(()));
    }

    #[tokio::test]
    async fn document_replacement_before_admission_settles_the_original_waiter() {
        let (_close, receipt) = watch::channel(false);
        let (document, original) = watch::channel(());
        document.send_replace(());
        let (_sender, response) = oneshot::channel::<Result<(), String>>();
        let result = settle(response, wait_original(wait_closed(receipt), original)).await;
        assert!(result.unwrap_err().contains("document changed"));
        // A request begun in the new generation does not inherit the old event.
        let mut replacement = document.subscribe();
        assert!(!replacement.has_changed().unwrap());
        document.send_replace(());
        replacement.changed().await.unwrap();
    }
}
