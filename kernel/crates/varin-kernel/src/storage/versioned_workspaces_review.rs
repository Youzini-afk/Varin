//! Persistent-tree boundaries used by workspace import, fork and publication.
//! Exercise the real Storage owner, including collection between upload batches.
use super::*;

struct Fixture {
    storage: Storage,
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("workspace-tree-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&directory, "host").unwrap();
        storage.issue_grant(&json!({"grantId":"owner","hostGeneration":"generation",
            "owningWorkspace":"project","executionWorkspace":"project","threadId":"thread","runId":"run",
            "capabilities":["storage.admin"],"pathScopes":[""]}),
            "host", "generation", &directory.to_string_lossy(), "epoch").unwrap();
        Self { storage, directory }
    }
    fn call(&mut self, method: &str, params: Value) -> Result<Value, KernelError> {
        self.call_as("owner", method, params)
    }
    fn call_as(&mut self, actor: &str, method: &str, params: Value) -> Result<Value, KernelError> {
        let (grant, params) =
            self.storage
                .authorize(Some(actor), "epoch", "host", "generation", method, &params)?;
        self.storage.dispatch(method, &params, Some(actor), &grant)
    }
    fn begin(&mut self, name: &str, base: Option<&str>) {
        let mut params = json!({"operationId":format!("create:{name}"),"builderId":name,"branchId":name,
            "workspaceId":"project","draftBasePaths":[],"captureScopes":[]});
        if let Some(base) = base {
            params["baseRef"] = json!(base);
        }
        self.call("branch.create.begin", params).unwrap();
    }
    fn append(&mut self, name: &str, sequence: u64, entries: Value) -> Result<Value, KernelError> {
        self.call(
            "branch.create.append",
            json!({"builderId":name,"sequence":sequence,"entries":entries}),
        )
    }
    fn finish(&mut self, name: &str) -> Value {
        self.call(
            "branch.create.finish",
            json!({"builderId":name,"operationId":format!("create:{name}")}),
        )
        .unwrap()
    }
    fn nodes(&self) -> i64 {
        self.storage
            .conn
            .query_row("SELECT COUNT(*) FROM trie_nodes", [], |row| row.get(0))
            .unwrap()
    }
    fn collect(&mut self, name: &str) {
        self.call("storage.gc", json!({"operationId":name}))
            .unwrap();
    }
    fn blob(&mut self, name: &str, bytes: &[u8]) -> Value {
        let input = json!({"workspaceId":"project","operationId":name,"streamId":name,"byteLength":bytes.len()});
        self.storage.begin_blob_stream(&input, "owner").unwrap();
        self.storage
            .stream_blob_bytes(name, 0, bytes, "owner")
            .unwrap();
        let blob = self.storage.finish_blob_stream(&input, "owner").unwrap();
        json!({"state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":bytes.len(),"mode":420},"ownerId":blob["ownerId"]})
    }
    fn inspect(&mut self, branch: &str, path: &str) -> Value {
        self.call(
            "branch.path.inspect",
            json!({"branchId":branch,"path":path}),
        )
        .unwrap()
    }
    fn apply(&mut self, operation: &str, path: &str, before: &Value, content: &Value) -> Value {
        self.call("branch.path.apply", json!({"operationId":operation,"branchId":"main","changes":[{
            "path":path,"expectedState":before,"state":content["state"],"ownerId":content["ownerId"]
        }]})).unwrap()
    }
    fn close(self) {
        drop(self.storage);
        fs::remove_dir_all(self.directory).unwrap();
    }
}
#[test]
fn workspace_import_builds_before_publication_and_survives_interleaved_gc() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([
            {"path":"src","state":{"kind":"directory","mode":493}},
            {"path":"src/中文","state":{"kind":"directory","mode":493}}
        ]),
    )
    .unwrap();
    // The tree is staged, and no caller can select a partial branch yet.
    assert!(f.storage.branch("main").is_err());
    f.collect("gc-during-import");
    let staged = f.storage.branch_builders["main"].staged_root.clone();
    assert!(f.storage.root_get(&staged, "src/中文").unwrap().is_some());
    f.append(
        "main",
        1,
        json!([
            {"path":"src/Readme","state":{"kind":"symlink","symlinkTarget":"../README","mode":511}},
            {"path":"src/readme","state":{"kind":"directory","mode":448}}
        ]),
    )
    .unwrap();
    let before = f.nodes();
    let created = f.finish("main");
    assert_eq!(created["created"], true);
    assert_eq!(
        f.nodes(),
        before,
        "publication must not rebuild the uploaded tree"
    );
    let root = f.storage.branch("main").unwrap().head_root;
    assert_eq!(root, f.storage.branch("main").unwrap().base_root);
    assert_eq!(f.storage.root_entries(&root).unwrap().len(), 4);
    // Repeated creation retains its original receipt and exact committed root.
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([
            {"path":"src/readme","state":{"kind":"directory","mode":448}},
            {"path":"src/Readme","state":{"kind":"symlink","symlinkTarget":"../README","mode":511}},
            {"path":"src/中文","state":{"kind":"directory","mode":493}},
            {"path":"src","state":{"kind":"directory","mode":493}}
        ]),
    )
    .unwrap();
    assert_eq!(f.finish("main"), created);
    let directory = f.directory.clone();
    drop(f.storage);
    let storage = Storage::open(&directory, "host").unwrap();
    assert_eq!(storage.branch("main").unwrap().head_root, root);
    drop(storage);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn workspace_fork_keeps_parent_and_child_independent_without_new_tree_nodes() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([
            {"path":"src","state":{"kind":"directory","mode":493}},
            {"path":"src/entry","state":{"kind":"symlink","symlinkTarget":"v1","mode":511}},
            {"path":"untouched","state":{"kind":"directory","mode":493}}
        ]),
    )
    .unwrap();
    let main = f.finish("main");
    let frozen = main["root"].as_str().unwrap();
    let nodes = f.nodes();
    f.begin("child", Some(frozen));
    let child = f.finish("child");
    assert_eq!(child["root"], frozen);
    assert_eq!(f.nodes(), nodes, "fork must only retain existing nodes");
    let untouched = f
        .storage
        .find_path_node(frozen, &["untouched".into()])
        .unwrap();
    for (name, target) in [("main", "parent-v2"), ("child", "child-v2")] {
        f.call(
            "branch.write.begin",
            json!({"operationId":format!("write:{name}"),"builderId":name,
            "branchId":name,"expectedWriteRevision":0}),
        )
        .unwrap();
        f.call(
            "branch.write.append",
            json!({"builderId":name,"sequence":0,"changes":[
                {"path":"src/entry","state":{"kind":"symlink","symlinkTarget":target,"mode":511}}
            ]}),
        )
        .unwrap();
        f.call(
            "branch.write.finish",
            json!({"builderId":name,"operationId":format!("write:{name}")}),
        )
        .unwrap();
    }
    f.collect("gc-after-fork");
    for (name, expected) in [("main", "parent-v2"), ("child", "child-v2")] {
        let branch = f.storage.branch(name).unwrap();
        assert_eq!(branch.base_root, frozen);
        assert_eq!(
            f.storage
                .find_path_node(&branch.head_root, &["untouched".into()])
                .unwrap(),
            untouched
        );
        assert_eq!(
            f.storage.root_get(&branch.head_root, "src/entry").unwrap(),
            Some(PathState::Symlink {
                symlink_target: expected.into(),
                mode: Some(511)
            })
        );
    }
    assert_eq!(
        f.storage.root_get(frozen, "src/entry").unwrap(),
        Some(PathState::Symlink {
            symlink_target: "v1".into(),
            mode: Some(511)
        })
    );
    let directory = f.directory.clone();
    drop(f.storage);
    let storage = Storage::open(&directory, "host").unwrap();
    assert_ne!(
        storage.branch("main").unwrap().head_root,
        storage.branch("child").unwrap().head_root
    );
    drop(storage);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn workspace_import_rejects_cross_batch_namespace_conflicts_and_reclaims_aborted_candidates() {
    let mut f = Fixture::new();
    f.begin("import", None);
    f.append(
        "import",
        0,
        json!([{"path":"dir/child","state":{"kind":"directory","mode":493}}]),
    )
    .unwrap();
    let staged = f.storage.branch_builders["import"].staged_root.clone();
    for entries in [
        json!([{"path":"dir/child","state":{"kind":"directory","mode":448}}]),
        json!([{"path":"dir","state":{"kind":"symlink","symlinkTarget":"outside","mode":511}}]),
    ] {
        assert!(f.append("import", 1, entries).is_err());
        assert_eq!(f.storage.branch_builders["import"].next_sequence, 1);
        assert_eq!(f.storage.branch_builders["import"].staged_root, staged);
    }
    f.call("branch.create.abort", json!({"builderId":"import"}))
        .unwrap();
    f.collect("gc-aborted-import");
    assert!(f.storage.load_node(&staged).is_err());
    assert!(f.storage.branch("import").is_err());
    let directory = f.directory.clone();
    drop(f.storage);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn workspace_capture_cleanup_releases_only_original_owners_and_replays_after_response_loss() {
    let mut f = Fixture::new();
    let input =
        json!({"workspaceId":"project","operationId":"body","streamId":"body","byteLength":4});
    f.storage.begin_blob_stream(&input, "owner").unwrap();
    f.storage
        .stream_blob_bytes("body", 0, b"body", "owner")
        .unwrap();
    let blob = f.storage.finish_blob_stream(&input, "owner").unwrap();
    f.storage
        .record_object_owner(
            "another-caller",
            blob["hash"].as_str().unwrap(),
            Some("project"),
            None,
            "other-grant",
        )
        .unwrap();
    let batch = json!({"workspaceId":"project","ownerIds":[blob["ownerId"],"another-caller","already-consumed"]});
    assert_eq!(
        f.call("storage.blob.releaseBatch", batch.clone()).unwrap()["released"],
        1
    );
    assert_eq!(
        f.call("storage.blob.releaseBatch", batch).unwrap()["released"],
        0
    );
    let remaining: Vec<String> = f
        .storage
        .conn
        .prepare("SELECT owner_id FROM object_owners")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(remaining, ["another-caller"]);
    let directory = f.directory.clone();
    drop(f.storage);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn workspace_path_conditions_allow_disjoint_writes_and_reject_stale_content() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.finish("main");
    let a = f.blob("a", b"first");
    let b = f.blob("b", b"second");
    let missing = json!({"kind":"missing"});
    assert_eq!(
        f.apply("write-a", "src/a", &missing, &a)["status"],
        "committed"
    );
    // This observation predates a different path's commit. It remains valid.
    assert_eq!(
        f.apply("write-b", "src/b", &missing, &b)["status"],
        "committed"
    );
    let observed = f.inspect("main", "src/a");
    let next = f.blob("next", b"changed");
    let written = f.apply("edit-a", "src/a", &observed["state"], &next);
    assert_eq!(written["status"], "committed");
    assert_eq!(
        f.apply("edit-a", "src/a", &observed["state"], &next),
        written,
        "replay must not edit twice after consuming its owner"
    );
    let stale = f.blob("stale", b"should not overwrite");
    assert_eq!(
        f.apply("stale-edit", "src/a", &observed["state"], &stale)["status"],
        "conflict"
    );
    assert_eq!(f.inspect("main", "src/a")["state"], next["state"]);
    assert_eq!(f.inspect("main", "src")["state"]["kind"], "directory");
    assert!(
        !f.directory.join("managed").exists(),
        "path writes must not materialize an execution directory"
    );
    f.close();
}

#[test]
fn workspace_directory_replacement_fences_descendants_and_recreation_stays_empty() {
    let mut f = Fixture::new();
    let a = f.blob("a", b"first");
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([{"path":"dir/a","state":a["state"],"ownerId":a["ownerId"]}]),
    )
    .unwrap();
    f.finish("main");
    let before = f.inspect("main", "dir");
    let b = f.blob("b", b"later");
    f.apply("write-b", "dir/b", &json!({"kind":"missing"}), &b);
    let remove = |operation: &str, node: &Value| {
        json!({"operationId":operation,"branchId":"main","changes":[{
            "path":"dir","expectedState":before["state"],"expectedNode":node,"state":{"kind":"missing"}
        }]})
    };
    assert_eq!(
        f.call(
            "branch.path.apply",
            remove("stale-directory", &before["node"])
        )
        .unwrap()["status"],
        "conflict"
    );
    assert!(f
        .call(
            "branch.path.apply",
            json!({"operationId":"unfenced-directory","branchId":"main","changes":[{
                "path":"dir","expectedState":before["state"],"state":{"kind":"missing"}
            }]})
        )
        .is_err());
    let current = f.inspect("main", "dir");
    assert_eq!(
        f.call(
            "branch.path.apply",
            remove("remove-directory", &current["node"])
        )
        .unwrap()["status"],
        "committed"
    );
    f.call(
        "branch.path.apply",
        json!({"operationId":"recreate-directory","branchId":"main","changes":[{
            "path":"dir","expectedState":{"kind":"missing"},"state":{"kind":"directory","mode":493}
        }]}),
    )
    .unwrap();
    assert_eq!(f.inspect("main", "dir/a")["state"]["kind"], "missing");
    assert_eq!(f.inspect("main", "dir/b")["state"]["kind"], "missing");
    f.close();
}

#[test]
fn workspace_subtree_rename_retains_identity_and_bytes_after_gc_and_restart() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.finish("main");
    let a = f.blob("a", b"\0binary\xffdata");
    f.apply("write-a", "src/a", &json!({"kind":"missing"}), &a);
    let b = f.blob("b", b"another file");
    f.apply("write-b", "other/b", &json!({"kind":"missing"}), &b);
    let before = f.inspect("main", "src");
    let rename = json!({"operationId":"move-src","branchId":"main","sourcePath":"src","path":"renamed",
        "expectedSourceNode":before["node"],"expectedTargetNode":null});
    let result = f.call("branch.rename", rename.clone()).unwrap();
    assert_eq!(result["status"], "committed");
    assert_eq!(f.call("branch.rename", rename).unwrap(), result);
    assert_eq!(f.inspect("main", "renamed")["node"], before["node"]);
    assert_eq!(f.inspect("main", "src")["state"]["kind"], "missing");
    f.collect("gc-after-namespace-move");
    let read = f
        .call(
            "storage.getBlob",
            json!({"branchId":"main","path":"renamed/a","hash":a["state"]["objectHash"]}),
        )
        .unwrap();
    assert_eq!(
        BASE64
            .decode(read["bytesBase64"].as_str().unwrap())
            .unwrap(),
        b"\0binary\xffdata"
    );
    assert!(f
        .call(
            "storage.getBlob",
            json!({"branchId":"main","path":"other/b","hash":a["state"]["objectHash"]})
        )
        .is_err());
    let root = f.storage.branch("main").unwrap().head_root;
    drop(f.storage);
    let mut storage = Storage::open(&f.directory, "host").unwrap();
    assert_eq!(storage.branch("main").unwrap().head_root, root);
    assert_eq!(
        storage
            .branch_path_inspect(&json!({"branchId":"main","path":"renamed/a"}))
            .unwrap()["state"],
        a["state"]
    );
    storage.gc().unwrap();
    drop(storage);
    fs::remove_dir_all(f.directory).unwrap();
}

#[test]
fn workspace_fork_selects_current_or_exact_pin_and_survives_parent_release() {
    let mut f = Fixture::new();
    let old = f.blob("old", b"old");
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([{"path":"a","state":old["state"],"ownerId":old["ownerId"]}]),
    )
    .unwrap();
    f.finish("main");
    f.call(
        "branch.pin",
        json!({"operationId":"pin-base","branchId":"main","pinId":"base","revision":0}),
    )
    .unwrap();
    let next = f.blob("next", b"current");
    f.apply("advance-main", "a", &old["state"], &next);
    let nodes = f.nodes();
    let fork = json!({"operationId":"fork-current","branchId":"current-child","sourceBranchId":"main","workspaceId":"project","draftBasePaths":[],"captureScopes":[]});
    let created = f.call("branch.fork", fork.clone()).unwrap();
    assert_eq!(
        f.nodes(),
        nodes,
        "forking must not enumerate or rebuild content nodes"
    );
    let latest = f.blob("latest", b"parent continues");
    f.apply("advance-again", "a", &next["state"], &latest);
    assert_eq!(
        f.call("branch.fork", fork).unwrap(),
        created,
        "replay must preserve the original fork boundary"
    );
    assert_eq!(f.inspect("current-child", "a")["state"], next["state"]);
    f.call(
        "branch.delete",
        json!({"operationId":"release-parent","branchId":"main"}),
    )
    .unwrap();
    f.call("branch.fork", json!({"operationId":"fork-retained-base","branchId":"old-child","sourceBranchId":"main","sourcePinId":"base",
        "workspaceId":"project","draftBasePaths":[],"captureScopes":[]})).unwrap();
    f.call(
        "branch.unpin",
        json!({"operationId":"release-base","branchId":"main","pinId":"base"}),
    )
    .unwrap();
    f.collect("gc-after-parent-release");
    assert_eq!(f.inspect("old-child", "a")["state"], old["state"]);
    assert_eq!(f.inspect("current-child", "a")["state"], next["state"]);
    f.close();
}

#[test]
fn workspace_namespace_rejects_foreign_sources_and_rechecks_both_rename_paths_on_replay() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([
            {"path":"allowed/a","state":{"kind":"symlink","symlinkTarget":"first","mode":511}},
            {"path":"private/a","state":{"kind":"symlink","symlinkTarget":"other","mode":511}}
        ]),
    )
    .unwrap();
    f.finish("main");
    f.storage.issue_grant(&json!({"grantId":"limited","hostGeneration":"generation","owningWorkspace":"project",
        "executionWorkspace":"project","capabilities":["storage.read","storage.write"],"pathScopes":["allowed"]}),
        "host","generation",&f.directory.to_string_lossy(),"epoch").unwrap();
    let from = f.inspect("main", "private/a");
    let rename = json!({"operationId":"move-private","branchId":"main","sourcePath":"private/a","path":"allowed/b",
        "expectedSourceNode":from["node"],"expectedTargetNode":null});
    assert_eq!(
        f.call("branch.rename", rename.clone()).unwrap()["status"],
        "committed"
    );
    assert!(
        f.call_as("limited", "branch.rename", rename).is_err(),
        "completed receipts must not bypass the source-path grant"
    );
    assert!(f
        .call_as(
            "limited",
            "branch.fork",
            json!({"operationId":"wide-fork","workspaceId":"project","branchId":"child",
        "sourceBranchId":"main","draftBasePaths":[],"captureScopes":[]})
        )
        .is_err());
    f.storage.issue_grant(&json!({"grantId":"other-reader","hostGeneration":"generation","owningWorkspace":"project",
        "executionWorkspace":"project","capabilities":["storage.read","storage.write"],"pathScopes":[""]}),
        "host","generation",&f.directory.to_string_lossy(),"epoch").unwrap();
    let head = f.inspect("main", "");
    let pin = f
        .call(
            "branch.pin",
            json!({"operationId":"private-query-pin","branchId":"main",
        "expectedWriteRevision":head["writeRevision"],"expectedRoot":head["root"]}),
        )
        .unwrap();
    let fork = json!({"operationId":"private-pin-fork","workspaceId":"project","branchId":"private-pin-child",
        "sourceBranchId":"main","sourcePinId":pin["pinId"],"draftBasePaths":[],"captureScopes":[]});
    f.call("branch.fork", fork.clone()).unwrap();
    assert!(
        f.call_as("other-reader", "branch.fork", fork).is_err(),
        "completed fork receipts still check a live query pin's original owner"
    );
    // A caller-supplied workspace cannot mask the branch's actual ownership.
    f.storage.issue_grant(&json!({"grantId":"foreign-owner","hostGeneration":"generation","owningWorkspace":"other-project",
        "executionWorkspace":"other-project","capabilities":["storage.read","storage.write"],"pathScopes":[""]}),
        "host","generation",&f.directory.to_string_lossy(),"epoch").unwrap();
    f.call_as(
        "foreign-owner",
        "branch.create.begin",
        json!({"operationId":"foreign","builderId":"foreign","workspaceId":"other-project",
        "branchId":"foreign","draftBasePaths":[],"captureScopes":[]}),
    )
    .unwrap();
    f.call_as(
        "foreign-owner",
        "branch.create.finish",
        json!({"operationId":"foreign","builderId":"foreign"}),
    )
    .unwrap();
    assert!(f
        .call(
            "branch.path.inspect",
            json!({"workspaceId":"project","branchId":"foreign","path":"a"})
        )
        .is_err());
    assert!(f
        .call(
            "branch.fork",
            json!({"operationId":"foreign-fork","workspaceId":"project","branchId":"foreign-child",
        "sourceBranchId":"foreign","draftBasePaths":[],"captureScopes":[]})
        )
        .is_err());
    let observed = f
        .call(
            "branch.path.inspect",
            json!({"branchId":"main","path":"allowed/a","revision":0}),
        )
        .unwrap();
    assert!(
        observed["writeRevision"].is_null(),
        "a fixed path observation must not advertise a current write fence"
    );
    f.close();
}

#[test]
fn workspace_failed_rename_preserves_source_and_returns_a_typed_reason() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([
            {"path":"src/a","state":{"kind":"symlink","symlinkTarget":"data","mode":511}},
            {"path":"occupied/a","state":{"kind":"directory","mode":493}}
        ]),
    )
    .unwrap();
    f.finish("main");
    let source = f.inspect("main", "src");
    let root = source["root"].clone();
    let missing = f.call("branch.rename", json!({"operationId":"missing-parent","branchId":"main","sourcePath":"src","path":"missing/target",
        "expectedSourceNode":source["node"],"expectedTargetNode":null})).unwrap_err();
    assert_eq!(
        crate::error::error_code(&missing),
        "namespace_parent_missing"
    );
    let target = f.inspect("main", "occupied");
    let occupied = f.call("branch.rename", json!({"operationId":"nonempty-target","branchId":"main","sourcePath":"src","path":"occupied",
        "expectedSourceNode":source["node"],"expectedTargetNode":target["node"],"replace":true})).unwrap_err();
    assert_eq!(crate::error::error_code(&occupied), "namespace_not_empty");
    assert_eq!(f.inspect("main", "src")["root"], root);
    assert_eq!(f.inspect("main", "src")["node"], source["node"]);
    assert!(f.directory.join("managed").exists() == false);
    f.close();
}

#[test]
fn workspace_private_ranges_keep_snapshots_stable_and_publish_only_one_changed_file() {
    let mut f = Fixture::new();
    let original = (0..1024 * 1024)
        .map(|i| (i % 251) as u8)
        .collect::<Vec<_>>();
    let content = f.blob("private-base", &original);
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([{"path":"large.bin","state":content["state"],"ownerId":content["ownerId"]}]),
    )
    .unwrap();
    f.finish("main");
    let grant = f.storage.load_grant("owner").unwrap();
    {
        let (file, observation) = f
            .storage
            .open_private_file(
                "main",
                "large.bin",
                &grant,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        assert_eq!(
            fs::read_dir(f.directory.join("staging")).unwrap().count(),
            0,
            "opening an immutable file does not copy its body"
        );
        file.write(Some(4000), b"hello").unwrap();
        let logs = fs::read_dir(f.directory.join("staging"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(fs::read(logs[0].path()).unwrap().len(), 5);
        let snapshot = file.snapshot().unwrap();
        // The same opened parent continues to overwrite and truncate while the
        // selected snapshot retains its original ranges and immutable body.
        file.write(Some(4001), b"new parent").unwrap();
        file.truncate(2).unwrap();
        file.truncate(20).unwrap();
        let mut current = vec![255; 20];
        assert_eq!(file.read(0, &mut current).unwrap(), 20);
        assert_eq!(&current[..2], &original[..2]);
        assert!(current[2..].iter().all(|byte| *byte == 0));
        let mut expected = original.clone();
        expected[4000..4005].copy_from_slice(b"hello");
        let mut observed = vec![0; expected.len()];
        snapshot
            .read(0, &mut observed, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(observed, expected);
        let staging = f.directory.join("staging");
        let sealed = std::thread::spawn(move || snapshot.seal(&staging, &AtomicBool::new(false)))
            .join()
            .unwrap()
            .unwrap();
        let retention = f.storage.retain_private_file(&sealed);
        let installed = sealed
            .install(&f.directory, retention, &AtomicBool::new(false))
            .unwrap();
        f.collect("collect-between-seal-and-publish");
        let committed = f
            .storage
            .publish_private_file(
                "private-publish",
                "main",
                "large.bin",
                &observation,
                420,
                &file,
                &installed,
                &grant,
            )
            .unwrap()
            .finish();
        assert_eq!(committed["status"], "committed");
        assert_eq!(
            f.storage
                .publish_private_file(
                    "private-publish",
                    "main",
                    "large.bin",
                    &observation,
                    420,
                    &file,
                    &installed,
                    &grant
                )
                .unwrap()
                .finish(),
            committed
        );
        f.call("branch.fork",json!({"operationId":"fork-private-checkpoint","workspaceId":"project","branchId":"child",
            "sourceBranchId":"main","draftBasePaths":[],"captureScopes":[]})).unwrap();
        let state = f.inspect("child", "large.bin");
        let read = f
            .call(
                "storage.getBlob",
                json!({"hash":state["state"]["objectHash"],"branchId":"child","path":"large.bin"}),
            )
            .unwrap();
        assert_eq!(
            BASE64
                .decode(read["bytesBase64"].as_str().unwrap())
                .unwrap(),
            expected
        );
        assert_eq!(
            fs::read(
                object_path(
                    &f.directory,
                    content["state"]["objectHash"].as_str().unwrap()
                )
                .unwrap()
            )
            .unwrap(),
            original
        );
        assert!(!f.directory.join("managed").exists());
    }
    assert!(fs::read_dir(f.directory.join("staging"))
        .unwrap()
        .next()
        .is_none());
    f.close();
}

#[test]
fn workspace_private_overwrites_truncation_and_append_match_bytes_across_live_versions() {
    let f = Fixture::new();
    let file = Arc::new(workspace_files::PrivateFile::new_for_test(
        f.directory.join("staging"),
    ));
    let mut expected = Vec::new();
    let mut retained = Vec::new();
    let mut seed = 7u64;
    for step in 0..240 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let offset = ((seed >> 32) % 160) as usize;
        let length = ((seed >> 24) % 24 + 1) as usize;
        if step % 7 == 0 {
            file.truncate(offset as u64).unwrap();
            expected.resize(offset, 0);
        } else {
            let bytes = vec![step as u8; length];
            file.write(Some(offset as u64), &bytes).unwrap();
            expected.resize(expected.len().max(offset + length), 0);
            expected[offset..offset + length].copy_from_slice(&bytes);
        }
        let mut actual = vec![0; expected.len()];
        file.read(0, &mut actual).unwrap();
        assert_eq!(actual, expected, "step {step}");
        if step % 30 == 0 {
            retained.push((file.snapshot().unwrap(), expected.clone()));
        }
    }
    let mut workers = Vec::new();
    for byte in 0..4u8 {
        let file = file.clone();
        workers.push(std::thread::spawn(move || {
            for _ in 0..50 {
                file.write(None, &[byte; 4]).unwrap();
            }
        }));
    }
    for worker in workers {
        worker.join().unwrap();
    }
    let mut actual = vec![0; expected.len() + 800];
    file.read(0, &mut actual).unwrap();
    assert_eq!(&actual[..expected.len()], &expected);
    for byte in 0..4u8 {
        assert_eq!(
            actual[expected.len()..]
                .iter()
                .filter(|value| **value == byte)
                .count(),
            200
        );
    }
    for (snapshot, expected) in retained {
        let mut actual = vec![0; expected.len()];
        snapshot
            .read(0, &mut actual, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(actual, expected);
    }
    drop(file);
    f.close();
}

#[test]
fn workspace_private_publication_rejects_stale_paths_and_revoked_original_owners() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.finish("main");
    let grant = f.storage.load_grant("owner").unwrap();
    let (file, observation) = f
        .storage
        .open_private_file("main", "a", &grant, Arc::new(AtomicBool::new(false)))
        .unwrap();
    file.write(Some(0), b"private").unwrap();
    let snapshot = file.snapshot().unwrap();
    let cancelled = AtomicBool::new(true);
    assert!(matches!(
        snapshot.seal(&f.directory.join("staging"), &cancelled),
        Err(KernelError::Cancelled)
    ));
    let sealed = snapshot
        .seal(&f.directory.join("staging"), &AtomicBool::new(false))
        .unwrap();
    let retention = f.storage.retain_private_file(&sealed);
    let installed = sealed
        .install(&f.directory, retention, &AtomicBool::new(false))
        .unwrap();
    let other = f.blob("other-write", b"other");
    f.apply(
        "other-write-publish",
        "a",
        &json!({"kind":"missing"}),
        &other,
    );
    assert_eq!(
        f.storage
            .publish_private_file(
                "stale-private",
                "main",
                "a",
                &observation,
                420,
                &file,
                &installed,
                &grant
            )
            .unwrap()
            .finish()["status"],
        "conflict"
    );
    f.storage
        .revoke_grant(&json!({"grantId":"owner"}), "host")
        .unwrap();
    assert!(f
        .storage
        .publish_private_file(
            "revoked-private",
            "main",
            "a",
            &observation,
            420,
            &file,
            &installed,
            &grant
        )
        .is_err());
    assert!(matches!(
        file.read(0, &mut [0; 4]),
        Err(KernelError::Cancelled)
    ));
    assert!(matches!(
        snapshot.read(0, &mut [0; 4], &AtomicBool::new(false)),
        Err(KernelError::Cancelled)
    ));
    drop(installed);
    drop(snapshot);
    drop(file);
    f.close();
}

#[test]
fn workspace_private_publication_compacts_only_its_current_generation() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.finish("main");
    let grant = f.storage.load_grant("owner").unwrap();
    let (file, observation) = f
        .storage
        .open_private_file("main", "a", &grant, Arc::new(AtomicBool::new(false)))
        .unwrap();
    file.write(Some(0), b"abc").unwrap();
    let old = file.snapshot().unwrap();
    let sealed = old
        .seal(&f.directory.join("staging"), &AtomicBool::new(false))
        .unwrap();
    let retention = f.storage.retain_private_file(&sealed);
    let installed = sealed
        .install(&f.directory, retention, &AtomicBool::new(false))
        .unwrap();
    let publication = f
        .storage
        .publish_private_file(
            "compact-private",
            "main",
            "a",
            &observation,
            420,
            &file,
            &installed,
            &grant,
        )
        .unwrap();
    let result = std::thread::spawn(move || publication.finish())
        .join()
        .unwrap();
    assert_eq!(result["status"], "committed");
    assert!(
        fs::read_dir(f.directory.join("staging"))
            .unwrap()
            .next()
            .is_some(),
        "old reader still retains its exact backing"
    );
    drop(old);
    assert!(
        fs::read_dir(f.directory.join("staging"))
            .unwrap()
            .next()
            .is_none(),
        "published idle file releases obsolete private ranges"
    );
    file.write(Some(1), b"Z").unwrap();
    assert_eq!(
        f.storage
            .publish_private_file(
                "compact-private",
                "main",
                "a",
                &observation,
                420,
                &file,
                &installed,
                &grant
            )
            .unwrap()
            .finish(),
        result
    );
    let mut bytes = [0; 3];
    file.read(0, &mut bytes).unwrap();
    assert_eq!(
        &bytes, b"aZc",
        "receipt replay must not roll a later write back"
    );
    drop(file);
    drop(installed);
    f.close();
}

#[test]
fn workspace_private_staging_recovers_only_its_files_and_keeps_failed_cleanup_visible() {
    let f = Fixture::new();
    let directory = f.directory;
    drop(f.storage);
    let orphan = directory
        .join("staging")
        .join(format!("{}.private", Uuid::new_v4()));
    let sealed = directory
        .join("staging")
        .join(format!("{}.sealed", Uuid::new_v4()));
    let failed = directory
        .join("staging")
        .join(format!("{}.private", Uuid::new_v4()));
    let unrelated = directory.join("staging/retained.private");
    fs::write(&orphan, b"unconfirmed ranges").unwrap();
    fs::write(&sealed, b"unpublished candidate").unwrap();
    fs::write(&unrelated, b"unrelated asset").unwrap();
    fs::create_dir(&failed).unwrap();
    let storage = Storage::open(&directory, "host").unwrap();
    assert!(!orphan.exists() && !sealed.exists());
    assert_eq!(fs::read(&unrelated).unwrap(), b"unrelated asset");
    let (pending, failures) = storage.cleanup_status().unwrap();
    assert_eq!(pending, 1);
    assert_eq!(failures.len(), 1);
    assert!(
        failed.is_dir(),
        "cleanup must never turn a failed file unlink into recursive deletion"
    );
    fs::remove_dir(&failed).unwrap();
    storage.private_cleanup.retry();
    assert_eq!(storage.cleanup_status().unwrap().0, 0);
    drop(storage);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn workspace_directory_pages_keep_their_selected_namespace_and_recheck_authority() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.append(
        "main",
        0,
        json!([
            {"path":"one/A","state":{"kind":"symlink","symlinkTarget":"a","mode":511}},
            {"path":"one/B","state":{"kind":"symlink","symlinkTarget":"b","mode":511}},
            {"path":"two","state":{"kind":"symlink","symlinkTarget":"c","mode":511}}
        ]),
    )
    .unwrap();
    f.finish("main");
    let grant = f.storage.load_grant("owner").unwrap();
    let pin = f
        .call(
            "branch.pin",
            json!({"operationId":"directory-pin","branchId":"main","revision":0}),
        )
        .unwrap();
    let page = f
        .storage
        .read_branch_directory("main", "", None, None, 1, &grant)
        .unwrap();
    assert_eq!(page.entries[0].name, "one");
    assert!(page.entries[0].state.is_directory());
    let child = f.inspect("main", "one");
    assert_eq!(page.entries[0].node, child["node"].as_str().unwrap());
    assert_eq!(page.node, f.inspect("main", "")["node"].as_str().unwrap());
    f.call("branch.path.apply",json!({"operationId":"directory-new-child","branchId":"main","changes":[{
        "path":"alpha","expectedState":{"kind":"missing"},"state":{"kind":"directory","mode":493}
    }]})).unwrap();
    let changed = f
        .storage
        .read_branch_directory("main", "", None, page.next.as_deref(), 1, &grant)
        .err()
        .unwrap();
    assert_eq!(crate::error::error_code(&changed), "namespace_stale_cursor");
    let next = f
        .storage
        .read_branch_directory(
            "main",
            "",
            pin["pinId"].as_str(),
            page.next.as_deref(),
            1,
            &grant,
        )
        .unwrap();
    assert_eq!(next.entries[0].name, "two");
    assert!(next.next.is_none());
    f.storage.issue_grant(&json!({"grantId":"directory-reader","hostGeneration":"generation","owningWorkspace":"project",
        "executionWorkspace":"project","capabilities":["storage.read"],"pathScopes":["one/A"]}),
        "host","generation",&f.directory.to_string_lossy(),"epoch").unwrap();
    let reader = f.storage.load_grant("directory-reader").unwrap();
    let selected = f
        .storage
        .read_branch_directory("main", "", None, None, 10, &reader)
        .unwrap();
    assert_eq!(
        selected
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec!["one"]
    );
    let selected = f
        .storage
        .read_branch_directory("main", "one", None, None, 10, &reader)
        .unwrap();
    assert_eq!(
        selected
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec!["A"]
    );
    f.storage
        .revoke_grant(&json!({"grantId":"directory-reader"}), "host")
        .unwrap();
    assert!(f
        .storage
        .read_branch_directory("main", "one", None, None, 10, &reader)
        .is_err());
    f.call(
        "branch.delete",
        json!({"operationId":"delete-directory-parent","branchId":"main"}),
    )
    .unwrap();
    f.collect("directory-reader-gc");
    let retained = f
        .storage
        .read_branch_directory("main", "one", pin["pinId"].as_str(), None, 10, &grant)
        .unwrap();
    assert_eq!(retained.entries.len(), 2);
    f.close();
}

#[test]
fn workspace_private_sparse_ranges_seal_with_their_exact_logical_bytes() {
    let mut f = Fixture::new();
    f.begin("main", None);
    f.finish("main");
    let grant = f.storage.load_grant("owner").unwrap();
    let (file, observation) = f
        .storage
        .open_private_file(
            "main",
            "sparse.bin",
            &grant,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
    let offset = 1024 * 1024 + 37;
    file.write(Some(offset), b"tail").unwrap();
    file.truncate(offset + 100).unwrap();
    let snapshot = file.snapshot().unwrap();
    let sealed = snapshot
        .seal(&f.directory.join("staging"), &AtomicBool::new(false))
        .unwrap();
    let retention = f.storage.retain_private_file(&sealed);
    let installed = sealed
        .install(&f.directory, retention, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        f.storage
            .publish_private_file(
                "sparse-publish",
                "main",
                "sparse.bin",
                &observation,
                420,
                &file,
                &installed,
                &grant
            )
            .unwrap()
            .finish()["status"],
        "committed"
    );
    let state = f.inspect("main", "sparse.bin");
    let bytes = fs::read(
        object_path(&f.directory, state["state"]["objectHash"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let mut expected = vec![0; offset as usize + 100];
    expected[offset as usize..offset as usize + 4].copy_from_slice(b"tail");
    assert_eq!(bytes, expected);
    drop(snapshot);
    drop(file);
    drop(installed);
    f.close();
}
