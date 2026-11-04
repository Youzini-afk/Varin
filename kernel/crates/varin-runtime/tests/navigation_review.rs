#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::catalog::navigation::NavigationCommand;
use varin_runtime::{Catalog, RunState, SubmitInput};
#[test]
fn original_navigation_receipt_is_cas_bound_and_survives_new_history() {
    let path = std::env::temp_dir().join(format!("navigation-review-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&path).unwrap();
    db.create_thread("thread", "main").unwrap();
    let submit = |db: &mut Catalog, key: &str| {
        let r = db
            .submit(&SubmitInput {
                key: key.into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: db.head("main").unwrap(),
                input: json!({"text":key}),
                configuration: json!({}),
            })
            .unwrap();
        let run = db.run(&r.run_id).unwrap();
        let run = db
            .transition_run(&run.id, run.epoch, run.revision, RunState::Runnable)
            .unwrap();
        db.transition_run(&run.id, run.epoch, run.revision, RunState::Completed)
            .unwrap();
        db.head("main").unwrap()
    };
    let first = submit(&mut db, "first");
    let second = submit(&mut db, "second");
    let command = NavigationCommand {
        key: "rewind".into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        expected_head_id: second.clone(),
        target_head_id: first.clone(),
        undo_of: None,
        preserved_plan: None,
    };
    let prepared = db
        .prepare_navigation(command.clone())
        .unwrap()
        .load()
        .unwrap();
    let receipt = db.commit_navigation(prepared).unwrap();
    assert!(!receipt.already_applied);
    assert_eq!(db.head("main").unwrap(), first);
    let third = submit(&mut db, "third");
    let tree = db.capture_conversation_tree("thread", "main").unwrap().load(&|| false).unwrap();
    assert_eq!(tree.routes.len(), 2);
    let preserved = tree.routes.iter().find(|route| route.preserved).unwrap();
    assert_eq!(preserved.head_id, second);
    assert_eq!(db.history(&preserved.branch_id).unwrap().last().unwrap().content["text"], "second");
    assert_eq!(tree.nodes.len(), 3, "the common prefix appears only once");
    assert_eq!(tree.nodes[1].parent_id, tree.nodes[2].parent_id);
    let prepared = db
        .prepare_navigation(command.clone())
        .unwrap()
        .load()
        .unwrap();
    assert!(db.commit_navigation(prepared).unwrap().already_applied);
    assert_eq!(db.capture_conversation_tree("thread", "main").unwrap().load(&|| false).unwrap().routes.len(), 2,
        "an uncertain retry must not preserve the route twice");
    assert_eq!(
        db.head("main").unwrap(),
        third,
        "lost-response retry must not rewind new history"
    );
    assert!(
        db.prepare_navigation(NavigationCommand {
            target_head_id: None,
            ..command.clone()
        })
        .is_err()
    );
    assert!(
        db.prepare_navigation(NavigationCommand {
            key: "undo".into(),
            expected_head_id: first.clone(),
            target_head_id: second.clone(),
            undo_of: Some("rewind".into()),
            ..command.clone()
        })
        .is_err()
    );
    let reset = NavigationCommand {
        key: "second-rewind".into(),
        expected_head_id: third,
        target_head_id: first.clone(),
        ..command.clone()
    };
    let reset = db.prepare_navigation(reset).unwrap().load().unwrap();
    db.commit_navigation(reset).unwrap();
    let undo = NavigationCommand {
        key: "undo".into(),
        expected_head_id: first,
        target_head_id: second.clone(),
        undo_of: Some("rewind".into()),
        ..command
    };
    let undo = db.prepare_navigation(undo).unwrap().load().unwrap();
    db.commit_navigation(undo).unwrap();
    assert_eq!(db.head("main").unwrap(), second);
    drop(db);
    let db = Catalog::open(&path).unwrap();
    let tree = db.capture_conversation_tree("thread", "main").unwrap().load(&|| false).unwrap();
    assert_eq!(tree.routes.iter().filter(|route| route.preserved).count(), 2);
    assert!(tree.nodes.iter().any(|node| Some(&node.last_item_id) == second.as_ref()));
    assert_eq!(
        db.latest_navigation_receipt("thread", "main")
            .unwrap()
            .unwrap()
            .key,
        "undo"
    );
    drop(db);
    std::fs::remove_dir_all(path).unwrap();
}
