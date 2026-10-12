//! Real declarative extension callbacks, Host scope preparation, Catalog and model serialization.
//! Only model output and the existing test stdio rendezvous are controlled; no listener is used.
use super::web_domain_review::{Fixture, Host, EPOCH, HOST};
use super::*;
use crate::host_tools::ToolBridge;
use crate::storage::Storage;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod dispatch_fixture;

const THREAD: &str = "thread:context-composition";
const BRANCH: &str = "branch:context-composition";

fn context_rpc(runtime: Arc<RunSupervisor>, frame: &Value) -> Option<Result<Value, KernelError>> {
    let method = frame["method"].as_str().unwrap();
    let params = frame["params"].clone();
    if matches!(method, "runtime.input.submit" | "runtime.child.prepare") {
        return Some(input_commands::execute(
            runtime,
            method,
            params,
            Arc::new(AtomicBool::new(false)),
            None,
        ));
    }
    if !matches!(
        method,
        "runtime.context.inspect" | "runtime.context.refresh"
    ) {
        return None;
    }
    let catalog = runtime.catalog();
    Some((|| match method {
        "runtime.context.inspect" => {
            let read = catalog
                .lock()
                .unwrap()
                .capture_active_checkpoint(params["branchId"].as_str().unwrap())
                .map_err(domain)?;
            Ok(serde_json::to_value(
                read.map(|read| read.load()).transpose().map_err(domain)?,
            )?)
        }
        "runtime.context.refresh" => {
            let p: ContextRefreshParams = serde_json::from_value(params)?;
            let basis = personalization_basis(
                p.context
                    .personalization
                    .ok_or_else(|| KernelError::Protocol("missing personalization".into()))?,
            )?;
            let preparation = catalog
                .lock()
                .unwrap()
                .prepare_personalization_refresh(
                    &p.branch_id,
                    p.expected_revision
                        .try_into()
                        .map_err(|_| KernelError::Protocol("negative revision".into()))?,
                    p.context.effective_system_prompt,
                    p.context.instruction_sources,
                    p.context.memory_checkpoint.0,
                    basis,
                )
                .map_err(domain)?
                .require_resources(p.context.resources);
            let prepared = preparation.load().map_err(domain)?;
            Ok(serde_json::to_value(
                catalog
                    .lock()
                    .unwrap()
                    .publish_personalization_refresh(prepared)
                    .map_err(domain)?,
            )?)
        }
        _ => unreachable!(),
    })())
}

fn receive(f: &mut Fixture, kind: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(
            Instant::now() < deadline,
            "context Host stalled waiting for {kind}"
        );
        let runtime = f.runtime.clone();
        let frame = f.pump_dispatch(
            |frame| {
                let method = frame["method"].as_str().unwrap();
                if matches!(
                    method,
                    "runtime.input.submit"
                        | "runtime.child.prepare"
                        | "runtime.context.inspect"
                        | "runtime.context.refresh"
                ) {
                    context_rpc(runtime.clone(), frame)
                } else {
                    None
                }
            },
            |_, _| true,
        );
        if let Some(frame) = frame {
            assert_eq!(frame["kind"], kind, "{frame}");
            return frame;
        }
    }
}

struct Model {
    serializer: Arc<dyn ModelProvider>,
    snapshots: mpsc::Sender<RequestSnapshot>,
    release: Mutex<mpsc::Receiver<()>>,
}
fn model_start(
    runtime: &RunSupervisor,
    run_id: &str,
    configuration: Value,
) -> varin_runtime::supervisor::RunStart {
    let read = runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_launch(run_id)
        .unwrap()
        .unwrap();
    let launch = read.load().unwrap().selection;
    let mut start = model_session::bind(serde_json::from_value(configuration).unwrap()).unwrap();
    start = crate::questions::configure(start, runtime.catalog());
    start = crate::observations::configure(start, runtime.catalog());
    // The model is controlled to return text only. Preserve the original admitted directory
    // and policy identities rather than replacing the product input launch with a fixture one.
    start.binding.tools = launch.tools;
    start.binding.tool_schema_generation = launch.tool_schema_generation;
    start
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        self.serializer.serialize(view)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.snapshots.send(request.clone()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(60))
            .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "context-answer".into(),
                content: Content::Text {
                    text: "COMPOSED ANSWER".into(),
                },
                opaque: None,
            },
        })
        .unwrap();
        Ok(FinishReason::Stop)
    }
}
fn assert_context(request: &RequestSnapshot, data: &str) {
    let entries: Vec<_> = request
        .view
        .history
        .iter()
        .filter(|item| {
            matches!(&item.content,
        Content::Text { text } if text == "A INSTRUCTION" || text.starts_with("B DATA VERSION"))
        })
        .collect();
    assert_eq!(
        entries.len(),
        2,
        "selected context must reach the model once"
    );
    assert!(matches!(
        &entries[0].provenance,
        Provenance::SystemInstruction { .. }
    ));
    assert!(matches!(
        &entries[1].provenance,
        Provenance::ExternalData { .. }
    ));
    assert_ne!(
        entries[0].id, entries[1].id,
        "same local section name needs provider identity"
    );
    assert!(matches!(&entries[1].content, Content::Text { text } if text == data));
    let serialized = request.serialized.to_string();
    assert!(serialized.contains("ORIGINAL USER PROFILE"));
    assert!(!serialized.contains("UNSELECTED C"));
    let input = request.serialized["input"].as_array().unwrap();
    let a = input
        .iter()
        .find(|item| item.to_string().contains("A INSTRUCTION"))
        .unwrap();
    let b = input
        .iter()
        .find(|item| item.to_string().contains(data))
        .unwrap();
    assert_eq!(a["role"], "system");
    assert_ne!(
        b["role"], "system",
        "external data must not acquire instruction authority"
    );
}

#[test]
#[ignore = "requires built extension Host and Node/tsx; Host stdio + original Node child IPC, no listener or model account"]
fn ordered_context_reaches_original_requests_refresh_and_recovery() {
    let schemas = crate::child_capabilities::schemas();
    let memory = schemas.iter().find(|s| s.name == "memory").unwrap().clone();
    let dispatch = schemas
        .iter()
        .find(|s| s.name == "dispatch")
        .unwrap()
        .clone();
    let mut parent = dispatch_fixture::Fixture::new_parent_custom(
        0,
        memory,
        dispatch,
        false,
        false,
        false,
        |input, launch| {
            input.task = "Compose independent source-free context".into();
            input.tools = Some(vec!["memory".into()]);
            launch.source = None;
        },
    );
    let selected = parent
        .db
        .capture_child_dispatch_invocation(&parent.context)
        .unwrap()
        .load()
        .unwrap()
        .resolve(&parent.input)
        .unwrap();
    let launch = parent
        .db
        .prepare_child_launch(&parent.context.run_id, parent.launch.clone(), selected)
        .unwrap()
        .load()
        .unwrap();
    let preparation = parent
        .db
        .prepare_child_admission(&parent.context, parent.input.clone(), None, launch)
        .unwrap()
        .load()
        .unwrap();
    let child = parent.db.accept_child_references(preparation).unwrap();
    let child_view = parent.db.capture_child_read(child.clone()).load().unwrap();
    assert!(matches!(
        child.source,
        varin_runtime::catalog::collaboration::ChildSource::Absent
    ));
    let root = parent.root;
    let catalog_path = root.clone();
    let storage_root = root.join("storage");
    let mut db = parent.db;
    db.create_thread(THREAD, BRANCH).unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let (sender, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(sender.into());
    bridge.initialize(EPOCH);
    let mut f = Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/context-transform-host.test-helper.ts",
        ),
        runtime: runtime.clone(),
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge,
        outgoing,
    };
    let configuration = json!({"providerFamily":"openai-responses","model":"fixture","endpoint":"https://fixture.invalid/not-contacted",
        "credentialEnvironment":null,"allowAnonymous":false,"configurationGeneration":1,"maxOutputTokens":100});
    f.host.send(
        json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"storageRoot":storage_root,
        "threadId":THREAD,"branchId":BRANCH,"configuration":configuration}),
    );
    let submitted = receive(&mut f, "fixture-submitted");
    let run_id = submitted["receipt"]["run_id"].as_str().unwrap().to_owned();
    let mut start = model_start(&runtime, &run_id, configuration.clone());
    let (seen_tx, seen) = mpsc::channel();
    let (release, released) = mpsc::channel();
    start.provider = Arc::new(Model {
        serializer: start.provider,
        snapshots: seen_tx,
        release: Mutex::new(released),
    });
    let execution = runtime.start(&run_id, start).unwrap();
    let original = match seen.recv_timeout(Duration::from_secs(30)) {
        Ok(request) => request,
        Err(error) => panic!(
            "first request did not reach model: {error}; {:?}",
            execution.wait()
        ),
    };
    assert_context(&original, "B DATA VERSION ONE");
    let checkpoint_read = runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_active_checkpoint(BRANCH)
        .unwrap()
        .unwrap();
    let checkpoint = checkpoint_read.load().unwrap();
    f.host
        .send(json!({"kind":"fixture-update","checkpoint":checkpoint}));
    let updated = receive(&mut f, "fixture-updated")["checkpoint"].clone();
    assert_context(&original, "B DATA VERSION ONE");
    release.send(()).unwrap();
    assert_eq!(
        execution.wait().unwrap().state,
        varin_runtime::RunState::Completed
    );

    // A new input uses the updated active checkpoint through the original input admission.
    let head = runtime.catalog().lock().unwrap().head(BRANCH).unwrap();
    let second = input_commands::execute(runtime.clone(), "runtime.input.submit", json!({"key":"context-second",
        "threadId":THREAD,"branchId":BRANCH,"expectedHead":head,"input":{"text":"SECOND USER MESSAGE"},
        "configuration":configuration,"launch":{"source":null,"enabledTools":[],"inheritSource":false}}),
        Arc::new(AtomicBool::new(false)), None).unwrap();
    let second_id = second["run_id"].as_str().unwrap();
    let mut start = model_start(&runtime, second_id, configuration);
    let (seen_tx, seen) = mpsc::channel();
    let (release, released) = mpsc::channel();
    start.provider = Arc::new(Model {
        serializer: start.provider,
        snapshots: seen_tx,
        release: Mutex::new(released),
    });
    let execution = runtime.start(second_id, start).unwrap();
    let next = match seen.recv_timeout(Duration::from_secs(30)) {
        Ok(request) => request,
        Err(error) => panic!(
            "next request did not reach model: {error}; {:?}",
            execution.wait()
        ),
    };
    assert_context(&next, "B DATA VERSION TWO");
    release.send(()).unwrap();
    assert_eq!(
        execution.wait().unwrap().state,
        varin_runtime::RunState::Completed
    );
    f.host
        .send(json!({"kind":"fixture-child","executionId":child.execution_id,"child":child_view}));
    let child_prepared = receive(&mut f, "fixture-child-prepared");
    let child_run_id = child_prepared["receipt"]["receipt"]["run_id"]
        .as_str()
        .unwrap();
    let child_run = runtime.catalog().lock().unwrap().run(child_run_id).unwrap();
    let read = {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        db.prepare_context_read(
            child_run_id,
            db.epoch(),
            db.head(&child_run.branch_id).unwrap().as_deref(),
        )
        .unwrap()
        .unwrap()
    };
    let projection = read.load().unwrap();
    let fragments: Vec<_> = projection
        .history
        .iter()
        .filter_map(|item| match &item.content {
            Content::Text { text }
                if text == "A INSTRUCTION" || text.starts_with("B DATA VERSION") =>
            {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        fragments,
        ["B DATA VERSION TWO", "A INSTRUCTION"],
        "real child uses its own selected scope order"
    );
    assert_eq!(
        child_prepared["checkpoint"]["personalization"]["threadRole"],
        "worker"
    );
    runtime.cancel(child_run_id).unwrap();
    f.host
        .send(json!({"kind":"fixture-disabled","checkpoint":updated}));
    receive(&mut f, "fixture-disable-checked");
    f.host
        .send(json!({"kind":"fixture-empty","checkpoint":updated}));
    let empty = receive(&mut f, "fixture-empty-checked")["checkpoint"].clone();
    f.host.send(json!({"kind":"fixture-finish"}));
    receive(&mut f, "fixture-finished");
    drop(f);
    drop(runtime);
    let db = Catalog::open(&catalog_path).unwrap();
    assert_eq!(
        db.prepare_content_collection(Arc::new(AtomicBool::new(false)))
            .run()
            .status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    for expected in [&original, &next] {
        let actual = db
            .capture_model_step_read(&expected.view.request_id)
            .unwrap()
            .load_request()
            .unwrap();
        assert_eq!(
            actual,
            serde_json::to_value(expected).unwrap(),
            "GC/recovery preserves exact accepted request bytes"
        );
    }
    let restored = db
        .capture_active_checkpoint(BRANCH)
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(serde_json::to_value(restored).unwrap(), empty);
    let history = db.history(BRANCH).unwrap();
    assert!(history
        .iter()
        .any(|item| item.content.to_string().contains("COMPOSED ANSWER")));
    assert!(history
        .iter()
        .any(|item| item.content.to_string().contains("FIRST USER MESSAGE")));
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
