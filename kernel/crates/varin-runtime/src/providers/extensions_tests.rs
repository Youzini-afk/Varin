use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

struct Bridge {
    calls: Mutex<Vec<(String, ModelProtocolCall)>>,
    released: AtomicUsize,
    foreign: bool,
}
impl ModelProtocolBridge for Bridge {
    fn invoke(
        &self,
        id: &str,
        call: ModelProtocolCall,
        _: &CancellationToken,
    ) -> Result<ModelProtocolResult, ModelFailure> {
        self.calls.lock().unwrap().push((id.into(), call.clone()));
        match call {
            ModelProtocolCall::Serialize { request, .. } => Ok(ModelProtocolResult::Body {
                body: json!({"query": request.history, "request": request.request_id}),
            }),
            ModelProtocolCall::Parse {
                frame,
                connection_identity,
                state,
                ..
            } => match frame.as_deref() {
                Some("part") => Ok(ModelProtocolResult::Parsed {
                    events: vec![ProviderEvent::TextDelta {
                        item_id: "answer".into(),
                        text: "answer".into(),
                    }],
                    state: json!("received"),
                    finish: None,
                }),
                Some("complete") => {
                    assert_eq!(state, json!("received"));
                    Ok(ModelProtocolResult::Parsed {
                        events: vec![
                            ProviderEvent::ItemCompleted {
                                item: ProviderItem {
                                    id: "answer".into(),
                                    content: Content::Text {
                                        text: "answer".into(),
                                    },
                                    opaque: Some(OpaqueProviderItem {
                                        family: "fixture-custom".into(),
                                        adapter_version: "7".into(),
                                        connection_identity: if self.foreign {
                                            "foreign".into()
                                        } else {
                                            connection_identity
                                        },
                                        value: json!({"serverReceipt":"receipt"}),
                                    }),
                                },
                            },
                            ProviderEvent::Usage {
                                receipt: UsageReceipt {
                                    measurement: UsageMeasurement::Actual,
                                    output_tokens: Some(9),
                                    raw: Some(json!({"units":9})),
                                    ..Default::default()
                                },
                            },
                        ],
                        state: Value::Null,
                        finish: Some(FinishReason::Stop),
                    })
                }
                _ => Ok(ModelProtocolResult::Parsed {
                    events: vec![],
                    state,
                    finish: None,
                }),
            },
        }
    }
    fn release(&self, id: &str) {
        assert!(!id.is_empty());
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}
struct Transport {
    calls: AtomicUsize,
    complete: bool,
}
impl HttpTransport for Transport {
    fn stream(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(request.endpoint, "https://fixture.invalid/base/stream");
        assert_eq!(request.headers.get("x-protocol").unwrap(), "fixture-v7");
        assert_eq!(
            request.headers.get("authorization").unwrap(),
            "Bearer dispatch-only"
        );
        assert!(!String::from_utf8_lossy(&request.body.wire_bytes()).contains("dispatch-only"));
        assert!(!cancel.is_cancelled());
        assert!(!receive(b"data: par")?);
        assert!(!receive(b"t\r\n\r\n")?);
        if self.complete {
            assert!(receive(b"data: complete\n\n")?);
        }
        Ok(())
    }
}
fn configuration() -> ModelSessionConfiguration {
    serde_json::from_value(json!({"providerFamily":"fixture-custom","model":"fixture","endpoint":"https://fixture.invalid/base/stream",
        "credentialEnvironment":null,"allowAnonymous":false,"configurationGeneration":1,"maxOutputTokens":8,"adapterId":"fixture.codec","adapterVersion":"7","adapterBindingId":"fixed-generation","adapterIdentity":"fixed-artifact"})).unwrap()
}
fn metadata() -> ModelAdapterMetadata {
    ModelAdapterMetadata {
        id: "fixture.codec".into(),
        version: "7".into(),
        contract_version: MODEL_ADAPTER_CONTRACT,
        protocol_family: "fixture-custom".into(),
    }
}
fn view() -> RequestView {
    let binding: RequestBinding = serde_json::from_value(json!({"child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixed-account","provider_family":"fixture-custom","model":"fixture","credential_ref":"account","configuration_generation":1,"tool_schema_generation":0,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":null}})).unwrap();
    RequestView {
        request_id: "original-request".into(),
        run_id: "original-run".into(),
        origin: RequestOrigin::AuxiliaryInference {
            operation_id: "original-operation".into(),
            parent_operation_id: "parent-operation".into(),
            purpose: "title".into(),
        },
        binding,
        history: vec![Arc::new(ConversationItem {
            resource_activation: None,
            id: "input".into(),
            provenance: Provenance::UserInstruction {
                input_id: "input".into(),
            },
            content: Content::Text {
                text: "hello".into(),
            },
            opaque: Some(OpaqueProviderItem {
                connection_identity: "another-account".into(),
                family: "fixture-custom".into(),
                adapter_version: "7".into(),
                value: json!({"hidden":"foreign-signature"}),
            }),
        })],
    }
}
struct TestCredentials;
impl CredentialResolver for TestCredentials {
    fn headers(
        &self,
        reference: Option<&str>,
        _: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
        assert_eq!(reference, Some("account"));
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("authorization", "Bearer dispatch-only".parse().unwrap());
        Ok(headers)
    }
}
fn connection(transport: Arc<Transport>) -> Connection {
    Connection::new(
        "https://fixture.invalid/base/stream",
        Arc::new(TestCredentials),
        transport,
    )
}
#[test]
fn brokered_adapter_executes_real_codec_and_rust_http_with_original_identity_usage_and_lease() {
    let bridge = Arc::new(Bridge {
        calls: Mutex::new(vec![]),
        released: AtomicUsize::new(0),
        foreign: false,
    });
    let transport = Arc::new(Transport {
        calls: AtomicUsize::new(0),
        complete: true,
    });
    let adapter = BrokeredModelAdapter::new(
        metadata(),
        "fixed-generation".into(),
        "fixed-artifact".into(),
        BTreeMap::from([("x-protocol".into(), "fixture-v7".into())]),
        bridge.clone(),
    )
    .unwrap();
    let mut registry = registry::ModelAdapterRegistry::default();
    registry.publish(0, vec![Arc::new(adapter)]).unwrap();
    registry
        .retain_binding("fixed-generation", "accepted-run")
        .unwrap();
    registry.publish(1, vec![]).unwrap();
    let mut stale = configuration();
    stale.adapter_identity = Some("another-artifact".into());
    assert!(registry.select(&stale).is_err());
    let selected = registry.select(&configuration()).unwrap();
    let provider = selected
        .bind(&configuration(), connection(transport.clone()))
        .unwrap();
    let input = view();
    let serialized = provider
        .serialize_cancellable(&input, None, &CancellationToken::default())
        .unwrap();
    assert_eq!(serialized.to_value()["request"], "original-request");
    assert_eq!(serialized.to_value()["query"][0]["opaque"], Value::Null);
    assert_eq!(bridge.released.load(Ordering::SeqCst), 0);
    let mut events = vec![];
    let finish = provider
        .generate(
            &RequestSnapshot {
                view: input,
                serialized,
            },
            &CancellationToken::default(),
            &mut |event| {
                events.push(event);
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(finish, FinishReason::Stop);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    assert!(events.iter().any(|event| matches!(event, ProviderEvent::Usage { receipt } if receipt.output_tokens == Some(9) && receipt.input_tokens.is_none() && receipt.raw == Some(json!({"units":9})))));
    let calls = bridge.calls.lock().unwrap();
    assert!(calls.iter().all(|(id, _)| id == "fixed-generation"));
    assert!(
        calls
            .iter()
            .filter_map(|(_, call)| {
                if let ModelProtocolCall::Parse {
                    request_id, run_id, ..
                } = call
                {
                    Some((request_id, run_id))
                } else {
                    None
                }
            })
            .all(|(request, run)| request == "original-request" && run == "original-run")
    );
    drop(calls);
    drop(provider);
    assert_eq!(bridge.released.load(Ordering::SeqCst), 0);
    registry.release_retained("accepted-run");
    assert_eq!(bridge.released.load(Ordering::SeqCst), 1);
}
#[test]
fn decoder_cannot_change_continuation_scope_or_treat_eof_as_completion() {
    for (foreign, complete, code) in [
        (true, true, "model_adapter_continuation"),
        (false, false, "incomplete_stream"),
    ] {
        let bridge = Arc::new(Bridge {
            calls: Mutex::new(vec![]),
            released: AtomicUsize::new(0),
            foreign,
        });
        let adapter = BrokeredModelAdapter::new(
            metadata(),
            "fixed-generation".into(),
            "fixed-artifact".into(),
            BTreeMap::from([("x-protocol".into(), "fixture-v7".into())]),
            bridge,
        )
        .unwrap();
        let transport = Arc::new(Transport {
            calls: AtomicUsize::new(0),
            complete,
        });
        let provider = adapter
            .bind(&configuration(), connection(transport.clone()))
            .unwrap();
        let input = view();
        let serialized = provider.serialize(&input, None).unwrap();
        assert_eq!(
            provider
                .generate(
                    &RequestSnapshot {
                        view: input,
                        serialized
                    },
                    &CancellationToken::default(),
                    &mut |_| Ok(())
                )
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    }
}
struct CancelBridge {
    entered: mpsc::Sender<()>,
    drained: Mutex<mpsc::Receiver<()>>,
    released: AtomicUsize,
}
impl ModelProtocolBridge for CancelBridge {
    fn invoke(
        &self,
        _: &str,
        _: ModelProtocolCall,
        cancel: &CancellationToken,
    ) -> Result<ModelProtocolResult, ModelFailure> {
        let (wake, wait) = mpsc::sync_channel(1);
        let _watch = cancel.wake_on_cancel(wake);
        self.entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(cancel.is_cancelled());
        self.drained
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        // A non-cooperating codec may return a late body after cancellation. The original
        // serializer must wait for this real drain and then discard the unaccepted body.
        Ok(ModelProtocolResult::Body {
            body: json!({"late": true}),
        })
    }
    fn release(&self, _: &str) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}
#[test]
fn serializer_passes_original_cancellation_and_retains_binding_until_actual_callback_drain() {
    let (entered, wait) = mpsc::channel();
    let (drain, drained) = mpsc::channel();
    let bridge = Arc::new(CancelBridge {
        entered,
        drained: Mutex::new(drained),
        released: AtomicUsize::new(0),
    });
    let adapter = BrokeredModelAdapter::new(
        metadata(),
        "fixed-generation".into(),
        "fixed-artifact".into(),
        BTreeMap::new(),
        bridge.clone(),
    )
    .unwrap();
    let provider = adapter
        .bind(
            &configuration(),
            connection(Arc::new(Transport {
                calls: AtomicUsize::new(0),
                complete: false,
            })),
        )
        .unwrap();
    drop(adapter);
    let cancel = CancellationToken::default();
    let worker_cancel = cancel.clone();
    let worker =
        std::thread::spawn(move || provider.serialize_cancellable(&view(), None, &worker_cancel));
    wait.recv_timeout(Duration::from_secs(5)).unwrap();
    cancel.cancel();
    assert!(!worker.is_finished());
    assert_eq!(bridge.released.load(Ordering::SeqCst), 0);
    drain.send(()).unwrap();
    assert_eq!(worker.join().unwrap().unwrap_err().code, "cancelled");
    assert_eq!(bridge.released.load(Ordering::SeqCst), 1);
}

#[test]
fn original_admission_survives_same_artifact_restart_and_durable_identity_can_reconstruct() {
    let original = Arc::new(Bridge {
        calls: Mutex::new(vec![]),
        released: AtomicUsize::new(0),
        foreign: false,
    });
    let replacement = Arc::new(Bridge {
        calls: Mutex::new(vec![]),
        released: AtomicUsize::new(0),
        foreign: false,
    });
    let make = |id: &str, bridge: Arc<Bridge>| {
        Arc::new(
            BrokeredModelAdapter::new(
                metadata(),
                id.into(),
                "fixed-artifact".into(),
                BTreeMap::new(),
                bridge,
            )
            .unwrap(),
        ) as Arc<dyn registry::ModelAdapter>
    };
    let mut registry = registry::ModelAdapterRegistry::default();
    registry
        .publish(0, vec![make("fixed-generation", original.clone())])
        .unwrap();
    registry
        .retain_binding("fixed-generation", "queued-run")
        .unwrap();
    registry
        .publish(1, vec![make("fresh-process", replacement.clone())])
        .unwrap();
    let transport = || {
        connection(Arc::new(Transport {
            calls: AtomicUsize::new(0),
            complete: true,
        }))
    };
    let selected = registry
        .select(&configuration())
        .unwrap()
        .bind(&configuration(), transport())
        .unwrap();
    selected.serialize(&view(), None).unwrap();
    assert_eq!(original.calls.lock().unwrap()[0].0, "fixed-generation");
    assert!(replacement.calls.lock().unwrap().is_empty());
    registry.release_retained("queued-run");
    assert_eq!(original.released.load(Ordering::SeqCst), 0);
    drop(selected);
    assert_eq!(original.released.load(Ordering::SeqCst), 1);
    let reconstructed = registry
        .select(&configuration())
        .unwrap()
        .bind(&configuration(), transport())
        .unwrap();
    reconstructed.serialize(&view(), None).unwrap();
    assert_eq!(replacement.calls.lock().unwrap()[0].0, "fresh-process");
    let mut changed = configuration();
    changed.adapter_identity = Some("different-artifact".into());
    assert!(registry.select(&changed).is_err());
}
