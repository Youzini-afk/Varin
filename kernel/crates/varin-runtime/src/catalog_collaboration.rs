//! Durable parent/child facts. This is a Catalog domain, not a second task registry.
//! Preparation and model I/O are performed by their existing owners after admission.
use super::*;
use crate::execution::{
    AdmittedTool, ToolCompletion, ToolExecutionContext, ToolOrigin, ToolResult,
};
use serde::Deserialize;

pub const DISPATCH_TOOL: &str = "dispatch";
pub const STATUS_TOOL: &str = "child_status";
pub const REPORT_TOOL: &str = "child_report";
pub const WAIT_TOOL: &str = "wait_child";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DispatchInput {
    pub task: String,
    pub model: String,
    pub profile: String,
}
impl DispatchInput {
    pub fn validate(&self) -> Result<()> {
        if self.task.trim().is_empty() || self.model != "parent" || self.profile != "read_only" {
            return Err(RuntimeError::Invalid(
                "dispatch requires a task, explicit parent model and read_only profile".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildSourcePin {
    pub pin_id: String,
    pub root: String,
    pub source: launches::SourceSelection,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildReport {
    pub outcome: Outcome,
    pub sender_thread_id: String,
    pub run_id: Option<String>,
    pub history_ids: Vec<String>,
    pub detail: Option<String>,
    pub code_result: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildTask {
    pub operation_id: String,
    pub parent_run_id: String,
    pub parent_thread_id: String,
    pub parent_branch_id: String,
    pub origin: ToolOrigin,
    pub call_id: String,
    pub child_thread_id: String,
    pub child_branch_id: String,
    pub project_id: Option<String>,
    pub input_ref: Value,
    pub configuration_ref: Value,
    pub launch: launch_content::LaunchSelectionMetadata,
    pub source_pin: ChildSourcePin,
    pub state: String,
    pub revision: u64,
    pub cursor: u64,
    pub receipt: Option<Receipt>,
    pub report: Option<ChildReport>,
    pub resources_released: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildTextPage {
    pub operation_id: String,
    pub item_id: String,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub total_bytes: usize,
    pub text: String,
}
impl Catalog {
    /// Bounded projection of existing history content. No duplicated report body is persisted.
    pub fn read_child_report(
        &self,
        operation_id: &str,
        item_id: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<ChildTextPage> {
        self.capture_child_report(operation_id,item_id,offset,max_bytes)?.load()
    }
    pub fn capture_child_report(
        &self,
        operation_id: &str,
        item_id: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<child_content::ChildReportRead> {
        let child = self.child_task(operation_id)?;
        if !child
            .report
            .as_ref()
            .is_some_and(|r| r.history_ids.iter().any(|id| id == item_id))
        {
            return Err(RuntimeError::Invalid(
                "item is not a report of this child".into(),
            ));
        }
        Ok(child_content::ChildReportRead::new(self, operation_id, item_id, offset, max_bytes,
            record(&self.db,"history",item_id)?))
    }

    pub fn child_task(&self, operation_id: &str) -> Result<ChildTask> {
        record(&self.db, "child_tasks", operation_id)
    }
    pub fn child_tasks(&self) -> Result<Vec<ChildTask>> {
        read_all(&self.db, "child_tasks")
    }
    pub fn child_task_for_thread(&self, thread_id: &str) -> Result<Option<ChildTask>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM child_tasks WHERE child_thread_id=?1",
                [thread_id],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }
    /// The source owner has already admitted and pinned this exact revision under the real parent
    /// grant. No directory capture, credential preparation or extension callback runs here.
    pub fn accept_child(
        &mut self,
        context: &ToolExecutionContext,
        input: DispatchInput,
        pin: ChildSourcePin,
        child_launch: launches::LaunchSelection,
    ) -> Result<ChildTask> {
        let prepared = self.prepare_child_launch(&context.run_id, child_launch)?.load()?;
        self.accept_prepared_child(context, input, pin, prepared)
    }
    pub fn accept_prepared_child(&mut self, context: &ToolExecutionContext, input: DispatchInput,
        pin: ChildSourcePin, prepared: launch_content::PreparedChildLaunch) -> Result<ChildTask> {
        let prepared = self.prepare_child_admission(context,input,pin,prepared)?.load()?;
        self.accept_child_references(prepared)
    }
    pub fn accept_child_references(&mut self, prepared: child_content::PreparedChildAdmission) -> Result<ChildTask> {
        let context = &prepared.context;
        let child_launch = &prepared.launch;
        let pin = &prepared.pin;
        if let Some(old) =
            optional_record::<ChildTask>(&self.db, "child_tasks", &context.operation_id)?
        {
            if old.parent_run_id == context.run_id
                && old.origin == context.origin
                && old.input_ref == prepared.input_ref
                && &old.source_pin == pin
                && &old.launch == child_launch
            {
                return Ok(old);
            }
            return Err(RuntimeError::Conflict(
                "dispatch origin has different input or source".into(),
            ));
        }
        let project_id = self.run_project_id(&context.run_id)?;
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", &context.run_id)?;
        fence(&run, self.epoch)?;
        let mut op: Operation = record(&tx, "operations", &context.operation_id)?;
        let request_id = match &context.origin {
            ToolOrigin::ModelStep { request_id } => request_id,
            ToolOrigin::PolicyAction { .. } => {
                return Err(RuntimeError::Invalid(
                    "dispatch requires a committed model tool origin".into(),
                ))
            }
        };
        let step: ModelStep = record(&tx, "model_steps", request_id)?;
        if step.run_id != run.id
            || op.run_id != run.id
            || op.epoch != run.epoch
            || op.executor.as_deref() != Some(DISPATCH_TOOL)
            || context.operation_id != format!("{request_id}:tool:{}", prepared.call_id)
            || op.revision != prepared.operation_revision
            || op.phase != OperationPhase::Running
            || op.cancel_requested
            || run.cancel_requested
        {
            return Err(RuntimeError::Conflict(
                "dispatch is not an admitted parent tool call".into(),
            ));
        }
        let parent: launch_content::LaunchMetadata = record(&tx, "run_launches", &run.id)?;
        if parent.selection.source.as_ref() != Some(&pin.source)
            || parent.selection.connection_identity != child_launch.connection_identity
            || parent.selection.credential_scope != child_launch.credential_scope
            || parent.selection.model != child_launch.model
            || parent.selection.provider_family != child_launch.provider_family
            || parent.selection.configuration_generation != child_launch.configuration_generation
            || parent.selection.tool_schema_generation != child_launch.tool_schema_generation
            || parent.selection.tools_ref != prepared.parent_tools_ref
        {
            return Err(RuntimeError::Conflict(
                "child exceeds parent source/model/read authority".into(),
            ));
        }
        let child_thread_id = format!("thread:child:{}", op.id);
        let child_branch_id = format!("branch:child:{}", op.id);
        tx.execute("INSERT INTO threads(id) VALUES(?1)", [&child_thread_id])?;
        tx.execute(
            "INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,NULL)",
            params![child_branch_id, child_thread_id],
        )?;
        let mut child = ChildTask {
            operation_id: op.id.clone(),
            parent_run_id: run.id.clone(),
            parent_thread_id: run.thread_id.clone(),
            parent_branch_id: run.branch_id.clone(),
            origin: context.origin.clone(),
            call_id: prepared.call_id.clone(),
            child_thread_id,
            child_branch_id,
            project_id,
            input_ref: prepared.input_ref,
            configuration_ref: prepared.configuration_ref,
            launch: prepared.launch,
            source_pin: prepared.pin,
            state: "preparing".into(),
            revision: 1,
            cursor: 0,
            receipt: None,
            report: None,
            resources_released: false,
        };
        // Persist the real tool receipt before releasing the admission transaction. Recovery can
        // complete the original exchange without creating another child or replaying the dispatch.
        let receipt = ToolResult {
            request_id: request_id.clone(),
            call_id: prepared.call_id,
            completion: ToolCompletion::JobAccepted {
                operation_id: op.id.clone(),
                phase: "preparing_child".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
            },
        };
        tx.execute(
            "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
            params![receipt.request_id, receipt.call_id, encode(&receipt)?],
        )?;
        op.handed_off = true;
        op.phase = OperationPhase::Preparing;
        op.effect = Effect::None;
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        child.cursor = event(
            &tx,
            &op.id,
            child.revision,
            "child.accepted",
            json!({"child_thread_id":child.child_thread_id,"parent_run_id":run.id}),
        )?;
        tx.execute(
            "INSERT INTO child_tasks(id,child_thread_id,body) VALUES(?1,?2,?3)",
            params![op.id, child.child_thread_id, encode(&child)?],
        )?;
        tx.commit()?;
        Ok(child)
    }
}

/// Required on every existing catalog before any write-capable open or epoch advancement.
pub(super) fn check_format(db: &Connection) -> Result<()> {
    let version: Option<i64> = db
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='collaboration'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let columns: Vec<(String, String, i64, i64)> = {
        let mut statement = db.prepare("PRAGMA table_info(child_tasks)")?;
        let rows = statement
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(5)?)))?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    if version != Some(2)
        || columns
            != vec![
                ("id".into(), "TEXT".into(), 0, 1),
                ("child_thread_id".into(), "TEXT".into(), 1, 0),
                ("body".into(), "TEXT".into(), 1, 0),
            ]
    {
        return Err(RuntimeError::Invalid(
            "unsupported or malformed collaboration domain; user data was preserved".into(),
        ));
    }
    let relations: Vec<(String, String, String, String, String, String)> = {
        let mut statement = db.prepare("PRAGMA foreign_key_list(child_tasks)")?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get(3)?,
                    r.get(2)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    let indexes: Vec<(String, bool, String, bool)> = {
        let mut statement = db.prepare(
            "SELECT name,\"unique\",origin,partial FROM pragma_index_list('child_tasks')",
        )?;
        let rows = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    let mut primary_id = false;
    let mut unique_thread = false;
    for (name, unique, origin, partial) in indexes {
        if !unique || partial {
            continue;
        }
        // index_info omits collation/order and cannot distinguish a partial UNIQUE constraint.
        // Auxiliary rowid columns are not keys; expressions have no column name and must not match.
        let keys: Vec<(Option<String>, String, bool)> = {
            let mut statement = db.prepare(
                "SELECT name,coll,\"desc\" FROM pragma_index_xinfo(?1) WHERE key=1 ORDER BY seqno",
            )?;
            let rows = statement
                .query_map([name], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<std::result::Result<_, _>>()?;
            rows
        };
        if origin == "pk" && keys == vec![(Some("id".into()), "BINARY".into(), false)] {
            primary_id = true;
        }
        if keys == vec![(Some("child_thread_id".into()), "BINARY".into(), false)] {
            unique_thread = true;
        }
    }
    let expected_relation = |column: &str, table: &str| {
        (
            column.into(),
            table.into(),
            "id".into(),
            "NO ACTION".into(),
            "NO ACTION".into(),
            "NONE".into(),
        )
    };
    if relations.len() != 2
        || !relations.contains(&expected_relation("id", "operations"))
        || !relations.contains(&expected_relation("child_thread_id", "threads"))
        || !primary_id
        || !unique_thread
    {
        return Err(RuntimeError::Invalid(
            "malformed collaboration constraints; user data was preserved".into(),
        ));
    }
    // Validate persisted domain bodies while the existing catalog is still read-only.
    // In particular, an older duplicated-text report is not silently rewritten as references.
    let mut statement = db.prepare("SELECT id,child_thread_id,body FROM child_tasks")?;
    for row in statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (id, thread, body) = row?;
        let child: ChildTask = serde_json::from_str(&body).map_err(|_| {
            RuntimeError::Invalid("unsupported collaboration body; user data was preserved".into())
        })?;
        if child.operation_id != id || child.child_thread_id != thread {
            return Err(RuntimeError::Invalid(
                "malformed collaboration identity; user data was preserved".into(),
            ));
        }
    }
    Ok(())
}
pub(super) fn initialize_new(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE child_tasks(id TEXT PRIMARY KEY REFERENCES operations(id),child_thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),body TEXT NOT NULL); INSERT INTO runtime_domains(name,version) VALUES('collaboration',2);")?;
    Ok(())
}

impl Catalog {
    /// Context is assembled by the single Host context owner from the child identity and admitted
    /// project/role. The existing input writer commits its Run, context, launch and relation together.
    pub fn capture_child_preparation(
        &self,
        operation_id: &str,
        source: launches::SourceSelection,
        proposal: context::ContextProposal,
        basis: personalization::PersonalizationBasis,
    ) -> Result<ChildPreparation> {
        let child = self.child_task(operation_id)?;
        let admitted = child
            .receipt
            .as_ref()
            .map(|receipt| self.capture_admitted_checkpoint(&receipt.run_id))
            .transpose()?
            .flatten();
        let checkpoint = self
            .capture_active_checkpoint(&child.child_branch_id)?
            .map(|checkpoint| checkpoint.id);
        Ok(ChildPreparation {
            child,
            source,
            proposal,
            basis,
            admitted,
            checkpoint,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_child(&mut self, prepared: PreparedChild) -> Result<ChildTask> {
        let PreparedChild {
            operation_id,
            submission,
            receipt,
        } = prepared;
        if let Some(submission) = submission {
            self.submit_admission(submission, None)?;
        } else if self.child_task(&operation_id)?.receipt != receipt {
            return Err(RuntimeError::Conflict(
                "child admission changed during preparation".into(),
            ));
        }
        self.child_task(&operation_id)
    }
    pub fn require_child_launch(&self, run_id: &str) -> Result<Option<ChildTask>> {
        let run = self.run(run_id)?;
        let Some(child) = self.child_task_for_thread(&run.thread_id)? else {
            return Ok(None);
        };
        let op = self.operation(&child.operation_id)?;
        if child.receipt.as_ref().map(|r| r.run_id.as_str()) != Some(run_id)
            || child.state != "ready"
            || op.cancel_requested
            || child.report.is_some()
        {
            return Err(RuntimeError::Conflict(
                "child is not eligible to launch".into(),
            ));
        }
        Ok(Some(child))
    }
}
pub struct ChildPreparation {
    child: ChildTask,
    source: launches::SourceSelection,
    proposal: context::ContextProposal,
    basis: personalization::PersonalizationBasis,
    admitted: Option<context::CheckpointRead>,
    checkpoint: Option<String>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChild {
    operation_id: String,
    submission: Option<submissions::PreparedSubmission>,
    receipt: Option<Receipt>,
}
impl ChildPreparation {
    pub fn load(self) -> Result<PreparedChild> {
        let Self {
            child,
            source,
            proposal,
            basis,
            admitted,
            checkpoint,
            epoch,
            content,
            publication,
        } = self;
        let scope = serde_json::to_value(&basis)?;
        if basis.session_id != child.child_thread_id
            || basis.project_id != child.project_id
            || scope.get("mode").and_then(Value::as_str) != Some("agent")
            || scope.get("threadRole").and_then(Value::as_str) != Some("worker")
            || proposal.branch_id != child.child_branch_id
            || proposal.through_id.is_some()
            || proposal.expected_revision != 0
            || !proposal.summary.is_empty()
        {
            return Err(RuntimeError::Conflict(
                "child context does not match admitted identity/role/project".into(),
            ));
        }
        source.validate()?;
        let mut expected = child.source_pin.source.clone();
        expected.branch_id = Some(format!("child-source:{}", child.operation_id));
        expected.revision = Some(0);
        if source != expected {
            return Err(RuntimeError::Conflict(
                "prepared source does not match child baseline identity".into(),
            ));
        }
        if child.receipt.is_some() {
            let admitted = admitted
                .ok_or_else(|| {
                    RuntimeError::Invalid("child admission has no context checkpoint".into())
                })?
                .load()?;
            if admitted.proposal != proposal || admitted.personalization.as_ref() != Some(&basis) {
                return Err(RuntimeError::Conflict(
                    "child preparation retry changed its admitted context".into(),
                ));
            }
            return Ok(PreparedChild {
                operation_id: child.operation_id,
                receipt: child.receipt,
                submission: None,
            });
        }
        let input: DispatchInput = serde_json::from_value(content.load(&child.input_ref)?)?;
        let configuration = content.load(&child.configuration_ref)?;
        let mut launch = child.launch.load(&content)?;
        launch.source = Some(source);
        let operation_id = child.operation_id;
        let submission = submissions::PreparedSubmission::stage(submissions::SubmissionBody {
            command: SubmitInput {
                key: format!("child:{operation_id}"),
                thread_id: child.child_thread_id,
                branch_id: child.child_branch_id,
                expected_head: None,
                input: Value::String(input.task),
                configuration,
            },
            launch: Some(launch),
            inherit_source: false,
            initial: Some(proposal),
            personalization: Some(basis),
            origin: submissions::SubmissionOrigin::Child {
                operation_id: operation_id.clone(),
                checkpoint,
                parent_thread_id: child.parent_thread_id,
            },
            epoch,
            content,
            publication,
        })?;
        Ok(PreparedChild {
            operation_id,
            submission: Some(submission),
            receipt: None,
        })
    }
}
impl Catalog {
    pub fn fail_child_preparation(
        &mut self,
        operation_id: &str,
        reason: &str,
    ) -> Result<ChildTask> {
        let mut child = self.child_task(operation_id)?;
        if child.report.is_some() {
            return Ok(child);
        }
        if let Some(receipt) = &child.receipt {
            let run = self.run(&receipt.run_id)?;
            let steps: i64 = self.db.query_row(
                "SELECT count(*) FROM model_steps WHERE run_id=?1",
                [&run.id],
                |r| r.get(0),
            )?;
            if steps != 0 || run.state.terminal() {
                return Err(RuntimeError::Conflict(
                    "child execution already started; preparation cannot replace its outcome"
                        .into(),
                ));
            }
            self.transition_run(&run.id, run.epoch, run.revision, RunState::Failed)?;
        }
        child.state = "failed".into();
        child.report = Some(ChildReport {
            outcome: Outcome::Failed,
            sender_thread_id: child.child_thread_id.clone(),
            run_id: child.receipt.as_ref().map(|r| r.run_id.clone()),
            history_ids: vec![],
            detail: Some(reason.into()),
            code_result: "no_changes".into(),
        });
        self.publish_child_report(child)
    }
    pub fn cancel_child(&mut self, operation_id: &str) -> Result<ChildTask> {
        let child = self.child_task(operation_id)?;
        if child.report.is_some() {
            return Ok(child);
        }
        self.request_cancel_operation(operation_id)?;
        if let Some(receipt) = &child.receipt {
            self.request_cancel_run(&receipt.run_id)?;
            return self.child_task(operation_id);
        }
        let mut child = child;
        child.state = "cancelled".into();
        child.report = Some(ChildReport {
            outcome: Outcome::Cancelled,
            sender_thread_id: child.child_thread_id.clone(),
            run_id: None,
            history_ids: vec![],
            detail: Some("Child preparation was cancelled before launch.".into()),
            code_result: "no_changes".into(),
        });
        self.publish_child_report(child)
    }
    pub fn mark_child_resources_released(&mut self, operation_id: &str) -> Result<ChildTask> {
        let tx = self.db.transaction()?;
        let mut child: ChildTask = record(&tx, "child_tasks", operation_id)?;
        if child.receipt.is_none() && child.report.is_none() {
            return Err(RuntimeError::Conflict(
                "preparation still owns its source pin".into(),
            ));
        }
        if !child.resources_released {
            child.resources_released = true;
            child.revision += 1;
            put(&tx, "child_tasks", operation_id, &child)?;
            event(
                &tx,
                operation_id,
                child.revision,
                "child.resources_released",
                Value::Null,
            )?;
        }
        tx.commit()?;
        Ok(child)
    }
    pub(super) fn publish_child_report(&mut self, mut child: ChildTask) -> Result<ChildTask> {
        let tx = self.db.transaction()?;
        let old: ChildTask = record(&tx, "child_tasks", &child.operation_id)?;
        if old.report.is_some() {
            return Ok(old);
        }
        child.revision = old.revision + 1;
        put(&tx, "child_tasks", &child.operation_id, &child)?;
        event(
            &tx,
            &child.operation_id,
            child.revision,
            "child.report_ready",
            json!({"sender_thread_id":child.child_thread_id,"outcome":child.report.as_ref().map(|r|r.outcome)}),
        )?;
        tx.commit()?;
        self.settle_child_receipts()?;
        Ok(child)
    }
    /// Called on real completion/event notifications and restart, never a timer. The original
    /// model exchange must commit before terminalizing its Job, including very fast children.
    pub fn settle_child_receipts(&mut self) -> Result<()> {
        let children:Vec<ChildTask>={
            let mut statement=self.db.prepare("SELECT c.body FROM child_tasks c JOIN operations o ON o.id=c.id JOIN tool_calls t ON t.request_id=json_extract(c.body,'$.origin.request_id') AND t.call_id=json_extract(c.body,'$.call_id') WHERE json_extract(c.body,'$.report') IS NOT NULL AND json_extract(o.body,'$.external_receipt') IS NULL AND t.committed=1")?;
            let rows=statement.query_map([],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            rows.into_iter().map(|row|serde_json::from_str(&row).map_err(Into::into)).collect::<Result<_>>()?
        };
        for child in children {
            let report=child.report.as_ref().expect("selected report");
            let op = self.operation(&child.operation_id)?;
            if op.external_receipt.is_none() {
                self.record_external_receipt(
                    &child.operation_id,
                    ExternalReceipt {
                        executor: DISPATCH_TOOL.into(),
                        identity: child.operation_id.clone(),
                        epoch: "collaboration-v1".into(),
                        outcome: report.outcome,
                        effect: Effect::None,
                        result: serde_json::to_value(report)?,
                    },
                )?;
            }
        }
        Ok(())
    }
    pub fn reconcile_child_reports(&mut self) -> Result<()> {
        for prepared in self.capture_child_reports()?.load()? { self.admit_child_report(prepared)?; }
        self.settle_child_receipts()
    }

}

pub(super) fn validate_submission(
    tx: &Transaction<'_>,
    operation_id: &str,
    command: &submissions::SubmissionIdentity,
) -> Result<()> {
    let child: ChildTask = record(tx, "child_tasks", operation_id)?;
    let op: Operation = record(tx, "operations", operation_id)?;
    if child.state != "preparing"
        || child.receipt.is_some()
        || child.report.is_some()
        || op.cancel_requested
        || command.thread_id != child.child_thread_id
        || command.branch_id != child.child_branch_id
    {
        return Err(RuntimeError::Conflict(
            "child preparation was cancelled or superseded".into(),
        ));
    }
    Ok(())
}
pub(super) fn publish_submission(
    tx: &Transaction<'_>,
    operation_id: &str,
    receipt: &Receipt,
) -> Result<()> {
    let mut child: ChildTask = record(tx, "child_tasks", operation_id)?;
    child.receipt = Some(receipt.clone());
    child.state = "ready".into();
    child.revision += 1;
    put(tx, "child_tasks", operation_id, &child)?;
    event(
        tx,
        operation_id,
        child.revision,
        "child.prepared",
        json!({"run_id":receipt.run_id}),
    )?;
    Ok(())
}

impl Catalog {
    pub fn require_child_parent(&self, run_id: &str, operation_id: &str) -> Result<ChildTask> {
        let run = self.run(run_id)?;
        let child = self.child_task(operation_id)?;
        if child.parent_thread_id != run.thread_id {
            return Err(RuntimeError::Conflict(
                "child belongs to another parent Thread".into(),
            ));
        }
        Ok(child)
    }
    pub fn wait_for_child(
        &mut self,
        context: &ToolExecutionContext,
        operation_id: &str,
    ) -> Result<Wait> {
        let child = self.require_child_parent(&context.run_id, operation_id)?;
        let op = self.operation(&context.operation_id)?;
        if op.run_id != context.run_id
            || op.executor.as_deref() != Some(WAIT_TOOL)
            || op.cancel_requested
        {
            return Err(RuntimeError::Conflict(
                "child wait is not an admitted tool".into(),
            ));
        }
        let wait_id = format!("child-wait:{}", context.operation_id);
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", &context.run_id)?;
        if run.state.terminal() || run.cancel_requested {
            return Err(RuntimeError::Conflict("parent can no longer wait".into()));
        }
        let wait = if let Some(wait) = optional_record::<Wait>(&tx, "waits", &wait_id)? {
            wait
        } else {
            let trigger_cursor=tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='operation.settled' AND cursor>?2 ORDER BY cursor LIMIT 1",params![operation_id,sql_number(child.cursor)?],|r|read_number(r,0)).optional()?;
            let wait = Wait {
                id: wait_id.clone(),
                run_id: context.run_id.clone(),
                subject: operation_id.into(),
                kind: "operation.settled".into(),
                after_cursor: child.cursor,
                trigger_cursor,
                cancelled: false,
            };
            tx.execute(
                "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
                params![wait.id, wait.run_id, encode(&wait)?],
            )?;
            if let Some(cursor) = trigger_cursor {
                Self::enqueue_resume(&tx, &wait, cursor)?;
            }
            event(
                &tx,
                &wait.id,
                1,
                "wait.registered",
                serde_json::to_value(&wait)?,
            )?;
            wait
        };
        let mut op: Operation = record(&tx, "operations", &context.operation_id)?;
        op.waiting_on = Some(wait_id);
        op.phase = OperationPhase::Waiting;
        op.handed_off = true;
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        // Preserve this Job receipt through Host/kernel loss just as dispatch admission does.
        let admitted: AdmittedTool = serde_json::from_value(op.intent.clone())?;
        let request_id = match &context.origin {
            ToolOrigin::ModelStep { request_id } => request_id,
            _ => {
                return Err(RuntimeError::Invalid(
                    "child wait needs a model origin".into(),
                ))
            }
        };
        let receipt = ToolResult {
            request_id: request_id.clone(),
            call_id: admitted.call.call_id,
            completion: ToolCompletion::JobAccepted {
                operation_id: op.id.clone(),
                phase: "awaiting_child".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
            },
        };
        tx.execute(
            "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
            params![receipt.request_id, receipt.call_id, encode(&receipt)?],
        )?;
        event(
            &tx,
            &op.id,
            op.revision,
            "child.wait_registered",
            json!({"wait_id":wait.id,"child_operation_id":operation_id}),
        )?;
        tx.commit()?;
        Ok(wait)
    }
    pub fn pending_child_wait(&self, run_id: &str) -> Result<Option<String>> {
        self.db.query_row("SELECT json_extract(body,'$.waiting_on') FROM operations WHERE run_id=?1 AND json_extract(body,'$.executor')=?2 AND json_extract(body,'$.phase')!='terminal' AND json_extract(body,'$.waiting_on') IS NOT NULL ORDER BY rowid LIMIT 1",
            params![run_id,WAIT_TOOL],|row|row.get(0)).optional().map_err(Into::into)
    }

    pub fn cancel_child_wait(&mut self, wait_id: &str) -> Result<Wait> {
        self.request_cancel_child_wait(wait_id)?;
        self.deliver_child_waits()?;
        self.inspect_child_wait(wait_id)
    }
    pub fn inspect_child_wait(&self,wait_id:&str) -> Result<Wait> {
        if !wait_id.starts_with("child-wait:") {return Err(RuntimeError::Invalid("not a collaboration Wait".into()));}
        record(&self.db,"waits",wait_id)
    }
    pub fn request_cancel_child_wait(&mut self,wait_id:&str) -> Result<Wait> {
        if !wait_id.starts_with("child-wait:") {
            return Err(RuntimeError::Invalid("not a collaboration Wait".into()));
        }
        self.cancel_wait(wait_id)
    }
    /// Only a parked Run has relinquished its model-history writer. Do not append a report
    /// between a model call and its tool results, or concurrently with a frozen request.
    pub(super) fn close_finished_parent_waits(&mut self) -> Result<()> {
        let tx = self.db.transaction()?;
        let operations:Vec<Operation>={
            let mut statement=tx.prepare("SELECT o.body FROM operations o JOIN runs r ON r.id=o.run_id WHERE json_extract(o.body,'$.executor')=?1 AND json_extract(o.body,'$.phase')!='terminal' AND json_extract(r.body,'$.state') IN ('completed','failed','cancelled')")?;
            let rows=statement.query_map([WAIT_TOOL],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            rows.into_iter().map(|row|serde_json::from_str(&row).map_err(Into::into)).collect::<Result<_>>()?
        };
        for mut op in operations {
            if op.executor.as_deref() != Some(WAIT_TOOL) || op.phase == OperationPhase::Terminal {
                continue;
            }
            let run: Run = record(&tx, "runs", &op.run_id)?;
            if !run.state.terminal() {
                continue;
            }
            if let Some(id) = &op.waiting_on {
                let mut wait: Wait = record(&tx, "waits", id)?;
                wait.cancelled = true;
                put(&tx, "waits", id, &wait)?;
            }
            op.phase = OperationPhase::Terminal;
            op.outcome = Some(Outcome::Cancelled);
            op.effect = Effect::None;
            op.cancel_requested = true;
            op.revision += 1;
            op.result = Some(json!({"wait_cancelled":true,"reason":"parent_run_finished"}));
            put(&tx, "operations", &op.id, &op)?;
            event(
                &tx,
                &op.id,
                op.revision,
                "operation.settled",
                serde_json::to_value(&op)?,
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn deliver_child_waits(&mut self) -> Result<Vec<String>> {
        self.reconcile_child_reports()?;
        self.close_finished_parent_waits()?;
        for preparation in self.capture_child_waits()? {
            self.admit_child_wait(preparation.load()?)?;
        }
        self.pending_child_continuations()
    }

}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnacceptedChildSource {
    pub operation_id: String,
    pub parent_thread_id: String,
    pub source: launches::SourceSelection,
    pub pin_id: String,
}
impl Catalog {
    /// A process can stop after the source owner's durable pin receipt but before child admission.
    /// The immutable admitted tool + parent launch determine its exact cleanup identity. Only
    /// stopped/failed original dispatches qualify, so live admission is never raced by cleanup.
    pub fn unaccepted_child_sources(&self) -> Result<Vec<UnacceptedChildSource>> {
        let mut sources = Vec::new();
        for op in read_all::<Operation>(&self.db, "operations")? {
            if op.executor.as_deref() != Some(DISPATCH_TOOL) || op.phase != OperationPhase::Terminal
            {
                continue;
            }
            let owned:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM child_tasks WHERE id=?1) OR EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='child.source_released')",[&op.id],|r|r.get(0))?;
            if owned {
                continue;
            }
            let run = self.run(&op.run_id)?;
            let Some(source) = self
                .launch_metadata(&run.id)?
                .and_then(|launch| launch.selection.source)
            else {
                continue;
            };
            if source.mode != SourceMode::FixedBranch {
                continue;
            }
            sources.push(UnacceptedChildSource {
                pin_id: format!("child-pin:{}", op.id),
                operation_id: op.id,
                parent_thread_id: run.thread_id,
                source,
            });
        }
        Ok(sources)
    }
    pub fn mark_unaccepted_child_source_released(&mut self, operation_id: &str) -> Result<()> {
        if !self
            .unaccepted_child_sources()?
            .iter()
            .any(|source| source.operation_id == operation_id)
        {
            let done:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='child.source_released')",[operation_id],|r|r.get(0))?;
            if done {
                return Ok(());
            }
            return Err(RuntimeError::Conflict(
                "source cleanup no longer owns this dispatch".into(),
            ));
        }
        let tx = self.db.transaction()?;
        event(&tx, operation_id, 1, "child.source_released", Value::Null)?;
        tx.commit()?;
        Ok(())
    }
}
