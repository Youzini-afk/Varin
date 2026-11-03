//! Real Catalog dispatch, frozen policy invocation, send acceptance and queue consumption.
//! Only the resource owner transport is controlled; no test bypasses message admission.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::sync::mpsc;
use varin_runtime::catalog::{context::ContextProposal, resources::ContextResources};
use varin_runtime::{Effect, ExecutorOwner, OperationPhase};
#[allow(dead_code)]
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod dispatch;

struct Fixture {
    root: std::path::PathBuf,
    catalog: Arc<Mutex<Catalog>>,
    endpoint: Arc<MessageTools>,
    bridge: crate::host_query::OwnerChannel,
    frames: mpsc::Receiver<Value>,
    context: ToolExecutionContext,
    call: ToolCall,
    contract: ToolContract,
    parent_run: String,
}
impl Fixture {
    fn new(arguments: Value) -> Self {
        Self::new_call("send", arguments)
    }
    fn new_call(name: &str, arguments: Value) -> Self {
        let read_schema = if name == "read_thread" {
            crate::family_tools::schemas()
                .into_iter()
                .find(|schema| schema.name == name)
                .unwrap()
        } else {
            schema()
        };
        let dispatch_schema = crate::collaboration::schemas(vec![])
            .into_iter()
            .find(|schema| schema.name == "dispatch")
            .unwrap();
        let mut f = dispatch::Fixture::new_parent_custom(
            0,
            read_schema,
            dispatch_schema,
            false,
            false,
            false,
            |input, launch| {
                input.tools = Some(vec![
                    if name == "read_thread" {
                        name.into()
                    } else {
                        "send".into()
                    },
                    "dispatch".into(),
                ]);
                input.work_mode = Some(varin_runtime::catalog::dispatch::ChildWorkMode::Shared);
                launch.source = None;
            },
        );
        f.launch.tools.push(
            crate::collaboration::schemas(vec![])
                .into_iter()
                .chain(crate::family_tools::schemas())
                .find(|schema| schema.name == "dispatch")
                .unwrap(),
        );
        let selected =
            f.db.capture_child_dispatch_invocation(&f.context)
                .unwrap()
                .load()
                .unwrap();
        let resolved = selected.resolve(&f.input).unwrap();
        let child_model = resolved.model.clone();
        let launch =
            f.db.prepare_child_launch(&f.context.run_id, f.launch.clone(), resolved)
                .unwrap()
                .load()
                .unwrap();
        let prepared =
            f.db.prepare_child_admission(&f.context, f.input.clone(), None, launch)
                .unwrap()
                .load()
                .unwrap();
        let child = f.db.accept_child_references(prepared).unwrap();
        f.settle_exchange();
        let parent_run = f.context.run_id.clone();
        let proposal = ContextProposal {
            key: "attachment-context".into(),
            branch_id: child.child_branch_id.clone(),
            through_id: None,
            expected_revision: 0,
            summary: String::new(),
            effective_system_prompt: "File worker".into(),
            instruction_sources: vec![],
            memory_checkpoint: None,
        };
        let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
            "configurationDigest":"attachment-worker","memorySnapshot":{"revision":0,"memories":[]},
            "threadId":child.child_thread_id,"projectId":null,"originalSections":[{"name":"system","content":"File worker"}],"instructionSources":[]})).unwrap();
        let resources: ContextResources = serde_json::from_value(json!({"source":null,"snapshot":{
            "id":"attachment-resources","scope":{"threadId":child.child_thread_id,"branchId":child.child_branch_id,
                "mode":"agent","threadRole":"worker","projectId":null,"sourceIdentity":null,"cwd":"","projectTrusted":false,"projectRoot":null},
            "readers":[],"project":null,"configurationDigest":"attachment-worker","shadowedContextCanonicalIds":[],
            "system":null,"appendSystem":null,"instructions":[],"instructionScopes":[],"skills":[],"diagnostics":[],"capturedFiles":[],"observations":[]}})).unwrap();
        let prepared =
            f.db.capture_child_preparation(&child.operation_id, None, proposal, basis)
                .unwrap()
                .with_resources(Some(resources))
                .load()
                .unwrap();
        let child = f.db.admit_child(prepared).unwrap();
        let run = f.db.run(&child.receipt.unwrap().run_id).unwrap();
        let launch = f.db.launch_intent(&run.id).unwrap().unwrap().selection;
        let selected =
            f.db.prepare_child_dispatch_binding(
                &run.id,
                child_model,
                launch.tool_schema_generation,
                launch.tools.clone(),
            )
            .unwrap()
            .load()
            .unwrap();
        f.db.bind_child_dispatch(&run.id, selected).unwrap();
        let boundary = f.db.policy_boundary(&run.id, f.db.epoch()).unwrap();
        assert!(boundary.resource_checkpoint_id.is_some());
        let selected_schema = if name == "send" {
            schema()
        } else {
            crate::collaboration::schemas(vec![])
                .into_iter()
                .chain(crate::family_tools::schemas())
                .find(|schema| schema.name == name)
                .unwrap()
        };
        let call = ToolCall {
            call_id: "handoff-file".into(),
            name: name.into(),
            schema_version: selected_schema.version.clone(),
            arguments,
        };
        let action_id = format!("{}:policy:{}", run.id, boundary.id);
        let origin = ToolOrigin::PolicyAction {
            action_id: action_id.clone(),
            node_id: call.call_id.clone(),
        };
        let context = ToolExecutionContext {
            run_id: run.id.clone(),
            operation_id: origin.operation_id(&call.call_id),
            origin: origin.clone(),
        };
        let frozen = FrozenToolContext {
            tool_output_visible_bytes: None,
            execution_environment: None,
            direct_tools: None,
            child_dispatch: f
                .db
                .launch_metadata(&run.id)
                .unwrap()
                .unwrap()
                .dispatch_context_ref,
            resource_activations: vec![],
            resource_checkpoint_id: boundary.resource_checkpoint_id.clone(),
            run_id: run.id.clone(),
            origin,
            tool_schema_generation: launch.tool_schema_generation,
            tools: Arc::new(launch.tools.clone()),
            source: None,
        };
        let waiting = name == "dispatch" || call.arguments.get("wait").is_some();
        let contract = ToolContract {
            name: name.into(),
            schema_version: selected_schema.version,
            read_only: matches!(name, "dispatch" | "read_thread"),
            completion: if waiting {
                CompletionKind::Job
            } else {
                CompletionKind::Result
            },
            lifetime: if waiting {
                Lifetime::Thread
            } else {
                Lifetime::Run
            },
            resources: vec![],
        };
        let graph = PolicyGraphIntent::PolicyToolGraphV1 {
            dispatch_history: Some(f.db.execution_history(&run.branch_id).unwrap()),
            action_id,
            boundary,
            identity: launch.policy,
            state: json!({"stage":1}),
            nodes: vec![PolicyAdmittedNode {
                context: frozen,
                node: PolicyToolNode {
                    id: call.call_id.clone(),
                    depends_on: vec![],
                    call: call.clone(),
                },
            }],
        };
        let epoch = f.db.epoch();
        f.db.admit_policy_graph(&run.id, epoch, &graph).unwrap();
        if name != "read_thread" {
            f.db.commit_execution(
                &run.id,
                epoch,
                &ExecutionRecord::ToolAdmitted {
                    context: context.clone(),
                    tool: AdmittedTool {
                        contract: contract.clone(),
                        call: call.clone(),
                    },
                },
            )
            .unwrap();
            f.db.commit_execution(
                &run.id,
                epoch,
                &ExecutionRecord::ToolDispatched {
                    context: context.clone(),
                    executor_owner: ExecutorOwner::Kernel,
                },
            )
            .unwrap();
        }
        let catalog = Arc::new(Mutex::new(f.db));
        let (tx, frames) = mpsc::sync_channel(16);
        let bridge = crate::host_query::OwnerChannel::new("resource", tx);
        bridge.initialize("message-attachments");
        let endpoint = Arc::new(MessageTools {
            catalog: catalog.clone(),
            attachments: Some(bridge.clone()),
        });
        Self {
            root: f.root,
            catalog,
            endpoint,
            bridge,
            frames,
            context,
            call,
            contract,
            parent_run,
        }
    }
    fn authorize(&self) -> Result<(), ExecutionError> {
        self.endpoint.authorize(
            &self.context,
            &self.call,
            &self.contract,
            &CancellationToken::default(),
        )
    }
    fn reply(&self, frame: &Value, result: Value) {
        self.bridge.receive(json!({"v":1,"kind":"resource-response","id":frame["id"],"kernelEpoch":"message-attachments","result":result}));
    }
    fn start(&self, cancel: CancellationToken) -> std::thread::JoinHandle<ToolCompletion> {
        let (endpoint, context, call, contract) = (
            self.endpoint.clone(),
            self.context.clone(),
            self.call.clone(),
            self.contract.clone(),
        );
        std::thread::spawn(move || endpoint.execute(&context, &call, &contract, &cancel))
    }
    fn next(&self) -> Value {
        let frame = self
            .frames
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        if matches!(
            frame["query"]["request"]["kind"].as_str(),
            Some("attachment_prepare" | "attachment" | "attachment_report")
        ) {
            // Exercise the real Host resource checkpoint gate, not just the transport
            // mock. A capability's local authorization cannot substitute for this RPC.
            let mut query = frame["query"].clone();
            query.as_object_mut().unwrap().remove("request");
            let snapshot = crate::agent_resources::execute_rpc(
                self.catalog.clone(),
                "runtime.resources.snapshot",
                query,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .unwrap();
            assert_eq!(
                snapshot["snapshot"]["scope"]["threadId"],
                self.catalog
                    .lock()
                    .unwrap()
                    .run(&self.context.run_id)
                    .unwrap()
                    .thread_id
            );
            assert!(
                snapshot["source"].is_null(),
                "source-free attachment sender stays source-free"
            );
        }
        frame
    }
    fn message_id(&self) -> String {
        format!("message:{}", self.context.operation_id)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.bridge.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
const IMAGE_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7h8AAAAASUVORK5CYII=";
fn file() -> Value {
    json!({"ref":"attachment:fixed-image","filename":"pixel.png","mimeType":"image/png","byteLength":STANDARD.decode(IMAGE_BASE64).unwrap().len()})
}

#[test]
fn history_attachment_access_uses_only_returned_typed_parts_and_preserves_denied_metadata() {
    let f = Fixture::new_call(
        "read_thread",
        json!({"threadId":"thread:parent","branchId":"branch:parent",
        "query":{"kind":"recent","limit":1,"maxItemBytes":1}}),
    );
    let denied = json!({"ref":"attachment:unavailable","filename":"other.bin","mimeType":"application/octet-stream","byteLength":3});
    {
        let mut db = f.catalog.lock().unwrap();
        for (id, parts) in [
            (
                "older",
                json!([{"kind":"attachment","attachment":{"ref":"attachment:not-selected","filename":"older.bin","mimeType":"application/octet-stream","byteLength":1}}]),
            ),
            (
                "selected",
                json!([{"kind":"attachment","attachment":file()}, {"kind":"attachment","attachment":denied},
                {"kind":"text","text":"A reference mentioned as text is not a grant: attachment:text-only"}]),
            ),
        ] {
            let head = db.head("branch:parent").unwrap();
            let epoch = db.epoch();
            db.append_history(
                &f.parent_run,
                epoch,
                head.as_deref(),
                varin_runtime::HistorySource::Assistant,
                json!({"id":id,"provenance":{"kind":"assistant"},"opaque":null,
                    "content":{"kind":"output","output":{"data":null,"parts":parts}}}),
                None,
            )
            .unwrap();
        }
        assert!(
            db.operation(&f.context.operation_id).is_err(),
            "policy read has no synthetic effect Operation"
        );
    }
    let endpoint =
        crate::family_tools::declarations_with_attachments(f.catalog.clone(), f.bridge.clone())
            .into_iter()
            .find(|d| d.schema.name == "read_thread")
            .unwrap()
            .implementation;
    endpoint
        .authorize(
            &f.context,
            &f.call,
            &f.contract,
            &CancellationToken::default(),
        )
        .unwrap();
    let (context, call, contract) = (f.context.clone(), f.call.clone(), f.contract.clone());
    let worker = std::thread::spawn(move || {
        endpoint.execute(&context, &call, &contract, &CancellationToken::default())
    });
    let frame = f.next();
    assert!(
        f.catalog.try_lock().is_ok(),
        "history attachment grants happen outside Catalog control lock"
    );
    assert!(frame["query"]["resourceCheckpointId"].is_string());
    assert_eq!(
        frame["query"]["request"],
        json!({"kind":"attachment_report","sourceThreadId":"thread:parent",
        "sourceBranchId":"branch:parent","refs":["attachment:fixed-image","attachment:unavailable"]})
    );
    f.reply(&frame, json!({"status":"ready","attachments":[file()],"attachmentAccess":[
        {"ref":"attachment:fixed-image","status":"ready"},
        {"ref":"attachment:unavailable","status":"unreadable","reason":"Original owner denied file access"}]}));
    let ToolCompletion::Result {
        outcome, content, ..
    } = worker.join().unwrap()
    else {
        panic!("history result");
    };
    assert_eq!(outcome, varin_runtime::Outcome::Succeeded, "{content:?}");
    assert_eq!(content.data["page"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        content.data["page"]["items"][0]["attachments"],
        json!([file(), denied])
    );
    assert_eq!(content.data["attachmentAccess"][1]["status"], "unreadable");
    assert!(
        f.frames.try_recv().is_err(),
        "no history-wide or text-scanned grants"
    );
}

#[test]
fn accepted_wait_attachment_replay_never_recaptures_or_withdraws_and_queue_contains_real_pixels() {
    let f = Fixture::new(
        json!({"kind":"inform","targetThreadId":"thread:parent","targetBranchId":"branch:parent",
        "attachments":[{"path":"selected/pixel.png"}],"wait":{}}),
    );
    f.authorize().unwrap();
    assert!(
        f.frames.try_recv().is_err(),
        "authorization must not read or retain any attachment"
    );
    let worker = f.start(CancellationToken::default());
    let prepare = f.next();
    assert!(
        f.catalog.try_lock().is_ok(),
        "resource owner must be outside the Catalog lock"
    );
    assert_eq!(prepare["query"]["request"]["kind"], "attachment_prepare");
    assert_eq!(
        prepare["query"]["request"]["targetThreadId"],
        "thread:parent"
    );
    assert_eq!(
        prepare["query"]["request"]["attachments"],
        json!([{"path":"selected/pixel.png"}])
    );
    assert_eq!(prepare["query"]["runId"], f.context.run_id);
    f.reply(&prepare, json!({"status":"ready","attachments":[file()]}));
    let read = f.next();
    assert_eq!(read["query"]["request"]["ref"], "attachment:fixed-image");
    f.reply(&read,json!({"status":"ready","attachment":file(),"bytesBase64":IMAGE_BASE64,"offset":0,"nextOffset":STANDARD.decode(IMAGE_BASE64).unwrap().len(),"eof":true}));
    let completion = worker.join().unwrap();
    assert!(
        matches!(
            completion,
            ToolCompletion::JobAccepted {
                effect: Effect::Confirmed,
                ..
            }
        ),
        "{completion:?}"
    );
    assert_eq!(
        f.catalog
            .lock()
            .unwrap()
            .operation(&f.context.operation_id)
            .unwrap()
            .phase,
        OperationPhase::Waiting
    );
    // Simulate a lost acceptance response. Cancelling this new observer cannot revoke delivery.
    let cancelled = CancellationToken::default();
    cancelled.cancel();
    let replay = f
        .endpoint
        .execute(&f.context, &f.call, &f.contract, &cancelled);
    assert_eq!(completion, replay);
    assert!(
        f.frames.try_recv().is_err(),
        "accepted replay must not query or release the file owner"
    );
    f.catalog
        .lock()
        .unwrap()
        .cancel_reply_wait(&f.context.operation_id)
        .unwrap();
    assert!(
        f.frames.try_recv().is_err(),
        "ending a reply observation does not revoke attachments"
    );
    let preparation = {
        let db = f.catalog.lock().unwrap();
        assert_eq!(
            db.attachment_delivery("input", &f.message_id())
                .unwrap()
                .unwrap()
                .attachments
                .len(),
            1
        );
        db.prepare_input_delivery(
            &f.parent_run,
            db.epoch(),
            db.head("branch:parent").unwrap().as_deref(),
        )
        .unwrap()
    };
    let prepared = preparation.load().unwrap();
    let delivered = f
        .catalog
        .lock()
        .unwrap()
        .admit_input_delivery(prepared)
        .unwrap()
        .unwrap();
    assert_eq!(delivered.items.len(), 1);
    let Content::Output { output } = &delivered.items[0].content else {
        panic!("typed output required");
    };
    assert!(output.parts.iter().any(|part|matches!(part,varin_runtime::output::OutputPart::Attachment { attachment } if attachment.reference=="attachment:fixed-image")));
    assert!(output.parts.iter().any(|part|matches!(part,varin_runtime::output::OutputPart::Media { media } if media.data_base64==IMAGE_BASE64)));
}

#[test]
fn partial_owner_preparation_failure_releases_exact_unaccepted_intent_but_uncertainty_retains_it() {
    for (status, cleanup) in [
        ("missing", true),
        ("cancelled", true),
        ("ready", true),
        ("unavailable", false),
    ] {
        let f = Fixture::new(
            json!({"kind":"inform","targetThreadId":"thread:parent","targetBranchId":"branch:parent",
            "text":"Keep the complete selection","attachments":[{"path":"first.csv"},{"path":"second.csv"}]}),
        );
        let worker = f.start(CancellationToken::default());
        let prepare = f.next();
        f.reply(&prepare, if status == "ready" {
            json!({"status":"ready","attachments":[file()]})
        } else {
            json!({"status":status,"reason":"Second selected file could not be prepared","path":"second.csv"})
        });
        if cleanup {
            let release = f.next();
            assert_eq!(
                release["query"]["request"],
                json!({"kind":"attachment_release","operationId":f.context.operation_id,
                "targetThreadId":"thread:parent","targetBranchId":"branch:parent"})
            );
            assert!(f.catalog.try_lock().is_ok());
            f.reply(&release, json!({"status":"ready","released":true}));
        }
        assert!(matches!(
            worker.join().unwrap(),
            ToolCompletion::NotDispatched { .. }
        ));
        assert!(
            f.catalog
                .lock()
                .unwrap()
                .attachment_delivery("input", &f.message_id())
                .unwrap()
                .is_none()
        );
        assert!(
            f.frames.try_recv().is_err(),
            "uncertain owner work must not be silently released"
        );
    }
}

#[test]
fn attachment_read_failure_releases_only_unpublished_relation_and_never_delivers_partial_message() {
    let f = Fixture::new(
        json!({"kind":"request","targetThreadId":"thread:parent","text":"Inspect this image","attachments":[{"path":"pixel.png"}]}),
    );
    f.authorize().unwrap();
    let worker = f.start(CancellationToken::default());
    let prepare = f.next();
    f.reply(&prepare, json!({"status":"ready","attachments":[file()]}));
    let read = f.next();
    f.reply(&read,json!({"status":"unavailable","code":"source_offline","reason":"The fixed image owner is offline"}));
    let release = f.next();
    assert_eq!(release["query"]["request"]["kind"], "attachment_release");
    assert_eq!(
        release["query"]["request"]["operationId"],
        f.context.operation_id
    );
    assert_eq!(
        release["query"]["request"]["targetThreadId"],
        "thread:parent"
    );
    f.reply(&release, json!({"status":"ready","released":true}));
    let completion = worker.join().unwrap();
    assert!(
        matches!(completion,ToolCompletion::NotDispatched { error:Some(ref failure),.. } if failure.code=="source_offline")
    );
    let db = f.catalog.lock().unwrap();
    assert!(
        db.attachment_delivery("input", &f.message_id())
            .unwrap()
            .is_none()
    );
    assert!(
        db.capture_message("thread:parent", "branch:parent", &f.message_id())
            .is_err()
    );
}

#[test]
fn unrelated_target_is_rejected_before_attachment_owner_receives_any_request() {
    let f = Fixture::new(
        json!({"kind":"inform","targetThreadId":"unrelated","attachments":[{"path":"secret.bin"}]}),
    );
    f.catalog
        .lock()
        .unwrap()
        .create_thread("unrelated", "unrelated-branch")
        .unwrap();
    assert!(f.authorize().is_err());
    let completed = f.endpoint.execute(
        &f.context,
        &f.call,
        &f.contract,
        &CancellationToken::default(),
    );
    assert!(matches!(completed, ToolCompletion::NotDispatched { .. }));
    assert!(f.frames.try_recv().is_err());
}

#[test]
fn dispatch_publishes_complete_attachment_before_child_creation_and_replay_does_not_read_owner() {
    let f = Fixture::new_call(
        "dispatch",
        json!({"task":"Use this fixed data","workMode":"shared","tools":["send"],"attachments":[{"ref":"attachment:data"}]}),
    );
    let (tx, host_frames) = mpsc::sync_channel(16);
    let host = crate::host_tools::ToolBridge::new(tx.into());
    host.initialize("message-attachments");
    let directory = Arc::new(
        varin_runtime::composition::tools::ToolDirectory::assemble(
            crate::collaboration::declarations_with_attachments(
                f.catalog.clone(),
                None,
                crate::tools::KernelResourceClient::new(
                    |_| panic!("source-free attachment dispatch must not capture a workspace"),
                    |_| Ok(()),
                    Default::default(),
                ),
                host.clone(),
                f.bridge.clone(),
            ),
        )
        .unwrap(),
    );
    let read = f
        .catalog
        .lock()
        .unwrap()
        .capture_tool_invocation(&f.context, &f.call.call_id)
        .unwrap();
    let frozen = read.load().unwrap().frozen;
    let invocation = directory
        .clone()
        .bind_call(&f.call, &frozen, &CancellationToken::default())
        .unwrap();
    let contract = invocation.prepare(&CancellationToken::default()).unwrap();
    invocation
        .authorize(&f.context, &contract, &CancellationToken::default())
        .unwrap();
    assert!(f.frames.try_recv().is_err());
    let context = f.context.clone();
    let worker = std::thread::spawn(move || {
        invocation.execute(&context, &contract, &CancellationToken::default())
    });
    let prepare = f.next();
    assert_eq!(
        prepare["query"]["request"]["targetThreadId"],
        format!("thread:child:{}", f.context.operation_id)
    );
    assert!(
        f.catalog
            .lock()
            .unwrap()
            .child_task(&f.context.operation_id)
            .is_err()
    );
    f.reply(&prepare,json!({"status":"ready","attachments":[{"ref":"attachment:data","filename":"data.bin","mimeType":"application/octet-stream","byteLength":7}]}));
    let retain = host_frames
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert_eq!(retain["kind"], "host-tool-child-retain");
    assert!(
        f.catalog
            .lock()
            .unwrap()
            .child_task(&f.context.operation_id)
            .is_err()
    );
    host.receive(json!({"v":1,"kind":"host-tool-response","id":retain["id"],"kernelEpoch":"message-attachments","ok":true}));
    let accepted = worker.join().unwrap();
    assert!(
        matches!(accepted.completion, ToolCompletion::JobAccepted { .. }),
        "{accepted:?}"
    );
    let db = f.catalog.lock().unwrap();
    let child = db.child_task(&f.context.operation_id).unwrap();
    assert!(
        child.receipt.is_none(),
        "delegation starts only after complete input admission"
    );
    assert_eq!(
        db.attachment_delivery("dispatch", &f.context.operation_id)
            .unwrap()
            .unwrap()
            .attachments[0]
            .reference,
        "attachment:data"
    );
    drop(db);
    let replay = directory
        .bind_call(&f.call, &frozen, &CancellationToken::default())
        .unwrap();
    let contract = replay.prepare(&CancellationToken::default()).unwrap();
    assert!(matches!(
        replay
            .execute(&f.context, &contract, &CancellationToken::default())
            .completion,
        ToolCompletion::JobAccepted { .. }
    ));
    assert!(f.frames.try_recv().is_err());
}

#[test]
fn dispatch_infers_image_requirement_from_original_file_and_does_not_start_nonvision_child() {
    let f = Fixture::new_call(
        "dispatch",
        json!({"task":"Inspect the image","workMode":"shared","tools":["send"],"attachments":[{"ref":"attachment:fixed-image"}]}),
    );
    let (tx, host_frames) = mpsc::sync_channel(16);
    let host = crate::host_tools::ToolBridge::new(tx.into());
    host.initialize("message-attachments");
    let directory = Arc::new(
        varin_runtime::composition::tools::ToolDirectory::assemble(
            crate::collaboration::declarations_with_attachments(
                f.catalog.clone(),
                None,
                crate::tools::KernelResourceClient::new(
                    |_| panic!("no source capture"),
                    |_| Ok(()),
                    Default::default(),
                ),
                host,
                f.bridge.clone(),
            ),
        )
        .unwrap(),
    );
    let read = f
        .catalog
        .lock()
        .unwrap()
        .capture_tool_invocation(&f.context, &f.call.call_id)
        .unwrap();
    let frozen = read.load().unwrap().frozen;
    let invocation = directory
        .bind_call(&f.call, &frozen, &CancellationToken::default())
        .unwrap();
    let contract = invocation.prepare(&CancellationToken::default()).unwrap();
    invocation
        .authorize(&f.context, &contract, &CancellationToken::default())
        .unwrap();
    let context = f.context.clone();
    let worker = std::thread::spawn(move || {
        invocation.execute(&context, &contract, &CancellationToken::default())
    });
    let prepare = f.next();
    f.reply(&prepare, json!({"status":"ready","attachments":[file()]}));
    let release = f.next();
    assert_eq!(release["query"]["request"]["kind"], "attachment_release");
    f.reply(&release, json!({"status":"ready","released":true}));
    let rejected = worker.join().unwrap();
    assert!(matches!(
        rejected.completion,
        ToolCompletion::Result {
            outcome: varin_runtime::Outcome::Failed,
            ..
        }
    ));
    assert!(
        f.catalog
            .lock()
            .unwrap()
            .child_task(&f.context.operation_id)
            .is_err()
    );
    assert!(
        host_frames.try_recv().is_err(),
        "incompatible visual model must not start or retain a child"
    );
}
