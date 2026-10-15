//! Standalone product text requests. These Runs have no Thread, branch, Bot or Goal.
//! Admission freezes the request; original inference owns dispatch, usage and stop evidence.
use super::*;
use crate::catalog::inference::generation::InferenceGenerateParams;
use serde::Deserialize;

pub const KIND: &str = "model_text_v1";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelTextAdmit {
    pub key: String,
    pub request_fingerprint: String,
    pub retry_of: Option<String>,
    pub generation: InferenceGenerateParams,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelTextReadParams {
    pub request_id: String,
    #[serde(default)]
    pub allow_missing: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTextView {
    pub request_id: String,
    pub request_fingerprint: String,
    pub run_id: String,
    pub generation: InferenceGenerateParams,
    pub cancelled: bool,
    pub retry_allowed: bool,
    pub inference: Option<Operation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTextStatus {
    pub request_id: String,
    pub request_fingerprint: String,
    pub run_id: String,
    pub execution_owner: ExecutorOwner,
    pub provider_id: String,
    pub model_id: String,
    pub purpose: String,
    pub effect: Effect,
    pub cancelled: bool,
    pub retry_allowed: bool,
    pub inference: Option<inference::InferenceStatus>,
}
use super::utility_run::UtilityRun;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    kind: String,
    request_fingerprint: String,
    provider_id: String,
    model_id: String,
    purpose: String,
    retry_of: Option<String>,
    request_ref: Value,
}
pub struct ModelTextRead {
    root: Operation,
    intent: Intent,
    retry_allowed: bool,
    inference: Option<Operation>,
    content: crate::content::ContentStore,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
impl ModelTextRead {
    pub fn load(mut self) -> Result<ModelTextView> {
        let generation = serde_json::from_value(self.content.load(&self.reference)?)?;
        if let Some(child) = &mut self.inference {
            inference::hydrate_operation(child, &self.content)?;
        }
        Ok(ModelTextView {
            request_id: self.root.id,
            request_fingerprint: self.intent.request_fingerprint,
            run_id: self.root.run_id,
            generation,
            cancelled: self.root.cancel_requested,
            retry_allowed: self.retry_allowed,
            inference: self.inference,
        })
    }
}
fn invalid() -> RuntimeError {
    RuntimeError::Conflict("model_text_identity_changed".into())
}
fn intent(op: &Operation) -> Result<Intent> {
    if op.intent["kind"] != KIND {
        return Err(invalid());
    }
    Ok(serde_json::from_value(op.intent.clone())?)
}
fn child_id(id: &str) -> String {
    format!("inference:{id}:1")
}
fn child(db: &Connection, id: &str) -> Result<Option<Operation>> {
    optional_record(db, "operations", &child_id(id))
}
fn stopped(op: &Operation) -> bool {
    let s = op.result.as_ref().and_then(|v| v.control().ok());
    op.phase == OperationPhase::Terminal
        && s.is_some_and(|s| {
            s["receipt"]["localExecutorStopped"] == true || s["dispatched"] == false
        })
}
fn retry_allowed(db: &Connection, root: &Operation) -> Result<bool> {
    Ok(match child(db, &root.id)? {
        Some(op) => stopped(&op) && op.outcome != Some(Outcome::Succeeded),
        None => root.cancel_requested,
    })
}
pub(super) fn parent_live(
    db: &Connection,
    parent: &Operation,
    owner: &ExecutorOwner,
    epoch: u64,
) -> Result<()> {
    intent(parent)?;
    let run: UtilityRun = record(db, "runs", &parent.run_id)?;
    if run.kind != KIND || parent.execution_owner.as_ref() != Some(owner) {
        return Err(invalid());
    }
    if run.epoch != epoch
        || parent.epoch != epoch
        || run.state.terminal()
        || run.cancel_requested
        || parent.cancel_requested
        || parent.phase == OperationPhase::Terminal
    {
        return Err(RuntimeError::DispatchCancelled);
    }
    Ok(())
}
pub(super) fn validate_generation(
    db: &Connection,
    p: &InferenceGenerateParams,
    reference: &Value,
    epoch: u64,
) -> Result<String> {
    let parent: Operation = record(db, "operations", &p.parent_operation_id)?;
    let i = intent(&parent)?;
    parent_live(db, &parent, &p.caller_owner, epoch)?;
    if p.ordinal != 1 || &i.request_ref != reference {
        return Err(invalid());
    }
    Ok(parent.run_id)
}
/// Called in the original child's receipt transaction, including recovery. No new execution.
pub(super) fn settle_parent(tx: &Transaction<'_>, inference: &Operation) -> Result<()> {
    if inference.intent["caller"]["kind"] != "model_text" {
        return Ok(());
    }
    let id = inference.intent["parentOperationId"]
        .as_str()
        .ok_or_else(invalid)?;
    let mut root: Operation = record(tx, "operations", id)?;
    intent(&root)?;
    if inference.phase != OperationPhase::Terminal {
        return Ok(());
    }
    root.phase = OperationPhase::Terminal;
    root.outcome = inference.outcome;
    root.effect = inference.effect;
    root.revision += 1;
    put(tx, "operations", id, &root)?;
    let mut run: UtilityRun = record(tx, "runs", &root.run_id)?;
    run.state = match inference.outcome {
        Some(Outcome::Succeeded) => RunState::Completed,
        Some(Outcome::Cancelled) => RunState::Cancelled,
        _ => RunState::Failed,
    };
    run.revision += 1;
    put(tx, "runs", &run.id, &run)?;
    event(
        tx,
        id,
        root.revision,
        "model_text.settled",
        json!({"runId":run.id,"inferenceId":inference.id}),
    )?;
    Ok(())
}
pub(super) fn recover(tx: &Transaction<'_>, op: &mut Operation, epoch: u64) -> Result<bool> {
    if op.intent["kind"] != KIND {
        return Ok(false);
    }
    intent(op)?;
    if op.phase != OperationPhase::Terminal {
        op.cancel_requested = true;
        op.epoch = epoch;
        op.revision += 1;
        if child(tx, &op.id)?.is_none() {
            op.phase = OperationPhase::Terminal;
            op.outcome = Some(Outcome::Cancelled);
            let mut run: UtilityRun = record(tx, "runs", &op.run_id)?;
            run.state = RunState::Cancelled;
            run.revision += 1;
            put(tx, "runs", &run.id, &run)?;
        }
        put(tx, "operations", &op.id, op)?;
        event(tx, &op.id, op.revision, "model_text.recovered", Value::Null)?;
    }
    Ok(true)
}
impl Catalog {
    pub fn admit_model_text(
        &mut self,
        p: &ModelTextAdmit,
        body: inference::InferenceBody,
    ) -> Result<String> {
        let g = &p.generation;
        let id = format!("model-text:{}", p.key);
        if p.key.trim().is_empty()
            || p.request_fingerprint.is_empty()
            || g.configuration
                .provider_id
                .as_ref()
                .is_none_or(|id| id.trim().is_empty())
            || g.parent_operation_id != id
            || g.ordinal != 1
            || !matches!(
                g.purpose.as_str(),
                "git-commit" | "review" | "walkthrough" | "text"
            )
            || g.user.trim().is_empty()
            || g.system_prompt.trim().is_empty()
            || !matches!(&g.caller_owner,ExecutorOwner::External{identity,epoch} if identity == "model.text.v1" && !epoch.is_empty())
        {
            return Err(invalid());
        }
        crate::model_session::connection_identity_with_scope(&g.configuration, &g.credential_scope)
            .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        let frozen = Intent {
            kind: KIND.into(),
            request_fingerprint: p.request_fingerprint.clone(),
            provider_id: g.configuration.provider_id.clone().ok_or_else(invalid)?,
            model_id: g
                .configuration
                .model_options
                .as_ref()
                .and_then(|v| v["catalogModelId"].as_str())
                .unwrap_or(&g.configuration.model)
                .to_owned(),
            purpose: g.purpose.clone(),
            retry_of: p.retry_of.clone(),
            request_ref: body.reference,
        };
        if let Some(previous) = optional_record::<Operation>(&self.db, "operations", &id)? {
            let i = intent(&previous)?;
            if i.request_fingerprint != p.request_fingerprint || i.retry_of != p.retry_of {
                return Err(invalid());
            }
            return Ok(id);
        }
        if let Some(previous) = &p.retry_of {
            let old = self.operation(previous)?;
            intent(&old)?;
            if !retry_allowed(&self.db, &old)? {
                return Err(RuntimeError::Conflict(
                    "model_text_retry_requires_original_stopped_failure".into(),
                ));
            }
        }
        let run = UtilityRun {
            kind: KIND.into(),
            id: format!("{id}:run"),
            state: RunState::Executing,
            epoch: self.epoch,
            revision: 1,
            cancel_requested: false,
        };
        let root = Operation {
            id: id.clone(),
            run_id: run.id.clone(),
            epoch: self.epoch,
            revision: 1,
            phase: OperationPhase::Running,
            outcome: None,
            effect: Effect::None,
            cancel_requested: false,
            lifetime: Lifetime::Run,
            handed_off: false,
            executor: Some("model.text.v1".into()),
            execution_owner: Some(g.caller_owner.clone()),
            waiting_on: None,
            intent: serde_json::to_value(frozen)?,
            result: Some(OperationResultMetadata::Control { value: Value::Null }),
            host_job: None,
            mcp_resource_subscription: None,
            managed_process: None,
            external_receipt: None,
            call_completion: None,
        };
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO runs(id,branch_id,body) VALUES(?1,NULL,?2)",
            params![run.id, encode(&run)?],
        )?;
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![id, run.id, encode(&root)?],
        )?;
        event(&tx, &id, 1, "model_text.admitted", json!({"runId":run.id}))?;
        tx.commit()?;
        Ok(id)
    }
    pub fn model_text_status(&self, id: &str) -> Result<ModelTextStatus> {
        let root = self.operation(id)?;
        let i = intent(&root)?;
        let child = child(&self.db, id)?;
        Ok(ModelTextStatus {
            request_id: root.id.clone(),
            request_fingerprint: i.request_fingerprint,
            run_id: root.run_id.clone(),
            execution_owner: root.execution_owner.clone().ok_or_else(invalid)?,
            provider_id: i.provider_id,
            model_id: i.model_id,
            purpose: i.purpose,
            effect: child.as_ref().map_or(root.effect, |op| op.effect),
            cancelled: root.cancel_requested,
            retry_allowed: retry_allowed(&self.db, &root)?,
            inference: child
                .as_ref()
                .map(|op| self.inference_observation(op))
                .transpose()?,
        })
    }
    pub fn capture_model_text(&self, id: &str) -> Result<ModelTextRead> {
        let root = self.operation(id)?;
        let i = intent(&root)?;
        Ok(ModelTextRead {
            retry_allowed: retry_allowed(&self.db, &root)?,
            inference: child(&self.db, id)?,
            root,
            reference: i.request_ref.clone(),
            intent: i,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }

    pub fn cancel_model_text(&mut self, id: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut root: Operation = record(&tx, "operations", id)?;
        intent(&root)?;
        if root.phase == OperationPhase::Terminal {
            tx.commit()?;
            return Ok(());
        }
        root = request_cancel_operation_in(&tx, id)?;
        let mut run: UtilityRun = record(&tx, "runs", &root.run_id)?;
        run.cancel_requested = true;
        run.revision += 1;
        if child(&tx, id)?.is_none() {
            root.phase = OperationPhase::Terminal;
            root.outcome = Some(Outcome::Cancelled);
            root.revision += 1;
            put(&tx, "operations", id, &root)?;
            run.state = RunState::Cancelled;
        }
        put(&tx, "runs", &run.id, &run)?;
        event(
            &tx,
            id,
            root.revision,
            "model_text.cancel_requested",
            Value::Null,
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::inference::{InferenceProblem, InferenceReceipt, InferenceUsage};
    fn input(key: &str) -> ModelTextAdmit {
        serde_json::from_value(json!({"key":key,"requestFingerprint":format!("fingerprint:{key}"),"retryOf":null,
      "generation":{"parentOperationId":format!("model-text:{key}"),"callerOwner":{"kind":"external","identity":"model.text.v1","epoch":"host"},"ordinal":1,
        "configuration":{"providerId":"chosen","providerFamily":"openai-responses","model":"original","endpoint":"https://utility.invalid/v1/responses","configurationGeneration":1,"allowAnonymous":false},
        "credentialScope":{"reference":"provider:chosen","authority":"host","account":"account","generation":1},"purpose":"git-commit","systemPrompt":"Original instruction","user":"Original prompt"}})).unwrap()
    }
    fn open() -> (std::path::PathBuf, Catalog) {
        let path = std::env::temp_dir().join(format!("varin-model-text-{}", Uuid::new_v4()));
        let db = Catalog::open(&path).unwrap();
        (path, db)
    }
    fn admit(db: &mut Catalog, p: &ModelTextAdmit) -> String {
        let body = db
            .prepare_inference_content()
            .write(&serde_json::to_value(&p.generation).unwrap())
            .unwrap();
        db.admit_model_text(p, body).unwrap()
    }
    fn generate(db: &mut Catalog, p: &ModelTextAdmit) -> String {
        let body = db
            .prepare_inference_content()
            .write(&serde_json::to_value(&p.generation).unwrap())
            .unwrap();
        db.admit_inference_generation(&p.generation, body)
            .unwrap()
            .operation_id
    }
    fn settle(db: &mut Catalog, id: &str, ok: bool) {
        let receipt = InferenceReceipt {
            request_started: Some(true),
            provider_completed: ok,
            local_executor_stopped: true,
            usage: InferenceUsage::default(),
            http_status: None,
            problem: (!ok).then_some(InferenceProblem::TransportFailed),
        };
        let body = db
            .prepare_inference_content()
            .write(&json!({"text":"Original answer"}))
            .unwrap();
        db.settle_inference_generation(id, body, receipt).unwrap();
    }
    #[test]
    fn standalone_admission_has_no_conversation_and_freezes_the_original_request() {
        let (_, mut db) = open();
        let p = input("original");
        let id = admit(&mut db, &p);
        assert!(db.list_threads().unwrap().is_empty());
        assert_eq!(
            db.db
                .query_row("SELECT count(*) FROM branches", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(db.run(&format!("{id}:run")).is_err()); // No fake conversational Run DTO.
        let original = db.capture_model_text(&id).unwrap().load().unwrap();
        assert_eq!(original.generation.user, "Original prompt");
        let mut duplicate = p.clone();
        duplicate.generation.configuration.model = "new-default".into();
        assert_eq!(admit(&mut db, &duplicate), id);
        assert_eq!(
            db.capture_model_text(&id)
                .unwrap()
                .load()
                .unwrap()
                .generation
                .configuration
                .model,
            "original"
        );
        let body = db
            .prepare_inference_content()
            .write(&serde_json::to_value(&duplicate.generation).unwrap())
            .unwrap();
        assert!(
            db.admit_inference_generation(&duplicate.generation, body)
                .is_err()
        );
    }
    #[test]
    fn original_usage_result_and_explicit_retry_wait_for_transport_drain() {
        let (_, mut db) = open();
        let p = input("original");
        let id = admit(&mut db, &p);
        let inference = generate(&mut db, &p);
        db.dispatch_inference_generation(&inference).unwrap();
        db.cancel_model_text(&id).unwrap();
        let view = db.capture_model_text(&id).unwrap().load().unwrap();
        assert!(!view.retry_allowed);
        assert!(view.cancelled);
        let mut retry = input("retry");
        retry.retry_of = Some(id.clone());
        let body = db
            .prepare_inference_content()
            .write(&serde_json::to_value(&retry.generation).unwrap())
            .unwrap();
        assert!(db.admit_model_text(&retry, body).is_err());
        settle(&mut db, &inference, false);
        let view = db.capture_model_text(&id).unwrap().load().unwrap();
        assert!(view.retry_allowed);
        assert_eq!(view.inference.unwrap().effect, Effect::Unknown);
        admit(&mut db, &retry);
    }
    #[test]
    fn completed_original_is_inspectable_after_restart_without_new_model_or_thread() {
        let (path, mut db) = open();
        let p = input("finished");
        let id = admit(&mut db, &p);
        let inference = generate(&mut db, &p);
        db.dispatch_inference_generation(&inference).unwrap();
        settle(&mut db, &inference, true);
        drop(db);
        let db = Catalog::open(path).unwrap();
        let view = db.capture_model_text(&id).unwrap().load().unwrap();
        assert!(!view.retry_allowed);
        assert_eq!(view.inference.unwrap().outcome, Some(Outcome::Succeeded));
        assert!(db.list_threads().unwrap().is_empty());
    }
    #[test]
    fn restored_uncertain_dispatch_is_never_replayed_or_mislabeled_stopped() {
        let (path, mut db) = open();
        let p = input("uncertain");
        let id = admit(&mut db, &p);
        let inference = generate(&mut db, &p);
        db.dispatch_inference_generation(&inference).unwrap();
        drop(db);
        let mut db = Catalog::open(path).unwrap();
        let view = db.capture_model_text(&id).unwrap().load().unwrap();
        assert!(!view.retry_allowed);
        assert_eq!(
            view.inference.unwrap().outcome,
            Some(Outcome::Indeterminate)
        );
        let body = db
            .prepare_inference_content()
            .write(&serde_json::to_value(&p.generation).unwrap())
            .unwrap();
        assert!(db.admit_inference_generation(&p.generation, body).is_err());
        assert!(db.list_threads().unwrap().is_empty());
    }
    #[test]
    fn physical_worker_stop_retains_unknown_receipt_when_body_publication_failed() {
        let (_, mut db) = open();
        let p = input("receipt-failed");
        let id = admit(&mut db, &p);
        let child = generate(&mut db, &p);
        db.dispatch_inference_generation(&child).unwrap();
        db.record_kernel_operation_worker_stopped(&child, db.epoch())
            .unwrap();
        let status = db.model_text_status(&id).unwrap();
        let inference = status.inference.unwrap();
        assert_eq!(inference.outcome, Some(Outcome::Indeterminate));
        assert!(inference.receipt_pending);
        assert!(inference.receipt.unwrap().local_executor_stopped);
        assert_eq!(status.effect, Effect::Unknown);
        assert!(status.retry_allowed);
    }
    #[test]
    fn original_cancel_and_status_do_not_read_unavailable_content() {
        let (path, mut db) = open();
        let p = input("unreadable");
        let id = admit(&mut db, &p);
        let op = db.operation(&id).unwrap();
        let object = crate::content::object_path(
            &path.join("content"),
            op.intent["requestRef"]["content_object"].as_str().unwrap(),
        )
        .unwrap();
        std::fs::remove_file(object).unwrap();
        assert!(db.capture_model_text(&id).unwrap().load().is_err());
        db.cancel_model_text(&id).unwrap();
        let status = db.model_text_status(&id).unwrap();
        assert!(status.cancelled && status.retry_allowed);
        assert_eq!(status.provider_id, "chosen");
    }
    #[test]
    fn interrupted_admission_without_dispatch_is_cancelled_and_explicitly_retryable() {
        let (path, mut db) = open();
        let p = input("admitted");
        let id = admit(&mut db, &p);
        drop(db);
        let db = Catalog::open(path).unwrap();
        let view = db.capture_model_text(&id).unwrap().load().unwrap();
        assert!(view.cancelled);
        assert!(view.retry_allowed);
        assert!(view.inference.is_none());
    }
}
