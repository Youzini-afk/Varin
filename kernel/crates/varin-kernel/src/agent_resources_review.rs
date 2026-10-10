//! Real Catalog/ContentStore/ToolDirectory/OwnerChannel paths, with a deterministic Host reply.
use crate::agent_resources::{declaration, execute_rpc, schema};
use crate::host_query::OwnerChannel;
use crate::storage::Storage;
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, mpsc, Arc, Mutex};
use varin_runtime::catalog::{
    context::ContextProposal, personalization::PersonalizationBasis, resources::ContextResources,
};
use varin_runtime::composition::tools::ToolDirectory;
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Outcome, SubmitInput};

#[test]
fn read_only_resource_view_pins_reads_and_releases_only_its_owned_view() {
    let root = std::env::temp_dir().join(format!("varin-resource-grant-{}", uuid::Uuid::new_v4()));
    let mut storage = Storage::open(&root, "host").unwrap();
    for id in ["writer", "reader", "other"] {
        storage.issue_grant(&json!({"grantId":id,"hostGeneration":"generation","capabilities":if id=="writer"{vec!["storage.read","storage.write"]}else{vec!["storage.read"]},
            "pathScopes":if id=="writer"{vec![""]}else{vec!["bundle/skill","ancestor/skill"]},"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":id,"runId":id}),
            "host","generation",&root.to_string_lossy(),"epoch").unwrap();
    }
    let invoke = |storage: &mut Storage, id: &str, method: &str, value: Value| {
        let (grant, params) =
            storage.authorize(Some(id), "epoch", "host", "generation", method, &value)?;
        storage.dispatch(method, &params, Some(id), &grant)
    };
    use base64::Engine;
    let upload = json!({"operationId":"ancestor-body","streamId":"ancestor-body","workspaceId":"workspace","byteLength":6});
    invoke(
        &mut storage,
        "writer",
        "storage.putBlob.begin",
        upload.clone(),
    )
    .unwrap();
    invoke(&mut storage,"writer","storage.putBlob.chunk",json!({"streamId":"ancestor-body","sequence":0,"bytesBase64":base64::engine::general_purpose::STANDARD.encode(b"secret")})).unwrap();
    let body = invoke(&mut storage, "writer", "storage.putBlob.finish", upload).unwrap();
    invoke(&mut storage,"writer","branch.create.begin",json!({"operationId":"create","builderId":"create","workspaceId":"workspace","branchId":"branch","draftBasePaths":[],"captureScopes":[]})).unwrap();
    invoke(&mut storage,"writer","branch.create.append",json!({"builderId":"create","sequence":0,"entries":[{"path":"bundle","state":{"kind":"directory","mode":493}},{"path":"bundle/skill","state":{"kind":"directory","mode":493}},{"path":"bundle/sibling","state":{"kind":"directory","mode":493}},{"path":"outside","state":{"kind":"directory","mode":493}},{"path":"ancestor","state":{"kind":"regular-file","objectHash":body["hash"],"byteLength":6,"mode":420},"ownerId":body["ownerId"]}]})).unwrap();
    invoke(
        &mut storage,
        "writer",
        "branch.create.finish",
        json!({"operationId":"create","builderId":"create"}),
    )
    .unwrap();
    let pinned = invoke(
        &mut storage,
        "reader",
        "branch.pin",
        json!({"operationId":"pin-reader","branchId":"branch","revision":0,"pinId":"reader-pin"}),
    )
    .unwrap();
    assert_eq!(pinned["pinned"], true);
    let read = invoke(
        &mut storage,
        "reader",
        "pin.read",
        json!({"pinId":"reader-pin","includeEntries":true}),
    )
    .unwrap();
    assert_eq!(read["entries"].as_array().unwrap().len(), 1);
    assert_eq!(read["entries"][0]["path"], "bundle/skill");
    for (method, subject) in [
        ("branch.read", json!({"branchId":"branch","revision":0})),
        ("pin.read", json!({"pinId":"reader-pin"})),
    ] {
        let mut params = subject.clone();
        params["paths"] = json!(["", "bundle", "bundle/skill", "ancestor"]);
        let metadata = invoke(&mut storage, "reader", method, params).unwrap();
        assert_eq!(metadata["entries"].as_array().unwrap().len(), 4);
        assert_eq!(metadata["entries"][0]["state"]["kind"], "directory");
        assert_eq!(metadata["entries"][3]["state"]["objectHash"], body["hash"]);
        let mut params = subject.clone();
        params["paths"] = json!(["bundle/sibling"]);
        assert!(invoke(&mut storage, "reader", method, params).is_err());
        let mut params = subject.clone();
        params["roots"] = json!([""]);
        let listed = invoke(&mut storage, "reader", method, params).unwrap();
        assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
        assert_eq!(listed["entries"][0]["path"], "bundle/skill");
        let mut params = subject;
        params["path"] = json!("ancestor");
        params["hash"] = body["hash"].clone();
        assert!(invoke(&mut storage, "reader", "storage.getBlob", params).is_err());
    }
    assert!(invoke(
        &mut storage,
        "reader",
        "pin.read",
        json!({"pinId":"reader-pin","paths":["outside"]})
    )
    .is_err());
    assert!(invoke(&mut storage,"reader","branch.write.begin",json!({"operationId":"write","builderId":"write","branchId":"branch","expectedWriteRevision":0})).is_err());
    assert!(invoke(
        &mut storage,
        "reader",
        "file.root.register",
        json!({"rootId":"root","workspaceId":"workspace","path":root})
    )
    .is_err());
    invoke(
        &mut storage,
        "other",
        "branch.pin",
        json!({"operationId":"pin-other","branchId":"branch","revision":0,"pinId":"other-pin"}),
    )
    .unwrap();
    assert!(invoke(
        &mut storage,
        "reader",
        "branch.unpin",
        json!({"operationId":"release-other","branchId":"branch","pinId":"other-pin"})
    )
    .is_err());
    let released = invoke(
        &mut storage,
        "reader",
        "branch.unpin",
        json!({"operationId":"release-own","branchId":"branch","pinId":"reader-pin"}),
    )
    .unwrap();
    assert_eq!(released["released"], true);
    invoke(&mut storage,"reader","branch.pin",json!({"operationId":"repin-reader","branchId":"branch","revision":0,"pinId":"retained-pin"})).unwrap();
    storage
        .revoke_grant(&json!({"grantId":"reader"}), "host")
        .unwrap();
    assert!(invoke(
        &mut storage,
        "reader",
        "pin.read",
        json!({"pinId":"retained-pin","includeEntries":true})
    )
    .is_err());
    assert!(invoke(
        &mut storage,
        "reader",
        "branch.unpin",
        json!({"operationId":"revoked-release","branchId":"branch","pinId":"retained-pin"})
    )
    .is_err());
    drop(storage);
    std::fs::remove_dir_all(root).unwrap();
}
fn basis(text: &str) -> PersonalizationBasis {
    serde_json::from_value(
        json!({"mode":"agent","threadRole":"main","revision":1,"configurationDigest":"profile",
        "memorySnapshot":{"revision":0,"memories":[]},"sessionId":"thread","projectId":null,
        "originalSections":[{"name":"system","content":text}],"instructionSources":[]}),
    )
    .unwrap()
}
fn resources(text: &str) -> ContextResources {
    let reference = json!({"domainId":"user","viewId":"fixed","path":"SKILL.md","canonicalId":"user/SKILL.md","version":text});
    serde_json::from_value(json!({"source":null,"snapshot":{"id":text,"scope":{"threadId":"thread","branchId":"branch","mode":"agent","threadRole":"main","projectId":null,"sourceIdentity":null,"cwd":"","projectTrusted":false},
        "readers":[{"domainId":"user","viewId":"fixed","consistency":"capture-only"}],"project":null,"configurationDigest":"resources","shadowedContextCanonicalIds":[],"system":null,"appendSystem":null,"instructions":[],"instructionScopes":[],"skills":[],"diagnostics":[],"capturedFiles":[{"reference":reference,"content":text}],"observations":[]}})).unwrap()
}
#[test]
fn resource_builtin_uses_frozen_checkpoint_and_current_cancellation_without_operations() {
    for (policy_call, cancel_before_reply) in
        [(false, false), (false, true), (true, false), (true, true)]
    {
        let root =
            std::env::temp_dir().join(format!("varin-resource-builtin-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "branch").unwrap();
        let prepared = catalog
            .prepare_submission(
                SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("read skill"),
                    configuration: json!({}),
                },
                Some(ContextProposal {
                    key: "old-context".into(),
                    branch_id: "branch".into(),
                    through_id: None,
                    expected_revision: 0,
                    summary: String::new(),
                    effective_system_prompt: "old".into(),
                    instruction_sources: vec![],
                    memory_checkpoint: None,
                }),
                Some(basis("old")),
            )
            .unwrap()
            .with_resources(Some(resources("old")))
            .load(None, false)
            .unwrap();
        let receipt = catalog.admit_submission(prepared).unwrap();
        let call = ToolCall {
            call_id: "read".into(),
            name: "resource_read".into(),
            schema_version: "1".into(),
            arguments: json!({"kind":"skill","resourceId":"skill"}),
        };
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: Some(receipt.input_id.clone()),
        };
        let binding = RequestBinding {
            resource_checkpoint_id: Some("old-context".into()),
            connection_identity: "fixture".into(),
            provider_family: "fixture".into(),
            model: "fixture".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: vec![schema()],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: range.clone(),
        };
        let snapshot = RequestSnapshot {
            view: RequestView {
                request_id: "model".into(),
                run_id: receipt.run_id.clone(),
                origin: RequestOrigin::Conversation {
                    step: 1,
                    history_range: range,
                },
                binding,
                history: vec![],
            },
            serialized: json!({}),
        };
        let epoch = catalog.epoch();
        if !policy_call {
            for record in [
                ExecutionRecord::RequestPrepared { snapshot },
                ExecutionRecord::ModelDispatched {
                    request_id: "model".into(),
                },
                ExecutionRecord::ModelFinished {
                    request_id: "model".into(),
                    outcome: ModelOutcome::Completed,
                    finish_reason: Some(FinishReason::ToolCalls),
                    items: vec![ProviderItem {
                        id: "call".into(),
                        content: Content::ToolCall { call: call.clone() },
                        opaque: None,
                    }],
                    interrupted_deltas: vec![],
                    usage: UsageReceipt::default(),
                    failure: None,
                },
            ] {
                catalog
                    .commit_execution(&receipt.run_id, epoch, &record)
                    .unwrap();
            }
        }
        let origin = if policy_call {
            let boundary = catalog.policy_boundary(&receipt.run_id, epoch).unwrap();
            let action_id = format!("{}:policy:{}", receipt.run_id, boundary.id);
            let origin = ToolOrigin::PolicyAction {
                action_id: action_id.clone(),
                node_id: "read".into(),
            };
            let graph = PolicyGraphIntent::PolicyToolGraphV1 {
                action_id,
                boundary,
                identity: PolicyIdentity {
                    name: "default".into(),
                    version: "1".into(),
                },
                state: Value::Null,
                nodes: vec![PolicyAdmittedNode {
                    node: PolicyToolNode {
                        id: "read".into(),
                        depends_on: vec![],
                        call: call.clone(),
                    },
                    context: FrozenToolContext {
                        resource_checkpoint_id: Some("old-context".into()),
                        run_id: receipt.run_id.clone(),
                        origin: origin.clone(),
                        tool_schema_generation: 1,
                        tools: Arc::new(vec![schema()]),
                        source: None,
                    },
                }],
            };
            catalog
                .admit_policy_graph(&receipt.run_id, epoch, &graph)
                .unwrap();
            origin
        } else {
            ToolOrigin::ModelStep {
                request_id: "model".into(),
            }
        };
        let db = Arc::new(Mutex::new(catalog));
        let (out, frames) = mpsc::sync_channel(4);
        let bridge = OwnerChannel::new("resource", out);
        bridge.initialize("epoch");
        let directory = Arc::new(
            ToolDirectory::assemble(vec![declaration(db.clone(), bridge.clone())]).unwrap(),
        );
        let frozen = FrozenToolContext {
            resource_checkpoint_id: Some("old-context".into()),
            run_id: receipt.run_id.clone(),
            origin,
            tool_schema_generation: 1,
            tools: Arc::new(vec![schema()]),
            source: None,
        };
        let cancel = CancellationToken::default();
        let bound = directory.bind_call(&call, &frozen, &cancel).unwrap();
        let contract = bound.prepare(&cancel).unwrap();
        assert!(contract.read_only);
        assert!(bound.supports_policy_read(&contract));
        let candidate = db
            .lock()
            .unwrap()
            .prepare_resource_refresh(
                "branch",
                1,
                "new".into(),
                vec![],
                None,
                basis("new"),
                resources("new"),
            )
            .unwrap()
            .load()
            .unwrap();
        db.lock()
            .unwrap()
            .publish_resource_refresh(candidate)
            .unwrap();
        let context = ToolExecutionContext {
            run_id: receipt.run_id.clone(),
            origin: frozen.origin.clone(),
            operation_id: frozen.origin.operation_id("read"),
        };
        let responder = {
            let db = db.clone();
            let bridge = bridge.clone();
            let run = receipt.run_id.clone();
            std::thread::spawn(move || {
                let frame = frames
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                assert_eq!(frame["kind"], "resource-request");
                assert_eq!(frame["query"]["callId"], "read");
                assert_eq!(frame["query"]["resourceCheckpointId"], "old-context");
                let mut query = frame["query"].clone();
                query.as_object_mut().unwrap().remove("request");
                let snapshot = execute_rpc(
                    db.clone(),
                    "runtime.resources.snapshot",
                    query,
                    Arc::new(AtomicBool::new(false)),
                )
                .unwrap();
                assert_eq!(snapshot["snapshot"]["capturedFiles"][0]["content"], "old");
                if cancel_before_reply {
                    if policy_call {
                        let origin: ToolOrigin =
                            serde_json::from_value(frame["query"]["origin"].clone()).unwrap();
                        let ToolOrigin::PolicyAction { action_id, .. } = origin else {
                            panic!("policy origin")
                        };
                        db.lock()
                            .unwrap()
                            .request_cancel_operation(&action_id)
                            .unwrap();
                        assert!(!db.lock().unwrap().run(&run).unwrap().cancel_requested);
                    } else {
                        db.lock().unwrap().request_cancel_run(&run).unwrap();
                    }
                }
                bridge.receive(json!({"v":1,"kind":"resource-response","id":frame["id"],"kernelEpoch":"epoch","result":{"status":"ready","content":"old"}}));
            })
        };
        bound.authorize(&context, &contract, &cancel).unwrap();
        let result = bound.execute(&context, &contract, &cancel);
        responder.join().unwrap();
        let ToolCompletion::Result {
            outcome,
            effect,
            content,
        } = result.completion
        else {
            panic!("resource result missing")
        };
        assert_eq!(effect, Effect::None);
        assert_eq!(
            outcome,
            if cancel_before_reply {
                Outcome::Cancelled
            } else {
                Outcome::Succeeded
            }
        );
        assert_eq!(
            content["content"],
            if cancel_before_reply {
                Value::Null
            } else {
                json!("old")
            }
        );
        let sql = rusqlite::Connection::open(root.join("conversation.sqlite")).unwrap();
        assert_eq!(
            sql.query_row("SELECT count(*) FROM operations", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            if policy_call { 1 } else { 0 }
        );
        bridge.close();
        drop(sql);
        drop(bound);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
