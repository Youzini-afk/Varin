use super::*;
use crate::catalog::inference::generation::{
    generation_body, GenerationOutput, InferenceGenerateParams,
};
use crate::catalog::inference::{InferenceProblem, InferenceReceipt, InferenceUsage};
use crate::execution::{FinishReason, UsageMeasurement};

fn admission(key: &str, mode: MemoryWorkMode, start: u64) -> MemoryWorkAdmit {
    serde_json::from_value(json!({"key":key,"scopeId":"bot:original","mode":mode,
        "executionOwner":{"kind":"external","identity":"memory.organizer.v1","epoch":"host-one"},
        "claims":[{"source":"original-source-revision","start":start,"end":start+10}],"retryOf":null,
        "recipe":{"binding":{"configuration":{"providerId":"review","providerFamily":"openai-responses",
            "model":"review","endpoint":"https://memory.invalid/v1/responses","allowAnonymous":false,"configurationGeneration":1},
            "credentialScope":{"reference":"provider:review","authority":"host","account":"local-handle","generation":1}},
            "units":[{"id":"u0","text":"original frozen text"}],"presented":[{"id":7,"content":"original target"}],
            "system":"original instruction","prompt":"original prompt"}})).unwrap()
}
fn admit(db: &mut Catalog, p: &MemoryWorkAdmit) -> String {
    let body = db.prepare_inference_content().write(&p.recipe).unwrap();
    db.admit_memory_work(p, body).unwrap()
}
fn change(
    db: &mut Catalog,
    id: &str,
    owner: &ExecutorOwner,
    action: MemoryWorkAction,
) -> Result<()> {
    db.update_memory_work(&MemoryWorkUpdate {
        work_id: id.into(),
        execution_owner: owner.clone(),
        expected_revision: db.operation(id)?.revision,
        action,
    })
}
fn generation(p: &MemoryWorkAdmit, id: &str) -> InferenceGenerateParams {
    serde_json::from_value(json!({"parentOperationId":format!("{id}:generation"),"callerOwner":p.execution_owner,"ordinal":1,
        "configuration":p.recipe["binding"]["configuration"],"credentialScope":p.recipe["binding"]["credentialScope"],
        "purpose":"memory-organizer","systemPrompt":"original instruction","user":"original prompt"})).unwrap()
}
fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("varin-memory-work-{}", Uuid::new_v4()))
}

#[test]
fn work_uses_its_own_run_and_exact_source_claim_without_a_conversation_or_goal() {
    let mut db = Catalog::open(root()).unwrap();
    let p = admission("automatic", MemoryWorkMode::Automatic, 0);
    let id = admit(&mut db, &p);
    let view = db.capture_memory_work(&id).unwrap().load().unwrap();
    assert_eq!(view.recipe, p.recipe);
    assert!(db.goal_binding(&view.run_id).unwrap().is_none());
    assert!(db.capture_launch(&view.run_id).unwrap().is_none());
    assert!(db.list_threads().unwrap().is_empty());
    assert!(db
        .execution_history(&format!("{id}:branch"))
        .unwrap()
        .is_empty());
    assert!(db
        .prepare_branch_fork(&format!("{id}:branch"), "borrowed-branch", None, None)
        .is_err());
    let overlap = admission("overlap", MemoryWorkMode::Automatic, 5);
    let body = db
        .prepare_inference_content()
        .write(&overlap.recipe)
        .unwrap();
    assert!(db.admit_memory_work(&overlap, body).is_err());
    admit(
        &mut db,
        &admission("other-range", MemoryWorkMode::Automatic, 10),
    );
    let request = generation(&p, &id);
    let body = db
        .prepare_inference_content()
        .write(&serde_json::to_value(&request).unwrap())
        .unwrap();
    assert!(
        db.admit_inference_generation(&request, body).is_err(),
        "automatic generation requires original decision"
    );
}
#[test]
fn recovery_is_read_only_until_explicit_claim_and_old_owner_is_fenced() {
    let path = root();
    let mut db = Catalog::open(&path).unwrap();
    let p = admission("recover", MemoryWorkMode::Automatic, 0);
    let id = admit(&mut db, &p);
    change(
        &mut db,
        &id,
        &p.execution_owner,
        MemoryWorkAction::Decision { keep: vec![0] },
    )
    .unwrap();
    let before = db.operation(&id).unwrap();
    drop(db);
    let mut db = Catalog::open(&path).unwrap();
    let after = db.operation(&id).unwrap();
    assert_eq!(before.epoch, after.epoch);
    assert_ne!(after.epoch, db.epoch());
    assert!(stage_live(
        &db.db,
        &db.operation(&stage(&id, "generation")).unwrap(),
        &p.execution_owner,
        db.epoch()
    )
    .is_err());
    let mut next = p.clone();
    next.execution_owner = ExecutorOwner::External {
        identity: "memory.organizer.v1".into(),
        epoch: "host-two".into(),
    };
    change(&mut db, &id, &next.execution_owner, MemoryWorkAction::Claim).unwrap();
    assert!(stage_live(
        &db.db,
        &db.operation(&stage(&id, "generation")).unwrap(),
        &p.execution_owner,
        db.epoch()
    )
    .is_err());
    stage_live(
        &db.db,
        &db.operation(&stage(&id, "generation")).unwrap(),
        &next.execution_owner,
        db.epoch(),
    )
    .unwrap();
    assert_eq!(
        db.capture_memory_work(&id).unwrap().load().unwrap().recipe,
        p.recipe
    );
}
#[test]
fn dispatched_unknown_preserves_frozen_batch_and_cannot_replay_or_block_another_range() {
    let path = root();
    let mut db = Catalog::open(&path).unwrap();
    let p = admission("unknown", MemoryWorkMode::Selection, 0);
    let id = admit(&mut db, &p);
    let request = generation(&p, &id);
    let body = db
        .prepare_inference_content()
        .write(&serde_json::to_value(&request).unwrap())
        .unwrap();
    let inference = db.admit_inference_generation(&request, body).unwrap();
    db.dispatch_inference_generation(&inference.operation_id)
        .unwrap();
    drop(db);
    let mut db = Catalog::open(&path).unwrap();
    let view = db.capture_memory_work(&id).unwrap().load().unwrap();
    assert_eq!(view.recipe, p.recipe);
    assert_eq!(view.inference[0].effect, Effect::Unknown);
    assert!(change(&mut db, &id, &p.execution_owner, MemoryWorkAction::Claim).is_err());
    let mut retry = admission("retry", MemoryWorkMode::Selection, 0);
    retry.retry_of = Some(id);
    let body = db.prepare_inference_content().write(&retry.recipe).unwrap();
    assert!(db.admit_memory_work(&retry, body).is_err());
    admit(&mut db, &admission("other", MemoryWorkMode::Automatic, 20));
}
#[test]
fn original_generation_receipt_and_batch_survive_consumption_and_observer_ack_retries() {
    let path = root();
    let mut db = Catalog::open(&path).unwrap();
    let p = admission("complete", MemoryWorkMode::Selection, 0);
    let id = admit(&mut db, &p);
    let request = generation(&p, &id);
    let body = db
        .prepare_inference_content()
        .write(&serde_json::to_value(&request).unwrap())
        .unwrap();
    let inference = db.admit_inference_generation(&request, body).unwrap();
    db.dispatch_inference_generation(&inference.operation_id)
        .unwrap();
    let receipt = InferenceReceipt {
        request_started: Some(true),
        provider_completed: true,
        local_executor_stopped: true,
        usage: InferenceUsage {
            measurement: UsageMeasurement::Actual,
            input_tokens: Some(19),
            output_tokens: Some(7),
            ..Default::default()
        },
        http_status: Some(200),
        problem: None,
    };
    let output = GenerationOutput {
        finish_reason: Some(FinishReason::Stop),
        ..Default::default()
    };
    let response = generation_body(
        None,
        &output,
        Some(&receipt),
        None,
        Some("original response"),
    );
    let body = db.prepare_inference_content().write(&response).unwrap();
    db.settle_inference_generation(&inference.operation_id, body, receipt)
        .unwrap();
    let ack = MemoryWorkUpdate {
        work_id: id.clone(),
        execution_owner: p.execution_owner.clone(),
        expected_revision: db.operation(&id).unwrap().revision,
        action: MemoryWorkAction::Finish,
    };
    db.update_memory_work(&ack).unwrap();
    db.update_memory_work(&ack).unwrap();
    assert!(db.memory_work_ids("bot:original").unwrap().is_empty());
    // Consumed work leaves the pending list, but its original recipe and
    // inference output remain durable roots of the real ContentStore sweep.
    let collection = db.prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        crate::ContentCollectionStatus::Completed
    );
    drop(db);
    let db = Catalog::open(&path).unwrap();
    let view = db.capture_memory_work(&id).unwrap().load().unwrap();
    assert_eq!(view.recipe, p.recipe);
    assert!(view.consumed);
    let value = view.inference[0]
        .result
        .as_ref()
        .unwrap()
        .control()
        .unwrap();
    assert_eq!(value["response"], response);
    assert_eq!(value["response"]["providerOutput"]["finishReason"], "stop");
}
#[test]
fn explicit_selection_retry_requires_original_stopped_failure() {
    let mut db = Catalog::open(root()).unwrap();
    let p = admission("no-send", MemoryWorkMode::Selection, 0);
    let id = admit(&mut db, &p);
    let mut retry = admission("retry", MemoryWorkMode::Selection, 0);
    retry.retry_of = Some(id.clone());
    let body = db.prepare_inference_content().write(&retry.recipe).unwrap();
    assert!(db.admit_memory_work(&retry, body).is_err());
    db.request_cancel_run(&format!("{id}:run")).unwrap();
    admit(&mut db, &retry);
    let p = admission("stopped", MemoryWorkMode::Selection, 0);
    let id = admit(&mut db, &p);
    let request = generation(&p, &id);
    let body = db
        .prepare_inference_content()
        .write(&serde_json::to_value(request).unwrap())
        .unwrap();
    let op = db
        .admit_inference_generation(&generation(&p, &id), body)
        .unwrap();
    db.dispatch_inference_generation(&op.operation_id).unwrap();
    let receipt = InferenceReceipt {
        request_started: Some(false),
        provider_completed: false,
        local_executor_stopped: true,
        usage: Default::default(),
        http_status: None,
        problem: Some(InferenceProblem::NotDispatched),
    };
    let body = db
        .prepare_inference_content()
        .write(&json!({"error":"known no send"}))
        .unwrap();
    db.settle_inference_generation(&op.operation_id, body, receipt)
        .unwrap();
    let mut retry = admission("stopped-retry", MemoryWorkMode::Selection, 0);
    retry.retry_of = Some(id);
    admit(&mut db, &retry);
}

#[test]
fn wake_resumes_only_unsent_generation_and_preserves_completed_decision_and_cancel_history() {
    use crate::catalog::inference::{
        InferenceAdmitParams, InferenceOwnerParams, InferenceSettleParams,
    };
    for completed_decision in [false, true] {
        let mut db = Catalog::open(root()).unwrap();
        let mut p = admission("wake", MemoryWorkMode::Automatic, 0);
        p.recipe["decisionStatus"] = json!({"status":"ready","binding":{"configurationId":"original-classifier","providerId":"review","modelId":"classifier"}});
        let id = admit(&mut db, &p);
        let mut decision_id = None;
        if completed_decision {
            let request:InferenceAdmitParams=serde_json::from_value(json!({"parentOperationId":stage(&id,"decision"),"executionOwner":p.execution_owner,"ordinal":1,
                "binding":{"requestKind":"model_compute","purpose":"memory-organization","providerId":"review","modelId":"classifier","configurationId":"original-classifier",
                    "executor":{"kind":"http","api":"typesafe-system-one","endpoint":"https://memory.invalid/systemone","credentialScope":p.recipe["binding"]["credentialScope"]}},
                "request":{"original":"frozen classifier question"}})).unwrap();
            let body = db
                .prepare_inference_content()
                .write(&request.request)
                .unwrap();
            let op = db.admit_inference(&request, body).unwrap();
            db.dispatch_inference(&InferenceOwnerParams {
                operation_id: op.operation_id.clone(),
                execution_owner: p.execution_owner.clone(),
            })
            .unwrap();
            let settled = InferenceSettleParams {
                operation_id: op.operation_id.clone(),
                execution_owner: p.execution_owner.clone(),
                receipt: InferenceReceipt {
                    request_started: Some(true),
                    provider_completed: true,
                    local_executor_stopped: true,
                    usage: Default::default(),
                    http_status: Some(200),
                    problem: None,
                },
                response: json!({"answers":{"u0":{"type":"noul","noul":0.8}}}),
            };
            let body = db
                .prepare_inference_content()
                .write(&settled.response)
                .unwrap();
            db.settle_inference(&settled, body).unwrap();
            decision_id = Some(op.operation_id);
        }
        change(
            &mut db,
            &id,
            &p.execution_owner,
            MemoryWorkAction::Decision { keep: vec![0] },
        )
        .unwrap();
        db.request_cancel_run(&format!("{id}:run")).unwrap();
        let original = decision_id
            .as_ref()
            .map(|id| serde_json::to_value(db.operation(id).unwrap()).unwrap());
        change(&mut db, &id, &p.execution_owner, MemoryWorkAction::Resume).unwrap();
        let work = db.capture_memory_work(&id).unwrap().load().unwrap();
        assert!(!work.cancelled);
        assert_eq!(work.recipe, p.recipe);
        assert_eq!(work.decision, Some(vec![0]));
        if let Some(decision_id) = decision_id {
            assert_eq!(
                serde_json::to_value(db.operation(&decision_id).unwrap()).unwrap(),
                original.unwrap()
            );
        }
        let events = db.events_after(0, 100).unwrap();
        assert!(events.iter().any(|e| e.kind == "run.cancel_requested"));
        assert!(events.iter().any(|e| e.kind == "memory.work.resumed"));
        let request = generation(&p, &id);
        let body = db
            .prepare_inference_content()
            .write(&serde_json::to_value(&request).unwrap())
            .unwrap();
        let operation = db.admit_inference_generation(&request, body).unwrap();
        db.dispatch_inference_generation(&operation.operation_id)
            .unwrap();
        db.request_cancel_run(&format!("{id}:run")).unwrap();
        assert!(
            change(&mut db, &id, &p.execution_owner, MemoryWorkAction::Resume).is_err(),
            "an unresolved dispatched generation can never be resumed"
        );
    }
}

#[test]
fn explicit_retry_after_confirmed_local_drain_keeps_original_unknown_charge() {
    let mut db = Catalog::open(root()).unwrap();
    let p = admission("paid-unknown", MemoryWorkMode::Selection, 0);
    let id = admit(&mut db, &p);
    let request = generation(&p, &id);
    let body = db
        .prepare_inference_content()
        .write(&serde_json::to_value(&request).unwrap())
        .unwrap();
    let op = db.admit_inference_generation(&request, body).unwrap();
    db.dispatch_inference_generation(&op.operation_id).unwrap();
    let receipt = InferenceReceipt {
        request_started: Some(true),
        provider_completed: false,
        local_executor_stopped: true,
        usage: Default::default(),
        http_status: None,
        problem: Some(InferenceProblem::TransportFailed),
    };
    let body = db
        .prepare_inference_content()
        .write(&json!({"original":"incomplete transport evidence"}))
        .unwrap();
    db.settle_inference_generation(&op.operation_id, body, receipt)
        .unwrap();
    assert_eq!(
        db.operation(&op.operation_id).unwrap().effect,
        Effect::Unknown
    );
    let mut retry = admission("explicit-new-attempt", MemoryWorkMode::Selection, 0);
    retry.retry_of = Some(id);
    admit(&mut db, &retry);
    assert_eq!(
        db.operation(&op.operation_id).unwrap().effect,
        Effect::Unknown,
        "a new explicit intent never rewrites the original billable unknown"
    );
}
