//! Real worker/control continuations: neither cancellation nor observation can
//! release the original writer before its filesystem effect and receipt drain.
use super::*;
use crate::storage::file_mutations::{FileWriteArgs, FileWriteMode, TextMutation};

#[test]
fn file_effect_records_actual_result_after_cancel_revoke_and_deferred_release() {
    let mut f = Fixture::new();
    fs::write(f.work().join("seed"), "new bytes").unwrap();
    let captured = f.capture("seed", true, "content");
    f.short(
        "file.lease.acquire",
        f.lease("target", "original"),
        Some("writer"),
    );
    let params = json!({"workspaceId":"workspace","rootId":f.root_id,"operationId":"replace","path":"target",
        "leaseId":"original","ownerId":captured["ownerId"],"targetJson":captured["stateJson"],"expectedJson":"{\"kind\":\"missing\"}"});
    let (_, cancel) = f.begin("file.apply", params.clone(), "writer");
    let mut interrupted = false;
    loop {
        match f.rx.recv_timeout(WAIT).unwrap() {
            WorkerRequest::Workspace(command) => {
                if !interrupted
                    && fs::read(f.work().join("target")).ok().as_deref() == Some(b"new bytes")
                {
                    // This is the original receipt continuation, after the actual effect.
                    let pending=f.short("file.operation.reconcile",json!({"workspaceId":"workspace","rootId":f.root_id,"operationId":"replace"}),Some("writer"));
                    assert_eq!(pending["status"], "pending");
                    assert_eq!(
                        pending["operation"]["reason"],
                        "original-file-worker-running"
                    );
                    assert_eq!(f.short("file.lease.release",json!({"workspaceId":"workspace","rootId":f.root_id,"leaseId":"original"}),Some("writer"))["deferred"],true);
                    cancel.store(true, Ordering::Release);
                    f.short("authority.grant.revoke", json!({"grantId":"writer"}), None);
                    f.grant("next", &["storage.admin"], &[""]);
                    assert_eq!(
                        f.short(
                            "file.lease.acquire",
                            f.lease("target", "next-lease"),
                            Some("next")
                        )["status"],
                        "busy"
                    );
                    interrupted = true;
                }
                command(f.kernel.storage.as_mut());
            }
            WorkerRequest::FileEffectDone { result, .. } => {
                assert_eq!(result.unwrap()["status"], "applied");
                break;
            }
            _ => panic!("unexpected effect continuation"),
        }
    }
    assert!(
        interrupted,
        "cancellation must occur after the physical write and before its durable receipt"
    );
    assert_eq!(
        f.short(
            "operation.get",
            json!({"operationId":"replace"}),
            Some("next")
        )["state"],
        "committed"
    );
    assert_eq!(
        f.short(
            "file.lease.acquire",
            f.lease("target", "next-lease"),
            Some("next")
        )["status"],
        "acquired"
    );
    assert_eq!(fs::read(f.work().join("target")).unwrap(), b"new bytes");
}

#[test]
fn file_effect_crud_replays_original_receipts_and_cleans_pre_effect_cancellation() {
    let mut f = Fixture::new();
    let params = json!({"workspaceId":"workspace","rootId":f.root_id,"operationId":"mkdir","path":"dir","recursive":false});
    assert_eq!(
        f.short("file.mkdir", params.clone(), Some("writer"))["status"],
        "created"
    );
    assert_eq!(
        f.short("file.mkdir", params, Some("writer"))["status"],
        "created"
    );
    fs::write(f.work().join("dir/source"), "source").unwrap();
    fs::write(f.work().join("target"), "old target").unwrap();
    let rename = json!({"workspaceId":"workspace","rootId":f.root_id,"operationId":"rename","fromPath":"dir/source","toPath":"target"});
    assert_eq!(
        f.short("file.rename", rename.clone(), Some("writer"))["status"],
        "renamed"
    );
    assert_eq!(
        f.short("file.rename", rename, Some("writer"))["status"],
        "renamed"
    );
    assert_eq!(fs::read(f.work().join("target")).unwrap(), b"source");
    let remove = json!({"workspaceId":"workspace","rootId":f.root_id,"operationId":"remove","path":"target","recursive":false,"force":false});
    let (_, cancel) = f.begin("file.remove", remove.clone(), "writer");
    let WorkerRequest::Workspace(command) = f.rx.recv_timeout(WAIT).unwrap() else {
        panic!("effect did not reach its owner");
    };
    cancel.store(true, Ordering::Release);
    f.short("storage.health", json!({}), Some("reader"));
    command(f.kernel.storage.as_mut());
    assert!(matches!(f.finish_effect(), Err(KernelError::Cancelled)));
    assert_eq!(fs::read(f.work().join("target")).unwrap(), b"source");
    assert_eq!(
        f.short("file.remove", remove.clone(), Some("writer"))["status"],
        "removed"
    );
    assert_eq!(
        f.short("file.remove", remove, Some("writer"))["status"],
        "removed"
    );
}

#[test]
fn text_mutation_worker_borrows_one_lease_and_keeps_journal_replay_conditional() {
    let mut f = Fixture::new();
    let mutation = TextMutation::Write(FileWriteArgs {
        path: "body".into(),
        read_version: String::new(),
        content: "first\r\n".into(),
        mode: Some(FileWriteMode::Create),
    });
    let (grant, _) = f
        .kernel
        .storage
        .as_ref()
        .unwrap()
        .authorize(
            Some("writer"),
            EPOCH,
            HOST,
            GENERATION,
            "file.apply",
            &json!({"workspaceId":"workspace","rootId":f.root_id,"path":"body"}),
        )
        .unwrap();
    let mut version = String::new();
    for (operation, mutation) in [
        ("create", mutation.clone()),
        ("create", mutation),
        (
            "replace",
            TextMutation::Write(FileWriteArgs {
                path: "body".into(),
                read_version: "stale".into(),
                content: "must not write".into(),
                mode: None,
            }),
        ),
    ] {
        let task = f
            .kernel
            .storage
            .as_ref()
            .unwrap()
            .prepare_text_mutation(
                "workspace",
                &f.root_id,
                operation,
                &mutation,
                &grant,
                None,
                varin_runtime::SourceMode::LiveRoot,
                None,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        let (done, rx) = mpsc::channel();
        let port = Kernel::workspace_port(&f.tx);
        let worker = thread::spawn(move || {
            done.send(task.run(port)).ok();
        });
        let value = loop {
            if let Ok(value) = rx.try_recv() {
                break value.unwrap_or_else(|failure| panic!("{}", failure.error));
            }
            match f.rx.recv_timeout(Duration::from_millis(10)) {
                Ok(WorkerRequest::Workspace(command)) => {
                    f.short("storage.health", json!({}), Some("reader"));
                    command(f.kernel.storage.as_mut());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                _ => panic!("unexpected text mutation continuation"),
            }
        };
        worker.join().unwrap();
        if operation == "replace" {
            assert_eq!(value["status"], "conflict");
        } else {
            assert_eq!(value["status"], "applied");
            if version.is_empty() {
                version = value["readVersion"].as_str().unwrap().into();
            } else {
                assert_eq!(value["readVersion"], version);
            }
        }
    }
    assert_eq!(fs::read(f.work().join("body")).unwrap(), b"first\r\n");
    assert_eq!(
        f.short(
            "file.lease.acquire",
            f.lease("body", "after"),
            Some("writer")
        )["status"],
        "acquired"
    );
}
