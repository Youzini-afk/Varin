//! Reported tool failures against the real resource owners, in disposable roots.
use super::*;
use std::{fs, path::PathBuf, sync::Mutex};
const HOST: &str = "tools-host";
const GENERATION: &str = "tools-generation";
const EPOCH: &str = "tools-epoch";
struct TestRoot(PathBuf);
impl std::ops::Deref for TestRoot {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Fixture {
    executor: KernelToolExecutor,
    _storage: Arc<Mutex<Storage>>,
    root: TestRoot,
    serial: usize,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("varin-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        let mut storage = Storage::open(&root.join("store"), HOST).unwrap();
        storage.issue_grant(&json!({"grantId":"actor","hostGeneration":GENERATION,"capabilities":["storage.admin","process"],
            "pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run"}),
            HOST,GENERATION,&root.join("store").to_string_lossy(),EPOCH).unwrap();
        let params = json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":root.join("work")});
        let (grant, params) = storage
            .authorize(
                Some("actor"),
                EPOCH,
                HOST,
                GENERATION,
                "file.root.register",
                &params,
            )
            .unwrap();
        let registered = storage
            .dispatch("file.root.register", &params, Some("actor"), &grant)
            .unwrap();
        let binding:ToolBinding=serde_json::from_value(json!({"resourceOwner":{"kind":"local"},"grantId":"actor","runId":"run","threadId":"thread",
            "workspaceId":"workspace","executionWorkspaceId":"workspace","rootId":registered["rootId"],"sourceMode":"live_root",
            "liveRoot":{"hostId":HOST,"rootId":registered["rootId"],"canonicalRoot":registered["canonicalRoot"]},
            "enabledTools":["file_read","file_write","file_edit","file_list","file_search","process_spawn"]})).unwrap();
        let storage = Arc::new(Mutex::new(storage));
        let owner = storage.clone();
        let resources = KernelResourceClient::new(
            move |request| {
                let result = serve_resource(
                    &mut owner.lock().unwrap(),
                    EPOCH,
                    HOST,
                    GENERATION,
                    &request,
                );
                request.reply.send(result).unwrap();
                Ok(())
            },
            |_| Ok(()),
            crate::process::ProcessControlRegistry::default(),
        );
        Self {
            executor: KernelToolExecutor::new(binding, resources).unwrap(),
            _storage: storage,
            root: TestRoot(root),
            serial: 0,
        }
    }
    fn call(&mut self, name: &str, arguments: Value) -> ToolCompletion {
        self.try_call(name, arguments).unwrap()
    }
    fn try_call(&mut self, name: &str, arguments: Value) -> Result<ToolCompletion, ExecutionError> {
        self.serial += 1;
        let call = ToolCall {
            call_id: format!("call-{}", self.serial),
            name: name.into(),
            schema_version: "1".into(),
            arguments,
        };
        let origin = ToolOrigin::ModelStep {
            request_id: "request".into(),
        };
        let context = execution_context(&self.executor.binding.run_id, &call, &origin);
        let cancel = CancellationToken::default();
        let operation = self.executor.operation(Some(&context), &call)?;
        let contract = self
            .executor
            .planned_contract(&context, &call, &operation, &cancel)?;
        Ok(self
            .executor
            .execute_operation(&context, &call, operation, &contract, &cancel))
    }
    fn next_run(&mut self, id: &str, scopes: &[&str]) {
        self._storage.lock().unwrap().issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,
            "capabilities":["storage.read","storage.write"],"pathScopes":scopes,"owningWorkspace":"workspace",
            "executionWorkspace":"workspace","threadId":"thread","runId":id}), HOST,GENERATION,
            &self.root.join("store").to_string_lossy(),EPOCH).unwrap();
        self.executor.binding.grant_id = id.into();
        self.executor.binding.run_id = id.into();
    }
    fn read(&mut self, args: Value) -> Value {
        match self.call("file_read", args) {
            ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                content,
                ..
            } => content.data,
            other => panic!("{other:?}"),
        }
    }
}

#[test]
fn file_write_creates_without_a_read_and_keeps_existing_content_on_an_unversioned_retry() {
    let mut f=Fixture::new();
    assert!(matches!(f.call("file_write",json!({"path":"new.txt","content":"中文🙂"})),
        ToolCompletion::Result { outcome:Outcome::Succeeded,.. }));
    assert!(matches!(f.call("file_write",json!({"path":"new.txt","content":"overwritten"})),ToolCompletion::NotDispatched {..}));
    assert_eq!(fs::read_to_string(f.root.join("work/new.txt")).unwrap(),"中文🙂");
}

#[test]
fn text_edits_can_read_existing_content_larger_than_a_response_frame_internally() {
    let mut f=Fixture::new();
    let mut body="x".repeat(crate::protocol::MAX_BLOB_RESPONSE_BYTES+1);
    body.push_str("END");
    fs::write(f.root.join("work/large.txt"),&body).unwrap();
    let version=f.read(json!({"path":"large.txt","length":1}))["readVersion"].clone();
    assert!(matches!(f.call("file_edit",json!({"path":"large.txt","readVersion":version,"edits":[{"oldText":"END","newText":"DONE"}]})),
        ToolCompletion::Result { outcome:Outcome::Succeeded,.. }));
    let content=fs::read_to_string(f.root.join("work/large.txt")).unwrap();
    assert_eq!(content.len(),body.len()+1);
    assert!(content.ends_with("DONE"));
}

#[test]
fn file_version_survives_a_new_run_while_write_permissions_and_conflicts_stay_enforced() {
    let mut f = Fixture::new();
    fs::write(f.root.join("work/body"), "unchanged").unwrap();
    let original = f.read(json!({"path":"body"}))["readVersion"].clone();
    f.next_run("next-run", &[""]);
    assert_eq!(
        f.read(json!({"path":"body","length":1}))["readVersion"],
        original
    );
    let args = json!({"path":"body","readVersion":original,"edits":[{"oldText":"unchanged","newText":"updated"}]});
    assert!(matches!(
        f.call("file_edit", args.clone()),
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            ..
        }
    ));
    assert_eq!(
        fs::read_to_string(f.root.join("work/body")).unwrap(),
        "updated"
    );
    assert!(matches!(
        f.call("file_edit", args),
        ToolCompletion::NotDispatched { .. }
    ));
    let current = f.read(json!({"path":"body"}))["readVersion"].clone();
    f.next_run("limited-run", &["other"]);
    assert!(f.try_call("file_edit",json!({"path":"body","readVersion":current,"edits":[{"oldText":"updated","newText":"forbidden"}]})).is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("work/body")).unwrap(),
        "updated"
    );
}

#[test]
fn missing_process_cwd_is_not_dispatched_and_following_reads_work() {
    let mut f = Fixture::new();
    assert!(matches!(
        f.call(
            "process_spawn",
            json!({"command":"unused-command","args":[],"mode":"pipe","cwd":"missing"})
        ),
        ToolCompletion::NotDispatched { .. }
    ));
    fs::write(f.root.join("work/body"), "still available").unwrap();
    assert_eq!(
        f.read(json!({"path":"body"}))["content"]["text"],
        "still available"
    );
}

#[test]
fn process_dot_cwd_resolves_before_launch_and_globs_filter_records_without_pruning_traversal() {
    let mut f = Fixture::new();
    for cwd in [".", "./", ".\\"] {
        let operation = ResourceOperation::parse(ToolKind::ProcessSpawn,
            &json!({"command":"unused-command","args":[],"env":[],"mode":"pipe","cwd":cwd})).unwrap();
        let ResourceOperation::ProcessSpawn(args) = operation else { unreachable!() };
        assert_eq!(args.cwd, "");
    }
    let ToolCompletion::NotDispatched { reason } = f.call("process_spawn",
        json!({"command":"unused-command","args":[],"env":[],"mode":"pipe","cwd":"./missing"})) else { panic!("missing directory was dispatched"); };
    assert!(reason.contains("working directory") && !reason.contains("normalized"), "{reason}");
    fs::create_dir_all(f.root.join("work/docs/sub")).unwrap();
    for path in ["README.md", "docs/notes.md", "docs/sub/last.md", "docs/other.txt"] {
        fs::write(f.root.join("work").join(path), "body").unwrap();
    }
    for (recursive, expected) in [(false, vec!["README.md"]), (true, vec!["README.md", "docs/notes.md", "docs/sub/last.md"])] {
        let ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } = f.call("file_list", json!({"globs":["*.md"],"recursive":recursive})) else { panic!("listing failed"); };
        let paths = content.data["records"].as_array().unwrap().iter().map(|r|r["path"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(paths, expected);
    }
}

#[test]
fn partial_utf8_read_has_the_full_file_version_and_advances_on_character_boundaries() {
    let mut f = Fixture::new();
    fs::write(f.root.join("work/body"), "第一🙂行\nnext").unwrap();
    let full = f.read(json!({"path":"body"}));
    let first = f.read(json!({"path":"body","offset":1,"length":1}));
    assert_eq!(first["content"]["text"], "第");
    assert_eq!(first["content"]["offset"], 0);
    assert_eq!(first["content"]["nextOffset"], 3);
    assert_eq!(first["readVersion"], full["readVersion"]);
    let next = f.read(json!({"path":"body","offset":3,"length":4}));
    assert_eq!(next["content"]["text"], "一🙂");
    assert_eq!(next["content"]["nextOffset"], 10);
    fs::write(f.root.join("work/body"), "第一🙂行\nchanged").unwrap();
    assert_ne!(
        f.read(json!({"path":"body","length":1}))["readVersion"],
        full["readVersion"]
    );
}

#[test]
fn directory_pages_cover_the_remaining_paths_without_entering_excluded_copies() {
    let mut f = Fixture::new();
    fs::create_dir_all(f.root.join("work/a/sub")).unwrap();
    fs::create_dir_all(f.root.join("work/.worktrees/copy")).unwrap();
    for name in ["a/sub/file", "a.txt", "b", "z", ".worktrees/copy/hidden"] {
        fs::write(f.root.join("work").join(name), "needle").unwrap();
    }
    let mut cursor = None;
    let mut seen = Vec::new();
    loop {
        let mut args = json!({"recursive":true,"maxResults":2});
        if let Some(value) = &cursor {
            args["cursor"] = json!(value);
        }
        let ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            content,
            ..
        } = f.call("file_list", args)
        else {
            panic!("listing failed")
        };
        let result = content.data;
        for item in result["records"].as_array().unwrap() {
            assert!(item.get("revision").is_none());
            assert!(item["data"]["state"].get("objectHash").is_none());
            seen.push(item["path"].as_str().unwrap().to_string());
        }
        cursor = result["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
        assert!(seen.len() < 20, "cursor failed to advance");
    }
    assert_eq!(seen, ["", "a", "a/sub", "a/sub/file", "a.txt", "b", "z"]);
}

#[test]
fn explicit_paths_reach_dependencies_worktrees_and_ignored_files_without_filter_flags() {
    let mut f = Fixture::new();
    for dir in [".git", "node_modules/pkg/node_modules/nested", ".worktrees/copy", "build"] {
        fs::create_dir_all(f.root.join("work").join(dir)).unwrap();
    }
    fs::write(f.root.join("work/.gitignore"), "node_modules/\n.worktrees/\nbuild/\n*.log\n").unwrap();
    fs::write(f.root.join("work/build/.gitignore"), "skip.txt\n").unwrap();
    for path in ["source.txt", ".git/config", "node_modules/pkg/index.js", "node_modules/pkg/node_modules/nested/index.js",
        ".worktrees/copy/source.txt", "build/output.txt", "build/skip.txt", "debug.log"] {
        fs::write(f.root.join("work").join(path), "needle").unwrap();
    }
    let mut query = |name: &str, args: Value| {
        let ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } = f.call(name,args) else {panic!("query failed")};
        let mut paths=content.data["records"].as_array().unwrap().iter().map(|r|r["path"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        paths.sort();paths
    };
    assert_eq!(query("file_list",json!({})), ["", ".git", ".gitignore", ".worktrees", "build", "debug.log", "node_modules", "source.txt"]);
    assert_eq!(query("file_search",json!({"query":"needle"})), ["source.txt"]);
    assert_eq!(query("file_search",json!({"query":"needle","paths":["node_modules/pkg",".worktrees/copy",".git/config","build","debug.log"]})),
        [".git/config", ".worktrees/copy/source.txt", "build/output.txt", "debug.log", "node_modules/pkg/index.js"]);
    assert_eq!(query("file_search",json!({"query":"needle","paths":["","node_modules/pkg"]})), ["node_modules/pkg/index.js", "source.txt"]);
    assert_eq!(query("file_list",json!({"paths":["node_modules/pkg"]})), ["node_modules/pkg", "node_modules/pkg/index.js", "node_modules/pkg/node_modules"]);
}
