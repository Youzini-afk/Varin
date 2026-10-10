//! Scheduling projects existing Run and collaboration facts; it creates no task tree.
use super::*;
use std::collections::BTreeSet;

impl Catalog {
    pub fn resource_admission(
        &self,
    ) -> std::sync::Arc<crate::resource_admission::ResourceAdmission> {
        self.resource_admission.clone()
    }
    /// Re-derived from committed lineage. Projects, paths and model arguments are irrelevant.
    pub fn task_family(&self, run_id: &str, epoch: u64) -> Result<String> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::Conflict(
                "Run cancellation forbids new execution".into(),
            ));
        }
        thread_family(&self.db, &run.thread_id)
    }
}

impl Catalog {
    /// A read-only tool already has a real call identity, but need not have an Operation row.
    /// Lookup starts from that durable origin, not an unscoped scheduler ticket supplied by a caller.
    pub fn inspect_admission(
        &self,
        run_id: &str,
        epoch: u64,
        origin: &crate::execution::ToolOrigin,
        call_id: &str,
    ) -> Result<Value> {
        use crate::execution::ToolOrigin;
        let run = self.run(run_id)?;
        if run.epoch != epoch {
            return Err(RuntimeError::Conflict(
                "admission generation expired".into(),
            ));
        }
        let (identity, settled) = match origin {
            ToolOrigin::ModelStep { request_id } => {
                // Identity checks need metadata only; never hydrate the frozen prompt/originals
                // while answering a transient scheduling query on the control owner.
                let step: ModelStep = record(&self.db, "model_steps", request_id)?;
                if step.run_id != run_id || step.epoch != epoch {
                    return Err(RuntimeError::Conflict(
                        "admission origin is not owned by this Run generation".into(),
                    ));
                }
                let receipt: Option<Option<String>> = self
                    .db
                    .query_row(
                        "SELECT receipt FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                        params![request_id, call_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let receipt = receipt.ok_or_else(|| RuntimeError::NotFound("tool call".into()))?;
                (format!("{request_id}:tool:{call_id}"), receipt.is_some())
            }
            ToolOrigin::PolicyAction { action_id, node_id } => {
                let operation = self.operation(action_id)?;
                if operation.run_id != run_id || operation.epoch != epoch {
                    return Err(RuntimeError::Conflict(
                        "admission origin is not owned by this Run generation".into(),
                    ));
                }
                policy::graph_metadata(&operation)?.ok_or_else(|| {
                    RuntimeError::Invalid("origin is not a policy read graph".into())
                })?;
                let settled:bool = self.db.query_row("SELECT receipt IS NOT NULL FROM policy_graph_nodes WHERE action_id=?1 AND node_id=?2 AND call_id=?3",
                    params![action_id,node_id,call_id],|row|row.get(0)).optional()?
                    .ok_or_else(||RuntimeError::NotFound("policy graph tool call".into()))?;
                (
                    format!("{action_id}:node:{node_id}"),
                    settled,
                )
            }
        };
        // Recovered external resource occupancy is not a live execution admission. Its durable
        // Operation remains queryable through the existing operation API.
        let queue = self
            .resource_admission
            .inspect(&identity)
            .filter(|status| status.run_id.is_some());
        if let Some(status) = &queue {
            if status.run_id.as_deref() != Some(run_id)
                || status.owner_generation != Some(epoch)
                || status.origin.as_ref() != Some(origin)
            {
                return Err(RuntimeError::Conflict(
                    "admission identity does not match Run origin".into(),
                ));
            }
        }
        // Absence is explicitly transient, never a fabricated terminal result. Durable receipts
        // distinguish known settlement; unknown origins and expired generations were rejected above.
        let state = queue
            .as_ref()
            .map(|status| status.state)
            .unwrap_or(if settled { "settled" } else { "not_active" });
        Ok(json!({"admissionId":identity,"state":state,"queue":queue}))
    }
}

/// The one lineage authority shared by scheduling and conversation readers.
pub(super) fn thread_family(db: &Connection, thread_id: &str) -> Result<String> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)", [thread_id], |row| row.get(0))?;
    if !exists { return Err(RuntimeError::NotFound(thread_id.into())); }
    let mut thread = thread_id.to_owned();
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(thread.clone()) { return Err(RuntimeError::Invalid("cyclic task lineage".into())); }
        let raw: Option<String> = db.query_row("SELECT body FROM child_tasks WHERE child_thread_id=?1", [&thread], |row| row.get(0)).optional()?;
        let Some(raw) = raw else { return Ok(thread); };
        let child: delegated::ChildRelation = serde_json::from_str(&raw)?;
        let parent: Run = record(db, "runs", &child.parent_run_id)?;
        if child.child_thread_id != thread || parent.thread_id != child.parent_thread_id {
            return Err(RuntimeError::Invalid("task lineage does not match parent Run".into()));
        }
        thread = parent.thread_id;
    }
}
