#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/computer_requests.rs"]
mod fixture;
use fixture::*;
use serde_json::json;
use varin_runtime::{
    catalog::{computer_requests::*, computer_wait},
    execution::*,
    *,
};
#[test]
fn real_child_request_and_wait_recover_one_environment_decision_from_both_origins() {
    for policy in [false, true] {
        let mut f = Fixture::new();
        let request = f.request(policy);
        let wait = f.wait(&request, policy);
        assert_eq!(
            f.base.db.run(&f.child_run).unwrap().state,
            RunState::Waiting
        );
        let input = f
            .base
            .db
            .prepare_input_delivery(
                &f.parent_run,
                f.base.db.epoch(),
                f.base.db.head("branch:parent").unwrap().as_deref(),
            )
            .unwrap()
            .load()
            .unwrap();
        let delivered = f.base.db.admit_input_delivery(input).unwrap().unwrap();
        assert!(delivered.activating);
        assert!(matches!(
            delivered.items[0].provenance,
            Provenance::EnvironmentFact { .. }
        ));
        let reason = f
            .base
            .db
            .prepare_result_content()
            .write_data(&json!("Original grant explanation"))
            .unwrap();
        let actor = f.user("grant-original");
        let claiming = f
            .base
            .db
            .begin_computer_decision(
                &request.id,
                request.revision,
                actor.clone(),
                true,
                "physical-epoch".into(),
                "assignment".into(),
                Some(reason),
            )
            .unwrap();
        assert_eq!(claiming.status, ComputerRequestStatus::Granting);
        let changed = f
            .base
            .db
            .prepare_result_content()
            .write_data(&json!("Changed grant explanation"))
            .unwrap();
        assert!(
            f.base
                .db
                .begin_computer_decision(
                    &request.id,
                    request.revision,
                    actor,
                    false,
                    "physical-epoch".into(),
                    "different".into(),
                    Some(changed)
                )
                .is_err()
        );
        let detail = f
            .base
            .db
            .prepare_result_content()
            .write_data(&json!("Original owner confirmed assignment ready"))
            .unwrap();
        f.base
            .db
            .settle_computer_decision(
                &request.id,
                claiming.claim.as_ref().unwrap(),
                ComputerRequestStatus::Granted,
                Some(detail),
            )
            .unwrap();
        content_collection::collect(|| f.base.db.prepare_content_collection(Default::default()))
            .unwrap();
        let reason_ref = claiming
            .claim
            .as_ref()
            .unwrap()
            .reason_ref
            .as_ref()
            .unwrap();
        let reason_object = varin_runtime::content::object_path(
            &f.base.root.join("content"),
            reason_ref["content_object"].as_str().unwrap(),
        )
        .unwrap();
        assert!(
            reason_object.is_file(),
            "the original decision reason survives replacement by settlement detail"
        );
        let root = f.base.root.clone();
        drop(f.base.db);
        f.base.db = Catalog::open(&root).unwrap();
        let owner = std::sync::Mutex::new(f.base.db);
        computer_wait::deliver_waits(&owner).unwrap();
        computer_wait::deliver_waits(&owner).unwrap();
        f.base.db = owner.into_inner().unwrap();
        let history = f
            .base
            .db
            .execution_history(&f.base.db.run(&f.child_run).unwrap().branch_id)
            .unwrap();
        assert_eq!(
            history
                .iter()
                .filter(|i| i.id == format!("computer-request-result:computer-request-wait:{wait}"))
                .count(),
            1
        );
        assert_eq!(
            f.base.db.operation(&wait).unwrap().phase,
            OperationPhase::Terminal
        );
        assert_eq!(
            f.base.db.computer_request(&request.id).unwrap().status,
            ComputerRequestStatus::Granted
        );
        f.cleanup();
    }
}
#[test]
fn root_child_observation_yields_only_for_its_real_request_and_wait_cancel_preserves_request() {
    let mut f = Fixture::new();
    let parent_wait = f.base.admit_wait("computer");
    let request = f.request(false);
    let child_wait = f.wait(&request, false);
    assert!(f.base.db.interrupt_request_observations().unwrap());
    assert_eq!(
        f.base
            .db
            .operation(parent_wait.id.strip_prefix("child-wait:").unwrap())
            .unwrap()
            .phase,
        OperationPhase::Waiting
    );
    let owner = std::sync::Mutex::new(f.base.db);
    varin_runtime::catalog::child_delivery::deliver_waits(&owner).unwrap();
    f.base.db = owner.into_inner().unwrap();
    assert_eq!(
        f.base.db.run(&f.parent_run).unwrap().state,
        RunState::Runnable
    );
    f.base.db.cancel_observation(&child_wait).unwrap();
    let owner = std::sync::Mutex::new(f.base.db);
    computer_wait::deliver_waits(&owner).unwrap();
    f.base.db = owner.into_inner().unwrap();
    assert_eq!(
        f.base.db.computer_request(&request.id).unwrap().status,
        ComputerRequestStatus::Pending
    );
    assert_eq!(
        f.base.db.operation(&child_wait).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    f.cleanup();
}

#[test]
fn decisions_before_wait_and_lost_grant_claims_deliver_without_reissuing_assignments() {
    for lost_claim in [false, true] {
        let mut f = Fixture::new();
        let request = f.request(lost_claim);
        let claimed = f
            .base
            .db
            .begin_computer_decision(
                &request.id,
                request.revision,
                f.user("decision"),
                lost_claim,
                "original-owner".into(),
                "original-assignment".into(),
                None,
            )
            .unwrap();
        if lost_claim {
            assert_eq!(claimed.status, ComputerRequestStatus::Granting);
            f.base
                .db
                .reconcile_computer_requests(Some("replacement-owner"))
                .unwrap();
        }
        let wait = f.wait(&request, lost_claim);
        let owner = std::sync::Mutex::new(f.base.db);
        computer_wait::deliver_waits(&owner).unwrap();
        f.base.db = owner.into_inner().unwrap();
        assert_eq!(
            f.base.db.operation(&wait).unwrap().outcome,
            Some(Outcome::Succeeded)
        );
        assert_eq!(
            f.base.db.computer_request(&request.id).unwrap().status,
            if lost_claim {
                ComputerRequestStatus::Indeterminate
            } else {
                ComputerRequestStatus::Denied
            }
        );
        assert!(f.base.db.pending_resumptions().unwrap().is_empty());
        f.cleanup();
    }
}

#[test]
fn requester_finishing_closes_its_wait_and_pending_notification_in_the_first_delivery_pass() {
    let mut f = Fixture::new();
    let request = f.request(false);
    let wait = f.wait(&request, false);
    let cancelled = f.base.db.request_cancel_run(&f.child_run).unwrap();
    f.base
        .db
        .transition_run(
            &f.child_run,
            f.base.db.epoch(),
            cancelled.revision,
            RunState::Cancelled,
        )
        .unwrap();
    let owner = std::sync::Mutex::new(f.base.db);
    computer_wait::deliver_waits(&owner).unwrap();
    f.base.db = owner.into_inner().unwrap();
    assert_eq!(
        f.base.db.computer_request(&request.id).unwrap().status,
        ComputerRequestStatus::Cancelled
    );
    assert_eq!(
        f.base.db.operation(&wait).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    assert!(f.base.db.pending_resumptions().unwrap().is_empty());
    assert_eq!(
        f.base.db.run(&f.child_run).unwrap().state,
        RunState::Cancelled
    );
    f.cleanup();
}
