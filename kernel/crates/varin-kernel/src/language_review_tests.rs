//! Independent rendezvous behavior: no server, network, or catalog owner is mocked here.
use super::*;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(3);
fn fixture() -> (LanguageBridge, mpsc::Receiver<Value>) {
    let (tx, rx) = mpsc::sync_channel(16);
    let bridge = LanguageBridge::new(tx);
    bridge.initialize("epoch-one");
    (bridge, rx)
}
fn start(bridge: &LanguageBridge, token: &CancellationToken) -> mpsc::Receiver<Result<Value, ExecutionError>> {
    let (tx, rx) = mpsc::channel();
    let bridge = bridge.clone();
    let token = token.clone();
    std::thread::spawn(move || { let _ = tx.send(bridge.query(json!({"path":"source.ts"}), &token)); });
    rx
}
fn reply(request: &Value, result: Value) -> Value {
    json!({"v":1,"kind":"language-response","id":request["id"],"kernelEpoch":request["kernelEpoch"],"result":result})
}

#[test]
fn wrong_epoch_and_malformed_reply_cannot_complete_current_waiter() {
    let (bridge, events) = fixture();
    let token = CancellationToken::default();
    let result = start(&bridge, &token);
    let request = events.recv_timeout(WAIT).unwrap();
    let mut wrong_epoch = reply(&request, json!({"status":"ready","marker":"wrong"}));
    wrong_epoch["kernelEpoch"] = json!("previous-epoch");
    bridge.receive(wrong_epoch);
    bridge.receive(reply(&request, json!(null)));
    assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
    bridge.receive(reply(&request, json!({"status":"ready","marker":"current"})));
    assert_eq!(result.recv_timeout(WAIT).unwrap().unwrap()["marker"], "current");
    assert!(bridge.state.lock().unwrap().pending.is_empty());
    bridge.close();
}

#[test]
fn cancelling_one_waiter_leaves_other_query_alive_and_ignores_late_reply() {
    let (bridge, events) = fixture();
    let first_token = CancellationToken::default();
    let first = start(&bridge, &first_token);
    let first_request = events.recv_timeout(WAIT).unwrap();
    let second = start(&bridge, &CancellationToken::default());
    let second_request = events.recv_timeout(WAIT).unwrap();
    first_token.cancel();
    assert!(first.recv_timeout(WAIT).unwrap().is_err());
    let cancelled = events.recv_timeout(WAIT).unwrap();
    assert_eq!(cancelled["kind"], "language-cancel");
    assert_eq!(cancelled["id"], first_request["id"]);
    bridge.receive(reply(&first_request, json!({"marker":"late-first"})));
    assert!(matches!(second.try_recv(), Err(mpsc::TryRecvError::Empty)));
    bridge.receive(reply(&second_request, json!({"marker":"second"})));
    assert_eq!(second.recv_timeout(WAIT).unwrap().unwrap()["marker"], "second");
    assert!(bridge.state.lock().unwrap().pending.is_empty());
    bridge.close();
}

#[test]
fn reinitialization_releases_old_waiter_without_allowing_its_reply_into_new_epoch() {
    let (bridge, events) = fixture();
    let old = start(&bridge, &CancellationToken::default());
    let old_request = events.recv_timeout(WAIT).unwrap();
    bridge.initialize("epoch-two");
    assert!(old.recv_timeout(WAIT).unwrap().is_err());
    let current = start(&bridge, &CancellationToken::default());
    let current_request = events.recv_timeout(WAIT).unwrap();
    assert_eq!(current_request["kernelEpoch"], "epoch-two");
    let mut forged = reply(&old_request, json!({"marker":"old"}));
    forged["id"] = current_request["id"].clone();
    bridge.receive(forged);
    assert!(matches!(current.try_recv(), Err(mpsc::TryRecvError::Empty)));
    bridge.receive(reply(&current_request, json!({"marker":"new"})));
    assert_eq!(current.recv_timeout(WAIT).unwrap().unwrap()["marker"], "new");
    bridge.close();
}

#[test]
fn closed_or_precancelled_bridge_does_not_leave_pending_requests() {
    let (bridge, events) = fixture();
    let token = CancellationToken::default();
    token.cancel();
    assert!(bridge.query(json!({}), &token).is_err());
    assert!(events.try_recv().is_err());
    let pending = start(&bridge, &CancellationToken::default());
    let _request = events.recv_timeout(WAIT).unwrap();
    bridge.close();
    assert!(pending.recv_timeout(WAIT).unwrap().is_err());
    assert!(bridge.state.lock().unwrap().pending.is_empty());
    assert!(bridge.query(json!({}), &CancellationToken::default()).is_err());
}
