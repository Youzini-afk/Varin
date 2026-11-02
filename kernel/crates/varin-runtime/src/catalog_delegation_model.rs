//! One-shot delegated model preparation. The original child and inference Operations own
//! frozen input, cancellation, paid attempts and the eventual execution binding.
use super::dispatch::{ChildModelBinding, DispatchInput};
use super::*;
use serde::Deserialize;

pub const KIND: &str = "delegation_model_selection_v1";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCandidate {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub configuration_fingerprint: String,
    pub thinking_levels: Vec<String>,
    pub default_thinking_level: String,
    pub input: Vec<String>,
    #[serde(flatten)]
    pub details: serde_json::Map<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Selector {
    pub provider_id: String,
    pub model_id: String,
    pub operation: String,
    pub configuration_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(flatten)]
    pub details: serde_json::Map<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SelectionCatalog {
    pub candidates: Vec<ModelCandidate>,
    pub selector: Option<Selector>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub model: String,
    pub thinking: String,
}
impl SelectionCatalog {
    pub fn choices(
        &self,
        input: &DispatchInput,
        parent: &ChildModelBinding,
    ) -> Result<Vec<Choice>> {
        let mut ids = std::collections::BTreeSet::new();
        if self.candidates.iter().any(|c| {
            c.id.is_empty()
                || c.provider_id.is_empty()
                || c.model_id.is_empty()
                || c.configuration_fingerprint.is_empty()
                || !ids.insert(&c.id)
                || !c.thinking_levels.contains(&c.default_thinking_level)
        }) {
            return Err(RuntimeError::Invalid(
                "Invalid delegated model catalog".into(),
            ));
        }
        let inherited = self.selector.is_none() && input.model.is_none();
        let mut choices = Vec::new();
        for candidate in &self.candidates {
            if input.model.as_ref().is_some_and(|id| id != &candidate.id) {
                continue;
            }
            if inherited
                && (Some(&candidate.provider_id) != parent.configuration.provider_id.as_ref()
                    || candidate.model_id
                        != parent
                            .configuration
                            .catalog_model_id
                            .as_deref()
                            .unwrap_or(&parent.configuration.model))
            {
                continue;
            }
            if input
                .input_types
                .iter()
                .any(|kind| !candidate.input.contains(kind))
            {
                continue;
            }
            let fixed = match input.thinking.as_deref() {
                Some("default") => Some(candidate.default_thinking_level.as_str()),
                Some(value) => Some(value),
                None if self.selector.is_none() => Some(candidate.default_thinking_level.as_str()),
                None => None,
            };
            for level in &candidate.thinking_levels {
                if fixed.is_some_and(|fixed| level != fixed) {
                    continue;
                }
                choices.push(Choice {
                    model: candidate.id.clone(),
                    thinking: level.clone(),
                });
            }
        }
        if choices.is_empty() {
            return Err(RuntimeError::Invalid(
                "No configured model supports the fixed model, thinking and input requirements"
                    .into(),
            ));
        }
        Ok(choices)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub recent_assistant: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipe {
    pub execution: ExecutionShape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherited_binding: Option<ChildModelBinding>,
    pub catalog: SelectionCatalog,
    pub choices: Vec<Choice>,
    pub input: DispatchInput,
    pub messages: Vec<SelectionMessage>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionShape {
    pub tools: Vec<String>,
    pub work_mode: dispatch::ChildWorkMode,
    pub input_types: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareParams {
    pub execution_id: String,
    pub execution_owner: ExecutorOwner,
    #[serde(default)]
    pub catalog: Option<SelectionCatalog>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitParams {
    pub execution_id: String,
    pub execution_owner: ExecutorOwner,
    pub choice: Choice,
    pub binding: ChildModelBinding,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionView {
    pub operation_id: String,
    pub run_id: String,
    pub execution_owner: ExecutorOwner,
    pub recipe: Recipe,
    pub result: Option<Choice>,
    pub inference: Vec<Operation>,
}
fn operation_id(execution: &str) -> String {
    format!("delegation-model:{execution}")
}
fn inference_children(db: &Connection, id: &str) -> Result<Vec<Operation>> {
    let mut query = db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.intent.parentOperationId')=?1 AND json_extract(body,'$.intent.kind')='inference_request_v1' ORDER BY rowid")?;
    let rows = query.query_map([id], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}
pub(super) fn is_selection(op: &Operation) -> bool {
    op.intent["kind"] == KIND
}
fn execution_id(op: &Operation) -> Result<&str> {
    if !is_selection(op) {
        return Err(RuntimeError::Invalid(
            "Not a delegated model selection".into(),
        ));
    }
    op.intent["executionId"]
        .as_str()
        .ok_or_else(|| RuntimeError::Invalid("Delegated selection identity missing".into()))
}
pub(super) fn parent_live(
    db: &Connection,
    op: &Operation,
    owner: &ExecutorOwner,
    epoch: u64,
) -> Result<()> {
    let execution = delegated::execution(db, execution_id(op)?)?;
    let relation = delegated::relation(db, &execution.child_operation_id)?;
    if op.execution_owner.as_ref() != Some(owner)
        || !matches!(owner, ExecutorOwner::External { .. })
    {
        return Err(RuntimeError::Conflict(
            "Delegated selection owner changed".into(),
        ));
    }
    if op.epoch != epoch
        || op.cancel_requested
        || op.phase != OperationPhase::Running
        || execution.cancel_requested
        || execution.report.is_some()
        || execution.receipt.is_some()
    {
        return Err(RuntimeError::DispatchCancelled);
    }
    if !super::bot::thread_permitted(db, &relation.child_thread_id, epoch)? {
        return Err(RuntimeError::BotSuspended);
    }
    Ok(())
}
fn preparation_permitted(db: &Connection, relation: &delegated::ChildRelation) -> Result<()> {
    let goal = goals::origin_goal(db, &relation.origin)?;
    goals::check_delegated_dispatch(db, &relation.parent_run_id, goal.as_ref())
        .map(|_| ())
        .map_err(|error| match error {
            RuntimeError::GoalChanged => RuntimeError::RequestActivationHeld,
            error => error,
        })
}
pub(super) fn require_ready(db: &Connection, id: &str) -> Result<()> {
    let execution = delegated::execution(db, id)?;
    if !matches!(execution.trigger, delegated::DelegatedTrigger::Dispatch) {
        return Ok(());
    }
    let relation = delegated::relation(db, &execution.child_operation_id)?;
    if relation.model_selection_required {
        let selected = optional_record::<Operation>(db, "operations", &operation_id(id))?;
        if !selected.is_some_and(|op| {
            op.phase == OperationPhase::Terminal && op.outcome == Some(Outcome::Succeeded)
        }) {
            return Err(RuntimeError::Conflict(
                "Delegated model selection is not complete".into(),
            ));
        }
    }
    Ok(())
}

pub struct Preparation {
    execution: delegated::DelegatedExecution,
    relation: delegated::ChildRelation,
    original: Option<Operation>,
    owner: ExecutorOwner,
    catalog: Option<SelectionCatalog>,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedSelection {
    operation: Operation,
    recipe: Recipe,
    _publication: crate::content::ContentPublication,
}
pub struct SelectionRead {
    operation: Operation,
    children: Vec<Operation>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl SelectionRead {
    pub fn load(mut self) -> Result<SelectionView> {
        let recipe =
            serde_json::from_value(self.content.load(&self.operation.intent["recipeRef"])?)?;
        for child in &mut self.children {
            inference::hydrate_operation(child, &self.content)?;
        }
        let result = self
            .operation
            .result
            .as_ref()
            .and_then(|v| v.control().ok())
            .filter(|v| !v.is_null())
            .map(|v| serde_json::from_value(v["choice"].clone()))
            .transpose()?;
        Ok(SelectionView {
            operation_id: self.operation.id,
            run_id: self.operation.run_id,
            execution_owner: self
                .operation
                .execution_owner
                .ok_or_else(|| RuntimeError::Invalid("Selection owner missing".into()))?,
            recipe,
            result,
            inference: self.children,
        })
    }
}
impl Preparation {
    pub fn load(self) -> Result<PreparedSelection> {
        if let Some(operation) = self.original {
            let recipe =
                serde_json::from_value(self.content.load(&operation.intent["recipeRef"])?)?;
            return Ok(PreparedSelection {
                operation,
                recipe,
                _publication: self._publication,
            });
        }
        let frozen: dispatch::FrozenChildDispatch =
            serde_json::from_value(self.content.load(&self.relation.dispatch_context_ref)?)?;
        let mut catalog = self.catalog.ok_or_else(|| {
            RuntimeError::Invalid(
                "Fresh delegated model catalog is required for preparation admission".into(),
            )
        })?;
        let input: DispatchInput =
            serde_json::from_value(self.content.load(&self.execution.input_ref)?)?;
        let inherited_binding =
            (catalog.selector.is_none() && input.model.is_none() && input.thinking.is_none())
                .then_some(frozen.parent_model.clone());
        if inherited_binding.as_ref().is_some_and(|binding| {
            input
                .input_types
                .iter()
                .any(|kind| kind == "image" && binding.configuration.accepts_images != Some(true))
        }) {
            return Err(RuntimeError::Invalid(
                "The inherited model does not declare image input support".into(),
            ));
        }
        let choices = if let Some(binding) = &inherited_binding {
            vec![Choice {
                model: "inherit".into(),
                thinking: binding
                    .configuration
                    .thinking_level
                    .clone()
                    .unwrap_or_else(|| "off".into()),
            }]
        } else {
            catalog.choices(&input, &frozen.parent_model)?
        };
        catalog
            .candidates
            .retain(|candidate| choices.iter().any(|choice| choice.model == candidate.id));
        let messages = if choices.len() == 1 {
            Vec::new()
        } else {
            recent_messages(
                &self.database,
                &self.content,
                self.relation.model_selection_head.as_deref(),
                &self.relation.origin,
                &self.relation.call_id,
            )?
        };
        let profile: dispatch::ChildSelectedProfile =
            serde_json::from_value(self.content.load(&self.relation.selected_profile_ref)?)?;
        let execution = ExecutionShape {
            tools: profile.tools,
            work_mode: profile.work_mode,
            input_types: input.input_types.clone(),
        };
        let recipe = Recipe {
            execution,
            inherited_binding,
            catalog,
            choices,
            input,
            messages,
        };
        let reference = self.content.save(&serde_json::to_value(&recipe)?)?;
        let operation = Operation {
            id: operation_id(&self.execution.execution_id),
            run_id: self.relation.parent_run_id,
            epoch: 0,
            revision: 1,
            phase: OperationPhase::Running,
            outcome: None,
            effect: Effect::None,
            cancel_requested: false,
            lifetime: Lifetime::Thread,
            handed_off: true,
            executor: Some("delegation.model.selection".into()),
            execution_owner: Some(self.owner),
            waiting_on: None,
            intent: json!({"kind":KIND,"executionId":self.execution.execution_id,"recipeRef":reference,"selector":recipe.catalog.selector}),
            result: Some(OperationResultMetadata::Control { value: Value::Null }),
            host_job: None,
            mcp_resource_subscription: None,
            managed_process: None,
            external_receipt: None,
            call_completion: None,
        };
        Ok(PreparedSelection {
            operation,
            recipe,
            _publication: self._publication,
        })
    }
}
impl Catalog {
    pub fn capture_delegation_model(&self, p: PrepareParams) -> Result<Preparation> {
        let execution = self.delegated_execution(&p.execution_id)?;
        let relation = delegated::relation(&self.db, &execution.child_operation_id)?;
        if !relation.model_selection_required
            || !matches!(execution.trigger, delegated::DelegatedTrigger::Dispatch)
            || !matches!(p.execution_owner, ExecutorOwner::External { .. })
        {
            return Err(RuntimeError::Invalid(
                "This execution has no delegated model preparation".into(),
            ));
        }
        let original: Option<Operation> =
            optional_record(&self.db, "operations", &operation_id(&p.execution_id))?;
        if !original.as_ref().is_some_and(|op| {
            op.phase == OperationPhase::Terminal && op.outcome == Some(Outcome::Succeeded)
        }) {
            preparation_permitted(&self.db, &relation)?;
        }
        Ok(Preparation {
            execution,
            relation,
            original,
            owner: p.execution_owner,
            catalog: p.catalog,
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog database missing".into()))?
                .into(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn admit_delegation_model(
        &mut self,
        mut prepared: PreparedSelection,
        owner: ExecutorOwner,
    ) -> Result<String> {
        let id = prepared.operation.id.clone();
        if let Some(mut existing) = optional_record::<Operation>(&self.db, "operations", &id)? {
            if existing.phase == OperationPhase::Terminal {
                return if existing.outcome == Some(Outcome::Succeeded) {
                    Ok(id)
                } else {
                    Err(RuntimeError::DispatchCancelled)
                };
            }
            let children = inference_children(&self.db, &id)?;
            // A new Host may recover immutable successful responses, but never re-dispatch a sent request.
            if existing.execution_owner.as_ref() != Some(&owner) || existing.epoch != self.epoch {
                if children
                    .iter()
                    .any(|op| op.phase != OperationPhase::Terminal)
                {
                    return Err(RuntimeError::Conflict(
                        "Original delegated selection is still unsettled".into(),
                    ));
                }
                existing.execution_owner = Some(owner);
                existing.epoch = self.epoch;
                existing.revision += 1;
                parent_live(
                    &self.db,
                    &existing,
                    existing.execution_owner.as_ref().unwrap(),
                    self.epoch,
                )?;
                let tx = self.db.transaction()?;
                put(&tx, "operations", &id, &existing)?;
                event(
                    &tx,
                    &id,
                    existing.revision,
                    "child.model_selection_recovered",
                    Value::Null,
                )?;
                tx.commit()?;
            }
            parent_live(
                &self.db,
                &existing,
                existing.execution_owner.as_ref().unwrap(),
                self.epoch,
            )?;
            return Ok(id);
        }
        let execution = delegated::execution(&self.db, execution_id(&prepared.operation)?)?;
        preparation_permitted(
            &self.db,
            &delegated::relation(&self.db, &execution.child_operation_id)?,
        )?;
        prepared.operation.epoch = self.epoch;
        parent_live(&self.db, &prepared.operation, &owner, self.epoch)?;
        if prepared.recipe.choices.is_empty() {
            return Err(RuntimeError::Invalid(
                "No delegated execution choices".into(),
            ));
        }
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![id, prepared.operation.run_id, encode(&prepared.operation)?],
        )?;
        event(
            &tx,
            &id,
            1,
            "child.model_selection_preparing",
            json!({"executionId":prepared.operation.intent["executionId"]}),
        )?;
        tx.commit()?;
        Ok(id)
    }
    pub fn find_delegation_model(&self, execution_id: &str) -> Result<Option<SelectionRead>> {
        self.delegated_execution(execution_id)?;
        let id = operation_id(execution_id);
        if optional_record::<Operation>(&self.db, "operations", &id)?.is_none() {
            return Ok(None);
        }
        self.read_delegation_model(&id).map(Some)
    }
    pub fn read_delegation_model(&self, id: &str) -> Result<SelectionRead> {
        let operation = self.operation(id)?;
        execution_id(&operation)?;
        Ok(SelectionRead {
            children: inference_children(&self.db, id)?,
            operation,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn prepare_delegation_model_commit(&self, p: CommitParams) -> Result<CommitPreparation> {
        let operation = self.operation(&operation_id(&p.execution_id))?;
        let children = inference_children(&self.db, &operation.id)?;
        Ok(CommitPreparation {
            p,
            operation,
            children,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn commit_delegation_model(&mut self, p: PreparedCommit) -> Result<()> {
        let mut op = self.operation(&p.operation_id)?;
        if op.phase == OperationPhase::Terminal {
            if op.outcome == Some(Outcome::Succeeded)
                && op.result == Some(OperationResultMetadata::Control { value: p.result })
            {
                return Ok(());
            }
            return Err(RuntimeError::Conflict(
                "Delegated model result changed".into(),
            ));
        }
        parent_live(&self.db, &op, &p.owner, self.epoch)?;
        if inference_children(&self.db, &op.id)? != p.children {
            return Err(RuntimeError::Conflict(
                "Original selection receipts changed during binding preparation".into(),
            ));
        }
        let mut execution = self.delegated_execution(&p.execution_id)?;
        let binding = p.binding;
        execution.configuration_ref = p.configuration_ref;
        execution.launch.credential_scope = binding.credential_scope.clone();
        execution.launch.connection_identity = binding.connection_identity()?;
        execution.launch.provider_family = binding.configuration.provider_family.clone();
        execution.launch.model = binding.configuration.model.clone();
        execution.launch.configuration_generation = binding.configuration.configuration_generation;
        execution.revision += 1;
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(Outcome::Succeeded);
        op.revision += 1;
        op.result = Some(OperationResultMetadata::Control { value: p.result });
        let tx = self.db.transaction()?;
        execution.cursor = event(
            &tx,
            &execution.execution_id,
            execution.revision,
            "child.model_selected",
            json!({"operationId":op.id}),
        )?;
        delegated::write_execution(&tx, &execution)?;
        put(&tx, "operations", &op.id, &op)?;
        tx.commit()?;
        Ok(())
    }
}
pub struct CommitPreparation {
    p: CommitParams,
    operation: Operation,
    children: Vec<Operation>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedCommit {
    execution_id: String,
    operation_id: String,
    owner: ExecutorOwner,
    children: Vec<Operation>,
    binding: ChildModelBinding,
    configuration_ref: Value,
    result: Value,
    _publication: crate::content::ContentPublication,
}
impl CommitPreparation {
    pub fn load(self) -> Result<PreparedCommit> {
        let recipe: Recipe =
            serde_json::from_value(self.content.load(&self.operation.intent["recipeRef"])?)?;
        if !recipe.choices.contains(&self.p.choice) {
            return Err(RuntimeError::Invalid(
                "Selected model or thinking is outside this frozen request".into(),
            ));
        }
        if self.operation.phase != OperationPhase::Terminal {
            let mut successful = None;
            for child in &self.children {
                let state = child
                    .result
                    .as_ref()
                    .ok_or_else(|| {
                        RuntimeError::Invalid("Selection inference receipt missing".into())
                    })?
                    .control()?;
                let stopped = state["receipt"]["localExecutorStopped"] == true;
                let transient = matches!(
                    (child.outcome, state["receipt"]["problem"].as_str()),
                    (Some(Outcome::Indeterminate), Some("transport_failed"))
                        | (Some(Outcome::Failed), Some("http_rejected"))
                );
                if child.phase != OperationPhase::Terminal
                    || child.cancel_requested
                    || !stopped
                    || state["recovered"] == true
                    || state["receiptPending"] == true
                    || (child.outcome != Some(Outcome::Succeeded) && !transient)
                {
                    return Err(RuntimeError::Conflict(
                        "Original selection request is not successfully settled".into(),
                    ));
                }
                if child.intent["binding"]["requestKind"] == "model_compute"
                    && child.outcome == Some(Outcome::Succeeded)
                {
                    if successful.replace(child).is_some() {
                        return Err(RuntimeError::Conflict(
                            "Selection has more than one completed model choice".into(),
                        ));
                    }
                }
            }
            if recipe.choices.len() > 1 {
                let original = successful.ok_or_else(|| {
                    RuntimeError::Conflict(
                        "Original selection request has no successful model choice".into(),
                    )
                })?;
                if recipe
                    .catalog
                    .selector
                    .as_ref()
                    .is_some_and(|selector| selector.operation == "chat")
                {
                    let state = original.result.as_ref().unwrap().control()?;
                    let response = self.content.load(&state["responseRef"])?;
                    let text = response["text"].as_str().ok_or_else(|| {
                        RuntimeError::Invalid("Selection response has no choice text".into())
                    })?;
                    if response["providerOutput"]["finishReason"] == "length"
                        || serde_json::from_str::<Choice>(text)? != self.p.choice
                    {
                        return Err(RuntimeError::Conflict(
                            "Selected choice differs from the original model response".into(),
                        ));
                    }
                }
            } else if !self.children.is_empty() {
                return Err(RuntimeError::Conflict(
                    "An explicit execution choice must not invoke a selector".into(),
                ));
            }
        }
        let config = &self.p.binding.configuration;
        if let Some(inherited) = &recipe.inherited_binding {
            if inherited != &self.p.binding {
                return Err(RuntimeError::Conflict(
                    "Inherited execution binding changed".into(),
                ));
            }
        } else {
            let candidate = recipe
                .catalog
                .candidates
                .iter()
                .find(|c| c.id == self.p.choice.model)
                .ok_or_else(|| RuntimeError::Invalid("Unknown selected model".into()))?;
            if config.provider_id.as_ref() != Some(&candidate.provider_id)
                || config.catalog_model_id.as_deref().unwrap_or(&config.model) != candidate.model_id
                || config.thinking_level.as_deref() != Some(self.p.choice.thinking.as_str())
            {
                return Err(RuntimeError::Conflict(
                    "Prepared execution binding differs from the selected configuration".into(),
                ));
            }
        }
        self.p.binding.connection_identity()?;
        let configuration_ref = self.content.save(&serde_json::to_value(config)?)?;
        let result = json!({"choice":self.p.choice,"configurationRef":configuration_ref});
        Ok(PreparedCommit {
            execution_id: self.p.execution_id,
            operation_id: self.operation.id,
            owner: self.p.execution_owner,
            children: self.children,
            binding: self.p.binding,
            configuration_ref,
            result,
            _publication: self._publication,
        })
    }
}

// Initial product defaults for this auxiliary input only, never conversation/task limits.
const USER_CHARS: usize = 1000;
const RECENT_ASSISTANT_CHARS: usize = 2000;
const OLDER_ASSISTANT_CHARS: usize = 600;
const OMITTED: &str = "\n[… omitted …]\n";
pub(crate) fn preview(text: &str, limit: usize) -> String {
    let length = text.chars().count();
    if length <= limit {
        return text.to_owned();
    }
    let marker = OMITTED.chars().count();
    if limit <= marker {
        return OMITTED.chars().take(limit).collect();
    }
    let available = limit - marker;
    let head = available * 3 / 10;
    let tail = available - head;
    format!(
        "{}{}{}",
        text.chars().take(head).collect::<String>(),
        OMITTED,
        text.chars().skip(length - tail).collect::<String>()
    )
}
fn recent_messages(
    database: &Path,
    content: &crate::content::ContentStore,
    head: Option<&str>,
    origin: &crate::execution::ToolOrigin,
    call_id: &str,
) -> Result<Vec<SelectionMessage>> {
    let db = Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut next = head.map(str::to_owned);
    if let crate::execution::ToolOrigin::ModelStep { request_id } = origin {
        // A provider response may contain text after this dispatch call. The frozen
        // admission head is only an upper bound, never permission to read that text.
        let prefix = crate::execution::model_history_id(request_id, "");
        let mut found = false;
        while let Some(id) = next {
            let item: HistoryItem = record(&db, "history", &id)?;
            next = item.parent;
            if item.id.starts_with(&prefix) && item.content["history_call_id"] == call_id {
                found = true;
                break;
            }
        }
        if !found {
            return Err(RuntimeError::Invalid(
                "Original dispatch history boundary is missing".into(),
            ));
        }
    }
    selected_messages(&db, content, next)
}
fn selected_messages(
    db: &Connection,
    content: &crate::content::ContentStore,
    mut next: Option<String>,
) -> Result<Vec<SelectionMessage>> {
    let mut rounds = 0usize;
    let mut messages = Vec::new();
    let mut round_assistant = false;
    let mut recent_assistants = 0usize;
    while let Some(id) = next {
        let item: HistoryItem = record(&db, "history", &id)?;
        next = item.parent;
        if !matches!(item.source, HistorySource::User | HistorySource::Assistant) {
            continue;
        }
        if item.source == HistorySource::Assistant && round_assistant && recent_assistants >= 2 {
            continue;
        }
        let user = item.source == HistorySource::User;
        let recent = !user && recent_assistants < 2;
        let limit = if user {
            USER_CHARS
        } else if recent {
            RECENT_ASSISTANT_CHARS
        } else {
            OLDER_ASSISTANT_CHARS
        };
        let text = content.history_text_preview(&item.content, limit)?.ok_or_else(|| RuntimeError::Invalid(
            "Original history text index is missing; model selection cannot read unbounded history bodies".into()))?;
        let attachments = content.history_media_types(&item.content)?;
        if !text.trim().is_empty() || user && !attachments.is_empty() {
            messages.push(SelectionMessage {
                id: item.id,
                role: if user { "user" } else { "assistant" }.into(),
                text: preview(&text, limit),
                recent_assistant: recent,
                attachments,
            });
            if !user {
                round_assistant = true;
                recent_assistants += 1;
            }
        }
        // An attachment-only genuine user input still opens a real round.
        if user {
            rounds += 1;
            round_assistant = false;
            if rounds == 3 {
                break;
            }
        }
    }
    messages.reverse();
    Ok(messages)
}

#[cfg(test)]
mod history_tests {
    use super::*;
    struct History {
        root: std::path::PathBuf,
        database: std::path::PathBuf,
        db: Connection,
        content: crate::content::ContentStore,
        head: Option<String>,
    }
    impl History {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("varin-selection-history-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let database = root.join("history.sqlite");
            let db = Connection::open(&database).unwrap();
            db.execute_batch("CREATE TABLE history(id TEXT PRIMARY KEY, body TEXT NOT NULL)")
                .unwrap();
            let content = crate::content::ContentStore::open(root.join("content")).unwrap();
            Self {
                root,
                database,
                db,
                content,
                head: None,
            }
        }
        fn add_reference(&mut self, id: &str, source: HistorySource, content: Value) {
            let item = HistoryItem {
                id: id.into(),
                run_id: "run".into(),
                thread_id: "thread".into(),
                parent: self.head.take(),
                source,
                content,
                provider: None,
            };
            self.db
                .execute(
                    "INSERT INTO history(id,body) VALUES(?1,?2)",
                    params![id, encode(&item).unwrap()],
                )
                .unwrap();
            self.head = Some(id.into());
        }
        fn text(&mut self, id: &str, source: HistorySource, text: &str) {
            let value = if source == HistorySource::User {
                json!({"text":text})
            } else {
                json!({"content":{"kind":"text","text":text}})
            };
            let reference = self.content.save_history(&value, &None).unwrap();
            self.add_reference(id, source, reference);
        }
        fn selected(&self) -> Vec<SelectionMessage> {
            selected_messages(&self.db, &self.content, self.head.clone()).unwrap()
        }
    }
    impl Drop for History {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn three_real_rounds_union_recent_two_without_loading_tool_or_internal_bodies() {
        let mut h = History::new();
        h.text("u0", HistorySource::User, "too old");
        h.text("a0", HistorySource::Assistant, "too old");
        h.text("u1", HistorySource::User, "first retained");
        h.text("a1-old", HistorySource::Assistant, "not last");
        h.text("a1", HistorySource::Assistant, &"旧🧪".repeat(1000));
        h.text("u2", HistorySource::User, "second retained");
        h.text("a2", HistorySource::Assistant, "last second");
        h.text("u3", HistorySource::User, &"用户🧪".repeat(1000));
        h.text("a3-old", HistorySource::Assistant, "not selected");
        h.text("progress", HistorySource::Assistant, &"进度🧪".repeat(2000));
        for index in 0..1000 {
            h.add_reference(
                &format!("tool-{index}"),
                HistorySource::Tool,
                json!({"content_object":"unread-tool-body"}),
            );
            h.add_reference(&format!("call-{index}"), HistorySource::Assistant,
                json!({"content_object":"unread-assistant-tool-body","history_text":{"chars":0,"ranges":[]}}));
        }
        for (id, source) in [
            ("summary", HistorySource::Compaction),
            ("schedule", HistorySource::Environment),
            ("child-report", HistorySource::Agent),
        ] {
            h.add_reference(id, source, json!({"content_object":"must-never-read"}));
        }
        h.text("latest", HistorySource::Assistant, "current finding");
        let messages = h.selected();
        assert_eq!(
            messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["u1", "a1", "u2", "a2", "u3", "progress", "latest"]
        );
        assert_eq!(messages[1].text.chars().count(), OLDER_ASSISTANT_CHARS);
        assert_eq!(messages[4].text.chars().count(), USER_CHARS);
        assert_eq!(messages[5].text.chars().count(), RECENT_ASSISTANT_CHARS);
        assert_eq!(
            messages
                .iter()
                .filter(|m| m.recent_assistant)
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["progress", "latest"]
        );
        assert!(messages[5].text.contains(OMITTED));
    }
    #[test]
    fn attachment_only_user_still_bounds_rounds_and_migrated_original_text_is_read() {
        let mut h = History::new();
        h.text("old", HistorySource::User, "not retained");
        h.text("u1", HistorySource::User, "first");
        let original = h
            .content
            .save_history(
                &json!({"content":{"kind":"text","text":"legacy original"}}),
                &None,
            )
            .unwrap();
        h.add_reference("legacy", HistorySource::Assistant, original);
        let payload = json!({"format":"user_input","content":{"text":"","attachments":[{"media_type":"image/png","content_ref":{"content_object":"absent-never-read"}}]},"provider":null});
        let reference = h
            .content
            .index_history_text(h.content.save(&payload).unwrap(), &payload)
            .unwrap();
        h.add_reference("u2", HistorySource::User, reference);
        h.text("a2", HistorySource::Assistant, "image discussion");
        h.text("u3", HistorySource::User, "current");
        let messages = h.selected();
        assert_eq!(
            messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["u1", "legacy", "u2", "a2", "u3"]
        );
        assert_eq!(messages[2].attachments, vec!["image/png"]);
        assert_eq!(messages[2].text, "");
    }
    #[test]
    fn original_dispatch_position_excludes_later_text_in_same_provider_response() {
        let mut h = History::new();
        h.text("user", HistorySource::User, "task");
        h.text("before", HistorySource::Assistant, "known before dispatch");
        let id = crate::execution::model_history_id("request:🧪", "provider:call");
        let value = json!({"content":{"kind":"tool_call","call":{"call_id":"dispatch-id","arguments":{"task":"work"}}}});
        let reference = h.content.save_history(&value, &None).unwrap();
        h.add_reference(&id, HistorySource::Assistant, reference);
        h.text(
            "after",
            HistorySource::Assistant,
            "not yet available at dispatch",
        );
        let messages = recent_messages(
            &h.database,
            &h.content,
            h.head.as_deref(),
            &crate::execution::ToolOrigin::ModelStep {
                request_id: "request:🧪".into(),
            },
            "dispatch-id",
        )
        .unwrap();
        assert_eq!(
            messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["user", "before"]
        );
    }
}
