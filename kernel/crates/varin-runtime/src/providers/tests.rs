use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Credentials(AtomicUsize);
impl CredentialResolver for Credentials {
    fn headers(
        &self,
        _: Option<&str>,
        _: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(reqwest::header::HeaderMap::new())
    }
}
struct Stream {
    bytes: Vec<u8>,
    chunk: usize,
}
impl HttpTransport for Stream {
    fn stream(
        &self,
        _: HttpRequest<'_>,
        _: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        for bytes in self.bytes.chunks(self.chunk) {
            if receive(bytes)? {
                break;
            }
        }
        Ok(())
    }
}
fn connection(events: Vec<Value>, chunk: usize) -> Connection {
    let bytes = events
        .into_iter()
        .map(|v| format!("data: {v}\r\n\r\n"))
        .collect::<String>()
        .into_bytes();
    Connection::new(
        "https://fixture.invalid",
        Arc::new(Credentials(AtomicUsize::new(0))),
        Arc::new(Stream { bytes, chunk }),
    )
}
#[test]
fn pi_messages_fragmented_signed_thinking_and_tool_exchange_roundtrip() {
    let provider = pi_messages::PiMessagesProvider {
        connection: connection(
            vec![
                json!({"type":"start"}),
                json!({"type":"thinking_start","contentIndex":0}),
                json!({"type":"thinking_delta","contentIndex":0,"delta":"内部推理"}),
                json!({"type":"thinking_end","contentIndex":0,"content":"内部推理","contentSignature":"signed-thinking"}),
                json!({"type":"toolcall_start","contentIndex":1,"id":"call-1","toolName":"read"}),
                json!({"type":"toolcall_delta","contentIndex":1,"delta":"{\"path\":\"文件.rs\"}"}),
                json!({"type":"toolcall_end","contentIndex":1,"toolCall":{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"文件.rs"}}}),
                json!({"type":"done","reason":"toolUse","usage":{"input":20,"output":3,"cacheRead":10,"cacheWrite":0},"rewrite":{"policyId":"fixture","changed":false}}),
            ],
            1,
        ),
        max_output_tokens: Some(100),
        reasoning: Some("low".into()),
        cache_retention: None,
    };
    let (result, events) = generate(&provider, pi_messages::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    let mut replay = view(pi_messages::FAMILY);
    replay.history = events
        .into_iter()
        .filter_map(|event| match event {
            ProviderEvent::ItemCompleted { item } => Some(ConversationItem {
                id: item.id,
                provenance: Provenance::Assistant,
                content: item.content,
                opaque: item.opaque,
            }),
            _ => None,
        })
        .collect();
    replay.history.push(ConversationItem {
        id: "result".into(),
        provenance: Provenance::ToolData {
            call_id: "call-1".into(),
        },
        content: Content::ToolResult {
            result: ToolResult {
                request_id: "request".into(),
                call_id: "call-1".into(),
                completion: ToolCompletion::Result {
                    outcome: crate::Outcome::Succeeded,
                    effect: crate::Effect::None,
                    content: json!({"text":"source"}),
                },
            },
        },
        opaque: None,
    });
    let wire = provider.serialize(&replay).unwrap();
    assert_eq!(
        wire["context"]["messages"][0]["toolsAdded"][0]["name"],
        "read"
    );
    assert_eq!(
        wire["context"]["messages"][1]["content"][0]["thinkingSignature"],
        "signed-thinking"
    );
    assert_eq!(wire["context"]["messages"][2]["toolCallId"], "call-1");
    assert_eq!(wire["context"]["messages"][2]["toolName"], "read");
    assert_eq!(wire["options"]["reasoning"], "low");
}
fn view(family: &str) -> RequestView {
    RequestView {
        request_id: "request".into(),
        run_id: "run".into(),
        origin: RequestOrigin::Conversation {
            step: 1,
            history_range: HistoryRange {
                branch_id: "branch".into(),
                ancestor_id: None,
                leaf_id: None,
            },
        },
        binding: RequestBinding {
            resource_checkpoint_id: None,
            connection_identity: "fixture-connection".into(),
            provider_family: family.into(),
            model: "model".into(),
            credential_ref: Some("test-ref".into()),
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: vec![ToolSchema {
                description: String::new(),
                output_schema: None,
                metadata: None,
                name: "read".into(),
                version: "1".into(),
                schema: json!({"type":"object"}),
            }],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: "branch".into(),
                ancestor_id: None,
                leaf_id: None,
            },
        },
        history: vec![],
    }
}
fn generate(
    provider: &impl ModelProvider,
    family: &str,
) -> (Result<FinishReason, ModelFailure>, Vec<ProviderEvent>) {
    let view = view(family);
    let snapshot = RequestSnapshot {
        serialized: provider.serialize(&view).unwrap(),
        view,
    };
    let mut events = vec![];
    let result = provider.generate(&snapshot, &CancellationToken::default(), &mut |event| {
        events.push(event);
        Ok(())
    });
    (result, events)
}
#[test]
fn responses_fragmented_utf8_opaque_tool_and_usage_roundtrip() {
    let reasoning =
        json!({"id":"reason","type":"reasoning","encrypted_content":"opaque-你好","summary":[]});
    let tool = json!({"id":"call-item","type":"function_call","call_id":"call-1","name":"read","arguments":"{\"path\":\"文件.rs\"}"});
    let p = responses::ResponsesProvider::new(connection(
        vec![
            json!({"type":"response.output_item.done","item":reasoning}),
            json!({"type":"response.output_item.done","item":tool}),
            json!({"type":"response.completed","response":{"output":[reasoning,tool],"usage":{"input_tokens":20,"output_tokens":3,"input_tokens_details":{"cached_tokens":10}}}}),
        ],
        1,
    ));
    let (result, events) = generate(&p, responses::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    let items: Vec<_> = events
        .into_iter()
        .filter_map(|e| {
            if let ProviderEvent::ItemCompleted { item } = e {
                Some(item)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(items.len(), 2);
    let mut v = view(responses::FAMILY);
    v.history = items
        .into_iter()
        .map(|i| ConversationItem {
            id: i.id,
            provenance: Provenance::Assistant,
            content: i.content,
            opaque: i.opaque,
        })
        .collect();
    let serialized = p.serialize(&v).unwrap();
    assert_eq!(serialized["input"][0], reasoning);
    assert_eq!(serialized["input"][1], tool);
}
#[test]
fn contradictory_duplicate_responses_item_cannot_silently_change_continuation() {
    let original = json!({"id":"same","type":"reasoning","encrypted_content":"first"});
    let changed = json!({"id":"same","type":"reasoning","encrypted_content":"different"});
    let p = responses::ResponsesProvider::new(connection(
        vec![
            json!({"type":"response.output_item.done","item":original}),
            json!({"type":"response.completed","response":{"output":[changed]}}),
        ],
        7,
    ));
    let (result, _) = generate(&p, responses::FAMILY);
    assert!(
        result.is_err(),
        "duplicate provider identity with contradictory opaque body was accepted"
    );
}
#[test]
fn truncated_response_and_out_of_order_tool_delta_do_not_complete() {
    let p = responses::ResponsesProvider::new(connection(
        vec![json!({"type":"response.output_text.delta","item_id":"m","delta":"partial"})],
        3,
    ));
    assert_eq!(
        generate(&p, responses::FAMILY).0.unwrap_err().code,
        "stream_interrupted"
    );
    let p = responses::ResponsesProvider::new(connection(
        vec![
            json!({"type":"response.function_call_arguments.delta","item_id":"unknown","delta":"{}"}),
        ],
        2,
    ));
    assert_eq!(
        generate(&p, responses::FAMILY).0.unwrap_err().code,
        "invalid_event_order"
    );
}
#[test]
fn anthropic_signature_and_server_tool_remain_opaque() {
    let p = anthropic::AnthropicProvider::new(
        connection(
            vec![
                json!({"type":"message_start","message":{"id":"msg","usage":{"input_tokens":10,"output_tokens":0}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"保留"}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"server","name":"web_search","input":{"query":"x"}}}),
                json!({"type":"content_block_stop","index":1}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
                json!({"type":"message_stop"}),
            ],
            1,
        ),
        100,
    );
    let (result, events) = generate(&p, anthropic::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::Stop);
    let items: Vec<_> = events
        .into_iter()
        .filter_map(|e| {
            if let ProviderEvent::ItemCompleted { item } = e {
                Some(item)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .all(|i| matches!(i.content, Content::ProviderOnly)));
    let mut v = view(anthropic::FAMILY);
    v.history = items
        .into_iter()
        .map(|i| ConversationItem {
            id: i.id,
            provenance: Provenance::Assistant,
            content: i.content,
            opaque: i.opaque,
        })
        .collect();
    let out = p.serialize(&v).unwrap();
    assert_eq!(out["messages"][0]["content"][0]["signature"], "signed");
    assert_eq!(out["messages"][0]["content"][1]["type"], "server_tool_use");
}
#[test]
fn cancelled_before_send_never_resolves_credentials() {
    let credentials = Arc::new(Credentials(AtomicUsize::new(0)));
    let p = responses::ResponsesProvider::new(Connection::new(
        "https://fixture.invalid",
        credentials.clone(),
        Arc::new(Stream {
            bytes: vec![],
            chunk: 1,
        }),
    ));
    let view = view(responses::FAMILY);
    let snapshot = RequestSnapshot {
        serialized: p.serialize(&view).unwrap(),
        view,
    };
    let cancel = CancellationToken::default();
    cancel.cancel();
    assert_eq!(
        p.generate(&snapshot, &cancel, &mut |_| Ok(()))
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert_eq!(credentials.0.load(Ordering::SeqCst), 0);
}

fn loopback_response(response: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/model", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut bytes = [0u8; 8192];
        let size = socket.read(&mut bytes).unwrap();
        assert!(size > 0);
        socket.write_all(&response).unwrap();
    });
    (endpoint, worker)
}
#[test]
fn http_status_preserves_retry_and_request_id_without_echoing_body() {
    let body = "secret prompt must not enter failure";
    let response=format!("HTTP/1.1 429 Too Many Requests\r\nContent-Length: {}\r\nRetry-After: 2\r\nX-Request-ID: server-123\r\nConnection: close\r\n\r\n{body}",body.len());
    let (endpoint, server) = loopback_response(response.into_bytes());
    let transport = ReqwestTransport::new(|| reqwest::Client::builder().no_proxy());
    let error = transport
        .stream(
            HttpRequest {
                endpoint: &endpoint,
                headers: reqwest::header::HeaderMap::new(),
                body: &json!({"input":"fixture"}),
            },
            &CancellationToken::default(),
            &mut |_| Ok(false),
        )
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, "http_429");
    assert_eq!(error.retry_after_ms, Some(2000));
    assert_eq!(error.provider_request_id.as_deref(), Some("server-123"));
    assert!(!error.message.contains("secret prompt"));
}
#[test]
fn http_cancellation_interrupts_stalled_headers_and_body() {
    use std::io::{Read, Write};
    for send_headers in [false, true] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/model", listener.local_addr().unwrap());
        let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = [0u8; 8192];
            assert!(socket.read(&mut bytes).unwrap() > 0);
            if send_headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            }
            accepted_tx.send(()).unwrap();
            let _ = release_rx.recv();
        });
        let cancel = CancellationToken::default();
        let worker_cancel = cancel.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let transport = ReqwestTransport::new(|| reqwest::Client::builder().no_proxy());
            let result = transport.stream(
                HttpRequest {
                    endpoint: &endpoint,
                    headers: reqwest::header::HeaderMap::new(),
                    body: &json!({}),
                },
                &worker_cancel,
                &mut |_| Ok(false),
            );
            done_tx.send(result).unwrap();
        });
        accepted_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        cancel.cancel();
        let result = done_rx.recv_timeout(std::time::Duration::from_secs(3));
        let _ = release_tx.send(());
        server.join().unwrap();
        worker.join().unwrap();
        assert_eq!(result.unwrap().unwrap_err().code, "cancelled");
    }
}
#[test]
fn actual_http_sse_reaches_responses_adapter() {
    let data = format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{"output":[{"id":"message","type":"message","content":[{"type":"output_text","text":"local transport"}]}]}})
    );
    let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len());
    let (endpoint, server) = loopback_response(response.into_bytes());
    let p = responses::ResponsesProvider::new(Connection::new(
        endpoint,
        Arc::new(Credentials(AtomicUsize::new(0))),
        Arc::new(ReqwestTransport::new(|| {
            reqwest::Client::builder().no_proxy()
        })),
    ));
    let (result, events) = generate(&p, responses::FAMILY);
    server.join().unwrap();
    assert_eq!(result.unwrap(), FinishReason::Stop);
    assert!(events.iter().any(|e|matches!(e,ProviderEvent::ItemCompleted{item} if matches!(&item.content,Content::Text{text} if text=="local transport"))));
}

#[test]
fn transport_reuses_builder_and_keeps_headers_request_local() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/model", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut captured = Vec::new();
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = [0u8; 8192];
            let size = socket.read(&mut bytes).unwrap();
            captured.push(String::from_utf8(bytes[..size].to_vec()).unwrap());
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 10\r\nConnection: close\r\n\r\ndata: {}\n\n").unwrap();
        }
        captured
    });
    let builds = Arc::new(AtomicUsize::new(0));
    let counted = builds.clone();
    let transport = ReqwestTransport::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        reqwest::Client::builder().no_proxy()
    });
    for token in ["fixture-A", "fixture-B"] {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        transport
            .stream(
                HttpRequest {
                    endpoint: &endpoint,
                    headers,
                    body: &json!({}),
                },
                &CancellationToken::default(),
                &mut |_| Ok(true),
            )
            .unwrap();
    }
    let requests = server.join().unwrap();
    assert_eq!(builds.load(Ordering::SeqCst), 1);
    assert!(requests[0].contains("Bearer fixture-A"));
    assert!(!requests[0].contains("fixture-B"));
    assert!(requests[1].contains("Bearer fixture-B"));
    assert!(!requests[1].contains("fixture-A"));
}
#[test]
fn shared_reqwest_transport_has_independent_progress_and_cancellation() {
    use std::io::{Read, Write};
    let slow = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let slow_endpoint = format!("http://{}/slow", slow.local_addr().unwrap());
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let slow_server = std::thread::spawn(move || {
        let (mut socket, _) = slow.accept().unwrap();
        let mut bytes = [0u8; 8192];
        assert!(socket.read(&mut bytes).unwrap() > 0);
        started_tx.send(()).unwrap();
        let _ = release_rx.recv();
    });
    let transport = Arc::new(ReqwestTransport::new(|| {
        reqwest::Client::builder().no_proxy()
    }));
    let cancel = CancellationToken::default();
    let slow_cancel = cancel.clone();
    let slow_transport = transport.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let slow_request = std::thread::spawn(move || {
        let result = slow_transport.stream(
            HttpRequest {
                endpoint: &slow_endpoint,
                headers: reqwest::header::HeaderMap::new(),
                body: &json!({}),
            },
            &slow_cancel,
            &mut |_| Ok(true),
        );
        done_tx.send(result).unwrap();
    });
    started_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let response=b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 10\r\nConnection: close\r\n\r\ndata: {}\n\n".to_vec();
    let fast_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let fast_endpoint = format!("http://{}/sibling", fast_listener.local_addr().unwrap());
    let (sibling_started_tx, sibling_started_rx) = std::sync::mpsc::channel();
    let (sibling_release_tx, sibling_release_rx) = std::sync::mpsc::channel();
    let fast_server = std::thread::spawn(move || {
        let (mut socket, _) = fast_listener.accept().unwrap();
        let mut bytes = [0u8; 8192];
        assert!(socket.read(&mut bytes).unwrap() > 0);
        sibling_started_tx.send(()).unwrap();
        let _ = sibling_release_rx.recv();
        socket.write_all(&response).unwrap();
    });
    let (fast_tx, fast_rx) = std::sync::mpsc::channel();
    let fast_transport = transport.clone();
    let fast_request = std::thread::spawn(move || {
        let result = fast_transport.stream(
            HttpRequest {
                endpoint: &fast_endpoint,
                headers: reqwest::header::HeaderMap::new(),
                body: &json!({}),
            },
            &CancellationToken::default(),
            &mut |_| Ok(true),
        );
        fast_tx.send(result).unwrap();
    });
    let sibling_started = sibling_started_rx.recv_timeout(std::time::Duration::from_secs(3));
    cancel.cancel();
    let cancelled = done_rx.recv_timeout(std::time::Duration::from_secs(3));
    let _ = sibling_release_tx.send(());
    let fast_result = fast_rx.recv_timeout(std::time::Duration::from_secs(3));
    let _ = release_tx.send(());
    slow_server.join().unwrap();
    fast_server.join().unwrap();
    slow_request.join().unwrap();
    fast_request.join().unwrap();
    assert!(
        sibling_started.is_ok(),
        "stalled first request blocked the sibling from starting"
    );
    assert!(
        fast_result.unwrap().is_ok(),
        "one stalled request held the shared connection owner"
    );
    assert_eq!(cancelled.unwrap().unwrap_err().code, "cancelled");
    assert_eq!(Arc::strong_count(&transport), 1);
}

fn chat_connection(events: Vec<Value>, done: bool) -> Connection {
    let mut bytes = events
        .into_iter()
        .map(|v| format!("data: {v}\n\n"))
        .collect::<String>();
    if done {
        bytes.push_str("data: [DONE]\n\n");
    }
    Connection::new(
        "https://fixture.invalid",
        Arc::new(Credentials(AtomicUsize::new(0))),
        Arc::new(Stream {
            bytes: bytes.into_bytes(),
            chunk: 1,
        }),
    )
}
#[test]
fn chat_complete_tool_fragments_replay_once_and_keep_usage_after_finish() {
    let p = chat::ChatProvider::new(chat_connection(
        vec![
            json!({"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":"}}]},"finish_reason":null}]}),
            json!({"id":"chat-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"文件.rs\"}"}}]},"finish_reason":"tool_calls"}]}),
            json!({"id":"chat-1","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"prompt_tokens_details":{"cached_tokens":10}}}),
        ],
        true,
    ));
    let (result, events) = generate(&p, chat::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    assert!(events.iter().any(|event|matches!(event,ProviderEvent::Usage{receipt} if receipt.input_tokens==Some(20)&&receipt.output_tokens==Some(4))));
    let items: Vec<_> = events
        .into_iter()
        .filter_map(|e| {
            if let ProviderEvent::ItemCompleted { item } = e {
                Some(item)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(items.len(), 2);
    let mut v = view(chat::FAMILY);
    v.history = items
        .into_iter()
        .map(|i| ConversationItem {
            id: i.id,
            provenance: Provenance::Assistant,
            content: i.content,
            opaque: i.opaque,
        })
        .collect();
    let replay = p.serialize(&v).unwrap();
    assert_eq!(replay["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        replay["messages"][0]["tool_calls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(replay["messages"][0]["tool_calls"][0]["id"], "call-1");
}
#[test]
fn chat_truncated_after_finish_does_not_emit_complete_items_and_multiple_choices_reject() {
    let event = json!({"id":"chat-1","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop"}]});
    let p = chat::ChatProvider::new(chat_connection(vec![event], false));
    let (result, events) = generate(&p, chat::FAMILY);
    assert_eq!(result.unwrap_err().code, "stream_interrupted");
    assert!(!events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ItemCompleted { .. })));
    let p = chat::ChatProvider::new(chat_connection(
        vec![
            json!({"id":"chat-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"},{"index":1,"delta":{},"finish_reason":"stop"}]}),
        ],
        true,
    ));
    assert!(generate(&p, chat::FAMILY).0.is_err());
}
#[test]
fn azure_keeps_query_deployment_header_and_distinct_opaque_family() {
    struct AzureCredential;
    impl CredentialResolver for AzureCredential {
        fn headers(
            &self,
            _: Option<&str>,
            _: &CancellationToken,
        ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("api-key", "fixture-only".parse().unwrap());
            Ok(headers)
        }
    }
    struct AzureEndpoint;
    impl HttpTransport for AzureEndpoint {
        fn stream(
            &self,
            request: HttpRequest<'_>,
            _: &CancellationToken,
            receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
        ) -> Result<(), ModelFailure> {
            let url = reqwest::Url::parse(request.endpoint).unwrap();
            let query: std::collections::BTreeMap<_, _> = url.query_pairs().collect();
            assert_eq!(query.get("tenant").unwrap(), "fixture");
            assert_eq!(query.get("api-version").unwrap(), "2025-04-01-preview");
            assert_eq!(request.body["model"], "my-deployment");
            assert_eq!(request.headers["api-key"], "fixture-only");
            assert!(!request.headers.contains_key("authorization"));
            let event = json!({"type":"response.completed","response":{"output":[{"id":"reasoning","type":"reasoning","encrypted_content":"azure-original"}]}});
            receive(format!("data: {event}\n\n").as_bytes())?;
            Ok(())
        }
    }
    let connection = Connection::new(
        "https://azure.example/responses?tenant=fixture",
        Arc::new(AzureCredential),
        Arc::new(AzureEndpoint),
    );
    let p = azure::AzureResponsesProvider::new(connection, "my-deployment", "2025-04-01-preview")
        .unwrap();
    let (result, events) = generate(&p, azure::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::Stop);
    assert!(events.iter().any(|e|matches!(e,ProviderEvent::ItemCompleted{item} if item.opaque.as_ref().is_some_and(|o|o.family==azure::FAMILY&&o.value["encrypted_content"]=="azure-original"))));
    let conflicting = Connection::new(
        "https://azure.example/responses?api-version=other",
        Arc::new(AzureCredential),
        Arc::new(AzureEndpoint),
    );
    assert!(
        azure::AzureResponsesProvider::new(conflicting, "deployment", "2025-04-01-preview")
            .is_err()
    );
}

#[test]
fn google_signed_parts_replay_in_place_and_optional_call_ids_pair_by_name() {
    let text = json!({"text":"context","thoughtSignature":"text-signature"});
    let call = json!({"functionCall":{"name":"read","args":{"path":"x"}},"thoughtSignature":"call-signature"});
    let p=google::GoogleProvider::new(connection(vec![json!({"responseId":"g","candidates":[{"index":0,"content":{"role":"model","parts":[text,call]}}]}),json!({"responseId":"g","candidates":[{"index":0,"finishReason":"STOP"}]}),json!({"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":4,"thoughtsTokenCount":2,"cachedContentTokenCount":3}})],1)).unwrap();
    let (result, events) = generate(&p, google::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    assert!(events.iter().any(|e|matches!(e,ProviderEvent::Usage{receipt} if receipt.output_tokens==Some(6)&&receipt.reasoning_tokens==Some(2))));
    let items: Vec<_> = events
        .into_iter()
        .filter_map(|e| {
            if let ProviderEvent::ItemCompleted { item } = e {
                Some(item)
            } else {
                None
            }
        })
        .collect();
    let call_id = items
        .iter()
        .find_map(|i| {
            if let Content::ToolCall { call } = &i.content {
                Some(call.call_id.clone())
            } else {
                None
            }
        })
        .unwrap();
    let mut v = view(google::FAMILY);
    v.history = items
        .into_iter()
        .map(|i| ConversationItem {
            id: i.id,
            provenance: Provenance::Assistant,
            content: i.content,
            opaque: i.opaque,
        })
        .collect();
    v.history.push(ConversationItem {
        id: "result".into(),
        provenance: Provenance::ToolData {
            call_id: call_id.clone(),
        },
        content: Content::ToolResult {
            result: ToolResult {
                request_id: "request".into(),
                call_id,
                completion: ToolCompletion::Result {
                    outcome: crate::Outcome::Succeeded,
                    effect: crate::Effect::None,
                    content: json!("bytes"),
                },
            },
        },
        opaque: None,
    });
    let replay = p.serialize(&v).unwrap();
    assert_eq!(replay["contents"][0]["parts"][0], text);
    assert_eq!(replay["contents"][0]["parts"][1], call);
    let response = &replay["contents"][1]["parts"][0]["functionResponse"];
    assert_eq!(response["name"], "read");
    assert!(response.get("id").is_none());
    v.binding.model = "another-model".into();
    assert!(!p
        .serialize(&v)
        .unwrap()
        .to_string()
        .contains("thoughtSignature"));
    let vertex = google::GoogleProvider::vertex(connection(vec![], 1)).unwrap();
    v.binding.provider_family = google::VERTEX_FAMILY.into();
    assert!(!vertex
        .serialize(&v)
        .unwrap()
        .to_string()
        .contains("thoughtSignature"));
}
#[test]
fn google_requires_terminal_evidence_and_rejects_partial_functions() {
    let p = google::GoogleProvider::new(connection(
        vec![json!({"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]})],
        1,
    ))
    .unwrap();
    assert_eq!(
        generate(&p, google::FAMILY).0.unwrap_err().code,
        "stream_interrupted"
    );
    let p = google::GoogleProvider::new(connection(
        vec![json!({"promptFeedback":{"blockReason":"SAFETY"}})],
        1,
    ))
    .unwrap();
    assert_eq!(
        generate(&p, google::FAMILY).0.unwrap(),
        FinishReason::ContentFilter
    );
    let p=google::GoogleProvider::new(connection(vec![json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","partialArgs":[{"jsonPath":"$.path","stringValue":"x"}]}}]},"finishReason":"STOP"}]})],1)).unwrap();
    assert_eq!(
        generate(&p, google::FAMILY).0.unwrap_err().code,
        "unsupported_function_streaming"
    );
    let p = google::GoogleProvider::new(connection(
        vec![json!({"candidates":[{"index":0},{"index":1}]})],
        1,
    ))
    .unwrap();
    assert!(generate(&p, google::FAMILY).0.is_err());
}
#[test]
fn google_accepts_actual_http_eof_only_after_finish_reason() {
    let data = format!(
        "data: {}\n\n",
        json!({"responseId":"g","candidates":[{"content":{"role":"model","parts":[{"text":"EOF answer"}]},"finishReason":"STOP"}]})
    );
    let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len());
    let (endpoint, server) = loopback_response(response.into_bytes());
    let p = google::GoogleProvider::new(Connection::new(
        endpoint,
        Arc::new(Credentials(AtomicUsize::new(0))),
        Arc::new(ReqwestTransport::new(|| {
            reqwest::Client::builder().no_proxy()
        })),
    ))
    .unwrap();
    let (result, events) = generate(&p, google::FAMILY);
    server.join().unwrap();
    assert_eq!(result.unwrap(), FinishReason::Stop);
    assert!(events.iter().any(|e|matches!(e,ProviderEvent::ItemCompleted{item} if matches!(&item.content,Content::Text{text} if text=="EOF answer"))));
}

#[test]
fn same_protocol_other_connection_never_receives_opaque_history() {
    let reasoning =
        json!({"id":"reasoning","type":"reasoning","encrypted_content":"connection-owned"});
    let message = json!({"id":"message","type":"message","content":[{"type":"output_text","text":"portable answer"}]});
    let p = responses::ResponsesProvider::new(connection(
        vec![json!({"type":"response.completed","response":{"output":[reasoning,message]}})],
        1,
    ));
    let (_, events) = generate(&p, responses::FAMILY);
    let mut v = view(responses::FAMILY);
    v.history = events
        .into_iter()
        .filter_map(|e| {
            if let ProviderEvent::ItemCompleted { item } = e {
                Some(ConversationItem {
                    id: item.id,
                    provenance: Provenance::Assistant,
                    content: item.content,
                    opaque: item.opaque,
                })
            } else {
                None
            }
        })
        .collect();
    assert!(v
        .history
        .iter()
        .all(|item| item.opaque.as_ref().unwrap().connection_identity
            == v.binding.connection_identity));
    assert!(p
        .serialize(&v)
        .unwrap()
        .to_string()
        .contains("connection-owned"));
    v.binding.connection_identity = "different-tenant".into();
    let changed = p.serialize(&v).unwrap().to_string();
    assert!(!changed.contains("connection-owned"));
    assert!(changed.contains("portable answer"));
    v.binding.connection_identity.clear();
    for item in &mut v.history {
        item.opaque.as_mut().unwrap().connection_identity.clear();
    }
    let unidentified = p.serialize(&v).unwrap().to_string();
    assert!(!unidentified.contains("connection-owned"));
    assert!(unidentified.contains("portable answer"));
}

#[test]
fn mistral_wire_id_collision_keeps_both_tool_result_pairs() {
    let first = "original-nonstandard-call-id".to_string();
    let second = mistral::derive_id(&first, 0);
    let p = mistral::MistralProvider::new(connection(vec![], 1));
    let mut v = view(mistral::FAMILY);
    for id in [&first, &second] {
        v.history.push(ConversationItem {
            id: format!("item-{id}"),
            provenance: Provenance::Assistant,
            content: Content::ToolCall {
                call: ToolCall {
                    call_id: id.clone(),
                    name: "read".into(),
                    schema_version: "1".into(),
                    arguments: json!({}),
                },
            },
            opaque: None,
        });
    }
    for id in [&first, &second] {
        v.history.push(ConversationItem {
            id: format!("result-{id}"),
            provenance: Provenance::ToolData {
                call_id: id.clone(),
            },
            content: Content::ToolResult {
                result: ToolResult {
                    request_id: "request".into(),
                    call_id: id.clone(),
                    completion: ToolCompletion::Result {
                        outcome: crate::Outcome::Succeeded,
                        effect: crate::Effect::None,
                        content: json!("ok"),
                    },
                },
            },
            opaque: None,
        });
    }
    let body = p.serialize(&v).unwrap();
    let calls = body["messages"][0]["tool_calls"].as_array().unwrap();
    let a = calls[0]["id"].as_str().unwrap();
    let b = calls[1]["id"].as_str().unwrap();
    assert_ne!(a, b);
    for id in [a, b] {
        assert_eq!(id.len(), 9);
        assert!(id.bytes().all(|b| b.is_ascii_alphanumeric()));
    }
    assert_eq!(body["messages"][1]["tool_call_id"], a);
    assert_eq!(body["messages"][2]["tool_call_id"], b);
    assert_eq!(body["messages"][1]["name"], "read");
}
#[test]
fn mistral_thinking_chunks_and_clean_eof_preserve_visible_text() {
    let events = vec![
        json!({"id":"mistral-1","choices":[{"index":0,"delta":{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"first"}]}]},"finish_reason":null}]}),
        json!({"id":"mistral-1","choices":[{"index":0,"delta":{"content":[{"type":"text","text":""},{"type":"thinking","thinking":[{"type":"text","text":"second"}]},{"type":"text","text":"visible"}]},"finish_reason":"stop"}]}),
    ];
    let p = mistral::MistralProvider::new(connection(events.clone(), 1));
    let (result, output) = generate(&p, mistral::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::Stop);
    let item = output
        .into_iter()
        .find_map(|e| {
            if let ProviderEvent::ItemCompleted { item } = e {
                Some(item)
            } else {
                None
            }
        })
        .unwrap();
    assert!(matches!(&item.content,Content::Text{text} if text=="visible"));
    let raw = item.opaque.unwrap().value;
    assert_eq!(raw["content"][0]["thinking"].as_array().unwrap().len(), 2);
    assert_eq!(raw["content"][1]["text"], "visible");
    let strict = chat::ChatProvider::new(chat_connection(
        vec![
            json!({"id":"strict","choices":[{"index":0,"delta":{"content":"visible"},"finish_reason":"stop"}]}),
        ],
        false,
    ));
    assert_eq!(
        generate(&strict, chat::FAMILY).0.unwrap_err().code,
        "stream_interrupted"
    );
}
#[test]
fn mistral_missing_call_id_and_object_arguments_form_stable_complete_call() {
    let p = mistral::MistralProvider::new(connection(
        vec![
            json!({"id":"mistral-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":null,"function":{"name":"read","arguments":{"path":"x"}}}]},"finish_reason":"tool_calls"}]}),
        ],
        1,
    ));
    let (result, output) = generate(&p, mistral::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    let call = output
        .into_iter()
        .find_map(|e| {
            if let ProviderEvent::ItemCompleted { item } = e {
                if let Content::ToolCall { call } = item.content {
                    Some(call)
                } else {
                    None
                }
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(call.call_id.len(), 9);
    assert_eq!(call.arguments, json!({"path":"x"}));
}

#[test]
fn mistral_repeated_function_name_does_not_duplicate_the_bound_tool() {
    let p = mistral::MistralProvider::new(connection(
        vec![
            json!({"id":"mistral-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"abc123XYZ","function":{"name":"read","arguments":"{"}}]},"finish_reason":null}]}),
            json!({"id":"mistral-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"\"path\":\"x\"}"}}]},"finish_reason":"tool_calls"}]}),
        ],
        1,
    ));
    let (result, events) = generate(&p, mistral::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    assert!(events.iter().any(|e|matches!(e,ProviderEvent::ItemCompleted{item} if matches!(&item.content,Content::ToolCall{call} if call.name=="read"&&call.arguments==json!({"path":"x"})))));
}

#[test]
fn codex_fixture_separates_instructions_and_pins_session_headers() {
    struct CodexCredentials;
    impl CredentialResolver for CodexCredentials {
        fn headers(
            &self,
            _: Option<&str>,
            _: &CancellationToken,
        ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("authorization", "Bearer fixture-only".parse().unwrap());
            headers.insert("chatgpt-account-id", "fixture-account".parse().unwrap());
            Ok(headers)
        }
    }
    struct CodexEndpoint;
    impl HttpTransport for CodexEndpoint {
        fn stream(
            &self,
            request: HttpRequest<'_>,
            _: &CancellationToken,
            receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
        ) -> Result<(), ModelFailure> {
            assert_eq!(request.headers["originator"], "varin");
            assert_eq!(request.headers["openai-beta"], "responses=experimental");
            assert_eq!(request.headers["chatgpt-account-id"], "fixture-account");
            let key = request.body["prompt_cache_key"].as_str().unwrap();
            assert_eq!(key.len(), 64);
            assert_eq!(request.headers["session-id"], key);
            assert_eq!(request.headers["x-client-request-id"], "request");
            let event = json!({"type":"response.completed","response":{"output":[{"id":"reasoning","type":"reasoning","encrypted_content":"codex-original"}]}});
            receive(format!("data: {event}\n\n").as_bytes())?;
            Ok(())
        }
    }
    let provider = codex::CodexProvider::new(Connection::new(
        "https://fixture.invalid/codex/responses",
        Arc::new(CodexCredentials),
        Arc::new(CodexEndpoint),
    ));
    let mut v = view(codex::FAMILY);
    v.binding.history_range.branch_id = "long-branch/with unicode 测试".repeat(8);
    v.history = vec![
        ConversationItem {
            id: "system".into(),
            provenance: Provenance::SystemInstruction {
                source: "fixture".into(),
            },
            content: Content::Text {
                text: "Follow the fixture task".into(),
            },
            opaque: None,
        },
        ConversationItem {
            id: "user".into(),
            provenance: Provenance::UserInstruction {
                input_id: "user".into(),
            },
            content: Content::Text {
                text: "hello".into(),
            },
            opaque: None,
        },
    ];
    let body = provider.serialize(&v).unwrap();
    assert_eq!(body["instructions"], "Follow the fixture task");
    assert_eq!(body["input"].as_array().unwrap().len(), 1);
    assert_eq!(body["store"], false);
    assert_eq!(body["parallel_tool_calls"], true);
    assert!(body.get("max_output_tokens").is_none());
    assert!(!body.to_string().contains("fixture-only"));
    let mut output = Vec::new();
    assert_eq!(
        provider
            .generate(
                &RequestSnapshot {
                    view: v,
                    serialized: body
                },
                &CancellationToken::default(),
                &mut |e| {
                    output.push(e);
                    Ok(())
                }
            )
            .unwrap(),
        FinishReason::Stop
    );
    assert!(output.iter().any(|e|matches!(e,ProviderEvent::ItemCompleted{item} if item.opaque.as_ref().is_some_and(|raw|raw.family==codex::FAMILY&&raw.connection_identity=="fixture-connection"))));
}
#[test]
fn codex_never_infers_account_identity_or_calls_http_without_it() {
    struct BearerOnly;
    impl CredentialResolver for BearerOnly {
        fn headers(
            &self,
            _: Option<&str>,
            _: &CancellationToken,
        ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("authorization", "Bearer fixture-only".parse().unwrap());
            Ok(headers)
        }
    }
    struct NeverHttp(Arc<AtomicUsize>);
    impl HttpTransport for NeverHttp {
        fn stream(
            &self,
            _: HttpRequest<'_>,
            _: &CancellationToken,
            _: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
        ) -> Result<(), ModelFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(failure(
                "unexpected_http",
                "credential boundary was skipped",
            ))
        }
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = codex::CodexProvider::new(Connection::new(
        "https://fixture.invalid/codex/responses",
        Arc::new(BearerOnly),
        Arc::new(NeverHttp(calls.clone())),
    ));
    assert_eq!(
        generate(&provider, codex::FAMILY).0.unwrap_err().code,
        "codex_credential_binding_required"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn explicit_model_image_capability_rejects_attachment_before_request_serialization() {
    let mut connection = connection(vec![], 1);
    connection.accepts_images = Some(false);
    let provider = responses::ResponsesProvider::new(connection);
    let mut request = view(responses::FAMILY);
    request.history.push(ConversationItem {
        id: "image".into(),
        provenance: Provenance::UserInstruction {
            input_id: "input".into(),
        },
        content: Content::Attachment {
            media_type: "image/png".into(),
            content_ref: "data:image/png;base64,ZmFrZQ==".into(),
            source: "user upload".into(),
        },
        opaque: None,
    });
    assert_eq!(
        provider.serialize(&request).unwrap_err().code,
        "unsupported_model_image"
    );
    request.history[0].content = Content::Text {
        text: "ordinary text".into(),
    };
    assert!(provider.serialize(&request).is_ok());
}

// AWS eventstream fixture uses Python zlib CRC32, independently of the decoder.
struct BedrockFixture {
    bytes: Vec<u8>,
    calls: AtomicUsize,
}
impl HttpTransport for BedrockFixture {
    fn stream(
        &self,
        _: HttpRequest<'_>,
        _: &CancellationToken,
        _: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        panic!("Bedrock must use binary transport")
    }
    fn stream_eventstream(
        &self,
        _: HttpRequest<'_>,
        _: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        for byte in &self.bytes {
            receive(&[*byte])?;
        }
        Ok(())
    }
}
struct BedrockFixtureCredential;
impl CredentialResolver for BedrockFixtureCredential {
    fn headers(
        &self,
        _: Option<&str>,
        _: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("authorization", "Bearer fake-local-only".parse().unwrap());
        Ok(headers)
    }
}
fn bedrock_fixture(bytes: Vec<u8>) -> (bedrock::BedrockProvider, Arc<BedrockFixture>) {
    let transport = Arc::new(BedrockFixture {
        bytes,
        calls: AtomicUsize::new(0),
    });
    (
        bedrock::BedrockProvider::new(Connection::new(
            "https://fixture.invalid/model/model/converse-stream",
            Arc::new(BedrockFixtureCredential),
            transport.clone(),
        )),
        transport,
    )
}
#[test]
fn bedrock_fragmented_binary_preserves_reasoning_tool_and_trailing_usage() {
    let (provider, _) =
        bedrock_fixture(include_bytes!("../../tests/fixtures/bedrock-converse.bin").to_vec());
    let (result, events) = generate(&provider, bedrock::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    assert!(events.iter().any(|event|matches!(event,ProviderEvent::Usage{receipt} if receipt.input_tokens==Some(10)&&receipt.cached_input_tokens==Some(2))));
    let items: Vec<_> = events
        .into_iter()
        .filter_map(|event| {
            if let ProviderEvent::ItemCompleted { item } = event {
                Some(item)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(items.len(), 2);
    assert_eq!(
        items[0].opaque.as_ref().unwrap().value["block"]["reasoningContent"]["reasoningText"]
            ["signature"],
        "opaque-signature"
    );
    assert!(
        matches!(&items[1].content,Content::ToolCall{call} if call.arguments==json!({"path":"file"}))
    );
    let mut request = view(bedrock::FAMILY);
    request.history = items
        .into_iter()
        .map(|item| ConversationItem {
            id: item.id,
            provenance: Provenance::Assistant,
            content: item.content,
            opaque: item.opaque,
        })
        .collect();
    let replay = provider.serialize(&request).unwrap();
    assert_eq!(
        replay["messages"][0]["content"][0]["reasoningContent"]["reasoningText"]["signature"],
        "opaque-signature"
    );
    assert_eq!(
        replay["messages"][0]["content"][1]["toolUse"]["toolUseId"],
        "call1"
    );
}
#[test]
fn bedrock_truncated_or_corrupt_frame_fails_and_pre_cancel_never_sends() {
    let bytes = include_bytes!("../../tests/fixtures/bedrock-converse.bin");
    let (provider, _) = bedrock_fixture(bytes[..bytes.len() - 2].to_vec());
    assert!(generate(&provider, bedrock::FAMILY).0.is_err());
    let mut corrupt = bytes.to_vec();
    corrupt[15] ^= 1;
    let (provider, _) = bedrock_fixture(corrupt);
    assert_eq!(
        generate(&provider, bedrock::FAMILY).0.unwrap_err().code,
        "invalid_eventstream"
    );
    let (provider, transport) = bedrock_fixture(bytes.to_vec());
    let view = view(bedrock::FAMILY);
    let snapshot = RequestSnapshot {
        serialized: provider.serialize(&view).unwrap(),
        view,
    };
    let cancel = CancellationToken::default();
    cancel.cancel();
    assert_eq!(
        provider
            .generate(&snapshot, &cancel, &mut |_| Ok(()))
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn actual_binary_http_reaches_bedrock_adapter_through_clean_eof() {
    let bytes = include_bytes!("../../tests/fixtures/bedrock-converse.bin");
    let mut response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.amazon.eventstream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).into_bytes();
    response.extend_from_slice(bytes);
    let (endpoint, server) = loopback_response(response);
    let provider = bedrock::BedrockProvider::new(Connection::new(
        endpoint,
        Arc::new(BedrockFixtureCredential),
        Arc::new(ReqwestTransport::new(|| {
            reqwest::Client::builder().no_proxy()
        })),
    ));
    let (result, events) = generate(&provider, bedrock::FAMILY);
    server.join().unwrap();
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    assert!(events.iter().any(
        |event| matches!(event,ProviderEvent::Usage{receipt} if receipt.output_tokens==Some(4))
    ));
}

#[test]
fn planning_call_original_is_retained_without_weakening_main_schema_authority() {
    let raw = json!({"id":"unoffered-item","type":"function_call","call_id":"unoffered-call","name":"unoffered","arguments":"{\"sentinel\":\"original\"}","provider_private":{"keep":true}});
    for planning in [false, true] {
        let provider = responses::ResponsesProvider::new(connection(
            vec![
                json!({"type":"response.output_item.done","item":raw}),
                json!({"type":"response.completed","response":{"output":[raw]}}),
            ],
            5,
        ));
        let mut view = view(responses::FAMILY);
        view.binding.tools.clear();
        if planning {
            view.origin = RequestOrigin::PolicyModelJob {
                action_id: "planning-action".into(),
                purpose: "planning".into(),
                boundary_id: "boundary".into(),
            };
        }
        let serialized = provider.serialize(&view).unwrap();
        let snapshot = RequestSnapshot { view, serialized };
        let mut events = Vec::new();
        let result = provider.generate(&snapshot, &CancellationToken::default(), &mut |event| {
            events.push(event);
            Ok(())
        });
        if planning {
            assert_eq!(result.unwrap(), FinishReason::ToolCalls);
            let items: Vec<_> = events
                .into_iter()
                .filter_map(|event| match event {
                    ProviderEvent::ItemCompleted { item } => Some(item),
                    _ => None,
                })
                .collect();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].opaque.as_ref().unwrap().value, raw);
            assert!(
                matches!(&items[0].content,Content::ToolCall{call} if call.schema_version.is_empty() && call.name=="unoffered")
            );
        } else {
            assert_eq!(result.unwrap_err().code, "unknown_tool_schema");
            assert!(!events.iter().any(|e|matches!(e,ProviderEvent::ItemCompleted{item} if matches!(item.content,Content::ToolCall{..}))));
        }
    }
}

#[test]
fn policy_output_is_assistant_history_in_every_provider_family() {
    let providers: Vec<(&str, Box<dyn ModelProvider>, &[&str], &str)> = vec![
        (
            chat::FAMILY,
            Box::new(chat::ChatProvider::new(connection(vec![], 1))),
            &["messages"],
            "assistant",
        ),
        (
            responses::FAMILY,
            Box::new(responses::ResponsesProvider::new(connection(vec![], 1))),
            &["input"],
            "assistant",
        ),
        (
            codex::FAMILY,
            Box::new(codex::CodexProvider::new(connection(vec![], 1))),
            &["input"],
            "assistant",
        ),
        (
            anthropic::FAMILY,
            Box::new(anthropic::AnthropicProvider::new(
                connection(vec![], 1),
                128,
            )),
            &["messages"],
            "assistant",
        ),
        (
            bedrock::FAMILY,
            Box::new(bedrock::BedrockProvider::new(connection(vec![], 1))),
            &["messages"],
            "assistant",
        ),
        (
            google::FAMILY,
            Box::new(google::GoogleProvider::new(connection(vec![], 1)).unwrap()),
            &["contents"],
            "model",
        ),
        (
            google::VERTEX_FAMILY,
            Box::new(google::GoogleProvider::vertex(connection(vec![], 1)).unwrap()),
            &["contents"],
            "model",
        ),
        (
            pi_messages::FAMILY,
            Box::new(pi_messages::PiMessagesProvider {
                connection: connection(vec![], 1),
                max_output_tokens: None,
                reasoning: None,
                cache_retention: None,
            }),
            &["context", "messages"],
            "assistant",
        ),
    ];
    for (family, provider, path, role) in providers {
        let mut request = view(family);
        request.history.push(ConversationItem {
            id: "delivered".into(),
            provenance: Provenance::PolicyOutput {
                action_id: "action".into(),
                identity: PolicyIdentity {
                    name: "strategy".into(),
                    version: "1".into(),
                },
            },
            content: Content::Text {
                text: "独立交付 🧭".into(),
            },
            opaque: None,
        });
        let wire = provider
            .serialize(&request)
            .unwrap_or_else(|error| panic!("{family}: {error}"));
        let mut messages = &wire;
        for key in path {
            messages = &messages[*key];
        }
        let output = messages
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message.to_string().contains("独立交付 🧭"))
            .unwrap_or_else(|| panic!("missing policy output in {family}: {wire}"));
        assert_eq!(
            output["role"], role,
            "policy output must remain the same agent's output for {family}"
        );
    }
}
