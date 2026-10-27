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
        let (grant, params) = self.storage.authorize(
            Some("owner"),
            "epoch",
            "host",
            "generation",
            method,
            &params,
        )?;
        self.storage
            .dispatch(method, &params, Some("owner"), &grant)
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
