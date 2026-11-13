use super::*;
use std::time::Duration;

fn fixture() -> (
    Arc<Shared>,
    mpsc::Receiver<Incoming>,
    mpsc::Receiver<BodyJob>,
    mpsc::Receiver<Control>,
) {
    let (control, controls) = mpsc::channel();
    let (incoming, input) = mpsc::channel();
    let (body_jobs, jobs) = mpsc::channel();
    let shared = Arc::new(Shared {
        stopped: AtomicBool::new(false),
        control,
        durable_cursor: Mutex::new(None),
        incoming,
        scheduled: Mutex::new(Scheduler {
            streams: HashMap::new(),
            order: VecDeque::new(),
            inline: VecDeque::new(),
            inline_bytes: 0,
            next_arrival: 0,
        }),
        changed: Condvar::new(),
        received: Mutex::new(HashMap::new()),
        response_lanes: Mutex::new(HashMap::new()),
        epoch: "test-epoch".into(),
        chunk_bytes: 16,
        body_jobs,
        arrivals: Mutex::new(Arrivals::default()),
    });
    (shared, input, jobs, controls)
}
fn sender(shared: &Arc<Shared>) -> Sender {
    Sender {
        shared: Some(shared.clone()),
        fixture: None,
    }
}

#[test]
fn inline_budget_counts_encoded_bytes_and_large_strings_stay_in_body_workers() {
    assert_eq!(
        inline_bytes(&json!("x".repeat(KERNEL_INLINE_MAX_BYTES - 2)))
            .unwrap()
            .len(),
        KERNEL_INLINE_MAX_BYTES
    );
    assert!(inline_bytes(&json!("x".repeat(KERNEL_INLINE_MAX_BYTES - 1))).is_none());
    assert!(inline_bytes(&json!("\n".repeat(KERNEL_INLINE_MAX_BYTES / 2))).is_none());
    assert!(inline_bytes(&json!("中文😀".repeat(KERNEL_INLINE_MAX_BYTES))).is_none());
}

#[test]
fn offers_keep_input_order_and_early_cancel_precedes_inline_execution_without_tombstones() {
    let (shared, input, _, _) = fixture();
    shared
        .after_arrival(
            2,
            Incoming::Frame(json!({"kind":"cancel","id":"second"}), Lane::Control),
        )
        .unwrap();
    shared
        .arrive(
            2,
            vec![
                Incoming::Open(json!({"id":"second"})),
                Incoming::Frame(json!({"id":"second"}), Lane::Data),
            ],
        )
        .unwrap();
    assert!(
        input.try_recv().is_err(),
        "a small input cannot overtake an earlier worker offer"
    );
    shared
        .arrive(1, vec![Incoming::Open(json!({"id":"first"}))])
        .unwrap();
    assert!(matches!(input.recv().unwrap(), Incoming::Open(value) if value["id"] == "first"));
    assert!(matches!(input.recv().unwrap(), Incoming::Open(value) if value["id"] == "second"));
    assert!(
        matches!(input.recv().unwrap(), Incoming::Frame(value, Lane::Control) if value["kind"] == "cancel")
    );
    assert!(
        matches!(input.recv().unwrap(), Incoming::Frame(value, Lane::Data) if value["id"] == "second")
    );
    shared
        .after_arrival(2, Incoming::Frame(json!({"kind":"cancel"}), Lane::Control))
        .unwrap();
    assert!(input.try_recv().is_ok());
    let arrivals = shared.arrivals.lock().unwrap();
    assert!(arrivals.pending.is_empty() && arrivals.after.is_empty());
}

#[test]
fn inline_read_registers_request_before_dispatch_without_body_jobs_or_commands() {
    let (shared, input, jobs, controls) = fixture();
    let request = json!({"v":PROTOCOL_VERSION,"kind":"request","id":"inline","method":"runtime.input.submit","params":{"branchId":"branch","input":{"text":"中文😀"}}});
    let mut payload = vec![1];
    payload.extend_from_slice(&1u64.to_be_bytes());
    payload.extend(serde_json::to_vec(&request).unwrap());
    let mut wire = Vec::new();
    crate::protocol::write_encoded_frame(&mut wire, &payload).unwrap();
    assert_eq!(
        read_data(std::io::Cursor::new(wire), &shared)
            .unwrap_err()
            .kind(),
        io::ErrorKind::UnexpectedEof
    );
    assert!(
        matches!(input.recv().unwrap(), Incoming::Open(meta) if meta["inputOrderKey"] == "input:branchId:branch")
    );
    assert!(
        matches!(input.recv().unwrap(), Incoming::Frame(value, Lane::Data) if value == request)
    );
    assert!(jobs.try_recv().is_err() && controls.try_recv().is_err());
}

#[test]
fn saturated_response_streams_do_not_own_reverse_bridge_credit() {
    let (shared, _, jobs, _controls) = fixture();
    let sender = sender(&shared);
    for index in 0..KERNEL_STREAM_CREDITS + 1 {
        sender.send(json!({"kind":"response","id":index.to_string(),"result":"x".repeat(KERNEL_INLINE_MAX_BYTES + 1)})).unwrap();
    }
    sender.send(json!({"kind":"host-tool-request","id":"nested","body":"x".repeat(KERNEL_INLINE_MAX_BYTES + 1)})).unwrap();
    let started = jobs.try_iter().collect::<Vec<_>>();
    assert_eq!(started.len(), KERNEL_STREAM_CREDITS + 1);
    assert!(started
        .iter()
        .any(|job| matches!(job, BodyJob::Encode(_, value) if value["id"] == "nested")));
    let completed = started
        .iter()
        .find_map(|job| match job {
            BodyJob::Encode(id, value) if value["kind"] == "response" => Some(*id),
            _ => None,
        })
        .unwrap();
    {
        let mut scheduler = shared.scheduled.lock().unwrap();
        scheduler.streams.remove(&completed);
        scheduler.order.retain(|id| *id != completed);
    }
    shared.start_streams().unwrap();
    assert!(
        matches!(jobs.try_recv().unwrap(), BodyJob::Encode(_, value) if value["kind"] == "response")
    );
}

#[test]
fn progress_waits_for_bounded_queue_space_not_remote_body_acknowledgements() {
    let (shared, _, jobs, controls) = fixture();
    shared.scheduled.lock().unwrap().inline_bytes = INLINE_QUEUE_BYTES;
    let (done, completion) = mpsc::channel();
    let progress = sender(&shared);
    let worker = thread::spawn(move || {
        progress
            .send_progress(json!({"kind":"runtime-event","stream":"progress","delta":"first"}))
            .unwrap();
        done.send(()).unwrap();
    });
    assert!(completion.recv_timeout(Duration::from_millis(20)).is_err());
    shared.scheduled.lock().unwrap().inline_bytes = 0;
    shared.changed.notify_all();
    completion.recv_timeout(Duration::from_secs(2)).unwrap();
    worker.join().unwrap();
    sender(&shared)
        .send_progress(json!({"kind":"runtime-event","stream":"progress","delta":"second"}))
        .unwrap();
    let scheduler = shared.scheduled.lock().unwrap();
    let deltas = scheduler
        .inline
        .iter()
        .map(|frame| {
            serde_json::from_slice::<Value>(&frame[INLINE_HEADER_BYTES..]).unwrap()["delta"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(deltas, ["first", "second"]);
    assert!(jobs.try_recv().is_err() && controls.try_recv().is_err());
}

#[test]
fn writer_interleaves_inline_frames_and_ready_stream_chunks() {
    let (shared, _, _jobs, _controls) = fixture();
    let send = sender(&shared);
    send.send_progress(json!({"kind":"runtime-event","stream":"progress","delta":"first"}))
        .unwrap();
    send.send_progress(json!({"kind":"runtime-event","stream":"progress","delta":"second"}))
        .unwrap();
    for _ in 0..2 {
        let id = Uuid::new_v4();
        let mut scheduler = shared.scheduled.lock().unwrap();
        scheduler.streams.insert(
            id,
            Outgoing {
                stream_id: id,
                bytes: Some(vec![42; 32]),
                offset: 0,
                sequence: 0,
                waiting: false,
                ready: true,
                aborting: false,
                ending: false,
                started: true,
                encoding: false,
                settled: false,
                group: 0,
                value: None,
            },
        );
        scheduler.order.push_back(id);
    }
    struct Writer {
        shared: Arc<Shared>,
        types: Vec<u8>,
        payload: bool,
    }
    impl io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.payload {
                self.types.push(bytes[0]);
                if self.types.len() == 4 {
                    self.shared.stopped.store(true, Ordering::Release);
                }
            }
            self.payload = !self.payload;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut output = Writer {
        shared: shared.clone(),
        types: vec![],
        payload: false,
    };
    write_data(&mut output, &shared).unwrap();
    assert_eq!(output.types, [1, 0, 1, 0]);
}

#[test]
fn cancelled_wire_does_not_release_the_credit_of_a_still_owned_encoder_job() {
    let (shared, _, jobs, _controls) = fixture();
    let sender = sender(&shared);
    for index in 0..KERNEL_STREAM_CREDITS + 1 {
        sender.send(json!({"kind":"response","id":index.to_string(),"result":"x".repeat(KERNEL_INLINE_MAX_BYTES + 1)})).unwrap();
    }
    let mut started = jobs.try_iter().collect::<Vec<_>>();
    assert_eq!(started.len(), KERNEL_STREAM_CREDITS);
    let job = started.remove(0);
    let id = match &job {
        BodyJob::Encode(id, _) => *id,
        _ => unreachable!(),
    };
    let mut wire = Vec::new();
    for kind in ["transport-stream-stop", "transport-stream-aborted"] {
        crate::protocol::write_frame(&mut wire, &json!({"v":PROTOCOL_VERSION,"kind":kind,"streamId":id.to_string(),"kernelEpoch":shared.epoch,"sequence":0})).unwrap();
    }
    assert_eq!(
        read_control(std::io::Cursor::new(wire), &shared)
            .unwrap_err()
            .kind(),
        io::ErrorKind::UnexpectedEof
    );
    assert!(shared.scheduled.lock().unwrap().streams.contains_key(&id));
    assert!(
        jobs.try_recv().is_err(),
        "wire settlement does not release queued body memory"
    );
    run_body_job(job, &shared).unwrap();
    assert!(!shared.scheduled.lock().unwrap().streams.contains_key(&id));
    assert!(matches!(jobs.try_recv().unwrap(), BodyJob::Encode(_, _)));
}
