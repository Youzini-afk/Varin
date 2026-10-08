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
fn view(family: &str) -> RequestView {
    RequestView {
        request_id: "request".into(),
        run_id: "run".into(),
        step: 1,
        binding: RequestBinding {
            provider_family: family.into(),
            model: "model".into(),
            credential_ref: Some("test-ref".into()),
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: vec![ToolSchema {
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
fn native_http_status_preserves_retry_and_request_id_without_echoing_body() {
    let body = "secret prompt must not enter failure";
    let response=format!("HTTP/1.1 429 Too Many Requests\r\nContent-Length: {}\r\nRetry-After: 2\r\nX-Request-ID: server-123\r\nConnection: close\r\n\r\n{body}",body.len());
    let (endpoint, server) = loopback_response(response.into_bytes());
    let transport = NativeHttpTransport::new(|| reqwest::Client::builder().no_proxy());
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
fn native_http_cancellation_interrupts_stalled_headers_and_body() {
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
            let transport = NativeHttpTransport::new(|| reqwest::Client::builder().no_proxy());
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
        Arc::new(NativeHttpTransport::new(|| {
            reqwest::Client::builder().no_proxy()
        })),
    ));
    let (result, events) = generate(&p, responses::FAMILY);
    server.join().unwrap();
    assert_eq!(result.unwrap(), FinishReason::Stop);
    assert!(events.iter().any(|e|matches!(e,ProviderEvent::ItemCompleted{item} if matches!(&item.content,Content::Text{text} if text=="local transport"))));
}
