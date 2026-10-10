#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::{Catalog, Receipt, RunState, SubmitInput};
fn selection(model: &str, source: Option<&str>) -> LaunchSelection {
    serde_json::from_value(json!({"extension_bindings":[],"connection_identity":format!("connection-{model}"),"provider_family":"fixture","model":model,"configuration_generation":2,"tool_schema_generation":if source.is_some(){2}else{0},"tools":if source.is_some(){json!([{"name":"file_read","version":"1","description":"Fixture tool","output_schema":null,"metadata":null,"schema":{}}])}else{json!([])},"policy":{"name":"agent","version":"1"},"source":source.map(|id|json!({"workspace_id":"workspace","execution_workspace_id":"execution","branch_id":id,"revision":1,"mode":"materialized","live_root":null})),"credential_scope":{"reference":model,"authority":"fixture","account":"account","generation":1}})).unwrap()
}
fn command(db: &Catalog, key: &str, branch: &str) -> SubmitInput {
    SubmitInput {
        key: key.into(),
        thread_id: "thread".into(),
        branch_id: branch.into(),
        expected_head: db.head(branch).unwrap(),
        input: json!({"text":key}),
        configuration: json!({}),
    }
}
fn complete(db: &mut Catalog, receipt: &Receipt) {
    let run = db.run(&receipt.run_id).unwrap();
    let run = db
        .transition_run(&run.id, run.epoch, run.revision, RunState::Runnable)
        .unwrap();
    db.transition_run(&run.id, run.epoch, run.revision, RunState::Completed)
        .unwrap();
}
#[test]
fn inherited_admission_preserves_environment_owner_new_model_and_original_retry_identity() {
    let root =
        std::env::temp_dir().join(format!("varin-inheritance-review-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "main").unwrap();
    let first = db
        .submit_with_launch(
            &command(&db, "first", "main"),
            Some(selection("model-a", Some("source-a"))),
        )
        .unwrap();
    complete(&mut db, &first);
    let inherited_command = command(&db, "inherited", "main");
    let chosen = selection("model-b", None);
    let next = db
        .submit_with_inherited_source(&inherited_command, chosen.clone())
        .unwrap();
    let saved = db.launch_intent(&next.run_id).unwrap().unwrap().selection;
    assert_eq!(
        saved.source.as_ref().unwrap().environment_run_id.as_deref(),
        Some(first.run_id.as_str())
    );
    assert_eq!(
        saved.source.as_ref().unwrap().branch_id.as_deref(),
        Some("source-a")
    );
    assert_eq!(saved.model, "model-b");
    assert_eq!(saved.credential_scope, chosen.credential_scope);
    assert_eq!(saved.tools.len(), 1);
    complete(&mut db, &next);
    let override_run = db
        .submit_with_launch(
            &command(&db, "override", "main"),
            Some(selection("model-c", Some("source-c"))),
        )
        .unwrap();
    complete(&mut db, &override_run);
    assert_eq!(
        db.submit_with_inherited_source(&inherited_command, chosen.clone())
            .unwrap(),
        next
    );
    assert_eq!(
        db.launch_intent(&next.run_id).unwrap().unwrap().selection,
        saved
    );
    let newest = db
        .submit_with_inherited_source(&command(&db, "newest", "main"), selection("model-d", None))
        .unwrap();
    let latest = db.launch_intent(&newest.run_id).unwrap().unwrap().selection;
    assert_eq!(
        latest.source.as_ref().unwrap().branch_id.as_deref(),
        Some("source-c")
    );
    assert_eq!(
        latest
            .source
            .as_ref()
            .unwrap()
            .environment_run_id
            .as_deref(),
        Some(override_run.run_id.as_str())
    );
    drop(db);
    let mut db = Catalog::open(&root).unwrap();
    assert_eq!(
        db.submit_with_inherited_source(&inherited_command, chosen)
            .unwrap(),
        next
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn initial_and_forked_branches_do_not_inherit_another_branchs_source() {
    let root =
        std::env::temp_dir().join(format!("varin-inheritance-review-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "main").unwrap();
    let initial = db
        .submit_with_inherited_source(&command(&db, "initial", "main"), selection("model-a", None))
        .unwrap();
    assert!(db
        .launch_intent(&initial.run_id)
        .unwrap()
        .unwrap()
        .selection
        .source
        .is_none());
    complete(&mut db, &initial);
    let source = db
        .submit_with_launch(
            &command(&db, "with-source", "main"),
            Some(selection("model-a", Some("source-a"))),
        )
        .unwrap();
    complete(&mut db, &source);
    db.fork_branch("main", "fork", Some(&source.input_id))
        .unwrap();
    let fork = db
        .submit_with_inherited_source(
            &command(&db, "fork-input", "fork"),
            selection("model-a", None),
        )
        .unwrap();
    let saved = db.launch_intent(&fork.run_id).unwrap().unwrap().selection;
    assert!(saved.source.is_none());
    assert!(saved.tools.is_empty());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
