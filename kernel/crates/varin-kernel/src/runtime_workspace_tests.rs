//! Use actual Kernel admission and its workspace callback continuation. No OS
//! mount or installed driver is necessary to exercise original ownership.
use super::*;
use sha2::Digest;

impl Fixture {
    fn publish_native_workspace_result(
        &mut self,
        candidate: &Value,
        publication: &str,
        grant: &str,
    ) -> Value {
        let params = json!({"workspaceId":"workspace","branchId":"parent","operationId":publication,"candidateOperationId":candidate["candidateOperationId"]});
        let request = Self::request("working.result.publish", params, Some(grant));
        assert!(self
            .kernel
            .handle(&request, Arc::new(AtomicBool::new(false)), &self.tx)
            .unwrap()
            .is_none());
        match self
            .rx
            .recv_timeout(WAIT)
            .expect("native result publication worker did not drain")
        {
            WorkerRequest::ResultPublicationDone { task, result, .. } => {
                let storage = self.kernel.storage.as_mut().unwrap();
                let receipt = result
                    .and_then(|prepared| storage.finish_result_publication(&task, prepared, grant));
                storage.release_result_publication_worker(&task);
                receipt.unwrap()
            }
            _ => panic!("unexpected result publication continuation"),
        }
    }
    pub(super) fn workspace_finish(&mut self) -> Result<Value, KernelError> {
        loop {
            match self
                .rx
                .recv_timeout(WAIT)
                .expect("native workspace worker did not drain")
            {
                WorkerRequest::Workspace(command) => command(self.kernel.storage.as_mut()),
                WorkerRequest::WorkspaceIdle => {}
                WorkerRequest::WorkspaceDone {
                    request: Some(request),
                    result,
                } => {
                    self.kernel
                        .workspace_tasks
                        .remove(request["id"].as_str().unwrap());
                    return result;
                }
                WorkerRequest::WorkspaceShutdownDone {
                    result,
                    processes,
                    computations,
                    ..
                } => {
                    self.kernel
                        .storage
                        .as_mut()
                        .unwrap()
                        .finish_execution_shutdown(processes, computations)?;
                    self.kernel.workspace_shutdown = false;
                    self.kernel.workspace_shutdown_started = false;
                    self.kernel.shutdown_complete = result.is_ok();
                    return result;
                }
                _ => panic!("unexpected workspace continuation"),
            }
        }
    }
    fn workspace(
        &mut self,
        method: &str,
        params: Value,
        grant: &str,
    ) -> Result<Value, KernelError> {
        let request = Self::request(method, params, Some(grant));
        let result = self
            .kernel
            .handle(&request, Arc::new(AtomicBool::new(false)), &self.tx)?;
        assert!(
            result.is_none(),
            "workspace I/O must leave Storage responsive"
        );
        self.workspace_finish()
    }
    fn native_workspace_write(&mut self, branch: &str, bytes: &'static [u8]) {
        let session = self.kernel.workspaces.session(branch);
        let sender = self.tx.clone();
        let worker = thread::spawn(move || {
            let result = (|| {
                let file = match session.lookup("file") {
                    Ok(file) => file,
                    Err(KernelError::Execution(error)) if error.code == "namespace_missing" => {
                        session.create_file("file", 0o644)?
                    }
                    Err(error) => return Err(error),
                };
                session.truncate(&file, 0)?;
                session.write(&file, None, bytes)?;
                Ok(Value::Null)
            })();
            sender
                .send(WorkerRequest::WorkspaceDone {
                    request: Some(json!({"id":"native-write"})),
                    result,
                })
                .unwrap();
        });
        self.workspace_finish().unwrap();
        worker.join().unwrap();
    }
}

#[test]
fn native_adoption_preserves_source_attributes_links_git_and_operation_replay() {
    let mut fixture = Fixture::new();
    fixture.grant("project", &["storage.read", "storage.write"], &[""]);
    let source = fixture.work();
    fs::create_dir_all(source.join("目录/empty")).unwrap();
    fs::create_dir_all(source.join(".git/objects/ab")).unwrap();
    fs::write(source.join("目录/code.txt"), "source 中文\n").unwrap();
    fs::hard_link(source.join("目录/code.txt"), source.join("alias.txt")).unwrap();
    fs::write(
        source.join(".git/config"),
        "[core]\nrepositoryformatversion = 0\nworktree = /original/project\n",
    )
    .unwrap();
    fs::write(source.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    fs::write(source.join(".git/objects/ab/blob"), "git-object").unwrap();
    fs::write(source.join(".varin"), "selected project data").unwrap();
    let before = crate::native_metadata::observe(&source.join("目录/code.txt")).unwrap();
    let params = json!({"branchId":"adopted","rootId":fixture.root_id,"operationId":"adopt"});
    let adopted = fixture
        .workspace("workspace.adopt", params.clone(), "project")
        .unwrap();
    assert_eq!(adopted["adoption"]["consistency"], "stable-capture");
    assert_eq!(
        fixture
            .workspace("workspace.adopt", params.clone(), "project")
            .unwrap(),
        adopted
    );
    let opened = fixture
        .workspace("workspace.open", json!({"branchId":"adopted"}), "project")
        .unwrap();
    let session = fixture.kernel.workspaces.session("adopted");
    let sender = fixture.tx.clone();
    let worker = thread::spawn(move || {
        let result = (|| {
            let file = session.lookup("目录/code.txt")?;
            let alias = session.lookup("alias.txt")?;
            assert!(Arc::ptr_eq(&file, &alias));
            let observed = file.attributes()?;
            assert_eq!(observed.modified, before.attributes.modified);
            assert_eq!(observed.changed, before.attributes.changed);
            assert_eq!(observed.security, before.attributes.security);
            assert_eq!(observed.xattrs, before.attributes.xattrs);
            let config = session.lookup(".git/config")?;
            let mut bytes = vec![0u8; 1024];
            let count = session.read(&config, 0, &mut bytes)?;
            let config = std::str::from_utf8(&bytes[..count]).unwrap();
            assert!(config.ends_with("\n[core]\n\tworktree = ..\n\tbare = false\n"));
            assert!(session.lookup("目录/empty")?.state()?.is_directory());
            session.lookup(".varin")?;
            let cached = session.lookup(".varin")?;
            let inode = cached.id;
            let released = Arc::downgrade(&cached);
            session.forget_cached(&cached)?;
            drop(cached);
            assert!(
                released.upgrade().is_none(),
                "clean entries are released after actual lookup references end"
            );
            assert_eq!(
                session.lookup(".varin")?.id,
                inode,
                "native file identity survives lookup-cache eviction"
            );
            session.lookup(".git/objects/ab/blob")?;
            session.truncate(&alias, 0)?;
            session.write(&alias, None, b"private")?;
            let link = session.create_file("native-link", 0o644)?;
            let point = crate::reparse_data::symlink("目录/code.txt")?;
            session.set_reparse_data(&link, Some(point.clone()))?;
            assert!(matches!(
                link.state()?,
                crate::model::PathState::Symlink { .. }
            ));
            assert_eq!(link.attributes()?.reparse_data, Some(point.clone()));
            session.set_reparse_data(&link, None)?;
            session.write(&link, None, b"ordinary")?;
            assert!(
                session.set_reparse_data(&link, Some(point)).is_err(),
                "type conversion must preserve nonempty original bytes"
            );
            let mut kept = [0u8; 8];
            session.read(&link, 0, &mut kept)?;
            assert_eq!(&kept, b"ordinary");
            let junction = session.create(
                "junction",
                crate::model::PathState::Directory { mode: Some(0o755) },
            )?;
            session
                .set_reparse_data(&junction, Some(crate::reparse_data::symlink("D:\\target")?))?;
            assert!(matches!(
                junction.state()?,
                crate::model::PathState::Symlink { .. }
            ));
            session.set_reparse_data(&junction, None)?;
            assert!(junction.state()?.is_directory());
            session.create_file("junction/child", 0o644)?;
            assert!(session
                .set_reparse_data(&junction, Some(crate::reparse_data::symlink("D:\\other")?))
                .is_err());
            session.lookup("junction/child")?;
            Ok(Value::Null)
        })();
        sender
            .send(WorkerRequest::WorkspaceDone {
                request: Some(json!({"id":"inspect-import"})),
                result,
            })
            .unwrap();
    });
    fixture.workspace_finish().unwrap();
    worker.join().unwrap();
    assert_eq!(
        fs::read_to_string(source.join("目录/code.txt")).unwrap(),
        "source 中文\n"
    );
    let mut fork = json!({"branchId":"adopted","generation":opened["binding"]["generation"],"targetBranchId":"adopt-child","operationId":"adopt-fork"});
    fixture
        .workspace("workspace.fork", fork.clone(), "project")
        .unwrap();
    fork["operationId"] = json!("adopt-fork-2");
    fork["targetBranchId"] = json!("adopt-child-2");
    fixture
        .workspace("workspace.fork", fork, "project")
        .unwrap();
    assert_eq!(
        fixture
            .workspace("workspace.adopt", params, "project")
            .unwrap(),
        adopted
    );
    let storage = fixture.kernel.storage.as_ref().unwrap();
    let connection = rusqlite::Connection::open_with_flags(
        storage.root().join("catalog.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let pending: i64 = connection
        .query_row(
            "SELECT count(*) FROM branches WHERE branch_id LIKE 'workspace-adoption:%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        pending, 0,
        "the successful import has no retained private candidate"
    );
    let syscall_receipts:i64=connection.query_row("SELECT count(*) FROM operations WHERE kind IN ('workspace.namespace.create','workspace.namespace.link','workspace.file.publish')",[],|row|row.get(0)).unwrap();
    assert_eq!(
        syscall_receipts, 0,
        "native syscalls do not create a permanent receipt ledger"
    );
    let request = Fixture::request("kernel.shutdown", json!({}), None);
    fixture
        .kernel
        .handle(&request, Arc::new(AtomicBool::new(false)), &fixture.tx)
        .unwrap();
    fixture.workspace_finish().unwrap();
}

#[test]
fn native_adoption_flattens_authorized_git_admin_and_retries_failed_preparation() {
    let mut fixture = Fixture::new();
    fs::write(fixture.work().join("file"), "keep-source").unwrap();
    fs::write(fixture.work().join(".git"), "malformed pointer\n").unwrap();
    let input =
        json!({"branchId":"git-workspace","rootId":fixture.root_id,"operationId":"git-adopt"});
    assert!(fixture
        .workspace("workspace.adopt", input.clone(), "writer")
        .is_err());
    let admin = fixture.directory.0.join("common");
    fs::create_dir_all(admin.join("worktrees/checkout")).unwrap();
    fs::create_dir_all(admin.join("objects/info")).unwrap();
    fs::write(admin.join("config"), "[core]\nrepositoryformatversion=0\n").unwrap();
    fs::write(admin.join("worktrees/checkout/commondir"), "../..\n").unwrap();
    fs::write(
        admin.join("worktrees/checkout/gitdir"),
        "old/check/out/.git\n",
    )
    .unwrap();
    fs::write(
        admin.join("worktrees/checkout/HEAD"),
        "ref: refs/heads/topic\n",
    )
    .unwrap();
    fs::write(
        fixture.work().join(".git"),
        format!("gitdir: {}\n", admin.join("worktrees/checkout").display()),
    )
    .unwrap();
    let denied = fixture
        .workspace("workspace.adopt", input.clone(), "writer")
        .unwrap_err();
    assert!(denied
        .to_string()
        .contains("outside the admitted source roots"));
    let root = fixture.short(
        "file.root.register",
        json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":admin}),
        Some("writer"),
    );
    // A new preparation records the newly admitted source, while the original
    // failed operation remains bound to its original arguments.
    let mut allowed = input;
    allowed["operationId"] = json!("git-adopt-authorized");
    allowed["gitRootIds"] = json!([root["rootId"]]);
    fixture
        .workspace("workspace.adopt", allowed, "writer")
        .unwrap();
    fixture
        .workspace(
            "workspace.open",
            json!({"branchId":"git-workspace"}),
            "writer",
        )
        .unwrap();
    let session = fixture.kernel.workspaces.session("git-workspace");
    let sender = fixture.tx.clone();
    let worker = thread::spawn(move || {
        let result = (|| {
            assert!(session.lookup(".git")?.state()?.is_directory());
            session.lookup(".git/HEAD")?;
            session.lookup(".git/config")?;
            assert!(session.lookup(".git/commondir").is_err());
            assert!(session.lookup(".git/gitdir").is_err());
            assert!(session.lookup(".git/worktrees").is_err());
            Ok(Value::Null)
        })();
        sender
            .send(WorkerRequest::WorkspaceDone {
                request: Some(json!({"id":"inspect-git-import"})),
                result,
            })
            .unwrap();
    });
    fixture.workspace_finish().unwrap();
    worker.join().unwrap();
    assert_eq!(
        fs::read_to_string(fixture.work().join("file")).unwrap(),
        "keep-source"
    );
    let request = Fixture::request("kernel.shutdown", json!({}), None);
    fixture
        .kernel
        .handle(&request, Arc::new(AtomicBool::new(false)), &fixture.tx)
        .unwrap();
    fixture.workspace_finish().unwrap();
}

#[test]
fn native_workspace_runtime_preserves_execution_leases_fork_receipts_and_shutdown_bytes() {
    let mut fixture = Fixture::new();
    fixture.short("authority.grant.issue",json!({"grantId":"execution","hostGeneration":GENERATION,"capabilities":["storage.read","storage.write"],"pathScopes":[""],
        "storageIdentity":fixture.kernel.storage.as_ref().unwrap().root(),"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread-a","runId":"run-a"}),None);
    fixture.short("branch.create.begin",json!({"operationId":"parent-create","builderId":"parent-builder","workspaceId":"workspace","branchId":"parent","draftBasePaths":[],"captureScopes":[]}),Some("writer"));
    fixture.short(
        "branch.create.finish",
        json!({"operationId":"parent-create","builderId":"parent-builder"}),
        Some("writer"),
    );
    let opened = fixture
        .workspace("workspace.open", json!({"branchId":"parent"}), "writer")
        .unwrap();
    assert!(
        fixture
            .workspace("workspace.open", json!({"branchId":"parent"}), "execution")
            .is_err(),
        "an execution lease cannot become the persistent project owner"
    );
    let address = json!({"branchId":"parent","generation":opened["binding"]["generation"]});
    fixture.short("authority.grant.issue",json!({"grantId":"other-source","hostGeneration":GENERATION,
        "capabilities":["storage.read","storage.write"],"pathScopes":[""],"storageIdentity":fixture.kernel.storage.as_ref().unwrap().root(),
        "owningWorkspace":"workspace","executionWorkspace":"another-source","threadId":"thread-b","runId":"run-b"}),None);
    let mut foreign = address.clone();
    foreign["leaseId"] = json!("foreign-holder");
    assert!(
        fixture
            .workspace("workspace.acquire", foreign, "other-source")
            .is_err(),
        "a matching project identity cannot substitute for the original execution source"
    );
    let mut lease = address.clone();
    lease["leaseId"] = json!("run-holder");
    fixture
        .workspace("workspace.acquire", lease.clone(), "execution")
        .unwrap();
    assert!(fixture
        .workspace("workspace.release", lease.clone(), "reader")
        .is_err());
    assert!(fixture
        .workspace("workspace.close", address.clone(), "writer")
        .is_err());
    let retirement = Fixture::request(
        "authority.grant.retire",
        json!({"target":{"kind":"grant","grantId":"writer"}}),
        None,
    );
    assert!(
        fixture
            .kernel
            .handle(&retirement, Arc::new(AtomicBool::new(false)), &fixture.tx)
            .is_err(),
        "project and execution ownership must survive retirement requests"
    );
    fixture.native_workspace_write("parent", b"before");
    let mut fork = address.clone();
    fork["operationId"] = json!("original-fork");
    fork["targetBranchId"] = json!("child");
    let first = fixture
        .workspace("workspace.fork", fork.clone(), "execution")
        .unwrap();
    fixture.native_workspace_write("parent", b"after!");
    let replay = fixture
        .workspace("workspace.fork", fork, "execution")
        .unwrap();
    assert_eq!(
        first, replay,
        "retry returns its original boundary after the parent has changed"
    );
    let child = fixture.short(
        "branch.read",
        json!({"branchId":"child","includeEntries":true}),
        Some("reader"),
    );
    assert_eq!(
        child["entries"][0]["state"]["objectHash"],
        format!("sha256-{}", hex::encode(sha2::Sha256::digest(b"before")))
    );
    let mut result_request = address.clone();
    result_request["publicationId"] = json!("snapshot-result");
    let candidate = fixture
        .workspace(
            "workspace.result.prepare",
            result_request.clone(),
            "execution",
        )
        .unwrap();
    fixture.native_workspace_write("parent", b"later!");
    assert_eq!(
        candidate,
        fixture
            .workspace("workspace.result.prepare", result_request, "execution")
            .unwrap()
    );
    fixture.short(
        "storage.gc",
        json!({"operationId":"native-result-retained-gc"}),
        Some("writer"),
    );
    let published =
        fixture.publish_native_workspace_result(&candidate, "snapshot-result", "execution");
    let fixed = fixture.short(
        "branch.read",
        json!({"branchId":"parent","revision":published["resultRevision"],"includeEntries":true}),
        Some("reader"),
    );
    assert_eq!(
        fixed["entries"][0]["state"]["objectHash"],
        format!("sha256-{}", hex::encode(sha2::Sha256::digest(b"after!"))),
        "publication must preserve the selected generation while parent writes continue"
    );
    fixture.short("working.result.candidate.release",json!({"workspaceId":"workspace","branchId":"parent","operationId":"result-candidate-release:snapshot-result","candidateOperationId":candidate["candidateOperationId"]}),Some("execution"));
    let filesystem_pin = format!("native-result:{}", published["recordId"].as_str().unwrap());
    let filesystem_base_pin = format!(
        "native-result-base:{}",
        published["recordId"].as_str().unwrap()
    );
    let database = rusqlite::Connection::open_with_flags(
        fixture.directory.0.join("store/catalog.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert!(database.query_row("SELECT EXISTS(SELECT 1 FROM pins p JOIN trie_nodes n ON n.hash=p.root_hash WHERE p.pin_id=?1)",[&filesystem_pin],|row|row.get::<_,bool>(0)).unwrap(),"the published result independently retains its file attributes after releasing the candidate");
    assert!(database.query_row("SELECT EXISTS(SELECT 1 FROM pins p JOIN trie_nodes n ON n.hash=p.root_hash WHERE p.pin_id=?1)",[&filesystem_base_pin],|row|row.get::<_,bool>(0)).unwrap(),"the published result retains the original attribute baseline for three-way integration");
    let health = fixture.short("storage.health", json!({"deep":true}), Some("writer"));
    assert_eq!(health["integrity"], "ok", "{health}");
    let mut stale = address.clone();
    stale["generation"] = json!(Uuid::new_v4());
    assert!(fixture
        .workspace("workspace.inspect", stale, "writer")
        .is_err());
    fixture
        .workspace("workspace.release", lease, "execution")
        .unwrap();
    fixture.short(
        "authority.grant.retire",
        json!({"target":{"kind":"grant","grantId":"execution"}}),
        None,
    );
    let request = Fixture::request("kernel.shutdown", json!({}), None);
    assert!(fixture
        .kernel
        .handle(&request, Arc::new(AtomicBool::new(false)), &fixture.tx)
        .unwrap()
        .is_none());
    assert_eq!(fixture.workspace_finish().unwrap()["stopping"], true);
    assert!(fixture.kernel.drained());
    let parent = fixture.short(
        "branch.read",
        json!({"branchId":"parent","includeEntries":true}),
        Some("reader"),
    );
    assert_eq!(
        parent["entries"][0]["state"]["objectHash"],
        format!("sha256-{}", hex::encode(sha2::Sha256::digest(b"later!")))
    );
    assert!(fixture.kernel.workspaces.is_empty());
    fixture.short(
        "branch.delete",
        json!({"operationId":"delete-native-result-parent","branchId":"parent"}),
        Some("writer"),
    );
    assert!(
        !database
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pins WHERE pin_id=?1)",
                [&filesystem_pin],
                |row| row.get::<_, bool>(0)
            )
            .unwrap(),
        "deleting the result source must release its private metadata retention too"
    );
    assert!(!database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pins WHERE pin_id=?1)",
            [&filesystem_base_pin],
            |row| row.get::<_, bool>(0)
        )
        .unwrap());
}
