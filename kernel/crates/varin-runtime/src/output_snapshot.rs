//! A borrowed storage projection of the original immutable request. Only media references are
//! constructed; text, tool JSON, provenance, opaque payloads and the frozen wire body stay borrowed.
//! These private serializers emit the existing RequestSnapshot shape, not another stored format.
use super::*;
use crate::execution::{Content, ConversationItem, RequestBinding, RequestOrigin, RequestSnapshot};

#[derive(Serialize)]
struct Snapshot<'a> {
    view: View<'a>,
    serialized: &'a crate::request_body::RequestBody,
}
#[derive(Serialize)]
struct View<'a> {
    request_id: &'a str,
    run_id: &'a str,
    origin: &'a RequestOrigin,
    binding: &'a RequestBinding,
    history: Vec<Item<'a>>,
}
#[derive(Serialize)]
struct Item<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    resource_activation: &'a Option<crate::catalog::resources::ResourceActivation>,
    id: &'a str,
    provenance: &'a Provenance,
    content: ContentView<'a>,
    opaque: &'a Option<crate::execution::OpaqueProviderItem>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum ContentView<'a> {
    Original(&'a Content),
    Stored(StoredContent<'a>),
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StoredContent<'a> {
    Media { media: StoredMedia },
    Output { output: Output<'a> },
    ToolResult { result: ToolResult<'a> },
}
#[derive(Serialize)]
struct Output<'a> {
    data: &'a Value,
    parts: Vec<Part<'a>>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Part<'a> {
    Text { text: &'a str },
    Media { media: StoredMedia },
}
#[derive(Serialize)]
struct ToolResult<'a> {
    request_id: &'a str,
    call_id: &'a str,
    completion: Completion<'a>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Completion<'a> {
    Result {
        outcome: &'a crate::Outcome,
        effect: &'a crate::Effect,
        content: Output<'a>,
    },
    JobAccepted {
        operation_id: &'a str,
        phase: &'a str,
        effect: &'a crate::Effect,
        lifetime: &'a crate::Lifetime,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Output<'a>>,
    },
}

struct Projection<'a> {
    store: &'a crate::content::ContentStore,
    dependencies: Vec<String>,
}
impl Projection<'_> {
    fn media(
        &mut self,
        media: &ResolvedMedia,
    ) -> Result<StoredMedia, crate::catalog::RuntimeError> {
        let bytes = media_bytes(&media.media_type, &media.data_base64)?;
        let content_ref: ContentRef = serde_json::from_value(self.store.save_bytes(&bytes)?)?;
        self.dependencies.push(content_ref.content_object.clone());
        Ok(StoredMedia {
            media_type: media.media_type.clone(),
            source: media.source.clone(),
            content_ref,
        })
    }
    fn output<'a>(
        &mut self,
        output: &'a OutputBody,
    ) -> Result<Output<'a>, crate::catalog::RuntimeError> {
        Ok(Output {
            data: &output.data,
            parts: output
                .parts
                .iter()
                .map(|part| {
                    Ok(match part {
                        OutputPart::Text { text } => Part::Text { text },
                        OutputPart::Media { media } => Part::Media {
                            media: self.media(media)?,
                        },
                    })
                })
                .collect::<Result<_, crate::catalog::RuntimeError>>()?,
        })
    }
    fn item<'a>(
        &mut self,
        item: &'a ConversationItem,
    ) -> Result<Item<'a>, crate::catalog::RuntimeError> {
        use crate::execution::ToolCompletion as C;
        let content = match &item.content {
            Content::Media { media } => ContentView::Stored(StoredContent::Media {
                media: self.media(media)?,
            }),
            Content::Output { output } => ContentView::Stored(StoredContent::Output {
                output: self.output(output)?,
            }),
            Content::ToolResult { result } => match &result.completion {
                C::NotDispatched { .. } => ContentView::Original(&item.content),
                completion => ContentView::Stored(StoredContent::ToolResult {
                    result: ToolResult {
                        request_id: &result.request_id,
                        call_id: &result.call_id,
                        completion: match completion {
                            C::Result {
                                outcome,
                                effect,
                                content,
                            } => Completion::Result {
                                outcome,
                                effect,
                                content: self.output(content)?,
                            },
                            C::JobAccepted {
                                operation_id,
                                phase,
                                effect,
                                lifetime,
                                content,
                            } => Completion::JobAccepted {
                                operation_id,
                                phase,
                                effect,
                                lifetime,
                                content: content
                                    .as_ref()
                                    .map(|content| self.output(content))
                                    .transpose()?,
                            },
                            C::NotDispatched { .. } => {
                                unreachable!("handled without media projection")
                            }
                        },
                    },
                }),
            },
            _ => ContentView::Original(&item.content),
        };
        Ok(Item {
            resource_activation: &item.resource_activation,
            id: &item.id,
            provenance: &item.provenance,
            content,
            opaque: &item.opaque,
        })
    }
}

pub(super) fn save(
    store: &crate::content::ContentStore,
    snapshot: &RequestSnapshot,
) -> Result<Value, crate::catalog::RuntimeError> {
    let mut projection = Projection {
        store,
        dependencies: Vec::new(),
    };
    let view = &snapshot.view;
    let stored = Snapshot {
        view: View {
            request_id: &view.request_id,
            run_id: &view.run_id,
            origin: &view.origin,
            binding: &view.binding,
            history: view
                .history
                .iter()
                .map(|item| projection.item(item))
                .collect::<Result<_, _>>()?,
        },
        serialized: &snapshot.serialized,
    };
    store.save_with_dependencies(&stored, projection.dependencies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{
        HistoryRange, OpaqueProviderItem, RequestView, ToolCall, ToolCompletion,
    };
    use serde_json::json;

    #[test]
    fn borrowed_snapshot_reopens_all_media_positions_and_exact_wire_bytes() {
        struct Directory(std::path::PathBuf);
        impl Drop for Directory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let directory = Directory(
            std::env::temp_dir().join(format!("varin-borrowed-snapshot-{}", uuid::Uuid::new_v4())),
        );
        let store = crate::content::ContentStore::open(directory.0.clone()).unwrap();
        let media = ResolvedMedia {
            media_type: "image/png".into(),
            source: OutputSource::Conversation {
                provenance: Provenance::UserInstruction {
                    input_id: "input".into(),
                },
            },
            data_base64: STANDARD.encode(b"original media bytes"),
        };
        let output = || OutputBody {
            data: json!({"source":"tool", "payload":"unicode 中文 and quoted \"text\"".repeat(512)}),
            parts: vec![
                OutputPart::Text {
                    text: "explicit presentation".into(),
                },
                OutputPart::Media {
                    media: media.clone(),
                },
            ],
        };
        let mut contents = vec![
            Content::Text {
                text: "original text".repeat(1024),
            },
            Content::ReasoningSummary {
                text: "portable summary".into(),
            },
            Content::Media {
                media: media.clone(),
            },
            Content::Output { output: output() },
            Content::ToolCall {
                call: ToolCall {
                    call_id: "call".into(),
                    name: "read".into(),
                    schema_version: "1".into(),
                    arguments: json!({"path":"source"}),
                },
            },
            Content::ProviderOnly,
        ];
        for completion in [
            ToolCompletion::NotDispatched {
                reason: "cancelled_before_dispatch".into(),
                error: None,
            },
            ToolCompletion::Result {
                outcome: crate::Outcome::Succeeded,
                effect: crate::Effect::None,
                content: output(),
            },
            ToolCompletion::JobAccepted {
                operation_id: "job".into(),
                phase: "running".into(),
                effect: crate::Effect::Unknown,
                lifetime: crate::Lifetime::Run,
                content: Some(output()),
            },
            ToolCompletion::JobAccepted {
                operation_id: "empty-job".into(),
                phase: "running".into(),
                effect: crate::Effect::Unknown,
                lifetime: crate::Lifetime::Run,
                content: None,
            },
        ] {
            contents.push(Content::ToolResult {
                result: crate::execution::ToolResult {
                    request_id: "prior-request".into(),
                    call_id: "call".into(),
                    completion,
                },
            });
        }
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: Some("tail".into()),
        };
        // Deliberately retain valid noncanonical whitespace/escapes: a Value roundtrip loses them.
        let wire = r#"{ "input": [{"role":"user","content":"\u0061"}], "model": "fixture" }"#;
        let snapshot = RequestSnapshot {
            serialized: serde_json::from_str(wire).unwrap(),
            view: RequestView {
                request_id: "request".into(),
                run_id: "run".into(),
                origin: RequestOrigin::Conversation {
                    compaction: None,
                    step: 1,
                    history_range: range.clone(),
                },
                binding: RequestBinding { tool_output_visible_bytes: None, mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
                    provider_id: None,
                    tokenizer: None,
                    request_context: None,
                    child_dispatch: None,
                    goal: None,
                    resource_activations: Vec::new(),
                    resource_checkpoint_id: None,
                    connection_identity: "connection".into(),
                    provider_family: "openai-responses".into(),
                    model: "fixture".into(),
                    credential_ref: None,
                    configuration_generation: 1,
                    tool_schema_generation: 1,
                    tools: Vec::new(),
                    instruction_sources: Vec::new(),
                    memory_checkpoint: None,
                    attachment_refs: Vec::new(),
                    environment_cursor: 0,
                    history_range: range,
                },
                history: contents
                    .into_iter()
                    .enumerate()
                    .map(|(index, content)| {
                        ConversationItem {
                            resource_activation: None,
                            id: format!("item-{index}"),
                            provenance: Provenance::Assistant,
                            content,
                            opaque: Some(OpaqueProviderItem {
                                connection_identity: "connection".into(),
                                family: "openai-responses".into(),
                                adapter_version: "1".into(),
                                value: json!({"opaque":"unchanged bytes"}),
                            }),
                        }
                        .into()
                    })
                    .collect(),
            },
        };
        let reference = store.save_snapshot(&snapshot).unwrap();
        let stored = store.load_bytes(&reference, &|| false).unwrap();
        let parsed: Value = serde_json::from_slice(&stored).unwrap();
        assert!(
            parsed["view"]["history"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item.get("resource_activation").is_none())
        );
        assert!(
            !String::from_utf8(stored)
                .unwrap()
                .contains(&media.data_base64),
            "semantic media bytes remain referenced, not copied into history"
        );
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(
                crate::content::object_path(
                    &directory.0,
                    reference["content_object"].as_str().unwrap(),
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["dependencies"].as_array().unwrap().len(),
            1,
            "every media position contributes the same original typed dependency"
        );
        drop(store);
        let store = crate::content::ContentStore::open(directory.0.clone()).unwrap();
        let restored = store.load_snapshot(&reference).unwrap();
        assert_eq!(restored.view, snapshot.view);
        assert_eq!(restored.serialized.wire_bytes().as_ref(), wire.as_bytes());
        assert_eq!(restored, snapshot);
        assert!(matches!(
            store.load_snapshot_cancellable(&reference, &|| true),
            Err(crate::catalog::RuntimeError::DispatchCancelled)
        ));
    }
}
