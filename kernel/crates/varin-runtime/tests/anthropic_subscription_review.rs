use serde_json::{json, Value};
use std::sync::Arc;
use varin_runtime::execution::*;
use varin_runtime::providers::{
    anthropic::AnthropicProvider, Connection, CredentialResolver, HttpRequest, HttpTransport,
};
struct Credentials;
impl CredentialResolver for Credentials {
    fn headers(
        &self,
        _: Option<&str>,
        _: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
        Ok(reqwest::header::HeaderMap::new())
    }
}
struct Wire(Vec<u8>);
impl HttpTransport for Wire {
    fn stream(
        &self,
        _: HttpRequest<'_>,
        _: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        for bytes in self.0.chunks(1) {
            if receive(bytes)? {
                break;
            }
        }
        Ok(())
    }
}
#[test]
fn subscription_tool_names_roundtrip_without_rewriting_signed_thinking_or_api_key_requests() {
    let thinking = json!({"type":"thinking","thinking":"private fixture reasoning","signature":"fake-signed-opaque-原文"});
    let tool =
        json!({"type":"tool_use","id":"call-one","name":"rEaD","input":{"path":"fixture.txt"}});
    let events = vec![
        json!({"type":"message_start","message":{"id":"msg","usage":{"input_tokens":1,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":thinking}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":tool}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}),
        json!({"type":"message_stop"}),
    ];
    let wire = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>()
        .into_bytes();
    let mut provider = AnthropicProvider::new(
        Connection::new(
            "https://fixture.invalid",
            Arc::new(Credentials),
            Arc::new(Wire(wire)),
        ),
        128,
    );
    let mut view = RequestView {
        request_id: "request".into(),
        run_id: "run".into(),
        origin: RequestOrigin::Conversation { step: 1, history_range: HistoryRange { branch_id: "main".into(), ancestor_id: None, leaf_id: None } },
        binding: RequestBinding {
            connection_identity: "fixture".into(),
            provider_family: "anthropic-messages".into(),
            model: "fixture".into(),
            credential_ref: None,
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
                branch_id: "main".into(),
                ancestor_id: None,
                leaf_id: None,
            },
        },
        history: vec![ConversationItem {
            id: "input".into(),
            provenance: Provenance::UserInstruction {
                input_id: "input".into(),
            },
            content: Content::Text {
                text: "Read fixture".into(),
            },
            opaque: None,
        }],
    };
    let api = provider.serialize(&view).unwrap();
    assert_eq!(api["tools"][0]["name"], "read");
    assert_eq!(api["system"], json!([]));
    provider.oauth = true;
    let serialized = provider.serialize(&view).unwrap();
    assert_eq!(serialized["tools"][0]["name"], "Read");
    assert!(serialized["system"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Claude Code"));
    let snapshot = RequestSnapshot {
        view: view.clone(),
        serialized,
    };
    let mut output = vec![];
    assert_eq!(
        provider
            .generate(&snapshot, &CancellationToken::default(), &mut |event| {
                if let ProviderEvent::ItemCompleted { item } = event {
                    output.push(item);
                }
                Ok(())
            })
            .unwrap(),
        FinishReason::ToolCalls
    );
    assert!(output.iter().any(|item|matches!(&item.content,Content::ToolCall{call} if call.name=="read"&&call.arguments==json!({"path":"fixture.txt"}))));
    for item in output {
        view.history.push(ConversationItem {
            id: item.id,
            provenance: Provenance::Assistant,
            content: item.content,
            opaque: item.opaque,
        });
    }
    let replay = provider.serialize(&view).unwrap();
    let blocks = replay["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().unwrap())
        .cloned()
        .collect::<Vec<Value>>();
    assert!(blocks.contains(&thinking));
    assert!(blocks.contains(&tool));
}
