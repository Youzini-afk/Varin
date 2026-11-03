//! Frozen Run-driver bindings and private checkpoints. Effects and model output remain
//! with the existing invocation / ModelStep owners; this domain never replays them.
use super::*;
use crate::driver::{DriverFinishReceipt, DriverRecovery, DriverSelection, DriverTerminalOutcome};
use crate::execution::{
    Content, ConversationItem, ExecutionInput, ExecutionRecord, FrozenToolContext, HistoryRange,
    Provenance, RequestBinding, RequestOrigin, RequestSnapshot, ToolCall, ToolOrigin,
};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DriverRunMetadata {
    pub run_id: String,
    pub selection: DriverSelection,
    pub started_epoch: Option<u64>,
    #[serde(default)]
    pub execution_revision: u64,
    pub checkpoint_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DriverCheckpointMetadata {
    pub run_id: String,
    pub driver_id: String,
    pub revision: u64,
    pub schema: String,
    pub state_ref: Value,
    pub operations: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DriverCheckpoint {
    pub revision: u64,
    pub schema: String,
    pub state: Value,
    pub operations: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DriverCallMetadata {
    pub id: String,
    pub run_id: String,
    pub epoch: u64,
    pub driver_id: String,
    pub call: super::tool_content::ToolCallMetadata,
    pub frozen_ref: Value,
    pub history_range: HistoryRange,
    pub goal: Option<super::goals::FrozenGoal>,
    pub dispatch_history: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_dispatch_completion: Option<super::result_content::ToolCompletionMetadata>,
}
#[derive(Debug, Clone)]
pub struct DriverCall {
    pub metadata: DriverCallMetadata,
    pub call: ToolCall,
    pub frozen: FrozenToolContext,
    pub history_range: HistoryRange,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DriverWorkKind {
    Model,
    Tool,
    Delivery,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DriverWorkReference {
    pub kind: DriverWorkKind,
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriverActivity {
    pub cursor: u64,
    pub input_pending: bool,
}

/// Preparation only stages bodies. The live callback retains admission until the
/// original execution transaction has accepted its terminal transition.
pub struct DriverFinishPreparation {
    record: ExecutionRecord,
    bodies: super::execution_persistence::ExecutionBodyPreparation,
}
pub struct PreparedDriverFinish {
    record: ExecutionRecord,
    bodies: super::execution_persistence::PreparedExecutionBodies,
}
impl DriverFinishPreparation {
    pub fn load(self) -> Result<PreparedDriverFinish> {
        let bodies = self.bodies.write(&self.record)?;
        Ok(PreparedDriverFinish {
            record: self.record,
            bodies,
        })
    }
}

pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE run_drivers(run_id TEXT PRIMARY KEY REFERENCES runs(id),body TEXT NOT NULL);
        CREATE TABLE driver_checkpoints(run_id TEXT NOT NULL REFERENCES run_drivers(run_id),revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,revision));
        CREATE TABLE driver_calls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES run_drivers(run_id),body TEXT NOT NULL);
        CREATE INDEX driver_calls_run ON driver_calls(run_id);
        INSERT INTO runtime_domains(name,version) VALUES('run_drivers',1);")?;
    Ok(())
}

/// Conversion fixes the released default by identity, including Runs whose launch was
/// not yet prepared. Later route configuration must not turn them into extension work.
pub(super) fn upgrade(tx: &Transaction<'_>) -> Result<()> {
    check_model_activity_index(tx, false)?;
    let already_described: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM run_launches WHERE json_type(body,'$.selection.driver') IS NOT NULL OR json_type(body,'$.selection.driver_models') IS NOT NULL) OR EXISTS(SELECT 1 FROM delegated_executions WHERE json_type(body,'$.launch.driver') IS NOT NULL OR json_type(body,'$.launch.driver_models') IS NOT NULL)",
        [], |row| row.get(0),
    )?;
    if already_described {
        return Err(RuntimeError::Invalid(
            "historical launch unexpectedly contains a driver selection; data was preserved".into(),
        ));
    }
    initialize(tx)?;
    tx.execute_batch("ALTER TABLE model_steps ADD COLUMN driver_id TEXT CHECK(driver_id IS NULL OR (length(driver_id)>0 AND node_id IS NULL));
        DROP INDEX model_steps_active;
        CREATE UNIQUE INDEX model_steps_active ON model_steps(run_id,coalesce(node_id,'')) WHERE driver_id IS NULL AND state IN ('prepared','dispatched');")?;
    let selection = encode(&DriverSelection::default())?;
    tx.execute("INSERT INTO run_drivers(run_id,body) SELECT id,json_object('run_id',id,'selection',json(?1),'started_epoch',NULL,'execution_revision',0,'checkpoint_revision',0) FROM runs", [&selection])?;
    tx.execute("UPDATE run_launches SET body=json_set(body,'$.selection.driver',json(?1),'$.selection.driver_models',json('[]'))", [&selection])?;
    // Frozen delegated launches may not yet have a child Run. They are historical
    // default choices too, rather than future routing requests.
    tx.execute("UPDATE delegated_executions SET body=json_set(body,'$.launch.driver',json(?1),'$.launch.driver_models',json('[]')) WHERE json_type(body,'$.launch')='object'", [&selection])?;
    Ok(())
}

fn check_model_activity_index(db: &Connection, driver_aware: bool) -> Result<()> {
    let active_index: Option<String> = db.query_row(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='model_steps_active' AND tbl_name='model_steps'",
        [], |row| row.get(0),
    ).optional()?;
    let predicate = if driver_aware {
        "driver_id IS NULL AND "
    } else {
        ""
    };
    let expected = format!("CREATE UNIQUE INDEX model_steps_active ON model_steps(run_id,coalesce(node_id,'')) WHERE {predicate}state IN ('prepared','dispatched')");
    let normalized = |sql: &str| sql.split_whitespace().collect::<String>().to_lowercase();
    if active_index.as_deref().map(normalized) != Some(normalized(&expected)) {
        return Err(RuntimeError::Invalid(
            "model activity ownership index differs from the catalog format; data was preserved"
                .into(),
        ));
    }
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT driver_id FROM model_steps")?;
    check_model_activity_index(db, true)?;
    let version: Option<i64> = db
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='run_drivers'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if version != Some(1) {
        return Err(RuntimeError::Invalid(
            "unsupported driver domain; data was preserved".into(),
        ));
    }
    for (table, expected) in [
        (
            "run_drivers",
            vec![("run_id", "TEXT", 0, 1), ("body", "TEXT", 1, 0)],
        ),
        (
            "driver_checkpoints",
            vec![
                ("run_id", "TEXT", 1, 1),
                ("revision", "INTEGER", 1, 2),
                ("body", "TEXT", 1, 0),
            ],
        ),
        (
            "driver_calls",
            vec![
                ("id", "TEXT", 0, 1),
                ("run_id", "TEXT", 1, 0),
                ("body", "TEXT", 1, 0),
            ],
        ),
    ] {
        let columns: Vec<(String, String, i64, i64)> = db
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| {
                Ok((row.get(1)?, row.get(2)?, row.get(3)?, row.get(5)?))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let expected: Vec<_> = expected
            .into_iter()
            .map(|(a, b, c, d)| (a.to_string(), b.to_string(), c, d))
            .collect();
        if columns != expected {
            return Err(RuntimeError::Invalid(format!(
                "malformed {table}; data was preserved"
            )));
        }
        let expected_parent = if table == "run_drivers" {
            "runs"
        } else {
            "run_drivers"
        };
        let expected_column = if table == "run_drivers" {
            "id"
        } else {
            "run_id"
        };
        let foreign_keys: Vec<(String, String, String)> = db
            .prepare(&format!("PRAGMA foreign_key_list({table})"))?
            .query_map([], |row| Ok((row.get(2)?, row.get(3)?, row.get(4)?)))?
            .collect::<std::result::Result<_, _>>()?;
        if foreign_keys
            != vec![(
                expected_parent.into(),
                "run_id".into(),
                expected_column.into(),
            )]
        {
            return Err(RuntimeError::Invalid(format!(
                "malformed {table} ownership; data was preserved"
            )));
        }
    }
    Ok(())
}

pub(crate) fn metadata(db: &Connection, run: &str) -> Result<Option<DriverRunMetadata>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT body FROM run_drivers WHERE run_id=?1",
            [run],
            |row| row.get(0),
        )
        .optional()?;
    let value: Option<DriverRunMetadata> = raw.map(|raw| serde_json::from_str(&raw)).transpose()?;
    if value.as_ref().is_some_and(|value| value.run_id != run) {
        return Err(RuntimeError::Invalid(
            "driver binding row differs from its Run".into(),
        ));
    }
    Ok(value)
}
pub(super) fn require_driver(
    db: &Connection,
    run_id: &str,
    driver_id: &str,
) -> Result<DriverRunMetadata> {
    let original = metadata(db, run_id)?
        .ok_or_else(|| RuntimeError::NotFound("original Run driver".into()))?;
    if original.selection.owner_key() != driver_id {
        return Err(RuntimeError::Conflict(
            "work belongs to another Run driver".into(),
        ));
    }
    original.selection.validate()?;
    Ok(original)
}
fn checkpoint_metadata(
    db: &Connection,
    driver: &DriverRunMetadata,
) -> Result<Option<DriverCheckpointMetadata>> {
    if driver.checkpoint_revision == 0 {
        return Ok(None);
    }
    let saved: DriverCheckpointMetadata = serde_json::from_str(&db.query_row(
        "SELECT body FROM driver_checkpoints WHERE run_id=?1 AND revision=?2",
        params![driver.run_id, sql_number(driver.checkpoint_revision)?],
        |row| row.get::<_, String>(0),
    )?)?;
    if saved.run_id != driver.run_id
        || saved.driver_id != driver.selection.owner_key()
        || saved.revision != driver.checkpoint_revision
    {
        return Err(RuntimeError::Invalid(
            "driver checkpoint differs from its original owner".into(),
        ));
    }
    Ok(Some(saved))
}
pub(super) fn driver_call_metadata(db: &Connection, id: &str) -> Result<DriverCallMetadata> {
    let call: DriverCallMetadata = record(db, "driver_calls", id)?;
    if call.id != id {
        return Err(RuntimeError::Invalid(
            "driver call row identity changed".into(),
        ));
    }
    require_driver(db, &call.run_id, &call.driver_id)?;
    Ok(call)
}
fn bound(
    db: &Connection,
    run_id: &str,
    epoch: u64,
    selection: &DriverSelection,
    admitting: bool,
) -> Result<(Run, DriverRunMetadata)> {
    let run: Run = record(db, "runs", run_id)?;
    if run.epoch != epoch {
        return Err(RuntimeError::Conflict(
            "driver belongs to a previous Run epoch".into(),
        ));
    }
    if admitting {
        fence(&run, epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::DispatchCancelled);
        }
        if !bot::run_permitted(db, &run)? {
            return Err(RuntimeError::BotSuspended);
        }
    }
    let driver =
        metadata(db, run_id)?.ok_or_else(|| RuntimeError::NotFound("Run driver binding".into()))?;
    if &driver.selection != selection {
        return Err(RuntimeError::Conflict(
            "original Run driver binding changed".into(),
        ));
    }
    if let Some(launch) =
        optional_record::<super::launch_content::LaunchMetadata>(db, "run_launches", run_id)?
    {
        if launch.selection.driver != driver.selection {
            return Err(RuntimeError::Conflict(
                "driver differs from the frozen launch".into(),
            ));
        }
    }
    Ok((run, driver))
}
/// Used at the original Run admission or launch publication, never by a route lookup.
pub(super) fn bind(
    tx: &Connection,
    run_id: &str,
    selection: &DriverSelection,
) -> Result<DriverRunMetadata> {
    selection.validate()?;
    if let Some(saved) = metadata(tx, run_id)? {
        if &saved.selection != selection {
            return Err(RuntimeError::Conflict(
                "original Run driver cannot be replaced".into(),
            ));
        }
        return Ok(saved);
    }
    let driver = DriverRunMetadata {
        run_id: run_id.into(),
        selection: selection.clone(),
        started_epoch: None,
        execution_revision: 0,
        checkpoint_revision: 0,
    };
    tx.execute(
        "INSERT INTO run_drivers(run_id,body) VALUES(?1,?2)",
        params![run_id, encode(&driver)?],
    )?;
    Ok(driver)
}

pub(super) fn preparable(
    db: &Connection,
    run_id: &str,
    launch: &super::launch_content::LaunchMetadata,
) -> Result<bool> {
    let run: Run = record(db, "runs", run_id)?;
    if run.cancel_requested
        || run.state.terminal()
        || launch.bound_epoch.is_some()
        || metadata(db, run_id)?.is_some()
    {
        return Ok(false);
    }
    let used: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1) OR EXISTS(SELECT 1 FROM policy_checkpoints WHERE run_id=?1)", [run_id], |row| row.get(0))?;
    Ok(!used)
}
pub struct DriverLaunchPreparation {
    expected: super::launch_content::LaunchMetadata,
    selection: DriverSelection,
    models: Vec<crate::execution::PolicyModelCapability>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedDriverLaunch {
    expected: super::launch_content::LaunchMetadata,
    selection: DriverSelection,
    models: Vec<super::launch_content::PolicyModelReference>,
    epoch: u64,
    _publication: crate::content::ContentPublication,
}
impl DriverLaunchPreparation {
    pub fn load(self) -> Result<PreparedDriverLaunch> {
        self.selection.validate()?;
        if matches!(self.selection, DriverSelection::Builtin { .. }) && !self.models.is_empty() {
            return Err(RuntimeError::Invalid(
                "default driver auxiliary models remain policy-owned".into(),
            ));
        }
        Ok(PreparedDriverLaunch {
            expected: self.expected,
            selection: self.selection,
            models: super::launch_content::stage_policy_models(&self.content, &self.models)?,
            epoch: self.epoch,
            _publication: self.publication,
        })
    }
}
struct DriverCallAuthority {
    epoch: u64,
    launch: super::launch_content::LaunchMetadata,
    has_goal: bool,
}
pub struct DriverContentPreparation {
    call_authority: Option<DriverCallAuthority>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedDriverCheckpoint {
    schema: String,
    state_ref: Value,
    operations: Vec<String>,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedDriverCall {
    authority: DriverCallAuthority,
    call: super::tool_content::ToolCallMetadata,
    frozen: FrozenToolContext,
    frozen_ref: Value,
    history_range: HistoryRange,
    tools_ref: Value,
    dispatch_history: Option<Value>,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedDriverPreDispatch {
    expected: DriverCallMetadata,
    completion: super::result_content::ToolCompletionMetadata,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedDriverDelivery {
    run_id: String,
    history_id: String,
    driver_id: String,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
impl DriverContentPreparation {
    pub fn checkpoint(
        self,
        schema: &str,
        state: &Value,
        operations: &[String],
    ) -> Result<PreparedDriverCheckpoint> {
        if schema.is_empty()
            || operations.iter().any(String::is_empty)
            || operations
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != operations.len()
        {
            return Err(RuntimeError::Invalid(
                "driver checkpoint requires a schema and distinct original work references".into(),
            ));
        }
        Ok(PreparedDriverCheckpoint {
            schema: schema.into(),
            state_ref: self.content.save(state)?,
            operations: operations.to_vec(),
            _publication: self.publication,
        })
    }
    pub fn call(
        self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        history_range: &HistoryRange,
        history: &crate::execution::ConversationHistory,
    ) -> Result<PreparedDriverCall> {
        let authority = self.call_authority.ok_or_else(|| {
            RuntimeError::Invalid(
                "driver tool preparation requires the original launch authority".into(),
            )
        })?;
        let tools: Vec<crate::execution::ToolSchema> =
            serde_json::from_value(self.content.load(&authority.launch.selection.tools_ref)?)?;
        let agent = authority.launch.selection.agent.as_ref();
        let allowed = agent.and_then(|agent| agent.tools.as_deref());
        let focus = agent
            .map(|agent| agent.work_focus.as_str())
            .unwrap_or("general");
        if frozen.run_id != authority.launch.run_id
            || *frozen.tools
                != crate::tool_disclosure::request_tools(&tools, authority.has_goal, allowed)
            || frozen.direct_tools.is_some()
                && frozen.direct_tools != crate::tool_disclosure::direct_tools(&frozen.tools, focus)
        {
            return Err(RuntimeError::Conflict(
                "driver tools differ from the admitted capability selection".into(),
            ));
        }
        let invocation_id = format!(
            "driver:tool:{}:{}:{}",
            frozen.run_id.len(),
            frozen.run_id,
            call.call_id
        );
        if !matches!(&frozen.origin, ToolOrigin::Driver { invocation_id: original } if original == &invocation_id)
            || call.call_id.is_empty()
            || !frozen
                .tools
                .iter()
                .any(|schema| schema.name == call.name && schema.version == call.schema_version)
        {
            return Err(RuntimeError::Invalid(
                "driver call requires its exact frozen tool schema".into(),
            ));
        }
        let dispatch_history = if frozen.tools.iter().any(|tool| tool.name == "dispatch") {
            let background = crate::context_retention::conversation_background(history);
            crate::execution::validate_history_pairs(&background)
                .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
            Some(self.content.save_items(&background)?)
        } else {
            None
        };
        Ok(PreparedDriverCall {
            dispatch_history,
            call: super::tool_content::ToolCallMetadata::write(&self.content, call)?,
            frozen: frozen.clone(),
            frozen_ref: self.content.save(&serde_json::to_value(frozen)?)?,
            tools_ref: authority.launch.selection.tools_ref.clone(),
            authority,
            history_range: history_range.clone(),
            _publication: self.publication,
        })
    }
    /// Only the original invocation runner can prove it rejected this selected call
    /// before admission. There is no contract or synthetic Operation to fabricate.
    pub fn pre_dispatch_completion(
        self,
        original: &DriverCallMetadata,
        completion: &crate::execution::ToolCompletion,
        executor_stopped: bool,
    ) -> Result<PreparedDriverPreDispatch> {
        if !executor_stopped
            || !matches!(
                completion,
                crate::execution::ToolCompletion::NotDispatched { .. }
            )
        {
            return Err(RuntimeError::Invalid(
                "pre-dispatch receipt requires the original stopped NotDispatched completion"
                    .into(),
            ));
        }
        Ok(PreparedDriverPreDispatch {
            expected: original.clone(),
            completion: super::result_content::ToolCompletionMetadata::write(
                &self.content,
                completion,
            )?,
            _publication: self.publication,
        })
    }
    pub fn delivery(
        self,
        run_id: &str,
        id: &str,
        text: &str,
        selection: &DriverSelection,
    ) -> Result<PreparedDriverDelivery> {
        if id.is_empty() {
            return Err(RuntimeError::Invalid(
                "driver delivery requires a stable identity".into(),
            ));
        }
        let history_id = format!("driver:delivery:{}:{run_id}:{id}", run_id.len());
        let item: ConversationItem = ConversationItem {
            resource_activation: None,
            id: history_id.clone(),
            provenance: Provenance::Assistant,
            content: Content::Text { text: text.into() },
            opaque: None,
        };
        Ok(PreparedDriverDelivery {
            run_id: run_id.into(),
            history_id,
            driver_id: selection.owner_key(),
            reference: self
                .content
                .save_history(&serde_json::to_value(item)?, &None)?,
            _publication: self.publication,
        })
    }
}

pub struct DriverRunRead {
    pub metadata: DriverRunMetadata,
    checkpoint: Option<DriverCheckpointMetadata>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl DriverRunRead {
    pub fn load_checkpoint(self) -> Result<Option<DriverCheckpoint>> {
        self.checkpoint
            .map(|checkpoint| {
                Ok(DriverCheckpoint {
                    revision: checkpoint.revision,
                    schema: checkpoint.schema,
                    state: self.content.load(&checkpoint.state_ref)?,
                    operations: checkpoint.operations,
                })
            })
            .transpose()
    }
}
pub struct DriverCallRead {
    pub metadata: DriverCallMetadata,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl DriverCallRead {
    pub fn load(self) -> Result<DriverCall> {
        let frozen: FrozenToolContext =
            serde_json::from_value(self.content.load(&self.metadata.frozen_ref)?)?;
        let call = self.metadata.call.clone().load(&self.content)?;
        if frozen.run_id != self.metadata.run_id
            || frozen.origin.operation_id(&call.call_id) != self.metadata.id
        {
            return Err(RuntimeError::Invalid(
                "driver call body differs from its original metadata".into(),
            ));
        }
        Ok(DriverCall {
            history_range: self.metadata.history_range.clone(),
            metadata: self.metadata,
            call,
            frozen,
        })
    }
}
pub struct DriverInputRead {
    run: Run,
    binding: RequestBinding,
    model_steps: u64,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl DriverInputRead {
    pub fn load(self) -> Result<ExecutionInput> {
        let history = super::recovery::hydrate_execution_history(
            &self.run,
            &self.binding,
            &self.database,
            &self.content,
            None,
        )?
        .expect("uncancelled history read");
        let mut items = Vec::new();
        for item in history {
            items.extend(super::execution_persistence::history_input_items(
                &item.id,
                item.source,
                &item.content,
            )?);
        }
        Ok(ExecutionInput {
            run_id: self.run.id,
            owner_generation: self.run.epoch,
            binding: self.binding,
            history: items,
            policy_state: Value::Null,
            completed_model_steps: self.model_steps,
        })
    }
}
pub struct DriverModelRead {
    step: ModelStep,
    driver_id: String,
    output_ref: Option<Value>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DriverModelOutputStatus {
    Committed,
    Rejected,
}
pub struct DriverModelRecord {
    pub step: ModelStep,
    pub snapshot: RequestSnapshot,
    pub output_status: Option<DriverModelOutputStatus>,
    pub output: Option<ExecutionRecord>,
}
impl DriverModelRead {
    pub fn load(self) -> Result<DriverModelRecord> {
        let snapshot = self.content.load_snapshot(&self.step.request)?;
        if snapshot.view.run_id != self.step.run_id
            || snapshot.view.request_id != self.step.id
            || !matches!(&snapshot.view.origin,RequestOrigin::Driver { driver_id,operation_id, .. } if driver_id==&self.driver_id && operation_id==&self.step.id)
        {
            return Err(RuntimeError::Conflict(
                "model request belongs to another driver".into(),
            ));
        }
        let output=self.output_ref.map(|reference| -> Result<(DriverModelOutputStatus,ExecutionRecord)> {
            let output=self.content.load(&reference)?;
            let status=match output.get("status").and_then(Value::as_str) { Some("committed")=>DriverModelOutputStatus::Committed,Some("rejected")=>DriverModelOutputStatus::Rejected,_=>return Err(RuntimeError::Invalid("unknown driver model output status".into())) };
            let record:ExecutionRecord=serde_json::from_value(output.get("record").cloned().ok_or_else(||RuntimeError::Invalid("driver model output record missing".into()))?)?;
            if !matches!(&record,ExecutionRecord::ModelFinished{request_id,..} if request_id==&self.step.id) { return Err(RuntimeError::Invalid("driver model receipt identity changed".into())); }
            Ok((status,record))
        }).transpose()?;
        let (output_status, output) = match output {
            Some((status, record)) => (Some(status), Some(record)),
            None => (None, None),
        };
        Ok(DriverModelRecord {
            step: self.step,
            snapshot,
            output_status,
            output,
        })
    }
}

impl Catalog {
    pub fn prepare_driver_finish(
        &self,
        outcome: DriverTerminalOutcome,
    ) -> Result<DriverFinishPreparation> {
        let record = match outcome {
            DriverTerminalOutcome::Complete => ExecutionRecord::StateChanged {
                state: RunState::Completed,
                waiting_on: None,
            },
            DriverTerminalOutcome::Fail { error } => {
                ExecutionRecord::ExecutionFailed { failure: error }
            }
        };
        let bodies = self.prepare_execution_bodies(&record)?;
        Ok(DriverFinishPreparation { record, bodies })
    }

    /// Called while holding the original Catalog owner, without releasing it between
    /// the work/input cut and its existing terminal execution transaction. A refusal
    /// leaves both the Run and the callback's ability to consume input unchanged.
    pub fn admit_driver_finish(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        prepared: PreparedDriverFinish,
    ) -> Result<DriverFinishReceipt> {
        let (run, _) = bound(&self.db, run_id, epoch, selection, false)?;
        if run.state == RunState::Cancelled {
            return Err(RuntimeError::DispatchCancelled);
        }
        if run.state.terminal() {
            return Ok(DriverFinishReceipt::Committed { state: run.state });
        }
        bound(&self.db, run_id, epoch, selection, true)?;
        if super::inputs::has_boundary_inputs(&self.db, run_id)? {
            return Ok(DriverFinishReceipt::InputPending);
        }
        if self.pending_question_wait(run_id)?.is_some()
            || self
                .pending_run_operations(run_id)?
                .iter()
                .any(|operation| !operation.handed_off)
        {
            return Ok(DriverFinishReceipt::WorkPending);
        }
        let unsettled_model: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched'))
             OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0)",
            [run_id], |row| row.get(0),
        )?;
        if unsettled_model {
            return Ok(DriverFinishReceipt::WorkPending);
        }
        for work in self.driver_work_ids(run_id, epoch, selection)? {
            if work.kind != DriverWorkKind::Tool {
                continue;
            }
            if let Some(operation) = optional_record::<Operation>(&self.db, "operations", &work.id)?
            {
                if !operation.handed_off && !self.driver_tool_stopped(&work.id)? {
                    return Ok(DriverFinishReceipt::WorkPending);
                }
            }
        }
        match self.commit_prepared_execution(run_id, epoch, &prepared.record, prepared.bodies) {
            Ok(()) => Ok(DriverFinishReceipt::Committed {
                state: self.run(run_id)?.state,
            }),
            Err(RuntimeError::InputPending) => Ok(DriverFinishReceipt::InputPending),
            Err(error) => Err(error),
        }
    }

    /// Post-commit callback failure is diagnostic only. It cannot undo the original
    /// terminal receipt or replace the Run's failure with a transport/provider error.
    pub fn record_driver_callback_failure(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        code: &str,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let (run, _) = bound(&tx, run_id, epoch, selection, false)?;
        if !run.state.terminal() {
            return Err(RuntimeError::Conflict(
                "driver callback still owns a nonterminal Run".into(),
            ));
        }
        event(
            &tx,
            run_id,
            run.revision,
            "driver.callback_failed",
            json!({"code":code}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn prepare_run_driver(
        &self,
        run_id: &str,
        selection: &DriverSelection,
        models: Vec<crate::execution::PolicyModelCapability>,
    ) -> Result<DriverLaunchPreparation> {
        let run = self.run(run_id)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::DispatchCancelled);
        }
        let expected = self.launch_metadata(run_id)?.ok_or_else(|| {
            RuntimeError::NotFound("driver preparation requires the original launch".into())
        })?;
        if let Some(original) = metadata(&self.db, run_id)? {
            if original.selection != *selection {
                return Err(RuntimeError::Conflict(
                    "the original driver was already selected".into(),
                ));
            }
        } else if !preparable(&self.db, run_id, &expected)? {
            return Err(RuntimeError::Conflict(
                "this Run has already begun execution".into(),
            ));
        }
        Ok(DriverLaunchPreparation {
            expected,
            selection: selection.clone(),
            models,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_run_driver(
        &mut self,
        prepared: PreparedDriverLaunch,
    ) -> Result<super::launch_content::LaunchRead> {
        if prepared.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "driver preparation belongs to a previous Catalog epoch".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let run_id = &prepared.expected.run_id;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::DispatchCancelled);
        }
        let mut launch: super::launch_content::LaunchMetadata =
            record(&tx, "run_launches", run_id)?;
        // Exact response-loss retries retain the original selection, not a new route.
        if let Some(original) = metadata(&tx, run_id)? {
            if original.selection != prepared.selection
                || launch.selection.driver != prepared.selection
                || launch.selection.driver_models != prepared.models
            {
                return Err(RuntimeError::Conflict(
                    "the original driver/model capabilities cannot be replaced".into(),
                ));
            }
            drop(tx);
            return self.launch_read(launch);
        }
        if launch != prepared.expected || !preparable(&tx, run_id, &launch)? {
            return Err(RuntimeError::Conflict(
                "launch changed during driver preparation".into(),
            ));
        }
        bind(&tx, run_id, &prepared.selection)?;
        launch.selection.driver = prepared.selection;
        launch.selection.driver_models = prepared.models;
        launch.revision += 1;
        put(&tx, "run_launches", run_id, &launch)?;
        event(
            &tx,
            run_id,
            launch.revision,
            "run.driver_prepared",
            json!({"driverId":launch.selection.driver.owner_key()}),
        )?;
        tx.commit()?;
        self.launch_read(launch)
    }
    pub fn bind_run_driver(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
    ) -> Result<DriverRunMetadata> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::DispatchCancelled);
        }
        let launch =
            optional_record::<super::launch_content::LaunchMetadata>(&tx, "run_launches", run_id)?;
        let expected = launch
            .as_ref()
            .map(|launch| launch.selection.driver.clone())
            .unwrap_or_default();
        if selection != &expected {
            return Err(RuntimeError::Conflict(
                "driver differs from original launch selection".into(),
            ));
        }
        let metadata = bind(&tx, run_id, selection)?;
        tx.commit()?;
        Ok(metadata)
    }
    /// Read recovery facts without claiming the driver has received control. Failed
    /// input preparation can safely be retried because no algorithm was dispatched.
    pub fn capture_driver_execution(
        &self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
    ) -> Result<DriverRunRead> {
        let (_, metadata) = bound(&self.db, run_id, epoch, selection, false)?;
        let checkpoint = checkpoint_metadata(&self.db, &metadata)?;
        Ok(DriverRunRead {
            metadata,
            checkpoint,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    /// Publish the dispatch marker only after input preparation, against the exact
    /// recovery facts read earlier. No two preparations may dispatch from one revision.
    pub fn admit_driver_execution(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        expected: &DriverRunMetadata,
    ) -> Result<DriverRunRead> {
        let tx = self.db.transaction()?;
        let (_, metadata) = bound(&tx, run_id, epoch, selection, true)?;
        if &metadata != expected {
            return Err(RuntimeError::Conflict(
                "driver execution changed during input preparation".into(),
            ));
        }
        let checkpoint = checkpoint_metadata(&tx, &metadata)?;
        let mut next = metadata.clone();
        next.started_epoch = Some(epoch);
        next.execution_revision = next
            .execution_revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Invalid("driver execution revision overflow".into()))?;
        tx.execute(
            "UPDATE run_drivers SET body=?2 WHERE run_id=?1",
            params![run_id, encode(&next)?],
        )?;
        event(
            &tx,
            run_id,
            next.execution_revision,
            "driver.started",
            json!({"driverId":selection.owner_key(),"epoch":epoch}),
        )?;
        tx.commit()?;
        Ok(DriverRunRead {
            metadata,
            checkpoint,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    /// Synchronous convenience. Production captures, prepares off-lock, then admits
    /// the exact original recovery metadata immediately before driver dispatch.
    pub fn start_driver_execution(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
    ) -> Result<DriverRunRead> {
        let expected = self
            .capture_driver_execution(run_id, epoch, selection)?
            .metadata;
        self.admit_driver_execution(run_id, epoch, selection, &expected)
    }
    pub fn prepare_driver_content(&self) -> DriverContentPreparation {
        DriverContentPreparation {
            call_authority: None,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    /// Capture the original executable cut while holding Catalog; tool body and
    /// directory validation remain on the caller's worker before admission.
    pub fn prepare_driver_call(&self, run_id: &str) -> Result<DriverContentPreparation> {
        let launch = record(&self.db, "run_launches", run_id)?;
        Ok(DriverContentPreparation {
            call_authority: Some(DriverCallAuthority {
                epoch: self.epoch,
                launch,
                has_goal: self.goal_binding(run_id)?.is_some(),
            }),
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn commit_driver_checkpoint(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        expected_revision: u64,
        prepared: PreparedDriverCheckpoint,
    ) -> Result<DriverCheckpointMetadata> {
        let DriverSelection::Extension { artifact } = selection else {
            return Err(RuntimeError::Invalid(
                "default driver retains its native checkpoint owner".into(),
            ));
        };
        if artifact.recovery != DriverRecovery::Checkpoint
            || artifact.checkpoint_schema.as_deref() != Some(prepared.schema.as_str())
        {
            return Err(RuntimeError::Conflict(
                "driver checkpoint schema differs from its frozen recovery contract".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let (_, mut driver) = bound(&tx, run_id, epoch, selection, true)?;
        let revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Invalid("checkpoint revision overflow".into()))?;
        let checkpoint = DriverCheckpointMetadata {
            run_id: run_id.into(),
            driver_id: selection.owner_key(),
            revision,
            schema: prepared.schema,
            state_ref: prepared.state_ref,
            operations: prepared.operations,
        };
        // The exact retry after a lost reply reads the same immutable checkpoint, even
        // if a later checkpoint has since committed. It cannot overwrite the latest one.
        let previous: Option<String> = tx
            .query_row(
                "SELECT body FROM driver_checkpoints WHERE run_id=?1 AND revision=?2",
                params![run_id, sql_number(revision)?],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            if serde_json::from_str::<DriverCheckpointMetadata>(&previous)? == checkpoint {
                return Ok(checkpoint);
            }
            return Err(RuntimeError::Conflict(
                "driver checkpoint revision already has another state".into(),
            ));
        }
        if driver.checkpoint_revision != expected_revision {
            return Err(RuntimeError::Conflict(
                "driver checkpoint revision changed".into(),
            ));
        }
        for operation in &checkpoint.operations {
            let delivery_prefix = format!("driver:delivery:{}:{run_id}:", run_id.len());
            let owned:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE id=?1 AND run_id=?2) OR EXISTS(SELECT 1 FROM model_steps WHERE id=?1 AND run_id=?2) OR EXISTS(SELECT 1 FROM driver_calls WHERE id=?1 AND run_id=?2) OR EXISTS(SELECT 1 FROM history WHERE id=?1 AND run_id=?2 AND substr(id,1,length(?3))=?3)",params![operation,run_id,delivery_prefix],|row|row.get(0))?;
            if !owned {
                return Err(RuntimeError::Conflict(
                    "checkpoint refers to work outside the original Run".into(),
                ));
            }
        }
        tx.execute(
            "INSERT INTO driver_checkpoints(run_id,revision,body) VALUES(?1,?2,?3)",
            params![run_id, sql_number(revision)?, encode(&checkpoint)?],
        )?;
        driver.checkpoint_revision = revision;
        tx.execute(
            "UPDATE run_drivers SET body=?2 WHERE run_id=?1",
            params![run_id, encode(&driver)?],
        )?;
        event(
            &tx,
            run_id,
            revision,
            "driver.checkpoint",
            json!({"driverId":checkpoint.driver_id,"revision":revision}),
        )?;
        tx.commit()?;
        Ok(checkpoint)
    }
    pub fn admit_driver_call(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        prepared: PreparedDriverCall,
    ) -> Result<DriverCallMetadata> {
        let tx = self.db.transaction()?;
        let (run, _) = bound(&tx, run_id, epoch, selection, true)?;
        let frozen = &prepared.frozen;
        if frozen.run_id != run_id || prepared.history_range.branch_id != run.branch_id {
            return Err(RuntimeError::Conflict(
                "driver tool source belongs to another Run".into(),
            ));
        }
        let launch: super::launch_content::LaunchMetadata = record(&tx, "run_launches", run_id)?;
        if prepared.authority.epoch != epoch
            || launch != prepared.authority.launch
            || super::goals::for_run(&tx, run_id)?.is_some() != prepared.authority.has_goal
        {
            return Err(RuntimeError::Conflict(
                "driver tool capability selection changed during preparation".into(),
            ));
        }
        {
            if frozen.tool_schema_generation != launch.selection.tool_schema_generation
                || prepared.tools_ref != launch.selection.tools_ref
                || frozen.source != launch.selection.source
                || frozen.child_dispatch != launch.dispatch_context_ref
            {
                return Err(RuntimeError::Conflict(
                    "driver tool directory differs from the frozen launch".into(),
                ));
            }
        }
        let call = DriverCallMetadata {
            id: frozen.origin.operation_id(&prepared.call.call_id),
            run_id: run_id.into(),
            epoch,
            driver_id: selection.owner_key(),
            call: prepared.call,
            frozen_ref: prepared.frozen_ref,
            history_range: prepared.history_range,
            goal: super::goals::for_run(&tx, run_id)?.map(|goal| goal.binding()),
            dispatch_history: prepared.dispatch_history,
            pre_dispatch_completion: None,
        };
        if let Some(previous) =
            optional_record::<DriverCallMetadata>(&tx, "driver_calls", &call.id)?
        {
            let mut expected = call.clone();
            expected.epoch = previous.epoch;
            expected.goal = previous.goal.clone();
            expected.pre_dispatch_completion = previous.pre_dispatch_completion.clone();
            if previous != expected {
                return Err(RuntimeError::Conflict(
                    "driver invocation identity reused with different input".into(),
                ));
            }
            return Ok(previous);
        }
        let occupied:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE id=?1) OR EXISTS(SELECT 1 FROM model_steps WHERE id=?1)", [&call.id], |row| row.get(0))?;
        if occupied {
            return Err(RuntimeError::Conflict(
                "driver invocation identity is already owned by another work item".into(),
            ));
        }
        if let Some(head) = &call.history_range.leaf_id {
            super::context_jobs::require_ancestor(&tx, &run.branch_id, head)?;
        }
        super::goals::check_dispatch(&tx, run_id, call.goal.as_ref())?;
        tx.execute(
            "INSERT INTO driver_calls(id,run_id,body) VALUES(?1,?2,?3)",
            params![call.id, run_id, encode(&call)?],
        )?;
        event(
            &tx,
            &call.id,
            1,
            "driver.tool_selected",
            json!({"runId":run_id,"driverId":call.driver_id}),
        )?;
        tx.commit()?;
        Ok(call)
    }
    pub fn commit_driver_pre_dispatch_completion(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        prepared: PreparedDriverPreDispatch,
    ) -> Result<DriverCallMetadata> {
        let tx = self.db.transaction()?;
        bound(&tx, run_id, epoch, selection, false)?;
        let mut original = driver_call_metadata(&tx, &prepared.expected.id)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE id=?1)",
            [&original.id],
            |row| row.get(0),
        )?;
        let mut expected = prepared.expected;
        expected.pre_dispatch_completion = original.pre_dispatch_completion.clone();
        if exists
            || original != expected
            || original.run_id != run_id
            || original.epoch != epoch
            || original.driver_id != selection.owner_key()
        {
            return Err(RuntimeError::Conflict(
                "pre-dispatch completion no longer owns the original unadmitted call".into(),
            ));
        }
        if let Some(previous) = &original.pre_dispatch_completion {
            if previous == &prepared.completion {
                return Ok(original);
            }
            return Err(RuntimeError::Conflict(
                "original pre-dispatch completion changed".into(),
            ));
        }
        original.pre_dispatch_completion = Some(prepared.completion);
        put(&tx, "driver_calls", &original.id, &original)?;
        event(
            &tx,
            &original.id,
            1,
            "driver.tool_not_dispatched",
            json!({"runId":run_id,"driverId":original.driver_id,"epoch":epoch}),
        )?;
        tx.commit()?;
        Ok(original)
    }
    pub fn capture_driver_pre_dispatch_completion(
        &self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        id: &str,
    ) -> Result<Option<super::result_content::ToolCompletionRead>> {
        bound(&self.db, run_id, epoch, selection, false)?;
        let call = driver_call_metadata(&self.db, id)?;
        if call.run_id != run_id || call.driver_id != selection.owner_key() {
            return Err(RuntimeError::Conflict(
                "receipt belongs to another Run driver".into(),
            ));
        }
        let Some(completion) = call.pre_dispatch_completion else {
            return Ok(None);
        };
        if !matches!(
            completion,
            super::result_content::ToolCompletionMetadata::NotDispatched { .. }
        ) || optional_record::<Operation>(&self.db, "operations", id)?.is_some()
        {
            return Err(RuntimeError::Invalid(
                "pre-dispatch receipt conflicts with an admitted Operation".into(),
            ));
        }
        Ok(Some(super::result_content::ToolCompletionRead {
            completion,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }))
    }
    pub fn capture_driver_call(&self, id: &str) -> Result<DriverCallRead> {
        let metadata: DriverCallMetadata = record(&self.db, "driver_calls", id)?;
        let driver = self::metadata(&self.db, &metadata.run_id)?
            .ok_or_else(|| RuntimeError::NotFound("original driver".into()))?;
        if metadata.driver_id != driver.selection.owner_key() {
            return Err(RuntimeError::Conflict(
                "driver call belongs to another implementation".into(),
            ));
        }
        Ok(DriverCallRead {
            metadata,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn capture_driver_input(
        &self,
        run_id: &str,
        epoch: u64,
        mut binding: RequestBinding,
    ) -> Result<DriverInputRead> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let active: Option<String> = self.db.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| row.get(0),
        )?;
        if active.as_deref() != Some(run_id) || run.cancel_requested {
            return Err(RuntimeError::Conflict(
                "original driver branch owner is unavailable".into(),
            ));
        }
        binding.history_range.leaf_id = self.head(&run.branch_id)?;
        self.driver_input_read(run, binding)
    }
    /// A final report is an observation, not new execution admission. It remains
    /// readable after cancellation/termination and never adopts a later Run's head.
    pub fn capture_driver_report(
        &self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        mut binding: RequestBinding,
    ) -> Result<DriverInputRead> {
        let (run, _) = bound(&self.db, run_id, epoch, selection, false)?;
        binding.history_range.leaf_id = self
            .db
            .query_row(
                "SELECT id FROM history WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        self.driver_input_read(run, binding)
    }
    fn driver_input_read(&self, run: Run, mut binding: RequestBinding) -> Result<DriverInputRead> {
        let run_id = run.id.as_str();
        binding.history_range.branch_id = run.branch_id.clone();
        binding.request_context = Some(self.model_request_context(run_id)?);
        Ok(DriverInputRead {
            model_steps: self.db.query_row(
                "SELECT count(*) FROM model_steps WHERE run_id=?1",
                [run_id],
                |row| read_number(row, 0),
            )?,
            run,
            binding,
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no persistent database".into()))?
                .into(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn commit_driver_delivery(
        &mut self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        prepared: PreparedDriverDelivery,
    ) -> Result<String> {
        let tx = self.db.transaction()?;
        let (run, _) = bound(&tx, run_id, epoch, selection, true)?;
        if prepared.run_id != run_id || prepared.driver_id != selection.owner_key() {
            return Err(RuntimeError::Conflict(
                "delivery belongs to another driver".into(),
            ));
        }
        if let Some(previous) =
            optional_record::<HistoryItem>(&tx, "history", &prepared.history_id)?
        {
            if previous.run_id == run_id && previous.content == prepared.reference {
                return Ok(prepared.history_id);
            }
            return Err(RuntimeError::Conflict(
                "delivery identity reused with different content".into(),
            ));
        }
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if active.as_deref() != Some(run_id) {
            return Err(RuntimeError::Conflict(
                "driver delivery branch owner changed".into(),
            ));
        }
        let item = HistoryItem {
            run_id: run_id.into(),
            id: prepared.history_id.clone(),
            thread_id: run.thread_id,
            parent: head,
            source: HistorySource::Assistant,
            content: prepared.reference,
            provider: None,
        };
        tx.execute(
            "INSERT INTO history(id,thread_id,parent,body,run_id) VALUES(?1,?2,?3,?4,?5)",
            params![item.id, item.thread_id, item.parent, encode(&item)?, run_id],
        )?;
        tx.execute(
            "UPDATE branches SET head=?2 WHERE id=?1",
            params![run.branch_id, item.id],
        )?;
        event(
            &tx,
            run_id,
            run.revision,
            "assistant.output",
            json!({"driverId":prepared.driver_id,"historyId":item.id}),
        )?;
        event(
            &tx,
            run_id,
            run.revision,
            "driver.delivered",
            json!({"driverId":prepared.driver_id,"historyId":item.id}),
        )?;
        tx.commit()?;
        Ok(item.id)
    }
    pub fn capture_driver_model_receipt(
        &self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
        request_id: &str,
    ) -> Result<DriverModelRead> {
        bound(&self.db, run_id, epoch, selection, false)?;
        let step: ModelStep = record(&self.db, "model_steps", request_id)?;
        if step.run_id != run_id {
            return Err(RuntimeError::Conflict(
                "model work belongs to another Run".into(),
            ));
        }
        let output_ref: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM model_outputs WHERE request_id=?1",
                [request_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(DriverModelRead {
            step,
            driver_id: selection.owner_key(),
            output_ref: output_ref
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    /// Stop proof belongs to the original executor. A terminal business receipt alone
    /// says nothing about its physical lifetime, and a handed-off Job may still run.
    pub fn driver_tool_stopped(&self, operation_id: &str) -> Result<bool> {
        let call = driver_call_metadata(&self.db, operation_id)?;
        let Some(operation) = optional_record::<Operation>(&self.db, "operations", operation_id)?
        else {
            return Ok(true);
        };
        if operation.run_id != call.run_id {
            return Err(RuntimeError::Conflict(
                "driver operation belongs to another Run".into(),
            ));
        }
        let Some(owner) = &operation.execution_owner else {
            return Ok(true);
        };
        if operation.external_receipt.as_ref().is_some_and(|receipt| {
            receipt.executor_stopped
                && receipt.identity == operation.id
                && operation.executor.as_deref() == Some(receipt.executor.as_str())
                && match owner {
                    ExecutorOwner::External { epoch, .. } => epoch == &receipt.epoch,
                    ExecutorOwner::Kernel => true,
                }
        }) {
            return Ok(true);
        }
        let owner = serde_json::to_value(owner)?;
        let explicit_kernel:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='operation.kernel_executor_stopped' AND json_extract(data,'$.operationEpoch')=?2 AND json_extract(data,'$.executionOwner.kind')='kernel')",params![operation.id,sql_number(operation.epoch)?],|row|row.get(0))?;
        if explicit_kernel && operation.execution_owner == Some(ExecutorOwner::Kernel) {
            return Ok(true);
        }
        if operation.execution_owner == Some(ExecutorOwner::Kernel)
            && operation.effect == Effect::Unknown
        {
            return Ok(false);
        }
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='operation.invocation_executor_stopped' AND json_extract(data,'$.operationEpoch')=?2 AND json_extract(data,'$.executionOwner.kind') IS ?3 AND json_extract(data,'$.executionOwner.identity') IS ?4 AND json_extract(data,'$.executionOwner.epoch') IS ?5)",params![operation.id,sql_number(operation.epoch)?,owner["kind"].as_str(),owner["identity"].as_str(),owner["epoch"].as_str()],|row|row.get(0))?)
    }
    /// Only original Run facts participate in this wait cursor. The global event
    /// subscription is a wake-up hint; callers re-read this scoped observation.
    pub fn driver_activity(
        &self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
    ) -> Result<DriverActivity> {
        let (run, _) = bound(&self.db, run_id, epoch, selection, false)?;
        let cursor = self.db.query_row(
            "SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1
             OR subject IN (SELECT id FROM model_steps WHERE run_id=?1 AND driver_id=?2)
             OR subject IN (SELECT id FROM driver_calls WHERE run_id=?1)
             OR subject IN (SELECT id FROM operations WHERE run_id=?1)
             OR subject IN (SELECT id FROM input_queue WHERE branch_id=?3 AND run_id=?1)",
            params![run_id, selection.owner_key(), run.branch_id],
            |row| read_number(row, 0),
        )?;
        Ok(DriverActivity {
            cursor,
            input_pending: super::inputs::has_boundary_inputs(&self.db, run_id)?,
        })
    }
    pub fn driver_work_ids(
        &self,
        run_id: &str,
        epoch: u64,
        selection: &DriverSelection,
    ) -> Result<Vec<DriverWorkReference>> {
        bound(&self.db, run_id, epoch, selection, false)?;
        let mut work = Vec::new();
        for (kind, query, prefix) in [
            (
                DriverWorkKind::Model,
                "SELECT id FROM model_steps WHERE run_id=?1 AND substr(id,1,length(?2))=?2 ORDER BY rowid",
                format!("driver:model:{}:{run_id}:", run_id.len()),
            ),
            (
                DriverWorkKind::Tool,
                "SELECT id FROM driver_calls WHERE run_id=?1 AND (?2='' OR id=?2) ORDER BY rowid",
                String::new(),
            ),
            (
                DriverWorkKind::Delivery,
                "SELECT id FROM history WHERE run_id=?1 AND substr(id,1,length(?2))=?2 ORDER BY rowid",
                format!("driver:delivery:{}:{run_id}:", run_id.len()),
            ),
        ] {
            for id in self
                .db
                .prepare(query)?
                .query_map(params![run_id, prefix], |row| row.get::<_, String>(0))?
            {
                work.push(DriverWorkReference {
                    kind: kind.clone(),
                    id: id?,
                });
            }
        }
        Ok(work)
    }
}

#[cfg(test)]
#[path = "catalog_driver_tests.rs"]
mod tests;
