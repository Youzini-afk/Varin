//! Original Catalog receipts and serialized snapshots supply a derived request estimate only.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use std::sync::Arc;
use varin_runtime::{context_capacity::*, execution::*, providers::*, *};

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
struct Stream;
impl HttpTransport for Stream {
    fn stream(
        &self,
        _: HttpRequest<'_>,
        _: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        for event in [
            json!({"type":"message_start","message":{"id":"actual","usage":{"input_tokens":100,"cache_read_input_tokens":700,"cache_creation_input_tokens":100,"output_tokens":0}}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}),
            json!({"type":"message_stop"}),
        ] {
            if receive(format!("data: {event}\n\n").as_bytes())? {
                break;
            }
        }
        Ok(())
    }
}
fn connection() -> Connection {
    Connection::new(
        "https://fixture.invalid",
        Arc::new(Credentials),
        Arc::new(Stream),
    )
}
fn anthropic() -> anthropic::AnthropicProvider {
    anthropic::AnthropicProvider::new(connection(), 100)
}
fn binding(branch: &str, family: &str) -> RequestBinding {
    serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
        "connection_identity":"fixture","provider_family":family,"model":"fixture","credential_ref":null,
        "configuration_generation":1,"tool_schema_generation":0,"tools":[],"instruction_sources":[],"memory_checkpoint":null,
        "attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":branch,"ancestor_id":null,"leaf_id":null}})).unwrap()
}
fn text(id: &str, content: &str) -> ConversationItem {
    ConversationItem {
        id: id.into(),
        resource_activation: None,
        provenance: Provenance::UserInstruction {
            input_id: id.into(),
        },
        content: Content::Text {
            text: content.into(),
        },
        opaque: None,
    }
}
fn snapshot(
    db: &Catalog,
    run: &str,
    branch: &str,
    id: &str,
    provider: &dyn ModelProvider,
) -> RequestSnapshot {
    let mut binding = binding(branch, anthropic::FAMILY);
    binding.history_range.leaf_id = db.head(branch).unwrap();
    let view = RequestView {
        request_id: id.into(),
        run_id: run.into(),
        origin: RequestOrigin::Conversation {
            compaction: None, step: 1,
            history_range: binding.history_range.clone(),
        },
        binding,
        history: db.execution_history(branch).unwrap(),
    };
    RequestSnapshot {
        serialized: provider.serialize(&view).unwrap(),
        view,
    }
}
fn actual(input: u64) -> UsageReceipt {
    UsageReceipt {
        measurement: UsageMeasurement::Actual,
        input_tokens: Some(input),
        output_tokens: Some(3),
        cached_input_tokens: Some(700),
        cache_write_tokens: Some(100),
        raw: Some(json!({"original":"untouched"})),
        ..Default::default()
    }
}
fn settle(
    db: &mut Catalog,
    snapshot: &RequestSnapshot,
    outcome: ModelOutcome,
    usage: UsageReceipt,
) {
    for record in [
        ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
        ExecutionRecord::RequestPrepared {
            snapshot: snapshot.clone().into(),
        },
        ExecutionRecord::ModelDispatched {
            request_id: snapshot.view.request_id.clone(),
        },
        ExecutionRecord::ModelFinished {
            request_id: snapshot.view.request_id.clone(),
            outcome,
            finish_reason: Some(FinishReason::Stop),
            items: vec![],
            interrupted_deltas: vec![],
            usage,
            failure: None,
        },
    ] {
        db.commit_execution(&snapshot.view.run_id, db.epoch(), &record)
            .unwrap();
    }
}
fn estimate(
    db: &Catalog,
    request: &RequestSnapshot,
    provider: &dyn ModelProvider,
) -> InputEstimate {
    db.capture_request_budget(&request.view.run_id, db.epoch())
        .unwrap()
        .estimate(
            &request.view,
            &request.serialized,
            provider.request_budget_protocol().unwrap(),
            &CancellationToken::default(),
        )
        .unwrap()
}
fn submit(db: &mut Catalog, branch: &str, key: &str) -> Receipt {
    db.submit(&SubmitInput {
        key: key.into(),
        thread_id: "thread".into(),
        branch_id: branch.into(),
        expected_head: db.head(branch).unwrap(),
        input: json!(key),
        configuration: json!({}),
    })
    .unwrap()
}
fn finish(db: &mut Catalog, run: &str, state: RunState) {
    db.commit_execution(
        run,
        db.epoch(),
        &ExecutionRecord::StateChanged {
            state,
            waiting_on: None,
        },
    )
    .unwrap();
}

#[test]
fn original_success_survives_new_run_reopen_and_later_unknown_but_latest_mismatch_does_not_resurrect(
) {
    let root = std::env::temp_dir().join(format!("varin-budget-{}", uuid::Uuid::new_v4()));
    let provider = anthropic();
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "branch").unwrap();
    let first = submit(&mut db, "branch", "first");
    let original = snapshot(&db, &first.run_id, "branch", "actual", &provider);
    let mut usage = UsageReceipt::default();
    provider
        .generate(&original, &CancellationToken::default(), &mut |event| {
            if let ProviderEvent::Usage { receipt } = event {
                usage = receipt;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(usage.input_tokens, Some(100));
    settle(&mut db, &original, ModelOutcome::Completed, usage.clone());
    assert_eq!(estimate(&db, &original, &provider).estimated_tokens, 900);
    let stored = db.model_step("actual").unwrap();
    assert_eq!(
        serde_json::from_value::<UsageReceipt>(stored.usage.unwrap()).unwrap(),
        usage
    );
    // Cancelling the Run after a successful step does not rewrite that successful observation.
    finish(&mut db, &first.run_id, RunState::Cancelled);
    drop(db);
    let mut db = Catalog::open(&root).unwrap();
    let next = submit(&mut db, "branch", "next appended input");
    let candidate = snapshot(&db, &next.run_id, "branch", "candidate", &provider);
    let expected = 900 + estimate_request(&candidate.view, &candidate.serialized).estimated_tokens
        - estimate_request(&original.view, &original.serialized).estimated_tokens;
    assert_eq!(
        estimate(&db, &candidate, &provider).estimated_tokens,
        expected
    );
    // Anthropic merged adjacent user content into one wire message, yet the exact prefix remains.
    assert_eq!(
        candidate.serialized["messages"].as_array().unwrap().len(),
        1
    );
    for (id, outcome, receipt) in [
        ("failed", ModelOutcome::Failed, actual(9_000)),
        ("cancelled", ModelOutcome::Cancelled, actual(9_000)),
        ("interrupted", ModelOutcome::Interrupted, actual(9_000)),
        ("missing", ModelOutcome::Completed, UsageReceipt::default()),
        (
            "estimated",
            ModelOutcome::Completed,
            UsageReceipt {
                measurement: UsageMeasurement::Estimated,
                ..actual(9_000)
            },
        ),
    ] {
        let request = snapshot(&db, &next.run_id, "branch", id, &provider);
        settle(&mut db, &request, outcome, receipt);
        assert_eq!(
            estimate(&db, &candidate, &provider).estimated_tokens,
            expected,
            "{id}"
        );
    }
    let mut changed = snapshot(
        &db,
        &next.run_id,
        "branch",
        "changed-model-config",
        &provider,
    );
    changed.view.binding.configuration_generation = 2;
    settle(&mut db, &changed, ModelOutcome::Completed, actual(9_000));
    let local = estimate_request(&candidate.view, &candidate.serialized);
    assert_eq!(estimate(&db, &candidate, &provider).method, local.method);
    let read = db.capture_request_budget(&next.run_id, db.epoch()).unwrap();
    let cancel = CancellationToken::default();
    cancel.cancel();
    assert!(matches!(
        read.estimate(
            &candidate.view,
            &candidate.serialized,
            provider.request_budget_protocol().unwrap(),
            &cancel
        ),
        Err(RuntimeError::DispatchCancelled)
    ));
    finish(&mut db, &next.run_id, RunState::Completed);
    db.fork_branch("branch", "fork", None).unwrap();
    let fork = submit(&mut db, "fork", "branch-fork");
    let request = snapshot(&db, &fork.run_id, "fork", "fork-request", &provider);
    assert_eq!(
        estimate(&db, &request, &provider).method,
        estimate_request(&request.view, &request.serialized).method
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn actual_serializers_keep_cache_semantics_full_tail_and_exact_prefix_invalidation() {
    let providers: Vec<(Box<dyn ModelProvider>, &str, u64)> = vec![
        (Box::new(anthropic()), anthropic::FAMILY, 900),
        (
            Box::new(responses::ResponsesProvider::new(connection())),
            responses::FAMILY,
            100,
        ),
        (
            Box::new(google::GoogleProvider::new(connection()).unwrap()),
            google::FAMILY,
            100,
        ),
    ];
    for (provider, family, input) in providers {
        let binding = binding("branch", family);
        let view = RequestView {
            request_id: "first".into(),
            run_id: "run".into(),
            origin: RequestOrigin::Conversation {
                compaction: None, step: 1,
                history_range: binding.history_range.clone(),
            },
            binding,
            history: vec![text("first", "original text").into()],
        };
        let original = RequestSnapshot {
            serialized: provider.serialize(&view).unwrap(),
            view,
        };
        let receipt = actual(100);
        let protocol = provider.request_budget_protocol().unwrap();
        let mut current = original.view.clone();
        current
            .history
            .push(text("tail", &"完整新增材料".repeat(100)).into());
        let serialized = provider.serialize(&current).unwrap();
        let local = estimate_request(&current, &serialized);
        let calibrated = calibrated_estimate(&current, &serialized, &original, &receipt, protocol);
        assert_eq!(
            calibrated.estimated_tokens,
            input + local.estimated_tokens
                - estimate_request(&original.view, &original.serialized).estimated_tokens
        );
        assert!(calibrated.method.starts_with("actual-input-calibrated"));
        for mutation in 0..10 {
            let mut changed = current.clone();
            match mutation {
                0 => changed.binding.tools.push(ToolSchema {
                    name: "new_tool".into(),
                    version: "1".into(),
                    description: "new schema".into(),
                    schema: json!({"type":"object"}),
                    output_schema: None,
                    metadata: None,
                    requirements: None,
                }),
                1 => changed
                    .binding
                    .instruction_sources
                    .push("new instruction".into()),
                2 => changed.binding.model = "other".into(),
                3 => changed.binding.connection_identity = "other".into(),
                4 => changed.binding.configuration_generation += 1,
                5 => changed.binding.tool_schema_generation += 1,
                6 => changed.binding.history_range.ancestor_id = Some("compacted".into()),
                7 => changed.binding.history_range.branch_id = "fork".into(),
                8 => {
                    changed.origin = RequestOrigin::PolicyModelJob {
                        action_id: "policy".into(),
                        purpose: "evaluation".into(),
                        boundary_id: "boundary".into(),
                    }
                }
                _ => {
                    Arc::make_mut(&mut changed.history[0]).content = Content::Text {
                        text: "edited original".into(),
                    }
                }
            }
            let changed_body = provider.serialize(&changed).unwrap();
            assert_eq!(
                calibrated_estimate(&changed, &changed_body, &original, &receipt, protocol).method,
                estimate_request(&changed, &changed_body).method,
                "{family}: {mutation}"
            );
        }
        let mut body = serialized.clone();
        body["new_fixed_option"] = json!(true);
        assert_eq!(
            calibrated_estimate(&current, &body, &original, &receipt, protocol).method,
            local.method
        );
        let zero = UsageReceipt {
            input_tokens: Some(0),
            cached_input_tokens: Some(0),
            cache_write_tokens: Some(0),
            ..receipt
        };
        assert_eq!(
            calibrated_estimate(
                &original.view,
                &original.serialized,
                &original,
                &zero,
                protocol
            )
            .estimated_tokens,
            0
        );
    }
}

#[test]
fn calibration_preserves_opaque_media_and_unmeasured_flags_and_rejects_incomplete_usage() {
    let provider = anthropic();
    let binding = binding("branch", anthropic::FAMILY);
    let mut view = RequestView {
        request_id: "opaque".into(),
        run_id: "run".into(),
        origin: RequestOrigin::Conversation {
            compaction: None, step: 1,
            history_range: binding.history_range.clone(),
        },
        binding,
        history: vec![text("first", "original").into()],
    };
    view.history.push(ConversationItem{id:"signed".into(),resource_activation:None,provenance:Provenance::Assistant,content:Content::ProviderOnly,
        opaque:Some(OpaqueProviderItem{family:anthropic::FAMILY.into(),connection_identity:"fixture".into(),adapter_version:"1".into(),
            value:json!({"type":"thinking","thinking":"retained opaque original","signature":"original-signature"})})}.into());
    let original = RequestSnapshot {
        serialized: provider.serialize(&view).unwrap(),
        view,
    };
    let saved_original = original.clone();
    let mut current = original.view.clone();
    current.history.push(ConversationItem {
        id: "media".into(),
        resource_activation: None,
        provenance: Provenance::UserInstruction {
            input_id: "media".into(),
        },
        content: Content::Media {
            media: varin_runtime::output::ResolvedMedia {
                media_type: "image/png".into(),
                data_base64: "AAEC".into(),
                source: varin_runtime::output::OutputSource::Conversation {
                    provenance: Provenance::UserInstruction {
                        input_id: "media".into(),
                    },
                },
            },
        },
        opaque: None,
    }.into());
    let serialized = provider.serialize(&current).unwrap();
    let saved_body = serialized.clone();
    let protocol = provider.request_budget_protocol().unwrap();
    let receipt = actual(100);
    let estimate = calibrated_estimate(&current, &serialized, &original, &receipt, protocol);
    assert!(estimate.method.starts_with("actual-input-calibrated"));
    assert_eq!(estimate.unmeasured_media, 1);
    assert_eq!(estimate.unmeasured_provider_items, 1);
    assert_eq!(serialized, saved_body);
    assert_eq!(original, saved_original);
    assert!(serialized.to_string().contains("original-signature"));
    assert!(serialized.to_string().contains("AAEC"));
    for usage in [
        UsageReceipt {
            cache_write_tokens: None,
            ..receipt.clone()
        },
        UsageReceipt {
            input_tokens: None,
            ..receipt.clone()
        },
        UsageReceipt {
            measurement: UsageMeasurement::Estimated,
            ..receipt.clone()
        },
        UsageReceipt {
            measurement: UsageMeasurement::Missing,
            ..receipt
        },
    ] {
        assert_eq!(
            calibrated_estimate(&current, &serialized, &original, &usage, protocol).method,
            estimate_request(&current, &serialized).method
        );
    }
    let bedrock = bedrock::BedrockProvider::new(connection())
        .request_budget_protocol()
        .unwrap();
    let receipt = UsageReceipt {
        input_tokens: Some(100),
        output_tokens: Some(3),
        cached_input_tokens: None,
        cache_write_tokens: None,
        raw: Some(json!({"inputTokens":100,"outputTokens":3,"totalTokens":103})),
        ..actual(100)
    };
    assert_eq!((bedrock.complete_input_tokens)(&receipt), Some(100));
    let invalid = UsageReceipt {
        raw: Some(json!({"totalTokens":2})),
        ..receipt.clone()
    };
    assert_eq!((bedrock.complete_input_tokens)(&invalid), None);
    let no_total = UsageReceipt {
        raw: Some(json!({"inputTokens":100,"outputTokens":3})),
        ..receipt
    };
    assert_eq!((bedrock.complete_input_tokens)(&no_total), None);
    let pi = pi_messages::PiMessagesProvider {
        connection: connection(),
        max_output_tokens: None,
        reasoning: None,
        cache_retention: None,
    }
    .request_budget_protocol()
    .unwrap();
    let zero_total = UsageReceipt {
        raw: Some(json!({"usage":{"totalTokens":0}})),
        ..actual(100)
    };
    assert_eq!((pi.complete_input_tokens)(&zero_total), Some(900));
}
