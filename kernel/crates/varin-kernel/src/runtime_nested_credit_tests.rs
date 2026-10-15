//! Original Runtime credit transition, with the transport's existing in-memory Sender.
use super::*;
fn request(body: bool) -> ActiveRequest {
    ActiveRequest {
        token: Arc::new(AtomicBool::new(false)),
        epoch: Some("epoch".into()),
        grant_id: None,
        runtime_cancel: None,
        input_order: None,
        wire_lane: Some(WireLane::Data),
        pending_body: body,
        body_cancel_receipt: false,
    }
}
#[test]
fn nested_body_credit_retains_the_original_pending_cancellation_and_terminal_owner() {
    let active = Mutex::new(HashMap::from([
        ("outer".into(), request(true)),
        ("peer".into(), request(false)),
    ]));
    let (send, receive) = mpsc::sync_channel(2);
    let responses = crate::transport::Sender::from(send);
    release_request_credit(&active, &responses, "outer", "runtime.tools.invoke");
    assert!(
        receive.try_recv().is_err(),
        "incomplete bodies never transfer credit"
    );
    active
        .lock()
        .unwrap()
        .get_mut("outer")
        .unwrap()
        .pending_body = false;
    release_request_credit(&active, &responses, "outer", "runtime.tools.invoke");
    assert_eq!(receive.recv().unwrap()["kind"], "request-credit-released");
    release_request_credit(&active, &responses, "outer", "runtime.tools.invoke");
    assert!(
        receive.try_recv().is_err(),
        "duplicate transfer cannot enlarge the window"
    );
    {
        let requests = active.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests
                .values()
                .filter(|request| request.wire_lane.is_some())
                .count(),
            1
        );
        requests["outer"].cancel();
        assert!(requests["outer"].token.load(Ordering::Acquire));
    }
    active
        .lock()
        .unwrap()
        .insert("inspection".into(), request(false));
    assert_eq!(
        active
            .lock()
            .unwrap()
            .values()
            .filter(|request| request.wire_lane.is_some())
            .count(),
        KERNEL_REQUEST_WINDOW
    );
    release_request_credit(
        &active,
        &responses,
        "inspection",
        "runtime.operation.inspect",
    );
    assert!(
        receive.try_recv().is_err(),
        "ordinary inspections keep their actual response credit"
    );
    active.lock().unwrap().remove("outer");
    assert_eq!(active.lock().unwrap().len(), 2);
}
