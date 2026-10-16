//! Actual Storage capture/lease/CAS against temporary filesystem trees.
use super::*;

struct Fixture {
    storage: Storage,
    directory: PathBuf,
    workspace: PathBuf,
    root_id: String,
    grant: Grant,
}
impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("non-directory-review-{}", Uuid::new_v4()));
        let workspace = directory.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let storage_root = directory.join("storage");
        let mut storage = Storage::open(&storage_root, "host").unwrap();
        storage
            .issue_grant(
                &json!({"grantId":"review","hostGeneration":"generation",
            "owningWorkspace":"workspace","executionWorkspace":"workspace",
            "capabilities":["storage.admin"],"pathScopes":["node"]}),
                "host",
                "generation",
                &storage_root.to_string_lossy(),
                "epoch",
            )
            .unwrap();
        let grant = storage.load_grant("review").unwrap();
        let root = storage
            .file_root_register(
                &json!({"workspaceId":"workspace",
            "executionWorkspaceId":"workspace","canonicalRoot":workspace}),
                &grant,
            )
            .unwrap();
        Self {
            storage,
            directory,
            workspace,
            root_id: root["rootId"].as_str().unwrap().into(),
            grant,
        }
    }
    fn lease(&mut self, id: &str, path: &str, scope: &str) -> Result<Value, KernelError> {
        self.storage.file_lease_acquire(
            &json!({"workspaceId":"workspace","rootId":self.root_id,
            "leaseId":id,"resources":[{"path":path,"scope":scope}]}),
            &self.grant,
        )
    }
    fn capture_task(
        &mut self,
        path: &str,
        store: bool,
    ) -> Result<super::super::capture_resources::CaptureTask, KernelError> {
        self.storage.prepare_capture(
            "file.capture",
            &json!({"workspaceId":"workspace",
            "rootId":self.root_id,"path":path,"operationId":Uuid::new_v4().to_string(),
            "store":store,"leaseId":"tree"}),
            &self.grant,
            Arc::new(AtomicBool::new(false)),
        )
    }
    fn capture(&mut self, path: &str, store: bool) -> Result<Value, KernelError> {
        let mut task = self.capture_task(path, store)?;
        let captured = (|| {
            let batch = if store {
                let hashed = task.hash_sources()?;
                self.storage
                    .retain_capture_objects(&mut task, &hashed, &self.grant)?;
                task.finish_sources(hashed)?
            } else {
                task.run()?
            };
            let receipt = self.storage.publish_capture(&task, batch, &self.grant)?;
            Ok(serde_json::from_str(receipt["stateJson"].as_str().unwrap()).unwrap())
        })();
        // This fixture executes the actual reader synchronously. Match the
        // runtime's worker-drained tail before issuing another capture.
        self.storage.finish_retained_file_lease(task.lease_id());
        captured
    }
    fn apply(
        &mut self,
        path: &str,
        expected: &Value,
        target: &Value,
    ) -> Result<Value, KernelError> {
        self.storage.file_apply(
            &json!({"workspaceId":"workspace","rootId":self.root_id,
            "path":path,"operationId":Uuid::new_v4().to_string(),"leaseId":"tree",
            "expectedJson":expected.to_string(),"targetJson":target.to_string()}),
            &self.grant,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn missing_descendants_do_not_authorize_replacing_a_file_ancestor() {
    let mut f = Fixture::new();
    fs::write(f.workspace.join("node"), b"original parent").unwrap();
    for (index, path) in ["node/child", "node/nested/child"].iter().enumerate() {
        let id = format!("descendant-{index}");
        assert_eq!(
            f.lease(&id, path, "exact")
                .expect("lease nonexistent descendant")["status"],
            "acquired"
        );
        f.storage
            .file_lease_release(
                &json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":id}),
                &f.grant,
            )
            .unwrap();
    }
    f.lease("tree", "node", "subtree").unwrap();
    let missing = json!({"kind":"missing"});
    let directory = json!({"kind":"directory"});
    for path in ["node/child", "node/nested/child"] {
        assert_eq!(f.capture(path, true).unwrap(), missing);
        assert_eq!(f.capture(path, false).unwrap(), missing);
        assert!(f.apply(path, &missing, &directory).is_err());
        assert_eq!(
            fs::read(f.workspace.join("node")).unwrap(),
            b"original parent"
        );
    }
    let original = f.capture("node", true).unwrap();
    // A parent changed after preview is a CAS conflict, not permission to replace it.
    fs::write(f.workspace.join("node"), b"later user parent").unwrap();
    assert_eq!(
        f.apply("node", &original, &directory).unwrap()["status"],
        "conflict"
    );
    assert_eq!(
        fs::read(f.workspace.join("node")).unwrap(),
        b"later user parent"
    );
    let later = f.capture("node", true).unwrap();
    assert_eq!(
        f.apply("node", &later, &directory).unwrap()["status"],
        "applied"
    );
    assert_eq!(
        f.apply("node/child", &missing, &directory).unwrap()["status"],
        "applied"
    );
    // Reverse directory-to-file must still remove the known descendant first.
    assert!(f.apply("node", &directory, &original).is_err());
    assert!(f.workspace.join("node/child").is_dir());
    assert_eq!(
        f.apply("node/child", &directory, &missing).unwrap()["status"],
        "applied"
    );
    assert_eq!(
        f.apply("node", &directory, &original).unwrap()["status"],
        "applied"
    );
    assert_eq!(
        fs::read(f.workspace.join("node")).unwrap(),
        b"original parent"
    );
}

#[cfg(unix)]
#[test]
fn a_file_ancestor_replaced_by_an_outside_symlink_cannot_publish_missing() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new();
    fs::write(f.workspace.join("node"), b"original parent").unwrap();
    f.lease("tree", "node", "subtree").unwrap();
    let mut task = f.capture_task("node/nested/child", true).unwrap();
    let hashed = task.hash_sources().unwrap();
    f.storage
        .retain_capture_objects(&mut task, &hashed, &f.grant)
        .unwrap();
    let outside = f.directory.join("outside");
    fs::create_dir_all(outside.join("nested")).unwrap();
    fs::write(outside.join("nested/child"), b"outside private data").unwrap();
    fs::remove_file(f.workspace.join("node")).unwrap();
    symlink(&outside, f.workspace.join("node")).unwrap();
    let completed = task.finish_sources(hashed);
    f.storage.finish_retained_file_lease(task.lease_id());
    assert!(matches!(completed, Err(KernelError::Authorization(_))));
    assert!(matches!(
        f.lease("escaped", "node/nested/child", "exact"),
        Err(KernelError::Authorization(_))
    ));
    assert!(matches!(
        f.capture("node/nested/child", false),
        Err(KernelError::Authorization(_))
    ));
    assert!(matches!(
        f.apply(
            "node/nested/child",
            &json!({"kind":"missing"}),
            &json!({"kind":"directory"})
        ),
        Err(KernelError::Authorization(_))
    ));
    assert_eq!(
        fs::read(outside.join("nested/child")).unwrap(),
        b"outside private data"
    );
}

#[cfg(unix)]
#[test]
fn missing_descendant_keeps_lexical_and_canonical_grant_scope_checks() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new();
    fs::write(f.workspace.join("other"), b"out of scope parent").unwrap();
    symlink("other", f.workspace.join("node")).unwrap();
    for path in [
        "other/child",
        "node/child",
        "node/nested/child",
        "node/../other/child",
    ] {
        assert!(
            matches!(
                f.lease("scope", path, "exact"),
                Err(KernelError::Authorization(_))
            ),
            "{path}"
        );
    }
    assert_eq!(
        fs::read(f.workspace.join("other")).unwrap(),
        b"out of scope parent"
    );
}
