//! Computer identity projection. Physical assignment and input belong to the original Host owner.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScope {
    pub thread_id: String,
    pub branch_id: String,
    pub root_thread_id: String,
    pub root_branch_id: String,
    pub current_run_id: Option<String>,
    pub current_root_run_id: Option<String>,
    pub can_execute: bool,
}
fn current_run(db: &Connection, thread: &str, branch: &str) -> Result<Option<Run>> {
    let active: Option<String> = db.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [branch],
        |row| row.get(0),
    )?;
    let Some(id) = active else {
        return Ok(None);
    };
    let run: Run = record(db, "runs", &id)?;
    if run.thread_id != thread || run.branch_id != branch || run.state.terminal() {
        return Err(RuntimeError::Invalid(
            "Computer active Run does not match its branch".into(),
        ));
    }
    Ok(Some(run))
}
impl Catalog {
    pub fn computer_scope(
        &self,
        thread: &str,
        branch: &str,
        run_id: Option<&str>,
        operation_id: Option<&str>,
    ) -> Result<ComputerScope> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Conflict(
                "Computer branch belongs to another Thread".into(),
            ));
        }
        let root_thread = scheduling::thread_family(&self.db, thread)?;
        let mut ancestor = thread.to_owned();
        let mut root_branch = branch.to_owned();
        loop {
            let raw: Option<String> = self
                .db
                .query_row(
                    "SELECT body FROM child_tasks WHERE child_thread_id=?1",
                    [&ancestor],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(raw) = raw else {
                break;
            };
            let child: delegated::ChildRelation = serde_json::from_str(&raw)?;
            let parent = self.run(&child.parent_run_id)?;
            if parent.thread_id != child.parent_thread_id
                || parent.branch_id != child.parent_branch_id
            {
                return Err(RuntimeError::Invalid(
                    "Computer family differs from original parent execution".into(),
                ));
            }
            ancestor = parent.thread_id;
            root_branch = parent.branch_id;
        }
        if ancestor != root_thread {
            return Err(RuntimeError::Invalid(
                "Computer family identity changed".into(),
            ));
        }
        if let Some(id) = run_id {
            let run = self.run(id)?;
            if run.thread_id != thread || run.branch_id != branch {
                return Err(RuntimeError::Conflict(
                    "Computer execution belongs to another branch".into(),
                ));
            }
        }
        if let Some(id) = operation_id {
            let op = self.operation(id)?;
            let run = self.run(&op.run_id)?;
            let intent = tool_content::ToolIntent::from_operation(&op)?;
            if run_id != Some(run.id.as_str())
                || run.thread_id != thread
                || run.branch_id != branch
                || run.cancel_requested
                || run.state.terminal()
                || op.cancel_requested
                || op.phase != OperationPhase::Running
                || !matches!(op.execution_owner, Some(ExecutorOwner::External { .. }))
                || intent.call().name != op.executor.as_deref().unwrap_or("")
            {
                return Err(RuntimeError::Conflict(
                    "Computer invocation is not its original active tool".into(),
                ));
            }
        }
        let current = current_run(&self.db, thread, branch)?;
        let root = if root_branch == branch {
            current.clone()
        } else {
            current_run(&self.db, &root_thread, &root_branch)?
        };
        Ok(ComputerScope {
            thread_id: thread.into(),
            branch_id: branch.into(),
            root_thread_id: root_thread,
            root_branch_id: root_branch,
            can_execute: current.as_ref().is_some_and(|run| !run.cancel_requested),
            current_run_id: current.map(|run| run.id),
            current_root_run_id: root.map(|run| run.id),
        })
    }
}
