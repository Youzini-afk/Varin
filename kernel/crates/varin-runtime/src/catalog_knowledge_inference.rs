//! Exact standalone Knowledge embedding work. No conversation, index-document fiction or new transport.
use super::utility_run::UtilityRun;
use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
pub const KIND: &str = "knowledge_inference_v1";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeInferenceAdmit {
    pub key: String,
    pub scope_id: String,
    pub purpose: String,
    pub execution_owner: ExecutorOwner,
    pub recipe: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeInferenceReadParams {
    pub operation_id: String,
    #[serde(default)]
    pub allow_missing: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeInferenceFinish {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub succeeded: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeInferenceView {
    pub operation_id: String,
    pub run_id: String,
    pub execution_owner: ExecutorOwner,
    pub recipe: Value,
    pub inference: Vec<Operation>,
    pub cancelled: bool,
    pub finished: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeInferenceStatus {
    pub operation_id: String,
    pub run_id: String,
    pub execution_owner: ExecutorOwner,
    pub cancelled: bool,
    pub finished: bool,
    pub inference: Vec<inference::InferenceStatus>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    kind: String,
    scope_id: String,
    binding: inference::InferenceBinding,
    input_fingerprint: String,
    dimensions: Option<u64>,
    recipe_ref: Value,
}
pub struct KnowledgeInferenceRead {
    root: Operation,
    reference: Value,
    children: Vec<Operation>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl KnowledgeInferenceRead {
    pub fn load(mut self) -> Result<KnowledgeInferenceView> {
        let recipe = self.content.load(&self.reference)?;
        for child in &mut self.children {
            inference::hydrate_operation(child, &self.content)?;
        }
        Ok(KnowledgeInferenceView {
            operation_id: self.root.id,
            run_id: self.root.run_id,
            execution_owner: self.root.execution_owner.ok_or_else(invalid)?,
            recipe,
            inference: self.children,
            cancelled: self.root.cancel_requested,
            finished: self.root.phase == OperationPhase::Terminal,
        })
    }
}
fn invalid() -> RuntimeError {
    RuntimeError::Conflict("knowledge_inference_identity_changed".into())
}
pub(super) fn is_work(op: &Operation) -> bool {
    op.intent["kind"] == KIND
}
fn intent(op: &Operation) -> Result<Intent> {
    if !is_work(op) {
        return Err(invalid());
    }
    Ok(serde_json::from_value(op.intent.clone())?)
}
fn children(db: &Connection, id: &str) -> Result<Vec<Operation>> {
    let mut q=db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.intent.parentOperationId')=?1 AND json_extract(body,'$.intent.kind')='inference_request_v1' ORDER BY rowid")?;
    let rows = q.query_map([id], |r| r.get::<_, String>(0))?;
    rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
}
pub(super) fn input_fingerprint(body: &Value) -> Result<Option<String>> {
    // Content preparation calls this outside the Catalog mutex. Only compact digests enter intents.
    let input = if let Some(input) = body.get("wire").and_then(|v| v.get("input")) {
        Some(input.clone())
    } else {
        body.get("params")
            .and_then(|v| v.get("items"))
            .and_then(Value::as_array)
            .map(|items| Value::Array(items.iter().map(|v| v["text"].clone()).collect()))
    };
    let Some(input) = input else { return Ok(None) };
    if !input
        .as_array()
        .is_some_and(|items| !items.is_empty() && items.iter().all(Value::is_string))
    {
        return Ok(None);
    }
    Ok(Some(hex::encode(Sha256::digest(serde_json::to_vec(
        &input,
    )?))))
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
        || run.cancel_requested
        || run.state.terminal()
        || parent.cancel_requested
        || parent.phase == OperationPhase::Terminal
    {
        return Err(RuntimeError::DispatchCancelled);
    }
    Ok(())
}
pub(super) fn validate_request(
    parent: &Operation,
    p: &inference::InferenceAdmitParams,
    body: &inference::InferenceBody,
    native: bool,
) -> Result<()> {
    let frozen = intent(parent)?;
    let expected_purpose = if frozen.binding.purpose == "knowledge-document-embedding" {
        "document"
    } else {
        "query"
    };
    if native
        || p.ordinal != 1
        || p.binding != frozen.binding
        || body.input_fingerprint.as_ref() != Some(&frozen.input_fingerprint)
        || p.request["purpose"] != expected_purpose
        || p.request["wire"].get("dimensions").and_then(Value::as_u64) != frozen.dimensions
    {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn recover(tx: &Transaction<'_>, root: &mut Operation, epoch: u64) -> Result<bool> {
    if !is_work(root) {
        return Ok(false);
    }
    intent(root)?;
    if root.phase != OperationPhase::Terminal {
        root.cancel_requested = true;
        root.epoch = epoch;
        root.phase = OperationPhase::Terminal;
        root.revision += 1;
        let has_children = !children(tx, &root.id)?.is_empty();
        root.outcome = Some(if has_children {
            Outcome::Indeterminate
        } else {
            Outcome::Cancelled
        });
        root.effect = if has_children {
            Effect::Unknown
        } else {
            Effect::None
        };
        put(tx, "operations", &root.id, root)?;
        let mut run: UtilityRun = record(tx, "runs", &root.run_id)?;
        run.state = if has_children {
            RunState::Failed
        } else {
            RunState::Cancelled
        };
        run.revision += 1;
        put(tx, "runs", &run.id, &run)?;
        event(
            tx,
            &root.id,
            root.revision,
            "knowledge_inference.recovered",
            Value::Null,
        )?;
    }
    Ok(true)
}
impl Catalog {
    pub fn admit_knowledge_inference(
        &mut self,
        p: &KnowledgeInferenceAdmit,
        body: inference::InferenceBody,
    ) -> Result<String> {
        let id = format!("knowledge-inference:{}", p.key);
        if p.key.trim().is_empty()
            || p.scope_id.trim().is_empty()
            || !matches!(
                p.purpose.as_str(),
                "knowledge-query-embedding" | "knowledge-document-embedding"
            )
            || !matches!(&p.execution_owner,ExecutorOwner::External{identity,epoch} if identity=="knowledge.inference.v1"&&!epoch.is_empty())
        {
            return Err(invalid());
        }
        let binding = &p.recipe["binding"];
        let identity = &p.recipe["identity"];
        let expected_purpose = if p.purpose == "knowledge-document-embedding" {
            "document"
        } else {
            "query"
        };
        if p.recipe["params"]["purpose"] != expected_purpose {
            return Err(invalid());
        }
        if binding["providerId"] != identity["providerId"]
            || binding["modelId"] != identity["modelId"]
            || binding["configurationId"] != identity["configurationId"]
            || binding["protocol"] != identity["protocol"]
        {
            return Err(invalid());
        }
        let frozen = Intent {
            kind: KIND.into(),
            scope_id: p.scope_id.clone(),
            dimensions: binding.get("dimensions").and_then(Value::as_u64),
            input_fingerprint: body.input_fingerprint.ok_or_else(invalid)?,
            recipe_ref: body.reference,
            binding: serde_json::from_value(
                json!({"requestKind":"model_compute","purpose":p.purpose,"providerId":identity["providerId"],"modelId":identity["modelId"],"configurationId":identity["configurationId"],
          "executor":{"kind":"http","api":identity["protocol"],"endpoint":identity["endpoint"],"credentialScope":identity["credentialScope"]}}),
            )?,
        };
        if let Some(old) = optional_record::<Operation>(&self.db, "operations", &id)? {
            if old.intent != serde_json::to_value(&frozen)? {
                return Err(invalid());
            }
            return Ok(id);
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
            executor: Some("knowledge.inference.v1".into()),
            execution_owner: Some(p.execution_owner.clone()),
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
        event(
            &tx,
            &id,
            1,
            "knowledge_inference.admitted",
            json!({"runId":run.id}),
        )?;
        tx.commit()?;
        Ok(id)
    }
    pub fn knowledge_inference_status(&self, id: &str) -> Result<KnowledgeInferenceStatus> {
        let root = self.operation(id)?;
        intent(&root)?;
        Ok(KnowledgeInferenceStatus {
            operation_id: root.id.clone(),
            run_id: root.run_id.clone(),
            execution_owner: root.execution_owner.ok_or_else(invalid)?,
            cancelled: root.cancel_requested,
            finished: root.phase == OperationPhase::Terminal,
            inference: children(&self.db, id)?
                .iter()
                .map(|op| self.inference_observation(op))
                .collect::<Result<_>>()?,
        })
    }
    pub fn capture_knowledge_inference(&self, id: &str) -> Result<KnowledgeInferenceRead> {
        let root = self.operation(id)?;
        let i = intent(&root)?;
        Ok(KnowledgeInferenceRead {
            children: children(&self.db, id)?,
            root,
            reference: i.recipe_ref,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn cancel_knowledge_inference(&mut self, id: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        let root: Operation = record(&tx, "operations", id)?;
        intent(&root)?;
        request_cancel_operation_in(&tx, id)?;
        let mut run: UtilityRun = record(&tx, "runs", &root.run_id)?;
        run.cancel_requested = true;
        run.revision += 1;
        put(&tx, "runs", &run.id, &run)?;
        tx.commit()?;
        Ok(())
    }
    pub fn finish_knowledge_inference(&mut self, p: &KnowledgeInferenceFinish) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut root: Operation = record(&tx, "operations", &p.operation_id)?;
        intent(&root)?;
        if root.execution_owner.as_ref() != Some(&p.execution_owner) {
            return Err(invalid());
        }
        let requests = children(&tx, &root.id)?;
        if requests.iter().any(|op| {
            op.phase != OperationPhase::Terminal
                || !op
                    .result
                    .as_ref()
                    .and_then(|v| v.control().ok())
                    .is_some_and(|v| {
                        v["receipt"]["localExecutorStopped"] == true || v["dispatched"] == false
                    })
        }) {
            return Err(RuntimeError::Conflict(
                "knowledge_inference_executor_not_drained".into(),
            ));
        }
        root.phase = OperationPhase::Terminal;
        root.outcome = Some(if requests.iter().any(|op| op.effect == Effect::Unknown) {
            Outcome::Indeterminate
        } else if root.cancel_requested {
            Outcome::Cancelled
        } else if !p.succeeded
            || requests
                .iter()
                .any(|op| op.outcome != Some(Outcome::Succeeded))
        {
            Outcome::Failed
        } else {
            Outcome::Succeeded
        });
        root.effect = if requests.iter().any(|op| op.effect == Effect::Unknown) {
            Effect::Unknown
        } else if requests.iter().any(|op| op.effect == Effect::Confirmed) {
            Effect::Confirmed
        } else {
            Effect::None
        };
        root.revision += 1;
        put(&tx, "operations", &root.id, &root)?;
        let mut run: UtilityRun = record(&tx, "runs", &root.run_id)?;
        run.state = match root.outcome {
            Some(Outcome::Succeeded) => RunState::Completed,
            Some(Outcome::Cancelled) => RunState::Cancelled,
            _ => RunState::Failed,
        };
        run.revision += 1;
        put(&tx, "runs", &run.id, &run)?;
        event(
            &tx,
            &root.id,
            root.revision,
            "knowledge_inference.finished",
            Value::Null,
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> KnowledgeInferenceAdmit {
        serde_json::from_value(json!({"key":"original","scopeId":"personal","purpose":"knowledge-query-embedding","executionOwner":{"kind":"external","identity":"knowledge.inference.v1","epoch":"host"},
 "recipe":{"binding":{"providerId":"chosen","modelId":"embedding","configurationId":"captured","protocol":"openai-compatible"},"identity":{"providerId":"chosen","modelId":"embedding","configurationId":"captured","protocol":"openai-compatible","endpoint":"https://embedding.invalid/v1/embeddings","credentialScope":{"reference":"provider:chosen","authority":"host","account":"original","generation":1}},"params":{"purpose":"query","items":[{"id":"q","text":"Original knowledge query"}]}}})).unwrap()
    }
    fn admit(db: &mut Catalog, p: &KnowledgeInferenceAdmit) -> String {
        let body = db.prepare_inference_content().write(&p.recipe).unwrap();
        db.admit_knowledge_inference(p, body).unwrap()
    }
    fn request(p: &KnowledgeInferenceAdmit, id: &str) -> inference::InferenceAdmitParams {
        serde_json::from_value(json!({"parentOperationId":id,"executionOwner":p.execution_owner,"ordinal":1,"binding":{"requestKind":"model_compute","purpose":p.purpose,"providerId":"chosen","modelId":"embedding","configurationId":"captured","executor":{"kind":"http","api":"openai-compatible","endpoint":"https://embedding.invalid/v1/embeddings","credentialScope":p.recipe["identity"]["credentialScope"]}},"request":{"purpose":"query","wire":{"model":"embedding","input":["Original knowledge query"]}}})).unwrap()
    }
    fn open() -> (std::path::PathBuf, Catalog) {
        let path =
            std::env::temp_dir().join(format!("varin-knowledge-inference-{}", Uuid::new_v4()));
        let db = Catalog::open(&path).unwrap();
        (path, db)
    }
    #[test]
    fn exact_knowledge_binding_and_input_are_required_without_a_fake_thread() {
        let (_, mut db) = open();
        let p = input();
        let id = admit(&mut db, &p);
        assert!(db.list_threads().unwrap().is_empty());
        let mut request = request(&p, &id);
        request.request["wire"]["input"] = json!(["Changed query"]);
        let body = db
            .prepare_inference_content()
            .write(&request.request)
            .unwrap();
        assert!(db.admit_inference(&request, body).is_err());
        let request = self::request(&p, &id);
        let body = db
            .prepare_inference_content()
            .write(&request.request)
            .unwrap();
        assert!(db.admit_inference(&request, body).is_ok());
    }
    #[test]
    fn knowledge_finish_requires_original_drain_and_recovery_does_not_replay() {
        let (path, mut db) = open();
        let p = input();
        let id = admit(&mut db, &p);
        let request = request(&p, &id);
        let body = db
            .prepare_inference_content()
            .write(&request.request)
            .unwrap();
        let child = db.admit_inference(&request, body).unwrap();
        db.dispatch_inference(&inference::InferenceOwnerParams {
            operation_id: child.operation_id.clone(),
            execution_owner: p.execution_owner.clone(),
        })
        .unwrap();
        assert!(
            db.finish_knowledge_inference(&KnowledgeInferenceFinish {
                operation_id: id.clone(),
                execution_owner: p.execution_owner.clone(),
                succeeded: false
            })
            .is_err()
        );
        drop(db);
        let mut db = Catalog::open(path).unwrap();
        let view = db.capture_knowledge_inference(&id).unwrap().load().unwrap();
        assert!(view.cancelled && view.finished);
        assert_eq!(view.inference[0].effect, Effect::Unknown);
        let body = db
            .prepare_inference_content()
            .write(&request.request)
            .unwrap();
        assert!(!db.admit_inference(&request, body).unwrap().live);
        assert!(db.list_threads().unwrap().is_empty());
    }
}
