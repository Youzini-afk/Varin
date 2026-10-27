//! Real Kernel request admission, file workers and completion, without transport sockets.
use super::*;
use std::time::Duration;

const HOST: &str = "inventory-host";
const GENERATION: &str = "inventory-generation";
const EPOCH: &str = "inventory-epoch";
const WAIT: Duration = Duration::from_secs(10);

#[path = "runtime_workspace_tests.rs"]
mod workspace_tests;

struct TempRoot(PathBuf);
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Fixture {
    kernel: Kernel,
    tx: mpsc::Sender<WorkerRequest>,
    rx: mpsc::Receiver<WorkerRequest>,
    revoked: Arc<Mutex<HashSet<String>>>,
    root_id: String,
    directory: TempRoot,
}
struct Hold {
    entered: mpsc::Receiver<()>,
    resume: Option<mpsc::Sender<()>>,
}
impl Hold {
    fn entered(&self) {
        self.entered
            .recv_timeout(WAIT)
            .expect("worker did not enter the actual directory read");
    }
    fn release(&mut self) {
        if let Some(resume) = self.resume.take() {
            let _ = resume.send(());
        }
    }
}
impl Drop for Hold {
    fn drop(&mut self) {
        self.release();
    }
}
impl Fixture {
    fn new() -> Self {
        let directory =
            TempRoot(std::env::temp_dir().join(format!("file-inventory-{}", Uuid::new_v4())));
        fs::create_dir_all(directory.0.join("work")).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut fixture = Self {
            kernel: Kernel::new(EPOCH.into()),
            tx,
            rx,
            revoked: Arc::new(Mutex::new(HashSet::new())),
            root_id: String::new(),
            directory,
        };
        fixture.short(
            "kernel.handshake",
            json!({"protocolVersion":PROTOCOL_VERSION,
            "buildVersion":KERNEL_BUILD_IDENTITY,"hostId":HOST,"hostGeneration":GENERATION,
            "storageRoot":fixture.directory.0.join("store"),"capabilities":[]}),
            None,
        );
        fixture.grant("writer", &["storage.admin"], &[""]);
        fixture.grant("reader", &["storage.read"], &[""]);
        let registered = fixture.short(
            "file.root.register",
            json!({"workspaceId":"workspace",
            "executionWorkspaceId":"workspace","canonicalRoot":fixture.work()}),
            Some("writer"),
        );
        fixture.root_id = registered["rootId"].as_str().unwrap().into();
        fixture
    }
    fn work(&self) -> PathBuf {
        self.directory.0.join("work")
    }
    fn grant(&mut self, id: &str, capabilities: &[&str], scopes: &[&str]) {
        self.short(
            "authority.grant.issue",
            json!({"grantId":id,"hostGeneration":GENERATION,
            "capabilities":capabilities,"pathScopes":scopes,"storageIdentity":fs::canonicalize(self.directory.0.join("store")).unwrap(),"owningWorkspace":"workspace",
            "executionWorkspace":"workspace"}),
            None,
        );
    }
    fn request(method: &str, params: Value, grant: Option<&str>) -> Value {
        let mut request = json!({"v":PROTOCOL_VERSION,"kind":"request","id":Uuid::new_v4().to_string(),
            "method":method,"params":params,"epoch":EPOCH});
        if let Some(grant) = grant {
            request["grantId"] = json!(grant);
        }
        request
    }
    fn short(&mut self, method: &str, params: Value, grant: Option<&str>) -> Value {
        let response = self
            .kernel
            .handle(
                &Self::request(method, params, grant),
                Arc::new(AtomicBool::new(false)),
                &self.tx,
            )
            .unwrap()
            .expect("short request became pending");
        assert_eq!(response["ok"], true, "{response}");
        response["result"].clone()
    }
    fn blob(&mut self, params: Value, grant: &str) -> Result<Value, KernelError> {
        self.begin("storage.getBlob", params, grant);
        self.finish_read()
    }
    fn finish_read(&mut self) -> Result<Value, KernelError> {
        match self
            .rx
            .recv_timeout(WAIT)
            .expect("blob reader did not drain")
        {
            WorkerRequest::BlobReadDone {
                reply: BlobReadReply::Wire(request),
                task,
                result,
            } => self
                .kernel
                .complete_blob_read(&request, &task, result, &self.revoked),
            _ => panic!("unexpected worker completion"),
        }
    }
    fn params(&self, path: &str) -> Value {
        json!({"workspaceId":"workspace","rootId":self.root_id,"path":path})
    }
    fn begin(&mut self, method: &str, params: Value, grant: &str) -> (Value, Arc<AtomicBool>) {
        let request = Self::request(method, params, Some(grant));
        let cancel = Arc::new(AtomicBool::new(false));
        assert!(self
            .kernel
            .handle(&request, cancel.clone(), &self.tx)
            .unwrap()
            .is_none());
        assert!(
            pending_file_worker(method),
            "production loop would discard the active cancellation identity"
        );
        (request, cancel)
    }
    fn receive(
        &self,
    ) -> (
        Value,
        crate::storage::file_inventory::InventoryTask,
        Result<crate::storage::file_inventory::InventoryResult, KernelError>,
    ) {
        match self
            .rx
            .recv_timeout(WAIT)
            .expect("inventory worker did not drain")
        {
            WorkerRequest::InventoryDone {
                request,
                task,
                result,
            } => (request, task, result),
            _ => panic!("unexpected worker completion"),
        }
    }
    fn finish(&mut self) -> Result<Value, KernelError> {
        let (request, task, result) = self.receive();
        self.kernel
            .complete_file_inventory(&request, &task, result, &self.revoked)
    }
    fn inventory(
        &mut self,
        method: &str,
        params: Value,
        grant: &str,
    ) -> Result<Value, KernelError> {
        self.begin(method, params, grant);
        self.finish()
    }
    fn hold(&mut self) -> Hold {
        let (entered, receiver) = mpsc::channel();
        let (resume, released) = mpsc::channel();
        self.kernel.inventory_traversal_hold = Some(Box::new(move || {
            entered.send(()).unwrap();
            // Dropping the test's guard also releases the actual worker after a failed assertion.
            let _ = released.recv_timeout(WAIT);
        }));
        Hold {
            entered: receiver,
            resume: Some(resume),
        }
    }
}

#[test]
fn file_reader_keeps_all_filesystem_access_on_worker_and_rechecks_original_grant() {
    use crate::storage::blob_reads::BlobReadPhase;
    let mut f = Fixture::new();
    fs::write(f.work().join("file"), b"worker bytes").unwrap();
    let moved = f.directory.0.join("temporarily-away");
    fs::rename(f.work(), &moved).unwrap();
    let (entered, admission) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    f.kernel.blob_read_hold = Some((BlobReadPhase::Verify, Box::new(move || {
        entered.send(()).unwrap();
        resumed.recv_timeout(WAIT).unwrap();
    })));
    // A missing root would fail a synchronous canonicalize/open. Admission is
    // strictly against Storage records while the worker owns filesystem work.
    f.begin("file.read", f.params("file"), "reader");
    admission.recv_timeout(WAIT).unwrap();
    f.short("storage.health", json!({}), Some("reader"));
    fs::rename(&moved, f.work()).unwrap();
    resume.send(()).unwrap();
    assert_eq!(f.finish_read().unwrap()["content"]["text"], "worker bytes");
    f.short("file.lease.acquire", json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"busy-file",
        "resources":[{"path":"file","scope":"exact"}]}), Some("writer"));
    let storage = f.kernel.storage.as_mut().unwrap();
    let (reader, _) = storage.authorize(Some("reader"), EPOCH, HOST, GENERATION, "file.read",
        &json!({"workspaceId":"workspace","rootId":f.root_id,"path":"file"})).unwrap();
    let key = storage.prepare_file_read(&json!({"rootId":f.root_id,"path":"file"}), &reader,
        Arc::new(AtomicBool::new(false))).unwrap().identity_only();
    let prepared = key.run().unwrap();
    assert!(storage.finish_file_read(&key, Ok(prepared), &reader).unwrap()["resourceKey"].is_string(),
        "canonical scheduling identity remains available while another operation holds the file lease");
    f.short("file.lease.release", json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"busy-file"}), Some("writer"));
    f.begin("file.read", f.params("file"), "reader");
    let completion = f.rx.recv_timeout(WAIT).unwrap();
    f.short("authority.grant.revoke", json!({"grantId":"reader"}), None);
    let WorkerRequest::BlobReadDone { reply:BlobReadReply::Wire(request), task, result } = completion else { panic!("wrong read continuation"); };
    assert!(result.is_ok(), "the read itself completed before revocation");
    assert!(f.kernel.complete_blob_read(&request, &task, result, &f.revoked).is_err());
}

#[test]
fn file_reader_worker_preserves_missing_directory_binary_and_unicode_ranges() {
    let mut f = Fixture::new();
    fs::create_dir(f.work().join("dir")).unwrap();
    fs::write(f.work().join("binary"), b"ab\0defghij").unwrap();
    fs::write(f.work().join("unicode"), "a中文🙂z").unwrap();
    for (path, offset, length, expected) in [
        ("missing", 0, 0, json!(true)),
        ("dir", 0, 0, json!("directory")),
        ("binary", 2, 4, json!("AGRlZg==")),
        ("unicode", 2, 3, json!("中文")),
    ] {
        f.begin("file.read", json!({"workspaceId":"workspace","rootId":f.root_id,"path":path,"offset":offset,"length":length}), "reader");
        let value = f.finish_read().unwrap();
        match path {
            "missing" => { assert_eq!(value["missing"], expected); assert!(value["readVersion"].is_string()); }
            "dir" => assert_eq!(value["state"]["kind"], expected),
            "binary" => { assert_eq!(value["content"]["bytesBase64"], expected); assert_eq!(value["content"]["offset"], 2); assert_eq!(value["content"]["nextOffset"], 6); }
            _ => assert_eq!(value["content"]["text"], expected),
        }
    }
    f.begin("file.read.check", f.params("unicode"), "reader");
    let identity = f.finish_read().unwrap();
    assert!(identity["resourceKey"].is_string());
    assert!(identity.get("content").is_none());
    f.begin("file.read.check", f.params("dir"), "reader");
    assert!(f.finish_read().is_err(), "retrieval admission still requires an actual regular file");
}
fn active(request: &Value, token: Arc<AtomicBool>) -> ActiveRequest {
    ActiveRequest {
        token,
        epoch: Some(EPOCH.into()),
        grant_id: request["grantId"].as_str().map(str::to_owned),
        runtime_cancel: None,
        input_order: None,
        wire_lane: Some(WireLane::Control),
        pending_body: false,
        body_cancel_receipt: false,
    }
}

#[test]
fn file_inventory_traversals_leave_storage_and_cancellation_available_until_worker_drain() {
    for method in ["file.scan", "file.measure"] {
        let mut f = Fixture::new();
        fs::write(f.work().join("one.txt"), b"one").unwrap();
        let mut hold = f.hold();
        let (request, token) = f.begin(method, f.params(""), "reader");
        hold.entered();
        assert_eq!(
            f.short("storage.health", json!({"deep":false}), Some("writer"))["integrity"],
            "not_checked"
        );
        // Another original metadata call is independently runnable while the first is held.
        let independent = f
            .inventory("file.measure", f.params("one.txt"), "reader")
            .unwrap();
        assert_eq!(independent["logicalBytes"], 3);
        active(&request, token.clone()).cancel();
        assert!(token.load(Ordering::Acquire));
        assert!(matches!(f.rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(f
            .kernel
            .file_workers
            .iter()
            .any(|(_, worker)| !worker.is_finished()));
        hold.release();
        assert!(matches!(f.finish(), Err(KernelError::Cancelled)));
        for (_, worker) in f.kernel.file_workers.drain(..) {
            worker.join().unwrap();
        }
        assert_eq!(
            f.short("storage.health", json!({}), Some("writer"))["operations"],
            0
        );
    }
}

#[test]
fn file_inventory_revocation_and_retirement_reject_late_results() {
    for method in ["authority.grant.revoke", "authority.grant.retire"] {
        let mut f = Fixture::new();
        fs::write(f.work().join("one.txt"), b"one").unwrap();
        let mut hold = f.hold();
        let (request, token) = f.begin("file.scan", f.params(""), "reader");
        hold.entered();
        let requests = Arc::new(Mutex::new(HashMap::from([(
            request["id"].as_str().unwrap().to_owned(),
            active(&request, token.clone()),
        )])));
        let params = if method.ends_with("retire") {
            json!({"target":{"kind":"grant","grantId":"reader"}})
        } else {
            json!({"grantId":"reader"})
        };
        let revoked = f.short(method, params, None);
        assert!(!revoked.is_null());
        mark_grant_revoked(&f.revoked, &requests, "reader");
        assert!(token.load(Ordering::Acquire));
        assert_eq!(
            f.short("storage.health", json!({}), Some("writer"))["integrity"],
            "not_checked"
        );
        hold.release();
        assert!(matches!(f.finish(), Err(KernelError::Authorization(_))));
    }
    // Authority must also be rechecked when the filesystem read finished before revocation.
    let mut f = Fixture::new();
    f.begin("file.scan", f.params(""), "reader");
    let (request, task, result) = f.receive();
    assert!(result.is_ok());
    f.short("authority.grant.revoke", json!({"grantId":"reader"}), None);
    assert!(matches!(
        f.kernel
            .complete_file_inventory(&request, &task, result, &f.revoked),
        Err(KernelError::Authorization(_))
    ));
}

#[test]
fn file_inventory_shutdown_retains_storage_until_real_worker_stops() {
    let mut f = Fixture::new();
    fs::write(f.work().join("one.txt"), b"one").unwrap();
    let mut hold = f.hold();
    let (_, token) = f.begin("file.measure", f.params(""), "reader");
    hold.entered();
    let request = Fixture::request("kernel.shutdown", json!({}), None);
    assert!(f.kernel.handle(&request,Arc::new(AtomicBool::new(false)),&f.tx).unwrap().is_none());
    assert!(token.load(Ordering::Acquire));
    let store = f.directory.0.join("store");
    assert!(
        crate::storage::Storage::open(&store, HOST).is_err(),
        "Storage released before its reader stopped"
    );
    assert!(!f.kernel.drained(), "shutdown must remain pending while the real reader is blocked");
    hold.release();
    assert!(matches!(f.finish(),Err(KernelError::Cancelled)));
    assert_eq!(f.workspace_finish().unwrap()["stopping"],true);
    assert!(f.kernel.drained());
    let kernel = std::mem::replace(&mut f.kernel, Kernel::new("closed".into()));
    drop(kernel);
    assert!(crate::storage::Storage::open(&store, HOST).is_ok());
}

#[test]
fn file_inventory_pages_preserve_path_fingerprint_and_changed_membership() {
    let mut f = Fixture::new();
    fs::create_dir_all(f.work().join("nested")).unwrap();
    let quoted = if cfg!(windows) { "nested/quote'.txt" } else { "nested/quote\".txt" };
    for (path, body) in [
        ("a.txt", "a"),
        (quoted, "quoted"),
        ("z.txt", "z"),
    ] {
        fs::write(f.work().join(path), body).unwrap();
    }
    let mut params = f.params("");
    params["pageSize"] = json!(2);
    let first = f.inventory("file.scan", params.clone(), "reader").unwrap();
    assert_eq!(first["paths"], json!(["a.txt", "nested"]));
    assert_eq!(first["total"], 4);
    params["cursor"] = first["nextCursor"].clone();
    params["expectedFingerprint"] = first["fingerprint"].clone();
    // Fingerprints are path inventory, not content versions.
    fs::write(f.work().join("a.txt"), b"different contents").unwrap();
    let second = f.inventory("file.scan", params.clone(), "reader").unwrap();
    assert_eq!(second["paths"], json!([quoted, "z.txt"]));
    assert!(second["nextCursor"].is_null());
    let mut all = first["paths"].as_array().unwrap().clone();
    all.extend(second["paths"].as_array().unwrap().iter().cloned());
    assert_eq!(
        first["fingerprint"],
        hash_json(&json!(all)).unwrap(),
        "wire fingerprint changed"
    );
    fs::write(f.work().join("added"), b"new member").unwrap();
    assert!(
        matches!(f.inventory("file.scan", params.clone(), "reader"), Err(KernelError::Operation(message)) if message.contains("inventory changed"))
    );
    params
        .as_object_mut()
        .unwrap()
        .remove("expectedFingerprint");
    assert!(
        matches!(f.inventory("file.scan", params, "reader"), Err(KernelError::Operation(message)) if message.contains("fingerprint is missing"))
    );
}

#[test]
fn file_inventory_scopes_hidden_paths_missing_and_measure_facts() {
    let mut f = Fixture::new();
    for directory in ["allowed/nested", "other", ".git", ".varin"] {
        fs::create_dir_all(f.work().join(directory)).unwrap();
    }
    for (path, body) in [
        ("allowed/a", "abc"),
        ("allowed/nested/b", "xy"),
        ("other/secret", "secret"),
        (".git/config", "git"),
        (".varin/state", "state"),
    ] {
        fs::write(f.work().join(path), body).unwrap();
    }
    let all = f.inventory("file.scan", f.params(""), "reader").unwrap();
    assert_eq!(
        all["paths"],
        json!([
            "allowed",
            "allowed/a",
            "allowed/nested",
            "allowed/nested/b",
            "other",
            "other/secret"
        ])
    );
    // Workspace resource operations must retain every actual descendant, including
    // metadata names, without weakening the original grant or changing normal scans.
    let mut complete = f.params("");
    complete["includeInternalEntries"] = json!(true);
    assert_eq!(
        f.inventory("file.scan", complete, "reader").unwrap()["paths"],
        json!([".git", ".git/config", ".varin", ".varin/state", "allowed", "allowed/a", "allowed/nested", "allowed/nested/b", "other", "other/secret"])
    );
    // Explicit scopes preserve the old ability to inventory a named metadata directory.
    let mut explicit = f.params("");
    explicit["scopes"] = json!([".git"]);
    assert_eq!(
        f.inventory("file.scan", explicit, "reader").unwrap()["paths"],
        json!([".git", ".git/config"])
    );
    let mut scoped = f.params("");
    scoped["scopes"] = json!(["allowed", "allowed/a", "missing"]);
    assert_eq!(
        f.inventory("file.scan", scoped, "reader").unwrap()["paths"],
        json!(["allowed", "allowed/a", "allowed/nested", "allowed/nested/b"])
    );
    f.grant("scoped", &["storage.read"], &["allowed"]);
    let inside = f
        .inventory("file.scan", f.params("allowed"), "scoped")
        .unwrap();
    assert_eq!(inside["paths"], json!(["a", "nested", "nested/b"]));
    let forbidden = Fixture::request("file.scan", f.params(""), Some("scoped"));
    assert!(matches!(
        f.kernel
            .handle(&forbidden, Arc::new(AtomicBool::new(false)), &f.tx),
        Err(KernelError::Authorization(_))
    ));
    assert!(f
        .inventory("file.scan", f.params("missing"), "reader")
        .is_err());
    let missing = f
        .inventory("file.measure", f.params("missing"), "reader")
        .unwrap();
    assert_eq!(
        missing,
        json!({"logicalBytes":null,"allocatedBytes":null,"unknown":true,"missing":true})
    );
    let measured = f
        .inventory("file.measure", f.params("allowed"), "scoped")
        .unwrap();
    assert_eq!(measured["logicalBytes"], 5);
    assert_eq!(measured["missing"], false);
    assert_eq!(measured["unknown"], false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let actual = ["allowed/a", "allowed/nested/b"]
            .iter()
            .map(|p| fs::symlink_metadata(f.work().join(p)).unwrap().blocks() * 512)
            .sum::<u64>();
        assert_eq!(measured["allocatedBytes"], actual);
    }
    #[cfg(not(unix))]
    assert!(measured["allocatedBytes"].is_null());
}

#[cfg(unix)]
#[test]
fn file_inventory_symlinks_root_replacement_and_non_utf8_remain_explicit() {
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let mut f = Fixture::new();
    let outside = f.directory.0.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret"), b"secret").unwrap();
    symlink(&outside, f.work().join("escape")).unwrap();
    let scanned = f.inventory("file.scan", f.params(""), "reader").unwrap();
    assert_eq!(scanned["paths"], json!(["escape"]));
    let measured = f
        .inventory("file.measure", f.params("escape"), "reader")
        .unwrap();
    assert_eq!(
        measured["logicalBytes"],
        fs::symlink_metadata(f.work().join("escape")).unwrap().len()
    );
    assert!(matches!(
        f.inventory("file.scan", f.params("escape/secret"), "reader"),
        Err(KernelError::Authorization(_))
    ));
    let bad = f
        .work()
        .join(std::ffi::OsString::from_vec(vec![b'x', 0xff]));
    fs::write(&bad, b"invalid name").unwrap();
    assert!(
        matches!(f.inventory("file.scan", f.params(""), "reader"), Err(KernelError::Operation(message)) if message.contains("non-UTF-8"))
    );
    fs::remove_file(bad).unwrap();
    let mut hold = f.hold();
    f.begin("file.scan", f.params(""), "reader");
    hold.entered();
    fs::rename(f.work(), f.directory.0.join("original-work")).unwrap();
    symlink(&outside, f.work()).unwrap();
    hold.release();
    assert!(matches!(f.finish(), Err(KernelError::Authorization(_))));
}

#[test]
fn file_inventory_optional_source_lease_is_retained_through_release_revoke_and_retire() {
    for action in ["release", "revoke", "retire"] {
        let mut f = Fixture::new();
        f.grant("source", &["storage.read", "storage.write"], &[""]);
        fs::write(f.work().join("input"), b"source").unwrap();
        let mut lease = f.params("");
        lease.as_object_mut().unwrap().remove("path");
        lease["leaseId"] = json!("original-source-lease");
        lease["resources"] = json!([{"path":"","scope":"subtree"}]);
        assert_eq!(
            f.short("file.lease.acquire", lease.clone(), Some("source"))["status"],
            "acquired"
        );
        let mut scan = f.params("");
        scan["leaseId"] = lease["leaseId"].clone();
        let mut hold = f.hold();
        let (request, token) = f.begin("file.scan", scan.clone(), "source");
        hold.entered();
        let duplicate = Fixture::request("file.scan", scan, Some("source"));
        assert!(
            matches!(f.kernel.handle(&duplicate, Arc::new(AtomicBool::new(false)), &f.tx),
            Err(KernelError::Operation(message)) if message.contains("retained by an active file worker"))
        );
        // Metadata callers that did not bind a lease keep the original read-only contract.
        assert_eq!(
            f.inventory("file.scan", f.params(""), "reader").unwrap()["paths"],
            json!(["input"])
        );
        if action == "release" {
            let released = f.short("file.lease.release", json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"original-source-lease"}), Some("source"));
            assert_eq!(released["deferred"], true);
            active(&request, token.clone()).cancel();
        } else {
            f.short(
                &format!("authority.grant.{action}"),
                if action == "retire" {
                    json!({"target":{"kind":"grant","grantId":"source"}})
                } else {
                    json!({"grantId":"source"})
                },
                None,
            );
            let requests = Arc::new(Mutex::new(HashMap::from([(
                request["id"].as_str().unwrap().to_owned(),
                active(&request, token.clone()),
            )])));
            mark_grant_revoked(&f.revoked, &requests, "source");
        }
        lease["leaseId"] = json!("reconciliation-probe");
        assert_eq!(
            f.short("file.lease.acquire", lease.clone(), Some("writer"))["status"],
            "busy"
        );
        assert!(token.load(Ordering::Acquire));
        hold.release();
        let result = f.finish();
        if action == "release" {
            assert!(matches!(result, Err(KernelError::Cancelled)));
        } else {
            assert!(matches!(result, Err(KernelError::Authorization(_))));
        }
        assert_eq!(
            f.short("file.lease.acquire", lease, Some("writer"))["status"],
            "acquired"
        );
    }
}

#[test]
fn file_inventory_supplied_lease_uses_original_owner_and_scope_coverage() {
    let mut f = Fixture::new();
    f.grant("source", &["storage.read", "storage.write"], &[""]);
    fs::create_dir_all(f.work().join("allowed")).unwrap();
    fs::create_dir_all(f.work().join("other")).unwrap();
    fs::write(f.work().join("allowed/input"), b"allowed").unwrap();
    fs::write(f.work().join("other/secret"), b"other").unwrap();
    let lease = json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"scoped-source",
        "resources":[{"path":"allowed","scope":"subtree"}]});
    f.short("file.lease.acquire", lease.clone(), Some("source"));
    let mut scan = f.params("");
    scan["leaseId"] = json!("scoped-source");
    scan["scopes"] = json!(["allowed"]);
    let wrong_owner = Fixture::request("file.scan", scan.clone(), Some("reader"));
    assert!(matches!(
        f.kernel
            .handle(&wrong_owner, Arc::new(AtomicBool::new(false)), &f.tx),
        Err(KernelError::Authorization(_))
    ));
    assert_eq!(
        f.inventory("file.scan", scan.clone(), "source").unwrap()["paths"],
        json!(["allowed", "allowed/input"])
    );
    scan["scopes"] = json!(["other"]);
    assert!(
        matches!(f.inventory("file.scan", scan, "source"), Err(KernelError::Authorization(message)) if message.contains("outside the held lease"))
    );
    // Failed worker completion releases its retention, not the caller's original lease.
    assert_eq!(
        f.short("file.lease.check", lease, Some("source"))["checked"],
        true
    );
}

#[cfg(unix)]
#[test]
fn file_inventory_bound_scope_rejects_parent_symlink_retarget_during_walk() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new();
    f.grant("source", &["storage.read", "storage.write"], &[""]);
    for dir in ["first/sub", "second/sub"] {
        fs::create_dir_all(f.work().join(dir)).unwrap();
    }
    fs::write(f.work().join("first/sub/input"), b"old").unwrap();
    fs::write(f.work().join("second/sub/input"), b"new").unwrap();
    symlink(f.work().join("first"), f.work().join("alias")).unwrap();
    f.short(
        "file.lease.acquire",
        json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"alias-source",
        "resources":[{"path":"alias/sub","scope":"subtree"}]}),
        Some("source"),
    );
    let mut scan = f.params("");
    scan["scopes"] = json!(["alias/sub"]);
    scan["leaseId"] = json!("alias-source");
    let mut hold = f.hold();
    f.begin("file.scan", scan, "source");
    hold.entered();
    fs::remove_file(f.work().join("alias")).unwrap();
    symlink(f.work().join("second"), f.work().join("alias")).unwrap();
    hold.release();
    assert!(
        matches!(f.finish(), Err(KernelError::Authorization(message)) if message.contains("outside the held lease"))
    );
}

// The same real Kernel fixture exercises body workers as well as metadata workers.
#[path = "runtime_capture_tests.rs"]
mod captures;
