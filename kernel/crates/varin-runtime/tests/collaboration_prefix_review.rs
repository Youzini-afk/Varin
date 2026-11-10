//! Original queue/report delivery plus actual Responses wire serialization. This proves
//! append order and frozen bytes, not a provider's server-side cache-hit accounting.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
use serde_json::json;
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::messages::MessageInput;
use varin_runtime::execution::*;
use varin_runtime::providers::{
    Connection, CredentialResolver, HttpRequest, HttpTransport, responses::ResponsesProvider,
};
use varin_runtime::{Catalog, MessageKind};
struct NoNetwork;
impl CredentialResolver for NoNetwork {
    fn headers(
        &self,
        _: Option<&str>,
        _: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
        panic!("serialization never resolves credentials")
    }
}
impl HttpTransport for NoNetwork {
    fn stream(
        &self,
        _: HttpRequest<'_>,
        _: &CancellationToken,
        _: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        panic!("serialization never sends a request")
    }
}
fn view(db: &Catalog, run: &str, step: u64) -> RequestView {
    let range = HistoryRange {
        branch_id: "branch:parent".into(),
        ancestor_id: None,
        leaf_id: db.head("branch:parent").unwrap(),
    };
    let launch = db.launch_intent(run).unwrap().unwrap().selection;
    let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
        "connection_identity":launch.connection_identity,"provider_family":"openai-responses","model":launch.model,"credential_ref":null,"configuration_generation":launch.configuration_generation,"tool_schema_generation":launch.tool_schema_generation,
        "tools":launch.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
    RequestView {
        request_id: format!("adjacent:{step}"),
        run_id: run.into(),
        origin: RequestOrigin::Conversation {
            compaction: None,
            step,
            history_range: range,
        },
        binding,
        history: db.execution_history("branch:parent").unwrap(),
    }
}
fn deliver(db: &mut Catalog, run: &str) {
    let head = db.head("branch:parent").unwrap();
    let read = db
        .prepare_input_delivery(run, db.epoch(), head.as_deref())
        .unwrap()
        .load()
        .unwrap();
    assert!(db.admit_input_delivery(read).unwrap().is_some());
}
#[test]
fn adjacent_frozen_requests_append_original_collaboration_message_and_report_without_status_tail() {
    let mut f = fixture::Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let provider = ResponsesProvider::new(Connection::new(
        "https://fixture.invalid",
        Arc::new(NoNetwork),
        Arc::new(NoNetwork),
    ));
    let first = provider.serialize(&view(&f.db, &run, 2), None).unwrap();
    let frozen_first = first.to_value();
    let message =
        f.db.prepare_user_message(
            "collaboration-update".into(),
            child.child_thread_id.clone(),
            child.child_branch_id.clone(),
            MessageInput {
                attachments: vec![],
                after_current: None,
                source_agent: None,
                name: None,
                wait: None,
                target_thread_id: Some("thread:parent".into()),
                target_branch_id: Some("branch:parent".into()),
                reply_to: None,
                kind: MessageKind::Inform,
                text: "The source has a conflicting date; keep the original evidence.".into(),
            },
        )
        .unwrap()
        .load()
        .unwrap();
    let message = f.db.admit_message(message).unwrap().receipt;
    assert_eq!(
        provider
            .serialize(&view(&f.db, &run, 2), None)
            .unwrap()
            .to_value(),
        frozen_first,
        "queued messages never rewrite the frozen input"
    );
    deliver(&mut f.db, &run);
    let second = provider.serialize(&view(&f.db, &run, 3), None).unwrap();
    let frozen_second = second.to_value();
    f.db.fail_delegated_preparation(&child.execution_id, "source_unavailable", None)
        .unwrap();
    let owner = Mutex::new(f.db);
    varin_runtime::catalog::child_delivery::reconcile_reports(&owner).unwrap();
    varin_runtime::catalog::child_delivery::reconcile_reports(&owner).unwrap();
    let mut db = owner.into_inner().unwrap();
    assert_eq!(
        provider
            .serialize(&view(&db, &run, 3), None)
            .unwrap()
            .to_value(),
        frozen_second,
        "a pending report does not mutate delivered context"
    );
    deliver(&mut db, &run);
    let third = provider
        .serialize(&view(&db, &run, 4), None)
        .unwrap()
        .to_value();
    for (older, newer) in [(&frozen_first, &frozen_second), (&frozen_second, &third)] {
        let old = older["input"].as_array().unwrap();
        let new = newer["input"].as_array().unwrap();
        assert!(new.len() > old.len());
        assert_eq!(
            &new[..old.len()],
            old,
            "whole wire input remains an exact prefix, not just matching IDs"
        );
    }
    assert_eq!(first.to_value(), frozen_first);
    assert_eq!(second.to_value(), frozen_second);
    let history = db.execution_history("branch:parent").unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|item| item.id == message.identity.message_id)
            .count(),
        1
    );
    let serialized = serde_json::to_string(&third).unwrap();
    assert!(serialized.contains("source_unavailable"));
    assert!(!serialized.contains("teammates:"));
    let before = third["input"].clone();
    drop(db);
    let db = Catalog::open(&f.root).unwrap();
    assert_eq!(
        provider
            .serialize(&view(&db, &run, 4), None)
            .unwrap()
            .to_value()["input"],
        before
    );
    drop(db);
    std::fs::remove_dir_all(f.root).unwrap();
}
