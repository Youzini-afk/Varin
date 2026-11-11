//! Real persisted-owner and idempotent replay boundaries; no transport fixture required.
use super::*;

fn grant_params(id: &str) -> Value {
    json!({"grantId":id,"hostGeneration":"generation","owningWorkspace":"workspace",
        "executionWorkspace":"workspace","threadId":"thread","runId":"run",
        "capabilities":["storage.admin","recovery.maintenance"],"pathScopes":[""]})
}
fn fixture() -> (Storage, PathBuf) {
    let root = std::env::temp_dir().join(format!("native-authority-{}", Uuid::new_v4()));
    let mut storage = Storage::open(&root, "host").unwrap();
    storage
        .issue_grant(
            &grant_params("actor"),
            "host",
            "generation",
            &root.to_string_lossy(),
            "epoch",
        )
        .unwrap();
    (storage, root)
}
fn invoke(storage: &mut Storage, method: &str, input: &Value) -> Result<Value, KernelError> {
    let (grant, params) =
        storage.authorize(Some("actor"), "epoch", "host", "generation", method, input)?;
    storage.dispatch(method, &params, Some("actor"), &grant)
}
fn grant_json(storage: &Storage) -> String {
    storage
        .conn
        .query_row(
            "SELECT grant_json FROM grants WHERE grant_id='actor'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}
fn record_input(id: &str) -> Value {
    json!({"operationId":id,"workspaceId":"workspace","recordId":"record","recordType":"recovery.checkpoint",
        "state":"ready","threadId":"thread","runId":"run","payloadJson":"{}","ownerIds":[],"references":[]})
}

#[test]
fn binary_file_apply_joins_the_original_journal_and_replays_after_temporary_owners_are_consumed() {
    let (mut storage, root) = fixture();
    let directory = root.join("binary-workspace");
    fs::create_dir(&directory).unwrap();
    let before = b"PK\x03\x04original\x00document";
    let after = b"PK\x03\x04edited\x00document";
    fs::write(directory.join("report.docx"), before).unwrap();
    let registered = invoke(&mut storage, "file.root.register", &json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":directory})).unwrap();
    let upload = |storage: &mut Storage, name: &str, bytes: &[u8]| {
        let params = json!({"workspaceId":"workspace","operationId":name,"streamId":name,"byteLength":bytes.len()});
        storage.begin_blob_stream(&params, "actor").unwrap();
        storage.stream_blob_bytes(name, 0, bytes, "actor").unwrap();
        storage.finish_blob_stream(&params, "actor").unwrap()
    };
    let original = upload(&mut storage, "before-binary", before);
    let target = upload(&mut storage, "after-binary", after);
    let state = |blob: &Value, length| json!({"kind":"regular-file","objectHash":blob["hash"],"byteLength":length});
    let input = json!({"operationId":"office-edit","workspaceId":"workspace","rootId":registered["rootId"],"path":"report.docx",
        "expectedJson":state(&original,before.len()).to_string(),"targetJson":state(&target,after.len()).to_string(),"ownerId":target["ownerId"],
        "journalBinding":{"anchor":{"executionId":"turn","threadId":"thread","branchId":"branch","runId":"run","entryId":"input","epoch":1},
            "sourceMode":"live_root","tool":"office_write","beforeOwnerId":original["ownerId"]}});
    let first = invoke(&mut storage, "file.apply", &input).unwrap();
    assert_eq!(first["status"], "applied");
    assert_eq!(fs::read(directory.join("report.docx")).unwrap(), after);
    assert_eq!(invoke(&mut storage, "file.apply", &input).unwrap(), first);
    let (prior, current, tool): (String,String,String) = storage.conn.query_row(
        "SELECT before_json,after_json,tool_name FROM recovery_changes WHERE path='report.docx'", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&prior).unwrap()["objectHash"], original["hash"]);
    assert_eq!(serde_json::from_str::<Value>(&current).unwrap()["objectHash"], target["hash"]);
    assert_eq!(tool, "office_write");
    let mut conflict = input.clone();
    conflict["operationId"] = json!("stale-edit");
    let stale_target = upload(&mut storage, "conflict-target", b"stale replacement");
    conflict["ownerId"] = stale_target["ownerId"].clone();
    conflict["targetJson"] = json!(state(&stale_target, 17).to_string());
    conflict["journalBinding"]["beforeOwnerId"] = upload(&mut storage, "conflict-before", before)["ownerId"].clone();
    assert_eq!(invoke(&mut storage, "file.apply", &conflict).unwrap()["status"], "conflict");
    assert_eq!(fs::read(directory.join("report.docx")).unwrap(), after);
    drop(storage);
    let storage = Storage::open(&root, "host").unwrap();
    let (reply, _) = std::sync::mpsc::channel();
    let source = serde_json::from_value(json!({"workspace_id":"workspace","execution_workspace_id":"workspace", "mode":"live_root",
        "branch_id":null,"revision":null,"live_root":{"hostId":"host","rootId":registered["rootId"],"canonicalRoot":registered["canonicalRoot"]},"resource_owner":{"kind":"local"}})).unwrap();
    let mut read = crate::tools::SourceEffectReceiptRead { source, run_id:"run".into(), thread_id:"thread".into(), operation_id:"office-edit".into(), reply };
    let recovered = storage.file_tool_receipt(&read).unwrap();
    assert_eq!(recovered["receipt"]["status"], "applied");
    assert_eq!(recovered["tool"], "office_write");
    assert_eq!(recovered["grantId"], "actor");
    let artifact=storage.domain_record_value("workspace",first["attachment"]["ref"].as_str().unwrap()).unwrap().unwrap();
    assert_eq!(artifact["runId"], "run");
    assert_eq!(serde_json::from_str::<Value>(artifact["payloadJson"].as_str().unwrap()).unwrap()["sourceGrantId"], "actor");
    assert_eq!(serde_json::from_str::<Value>(artifact["payloadJson"].as_str().unwrap()).unwrap()["managedSource"], false);
    let projected = crate::file_tool_reconciliation::recovered_output(&recovered["receipt"], "office-edit").unwrap();
    assert_eq!(projected.data["attachment"], first["attachment"]);
    assert!(matches!(&projected.parts[..], [varin_runtime::output::OutputPart::Attachment { attachment }]
        if attachment.byte_length == after.len() as u64 && attachment.reference == first["attachment"]["ref"].as_str().unwrap()));
    read.operation_id = "stale-edit".into();
    assert_eq!(storage.file_tool_receipt(&read).unwrap()["receipt"]["status"], "conflict");
    read.thread_id = "other-thread".into();
    assert!(storage.file_tool_receipt(&read).is_err());
    drop(storage);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_grants_store_null_and_historical_null_grants_reissue_without_migration() {
    let (mut storage, root) = fixture();
    let format = |storage: &Storage| {
        (
            storage
                .conn
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            storage
                .conn
                .query_row(
                    "SELECT value FROM metadata WHERE key='format_version'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
    };
    let original_format = format(&storage);
    let value: Value = serde_json::from_str(&grant_json(&storage)).unwrap();
    for key in [
        "authority_instance_id",
        "worker_id",
        "worker_generation",
        "session_id",
    ] {
        assert!(value.get(key).is_some_and(Value::is_null), "{key}");
    }
    let first = storage
        .issue_grant(
            &grant_params("actor"),
            "host",
            "generation",
            &root.to_string_lossy(),
            "epoch",
        )
        .unwrap();
    assert_eq!(value, first);
    drop(storage);
    let mut storage = Storage::open(&root, "host").unwrap();
    let second = storage
        .issue_grant(
            &grant_params("actor"),
            "host",
            "generation",
            &root.to_string_lossy(),
            "next-epoch",
        )
        .unwrap();
    assert_eq!(second["kernel_epoch"], "next-epoch");
    assert_eq!(second["session_id"], Value::Null);
    assert_eq!(
        format(&storage),
        original_format,
        "grant reissue must not migrate either store format"
    );
    drop(storage);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retired_grant_fields_cannot_be_issued_or_revived_from_a_matching_cached_identity() {
    for (wire, stored, value) in [
        (
            "authorityInstanceId",
            "authority_instance_id",
            json!("old-authority"),
        ),
        ("workerId", "worker_id", json!("old-worker")),
        ("workerGeneration", "worker_generation", json!(0)),
        ("sessionId", "session_id", json!("old-session")),
    ] {
        let (mut storage, root) = fixture();
        let mut input = grant_params("rejected");
        input[wire] = value.clone();
        assert!(matches!(
            storage.issue_grant(
                &input,
                "host",
                "generation",
                &root.to_string_lossy(),
                "epoch"
            ),
            Err(KernelError::Authorization(_))
        ));
        let mut persisted: Value = serde_json::from_str(&grant_json(&storage)).unwrap();
        persisted[stored] = value;
        let exact = serde_json::to_string_pretty(&persisted).unwrap();
        storage
            .conn
            .execute(
                "UPDATE grants SET grant_json=?1 WHERE grant_id='actor'",
                [&exact],
            )
            .unwrap();
        drop(storage);
        let mut storage = Storage::open(&root, "host").unwrap();
        assert!(matches!(
            storage.authorize(
                Some("actor"),
                "epoch",
                "host",
                "generation",
                "storage.snapshot",
                &json!({"workspaceId":"workspace"})
            ),
            Err(KernelError::Authorization(_))
        ));
        // Hash still matches the original null-owner request; a new epoch must not revive it.
        assert!(matches!(
            storage.issue_grant(
                &grant_params("actor"),
                "host",
                "generation",
                &root.to_string_lossy(),
                "next-epoch"
            ),
            Err(KernelError::Authorization(_))
        ));
        assert_eq!(grant_json(&storage), exact);
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn session_record_owners_reject_reads_writes_release_and_committed_replay_even_for_admin() {
    let (mut storage, root) = fixture();
    let input = record_input("native-put");
    let original = invoke(&mut storage, "storage.record.put", &input).unwrap();
    assert_eq!(
        invoke(&mut storage, "storage.record.put", &input).unwrap(),
        original
    );
    let session: Option<String> = storage
        .conn
        .query_row(
            "SELECT session_id FROM domain_records WHERE record_id='record'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(session.is_none());
    let mut legacy_input = record_input("rejected-put");
    legacy_input["sessionId"] = json!("old-session");
    assert!(matches!(
        invoke(&mut storage, "storage.record.put", &legacy_input),
        Err(KernelError::Authorization(_))
    ));
    storage
        .conn
        .execute(
            "UPDATE domain_records SET session_id='old-session' WHERE record_id='record'",
            [],
        )
        .unwrap();
    let mut update = input.clone();
    update["operationId"] = json!("update");
    update["expectedRecordRevision"] = json!(1);
    for (method, request) in [
        ("storage.record.put", input),
        ("storage.record.put", update),
        (
            "storage.record.get",
            json!({"workspaceId":"workspace","recordId":"record"}),
        ),
        ("storage.record.list", json!({"workspaceId":"workspace"})),
        (
            "storage.record.release",
            json!({"operationId":"release","workspaceId":"workspace","recordId":"record"}),
        ),
    ] {
        assert!(
            matches!(
                invoke(&mut storage, method, &request),
                Err(KernelError::Authorization(_))
            ),
            "{method}"
        );
    }
    let retained: (String, i64, String) = storage.conn.query_row("SELECT session_id,record_revision,payload_json FROM domain_records WHERE record_id='record'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(retained, ("old-session".into(), 1, "{}".into()));
    drop(storage);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_record_receipt_cannot_replay_after_record_disappears_but_history_is_preserved() {
    let (mut storage, root) = fixture();
    let input = record_input("old-put");
    let (_, params) = storage
        .authorize(
            Some("actor"),
            "epoch",
            "host",
            "generation",
            "storage.record.put",
            &input,
        )
        .unwrap();
    storage
        .operation_begin(
            "old-put",
            "storage.record.put",
            &hash_json(&params).unwrap(),
        )
        .unwrap();
    storage
        .record_operation_workspace("old-put", Some("workspace"))
        .unwrap();
    let old = json!({"recordId":"record","workspaceId":"workspace","sessionId":"old-session","recordRevision":1});
    storage.operation_finish("old-put", &old).unwrap();
    assert!(matches!(
        invoke(&mut storage, "storage.record.put", &input),
        Err(KernelError::Authorization(_))
    ));
    assert_eq!(
        invoke(
            &mut storage,
            "operation.get",
            &json!({"operationId":"old-put"})
        )
        .unwrap()["result"],
        old
    );
    assert!(storage
        .domain_record_value("workspace", "record")
        .unwrap()
        .is_none());
    drop(storage);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_cached_create_and_transition_cannot_bypass_persisted_session_owner() {
    let (mut storage, root) = fixture();
    let create = json!({"operationId":"recover","workspaceId":"workspace","threadId":"thread","runId":"run","kind":"combined","state":"planned","dataJson":"{}","files":[]});
    invoke(&mut storage, "recovery.operation.create", &create).unwrap();
    let complete = json!({"transitionId":"recover-complete","operationId":"recover","workspaceId":"workspace","expectedRevision":1,"state":"complete"});
    let completed = invoke(&mut storage, "recovery.operation.complete", &complete).unwrap();
    assert_eq!(
        invoke(&mut storage, "recovery.operation.complete", &complete).unwrap(),
        completed
    );
    storage
        .conn
        .execute(
            "UPDATE recovery_operations SET session_id='old-session' WHERE operation_id='recover'",
            [],
        )
        .unwrap();
    for (method, input) in [
        ("recovery.operation.create", create),
        ("recovery.operation.complete", complete),
        (
            "recovery.operation.release",
            json!({"transitionId":"recover-release","operationId":"recover","workspaceId":"workspace"}),
        ),
    ] {
        assert!(invoke(&mut storage, method, &input).is_err(), "{method}");
    }
    let retained: (String, String) = storage
        .conn
        .query_row(
            "SELECT session_id,state FROM recovery_operations WHERE operation_id='recover'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(retained, ("old-session".into(), "complete".into()));
    drop(storage);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn removed_working_verification_and_review_methods_do_not_dispatch() {
    let (mut storage, root) = fixture();
    for kind in ["verification", "review"] {
        for action in ["put", "list", "release"] {
            let method = format!("working.{kind}.{action}");
            assert!(matches!(
                invoke(
                    &mut storage,
                    &method,
                    &json!({"workspaceId":"workspace","operationId":"retired"})
                ),
                Err(KernelError::Protocol(_))
            ));
        }
    }
    assert!(storage
        .operation_get(&json!({"operationId":"retired"}))
        .unwrap()
        .is_null());
    drop(storage);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_source_record_owner_cannot_read_or_replace_a_legacy_session_record() {
    let (mut storage, root) = fixture();
    storage
        .save_source_record(
            "source.scope",
            "source",
            "workspace",
            "ready",
            &json!({"scope":"original"}),
        )
        .unwrap();
    storage
        .conn
        .execute(
            "UPDATE domain_records SET session_id='legacy-source' WHERE record_id='source'",
            [],
        )
        .unwrap();
    assert!(storage
        .source_record::<Value>("source.scope", "source")
        .is_err());
    assert!(storage
        .save_source_record(
            "source.scope",
            "source",
            "workspace",
            "closed",
            &json!({"scope":"replacement"})
        )
        .is_err());
    let retained: (String, String, String) = storage
        .conn
        .query_row(
            "SELECT session_id,state,payload_json FROM domain_records WHERE record_id='source'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        retained,
        (
            "legacy-source".into(),
            "ready".into(),
            r#"{"scope":"original"}"#.into()
        )
    );
    drop(storage);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_source_scope_scan_rechecks_record_and_original_grant_owners() {
    use crate::source_resources::{
        SourceAuthorityAddress, SourceAuthorityOpenParams, SourceAuthorityScopeParams,
    };
    let (mut storage, root) = fixture();
    let directory = root.join("workspace");
    fs::create_dir(&directory).unwrap();
    let registered = invoke(&mut storage, "file.root.register", &json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":directory})).unwrap();
    let source = json!({"resource_owner":{"kind":"managed_host","hostId":"host","connectionId":"connection","endpointIdentity":"endpoint"},
        "workspace_id":"workspace","execution_workspace_id":"workspace","mode":"live_root","branch_id":null,"revision":null,
        "live_root":{"hostId":"host","rootId":registered["rootId"],"canonicalRoot":registered["canonicalRoot"]},"environment_run_id":null});
    let opened = storage.source_authority_open(serde_json::from_value::<SourceAuthorityOpenParams>(json!({
        "principalId":"principal","coordinatorHostId":"coordinator","scope":{"kind":"run","threadId":"thread","runId":"run","epoch":1},
        "source":source,"grantId":"actor","enabledTools":[],"purpose":"source"})).unwrap(), "epoch", "host").unwrap();
    let scope = || {
        serde_json::from_value::<SourceAuthorityScopeParams>(json!({"principalId":"principal","coordinatorHostId":"coordinator","threadId":"thread","runId":"run"})).unwrap()
    };
    let address: SourceAuthorityAddress = serde_json::from_value(json!({"principalId":"principal","coordinatorHostId":"coordinator","authorityId":opened["authorityId"],"resourceEpoch":"epoch"})).unwrap();
    assert_eq!(
        storage
            .inspect_source_scope(scope())
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(storage.source_authority(&address, true, "epoch").is_ok());
    storage
        .conn
        .execute(
            "UPDATE domain_records SET session_id='old-session' WHERE record_id=?1",
            [address.authority_id.as_str()],
        )
        .unwrap();
    assert!(storage.inspect_source_scope(scope()).is_err());
    assert!(storage.source_authority(&address, true, "epoch").is_err());
    storage
        .conn
        .execute(
            "UPDATE domain_records SET session_id=NULL WHERE record_id=?1",
            [address.authority_id.as_str()],
        )
        .unwrap();
    let mut grant: Value = serde_json::from_str(&grant_json(&storage)).unwrap();
    grant["worker_id"] = json!("old-worker");
    let exact = grant.to_string();
    storage
        .conn
        .execute(
            "UPDATE grants SET grant_json=?1 WHERE grant_id='actor'",
            [&exact],
        )
        .unwrap();
    assert!(storage.inspect_source_scope(scope()).is_err());
    assert!(storage.source_authority(&address, true, "epoch").is_err());
    assert_eq!(grant_json(&storage), exact);
    drop(storage);
    fs::remove_dir_all(root).unwrap();
}


#[test]
fn managed_attachment_capture_intent_has_exact_native_identity() {
    let (mut storage,root)=fixture();
    let capture="a".repeat(64);
    let input=json!({"operationId":"capture-intent","workspaceId":"workspace",
        "recordId":format!("attachment.managed-capture-intent:{capture}"),"recordType":"attachment.managed-capture-intent",
        "state":"temporary","threadId":"thread","runId":"run",
        "payloadJson":json!({"captureId":capture,"operationId":"send","ref":"attachment:selected","path":"input.txt"}).to_string(),
        "ownerIds":[],"references":[]});
    invoke(&mut storage,"storage.record.put",&input).unwrap();
    let mut changed=input.clone();changed["operationId"]=json!("mismatched-record");changed["recordId"]=json!("attachment.managed-capture-intent:other");
    assert!(invoke(&mut storage,"storage.record.put",&changed).is_err());
    changed=input;changed["operationId"]=json!("missing-run");changed.as_object_mut().unwrap().remove("runId");
    assert!(invoke(&mut storage,"storage.record.put",&changed).is_err());
    drop(storage);fs::remove_dir_all(root).unwrap();
}

#[test]
fn attachment_import_requires_exact_native_or_external_consumer() {
    let (mut storage, root) = fixture();
    let mut external = grant_params("external-actor");
    external["threadId"] = json!("external-conversation");
    external["runId"] = Value::Null;
    external["operationId"] = json!("external-transport");
    external["externalTransportId"] = json!("external-transport");
    storage.issue_grant(&external,"host","generation",&root.to_string_lossy(),"epoch").unwrap();
    let payload = json!({"principalId":"paired","coordinatorHostId":"coordinator","authorityId":"authority",
        "threadId":"external-conversation","externalTransportId":"external-transport","operationId":"delivery",
        "ref":"attachment:original","attachment":{"ref":"attachment:original","filename":"input.txt","mimeType":"text/plain","byteLength":0},
        "contentHash":format!("sha256-{}","0".repeat(64))});
    let input = json!({"operationId":"import","workspaceId":"workspace","recordId":"attachment-import:original",
        "recordType":"attachment.import","state":"preparing","threadId":"external-conversation",
        "payloadJson":payload.to_string(),"ownerIds":[],"references":[]});
    storage.domain_record_put(&input,"external-actor").unwrap();
    for (field,value) in [("externalTransportId",json!("foreign")),("threadId",json!("foreign")),("runId",json!("fake-run"))] {
        let mut changed = input.clone();
        changed["operationId"] = json!(format!("reject:{field}"));
        changed["recordId"] = json!(format!("attachment-import:reject:{field}"));
        let mut changed_payload = payload.clone();changed_payload[field] = value;
        changed["payloadJson"] = json!(changed_payload.to_string());
        assert!(storage.domain_record_put(&changed,"external-actor").is_err(),"{field}");
    }
    let mut native = input.clone();native["threadId"] = json!("thread");native["runId"] = json!("run");
    native["recordId"] = json!("attachment-import:native");native["operationId"] = json!("native-import");
    let mut native_payload = payload.clone();native_payload.as_object_mut().unwrap().remove("externalTransportId");
    native_payload["threadId"] = json!("thread");native_payload["runId"] = json!("run");
    native["payloadJson"] = json!(native_payload.to_string());
    storage.domain_record_put(&native,"actor").unwrap();
    native_payload.as_object_mut().unwrap().remove("runId");native.as_object_mut().unwrap().remove("runId");
    native["operationId"] = json!("missing-native-run");native["recordId"] = json!("attachment-import:missing-native-run");
    native["payloadJson"] = json!(native_payload.to_string());
    assert!(storage.domain_record_put(&native,"actor").is_err());
    drop(storage);fs::remove_dir_all(root).unwrap();
}

#[test]
fn isolated_external_source_authority_uses_the_original_derived_execution_identity() {
    use crate::source_resources::SourceAuthorityOpenParams;
    let (mut storage, root) = fixture();
    let directory = root.join("parent-source");
    fs::create_dir(&directory).unwrap();
    let physical = invoke(&mut storage, "file.root.register", &json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":directory})).unwrap();
    let live_root = json!({"hostId":"host","rootId":physical["rootId"],"canonicalRoot":physical["canonicalRoot"]});
    let parent_source = json!({"resource_owner":{"kind":"managed_host","hostId":"host","connectionId":"connection","endpointIdentity":"endpoint"},
        "workspace_id":"workspace","execution_workspace_id":"workspace","mode":"live_root","branch_id":null,"revision":null,"live_root":live_root});
    let parent = storage.source_authority_open(serde_json::from_value::<SourceAuthorityOpenParams>(json!({
        "principalId":"principal","coordinatorHostId":"coordinator","scope":{"kind":"run","threadId":"thread","runId":"run","epoch":1},
        "source":parent_source,"grantId":"actor","enabledTools":[],"purpose":"source"})).unwrap(),"epoch","host").unwrap();
    // Persist the original handoff through Storage's actual operation owner.
    let handoff = json!({"operation_id":"child-source-handoff:dispatch","source":parent_source,
        "root":{"kind":"physical","root":live_root},"resource_authority":{"authority_id":parent["authorityId"],"resource_epoch":parent["resourceEpoch"]}});
    storage.operation_begin("child-source-handoff:dispatch","source.handoff","original-intent").unwrap();
    storage.operation_finish("child-source-handoff:dispatch",&handoff).unwrap();
    let derived = varin_runtime::catalog::launches::native_execution_workspace_id("dispatch");
    let open = |storage: &mut Storage, id: &str, execution: &str, principal: &str, conversation: &str, native: bool| {
        let external = native;
        let mut grant = json!({"grantId":id,"hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":execution,
            "threadId":conversation,"capabilities":["storage.read","storage.write","process"],"pathScopes":[""]});
        if external {grant["operationId"]=json!(id);grant["externalTransportId"]=json!(id);}
        storage.issue_grant(&grant,"host","generation",&root.to_string_lossy(),"epoch").unwrap();
        let mut source = parent_source.clone();
        source["mode"]=json!(if native {"native_workspace"}else{"fixed_branch"});
        source["branch_id"]=json!("child-source:dispatch");source["execution_workspace_id"]=json!(execution);
        source["live_root"]=Value::Null;source["revision"]=if native {Value::Null}else{json!(0)};
        let scope = if external {json!({"kind":"external","conversationId":conversation,"transportId":id})}
            else {json!({"kind":"source_read","threadId":conversation,"branchId":"child-branch","key":id})};
        let mut input=json!({"principalId":principal,"coordinatorHostId":"coordinator","scope":scope,"source":source,
            "grantId":id,"enabledTools":[],"purpose":if external {"external_harness"}else{"read"}});
        if external {input["operationId"]=json!(id);}
        storage.source_authority_open(serde_json::from_value(input).unwrap(),"epoch","host")
    };
    let ready = open(&mut storage,"external-correct",&derived,"principal","external:child:dispatch",true).unwrap();
    assert_eq!(ready["source"]["execution_workspace_id"],derived);
    assert!(open(&mut storage,"external-parent","workspace","principal","external:child:dispatch",true).is_err());
    assert!(open(&mut storage,"external-foreign","foreign-view","principal","external:child:dispatch",true).is_err());
    assert!(open(&mut storage,"external-principal",&derived,"another-principal","external:child:dispatch",true).is_err());
    assert!(open(&mut storage,"external-conversation",&derived,"principal","external:child:another",true).is_err());
    assert!(open(&mut storage,"fixed-correct","workspace","principal","thread:child:dispatch",false).is_ok());
    assert!(open(&mut storage,"fixed-derived",&derived,"principal","thread:child:dispatch",false).is_err());
    drop(storage);fs::remove_dir_all(root).unwrap();
}
