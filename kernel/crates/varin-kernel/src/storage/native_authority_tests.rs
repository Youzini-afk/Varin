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
