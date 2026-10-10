//! Same-task discovery and fixed conversation views over the original Catalog/ContentStore.
//! Captures are short control operations; ancestry, decoding and body IO belong to readers.
use super::*;
use crate::execution::{
    Content, ConversationItem, RequestSnapshot, ToolCall, ToolExecutionContext, ToolOrigin,
    ToolSchema,
};
use serde::Deserialize;
use std::collections::BTreeSet;

pub const THREADS_TOOL: &str = "threads";
pub const READ_TOOL: &str = "read_thread";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Older,
    Newer,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FamilyReadQuery {
    Recent {
        limit: Option<usize>,
        max_item_bytes: Option<usize>,
    },
    Range {
        after_id: Option<String>,
        before_id: Option<String>,
        direction: Direction,
        limit: Option<usize>,
        max_item_bytes: Option<usize>,
    },
    Search {
        text: String,
        direction: Direction,
        limit: Option<usize>,
        max_item_bytes: Option<usize>,
        scan_limit: Option<usize>,
    },
}
impl FamilyReadQuery {
    fn budgets(&self) -> Result<(usize, usize, usize)> {
        let (limit, bytes, scan) = match self {
            Self::Recent {
                limit,
                max_item_bytes,
            }
            | Self::Range {
                limit,
                max_item_bytes,
                ..
            } => (*limit, *max_item_bytes, None),
            Self::Search {
                limit,
                max_item_bytes,
                scan_limit,
                ..
            } => (*limit, *max_item_bytes, *scan_limit),
        };
        let values = (
            limit.unwrap_or(20),
            bytes.unwrap_or(4096),
            scan.unwrap_or(256),
        );
        if values.0 == 0 || values.1 == 0 || values.2 == 0 {
            return Err(RuntimeError::Invalid(
                "family read budgets must be positive".into(),
            ));
        }
        if matches!(self,Self::Search{text,..} if text.is_empty()) {
            return Err(RuntimeError::Invalid(
                "search text must not be empty".into(),
            ));
        }
        Ok(values)
    }
    fn direction(&self) -> Direction {
        match self {
            Self::Recent { .. } => Direction::Older,
            Self::Range { direction, .. } | Self::Search { direction, .. } => direction.clone(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRequest {
    pub run_id: Option<String>,
    pub anchor: Option<String>,
    pub cursor: Option<String>,
    pub query: FamilyReadQuery,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemRequest {
    pub run_id: Option<String>,
    pub anchor: String,
    pub item_id: String,
    pub offset: Option<usize>,
    pub max_bytes: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyRun {
    pub run_id: String,
    pub branch_id: String,
    pub state: RunState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRun {
    pub run_id: String,
    pub state: RunState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyBranch {
    pub branch_id: String,
    pub head_id: Option<String>,
    pub active_run_id: Option<String>,
    pub latest_run: Option<LatestRun>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyMember {
    pub thread_id: String,
    pub parent_thread_id: Option<String>,
    pub task: Option<String>,
    pub state: String,
    pub branches: Vec<FamilyBranch>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyList {
    pub root_thread_id: String,
    pub members: Vec<FamilyMember>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub thread_id: String,
    pub branch_id: String,
    pub runs: Vec<FamilyRun>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAssociation {
    pub request_id: String,
    pub call_id: String,
    pub role: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub parent_id: Option<String>,
    pub sequence: u64,
    pub run_id: String,
    pub source: HistorySource,
    pub kind: String,
    pub body: Option<Value>,
    pub preview: String,
    pub body_bytes: usize,
    pub body_truncated: bool,
    pub tool: Option<ToolAssociation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPage {
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: Option<String>,
    pub head_id: Option<String>,
    pub anchor: String,
    pub items: Vec<HistoryEntry>,
    pub next_cursor: Option<String>,
    pub scanned: usize,
    pub scan_complete: bool,
    pub has_earlier: bool,
    pub has_later: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPage {
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: Option<String>,
    pub head_id: Option<String>,
    pub item_id: String,
    pub format: String,
    pub text: String,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub total_bytes: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Anchor {
    kind: String,
    epoch: u64,
    caller: String,
    thread: String,
    branch: String,
    run: Option<String>,
    head: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadCursor {
    kind: String,
    anchor: Anchor,
    query: FamilyReadQuery,
    next: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunsCursor {
    kind: String,
    epoch: u64,
    caller: String,
    thread: String,
    branch: String,
    maximum: i64,
    head: Option<String>,
    before: i64,
    limit: usize,
}

pub struct FamilyRead {
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
    epoch: u64,
    key: [u8; 32],
    caller: String,
    target: Option<(String, String, Option<String>)>,
    invocation: Option<Invocation>,
}
struct Invocation {
    context: ToolExecutionContext,
    call: ToolCall,
    schema: ToolSchema,
    body: Value,
    metadata: Option<super::policy_body::PolicyActionMetadata>,
    stored: Option<super::tool_content::ToolCallMetadata>,
}
fn check(cancel: &dyn Fn() -> bool) -> Result<()> {
    if cancel() {
        Err(RuntimeError::DispatchCancelled)
    } else {
        Ok(())
    }
}
impl Catalog {
    pub fn capture_family_read(
        &self,
        caller: &str,
        thread: Option<&str>,
        branch: Option<&str>,
    ) -> Result<FamilyRead> {
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
            [caller],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(RuntimeError::NotFound(caller.into()));
        }
        let target = match (thread, branch) {
            (Some(thread), Some(branch)) => {
                let (actual, head): (String, Option<String>) = self
                    .db
                    .query_row(
                        "SELECT thread_id,head FROM branches WHERE id=?1",
                        [branch],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?
                    .ok_or_else(|| RuntimeError::NotFound(branch.into()))?;
                if actual != thread {
                    return Err(RuntimeError::Conflict(
                        "family branch belongs to another Thread".into(),
                    ));
                }
                Some((thread.into(), branch.into(), head))
            }
            (None, None) => None,
            _ => {
                return Err(RuntimeError::Invalid(
                    "family target requires Thread and branch".into(),
                ));
            }
        };
        Ok(FamilyRead {
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
            epoch: self.epoch,
            key: self.plan_cursor_key,
            caller: caller.into(),
            target,
            invocation: None,
        })
    }
    pub fn capture_family_tool(
        &self,
        context: ToolExecutionContext,
        call: ToolCall,
        schema: ToolSchema,
        thread: Option<&str>,
        branch: Option<&str>,
    ) -> Result<FamilyRead> {
        let run = self.run(&context.run_id)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested
            || context.operation_id != context.origin.operation_id(&call.call_id)
        {
            return Err(RuntimeError::Conflict(
                "family invocation owner changed".into(),
            ));
        }
        let (body, metadata, stored) = match &context.origin {
            ToolOrigin::ModelStep { request_id } => {
                let step: ModelStep = record(&self.db, "model_steps", request_id)?;
                if step.run_id != run.id || step.epoch != self.epoch {
                    return Err(RuntimeError::Conflict(
                        "family request belongs to another Run".into(),
                    ));
                }
                let raw: String = self
                    .db
                    .query_row(
                        "SELECT body FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                        params![request_id, call.call_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| RuntimeError::NotFound("family tool call".into()))?;
                let stored: super::tool_content::ToolCallMetadata = serde_json::from_str(&raw)?;
                (step.request, None, Some(stored))
            }
            ToolOrigin::PolicyAction { action_id, .. } => {
                let operation = self.operation(action_id)?;
                if operation.run_id != run.id
                    || operation.epoch != self.epoch
                    || operation.cancel_requested
                {
                    return Err(RuntimeError::Conflict("family policy owner changed".into()));
                }
                let metadata = super::policy::graph_metadata(&operation)?.ok_or_else(|| {
                    RuntimeError::Invalid("family origin is not a policy graph".into())
                })?;
                (metadata.body_ref().clone(), Some(metadata), None)
            }
        };
        let mut read = self.capture_family_read(&run.thread_id, thread, branch)?;
        read.invocation = Some(Invocation {
            context,
            call,
            schema,
            body,
            metadata,
            stored,
        });
        Ok(read)
    }
}
impl FamilyRead {
    pub fn authorize(self, cancel: &dyn Fn() -> bool) -> Result<()> {
        self.open(cancel)?;
        self.finish(cancel)
    }
    fn finish(&self, cancel: &dyn Fn() -> bool) -> Result<()> {
        check(cancel)?;
        let current = super::history_views::current_history_owner(&self.database, self.epoch)?;
        if let Some(invocation) = &self.invocation {
            let run: Run = record(&current, "runs", &invocation.context.run_id)?;
            fence(&run, self.epoch)?;
            if run.cancel_requested {
                return Err(RuntimeError::DispatchCancelled);
            }
            if let ToolOrigin::PolicyAction { action_id, .. } = &invocation.context.origin {
                let operation: Operation = record(&current, "operations", action_id)?;
                if operation.run_id != run.id
                    || operation.epoch != self.epoch
                    || operation.cancel_requested
                {
                    return Err(RuntimeError::Conflict(
                        "family policy owner changed during read".into(),
                    ));
                }
            }
        }
        check(cancel)
    }
    fn open(&self, cancel: &dyn Fn() -> bool) -> Result<Connection> {
        check(cancel)?;
        let db = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.execute_batch("BEGIN")?;
        let epoch: u64 = db.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| {
            read_number(row, 0)
        })?;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "family reader belongs to a previous owner epoch".into(),
            ));
        }
        if let Some(invocation) = &self.invocation {
            let run: Run = record(&db, "runs", &invocation.context.run_id)?;
            fence(&run, self.epoch)?;
            if run.cancel_requested {
                return Err(RuntimeError::DispatchCancelled);
            }
            let tools = match &invocation.context.origin {
                ToolOrigin::ModelStep { request_id } => {
                    if invocation
                        .stored
                        .clone()
                        .expect("captured call")
                        .load(&self.content)?
                        != invocation.call
                    {
                        return Err(RuntimeError::Conflict(
                            "family call differs from original ModelStep".into(),
                        ));
                    }
                    let snapshot: RequestSnapshot = serde_json::from_value(
                        self.content.load_cancellable(&invocation.body, cancel)?,
                    )?;
                    if snapshot.view.run_id != run.id || snapshot.view.request_id != *request_id {
                        return Err(RuntimeError::Conflict(
                            "family frozen request identity changed".into(),
                        ));
                    }
                    snapshot.view.binding.tools
                }
                ToolOrigin::PolicyAction { node_id, .. } => {
                    let graph = invocation
                        .metadata
                        .as_ref()
                        .expect("captured policy metadata")
                        .load_graph(&self.content, &run.id)?;
                    let node = graph
                        .nodes()
                        .iter()
                        .find(|node| node.node.id == *node_id)
                        .ok_or_else(|| RuntimeError::NotFound("family policy node".into()))?;
                    if node.node.call != invocation.call
                        || node.context.origin != invocation.context.origin
                    {
                        return Err(RuntimeError::Conflict(
                            "family call differs from frozen policy node".into(),
                        ));
                    }
                    node.context.tools.as_ref().clone()
                }
            };
            if invocation.schema.name != invocation.call.name
                || invocation.schema.version != invocation.call.schema_version
                || !tools.contains(&invocation.schema)
            {
                return Err(RuntimeError::Conflict(
                    "family capability was not selected in the original invocation".into(),
                ));
            }
        }
        let root = super::scheduling::thread_family(&db, &self.caller)?;
        if let Some((target, branch, _)) = &self.target {
            if super::scheduling::thread_family(&db, target)? != root {
                return Err(RuntimeError::Conflict(
                    "Thread is outside the caller's task family".into(),
                ));
            }
            let actual: String = db.query_row(
                "SELECT thread_id FROM branches WHERE id=?1",
                [branch],
                |row| row.get(0),
            )?;
            if actual != *target {
                return Err(RuntimeError::Conflict(
                    "family target branch changed".into(),
                ));
            }
        }
        check(cancel)?;
        Ok(db)
    }
    fn sign<T: Serialize>(&self, value: &T) -> Result<String> {
        use base64::Engine;
        let bytes = serde_json::to_vec(value)?;
        Ok(format!(
            "{}.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes),
            hex::encode(super::plan::mac(&self.key, &bytes))
        ))
    }
    fn decode<T: serde::de::DeserializeOwned>(&self, token: &str) -> Result<T> {
        use base64::Engine;
        let (body, signature) = token
            .split_once('.')
            .ok_or_else(|| RuntimeError::Invalid("invalid family cursor".into()))?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| RuntimeError::Invalid("invalid family cursor".into()))?;
        let signature = hex::decode(signature)
            .map_err(|_| RuntimeError::Invalid("invalid family cursor".into()))?;
        let expected = super::plan::mac(&self.key, &bytes);
        if signature.len() != expected.len()
            || signature
                .iter()
                .zip(expected)
                .fold(0u8, |v, (a, b)| v | (a ^ b))
                != 0
        {
            return Err(RuntimeError::Conflict(
                "family cursor is invalid or belongs to a previous owner epoch".into(),
            ));
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    fn target(&self) -> Result<&(String, String, Option<String>)> {
        self.target
            .as_ref()
            .ok_or_else(|| RuntimeError::Invalid("family history target missing".into()))
    }
    fn anchor(&self, db: &Connection, run: Option<&str>, token: Option<&str>) -> Result<Anchor> {
        let (thread, branch, head) = self.target()?;
        if let Some(run) = run {
            let selected: Run = record(db, "runs", run)?;
            if selected.thread_id != *thread {
                return Err(RuntimeError::Conflict(
                    "selected Run belongs to another Thread".into(),
                ));
            }
        }
        let anchor = if let Some(token) = token {
            self.decode::<Anchor>(token)?
        } else {
            Anchor {
                kind: "family_anchor".into(),
                epoch: self.epoch,
                caller: self.caller.clone(),
                thread: thread.clone(),
                branch: branch.clone(),
                run: run.map(str::to_owned),
                head: head.clone(),
            }
        };
        if anchor.kind != "family_anchor"
            || anchor.epoch != self.epoch
            || anchor.caller != self.caller
            || anchor.thread != *thread
            || anchor.branch != *branch
            || anchor.run.as_deref() != run
        {
            return Err(RuntimeError::Conflict(
                "family anchor belongs to another fixed view".into(),
            ));
        }
        Ok(anchor)
    }
    pub fn list(self, include_self: bool, cancel: &dyn Fn() -> bool) -> Result<FamilyList> {
        let db = self.open(cancel)?;
        let root = super::scheduling::thread_family(&db, &self.caller)?;
        let mut pending = vec![root.clone()];
        let mut seen = BTreeSet::new();
        let mut members = Vec::new();
        while let Some(thread) = pending.pop() {
            check(cancel)?;
            if !seen.insert(thread.clone()) {
                return Err(RuntimeError::Invalid("cyclic task lineage".into()));
            }
            let mut children=db.prepare("SELECT child_thread_id FROM child_tasks WHERE json_extract(body,'$.parent_thread_id')=?1 ORDER BY rowid")?;
            pending.extend(
                children
                    .query_map([&thread], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            );
            if !include_self && thread == self.caller {
                continue;
            }
            if super::scheduling::thread_family(&db, &thread)? != root {
                return Err(RuntimeError::Invalid("inconsistent task lineage".into()));
            }
            let child: Option<String> = db
                .query_row(
                    "SELECT body FROM child_tasks WHERE child_thread_id=?1",
                    [&thread],
                    |row| row.get(0),
                )
                .optional()?;
            let child = child
                .map(|raw| {let relation:delegated::ChildRelation=serde_json::from_str(&raw)?;delegated::execution_task(&db,&relation.operation_id)})
                .transpose()?;
            let mut statement = db.prepare(
                "SELECT id,head,active_run FROM branches WHERE thread_id=?1 ORDER BY rowid",
            )?;
            let mut branches = Vec::new();
            let mut active_states = Vec::new();
            for row in statement.query_map([&thread], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })? {
                check(cancel)?;
                let (branch_id, head_id, active_run_id) = row?;
                if let Some(run_id) = &active_run_id {
                    let active: Run = record(&db, "runs", run_id)?;
                    active_states.push(active.state);
                }
                let raw: Option<String> = db
                    .query_row(
                        "SELECT body FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",
                        [&branch_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let latest = raw
                    .map(|raw| serde_json::from_str::<Run>(&raw))
                    .transpose()?;
                branches.push(FamilyBranch {
                    branch_id,
                    head_id,
                    active_run_id,
                    latest_run: latest.map(|run| LatestRun {
                        run_id: run.id,
                        state: run.state,
                    }),
                });
            }
            // Activity wins over finished branches or the ChildTask's preparation stage.
            // A mixed set of active branches has no single execution phase.
            let state = if let Some(first) = active_states.first() {
                if active_states.iter().all(|state| state == first) {
                    serde_json::to_value(first)?
                        .as_str()
                        .expect("RunState string")
                        .to_owned()
                } else {
                    "active".into()
                }
            } else if let Some(child) = &child {
                let body:String=db.query_row("SELECT body FROM delegated_executions WHERE child_operation_id=?1 ORDER BY rowid DESC LIMIT 1",[&child.operation_id],|row|row.get(0))?;
                let execution:delegated::DelegatedExecution=serde_json::from_str(&body)?;
                execution.state().to_owned()
            } else {
                db.query_row(
                    "SELECT json_extract(r.body,'$.state') FROM runs r JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 ORDER BY r.rowid DESC LIMIT 1",
                    [&thread],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .unwrap_or_else(|| "idle".into())
            };
            let task = child
                .as_ref()
                .map(|child| {
                    self.content
                        .load_cancellable(&child.input_ref, cancel)
                        .and_then(|value| {
                            Ok(serde_json::from_value::<collaboration::DispatchInput>(value)?.task)
                        })
                })
                .transpose()?;
            members.push(FamilyMember {
                thread_id: thread,
                parent_thread_id: child.map(|child| child.parent_thread_id),
                task,
                state,
                branches,
            });
        }
        self.finish(cancel)?;
        Ok(FamilyList {
            root_thread_id: root,
            members,
        })
    }
    pub fn runs(
        self,
        cursor: Option<&str>,
        limit: Option<usize>,
        cancel: &dyn Fn() -> bool,
    ) -> Result<RunPage> {
        let db = self.open(cancel)?;
        let (thread, branch, head) = self.target()?;
        let limit = limit.unwrap_or(20);
        if limit == 0 {
            return Err(RuntimeError::Invalid(
                "run page limit must be positive".into(),
            ));
        }
        let position = if let Some(cursor) = cursor {
            let cursor: RunsCursor = self.decode(cursor)?;
            if cursor.kind != "family_runs"
                || cursor.epoch != self.epoch
                || cursor.caller != self.caller
                || cursor.thread != *thread
                || cursor.branch != *branch
                || cursor.limit != limit
            {
                return Err(RuntimeError::Conflict(
                    "Run cursor belongs to another view".into(),
                ));
            }
            cursor
        } else {
            let maximum: i64 = db.query_row(
                "SELECT coalesce(max(r.rowid),0) FROM runs r JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1",
                [thread],
                |row| row.get(0),
            )?;
            RunsCursor {
                kind: "family_runs".into(),
                epoch: self.epoch,
                caller: self.caller.clone(),
                thread: thread.clone(),
                branch: branch.clone(),
                maximum,
                head: head.clone(),
                before: maximum.saturating_add(1),
                limit,
            }
        };
        let view = Anchor {
            kind: "family_anchor".into(),
            epoch: self.epoch,
            caller: self.caller.clone(),
            thread: thread.clone(),
            branch: branch.clone(),
            run: None,
            head: position.head.clone(),
        };
        let visible = self
            .ancestry(&db, &view, cancel)?
            .into_iter()
            .map(|(_, item)| item.run_id)
            .collect::<BTreeSet<_>>();
        let mut statement=db.prepare("SELECT r.rowid,r.id,r.branch_id,json_extract(r.body,'$.state') FROM runs r JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND r.rowid<=?2 AND r.rowid<?3 ORDER BY r.rowid DESC")?;
        let mut rows = statement.query(params![thread, position.maximum, position.before])?;
        let mut runs = Vec::new();
        let mut last = position.before;
        let mut more = false;
        while let Some(row) = rows.next()? {
            check(cancel)?;
            let run_id: String = row.get(1)?;
            let branch_id: String = row.get(2)?;
            if branch_id != *branch && !visible.contains(&run_id) {
                continue;
            }
            if runs.len() == limit {
                more = true;
                break;
            }
            last = row.get(0)?;
            let state = serde_json::from_value(Value::String(row.get(3)?))?;
            runs.push(FamilyRun {
                run_id,
                branch_id,
                state,
            });
        }
        let next_cursor = more
            .then(|| {
                self.sign(&RunsCursor {
                    before: last,
                    ..position
                })
            })
            .transpose()?;
        self.finish(cancel)?;
        Ok(RunPage {
            thread_id: thread.clone(),
            branch_id: branch.clone(),
            runs,
            next_cursor,
        })
    }
    fn ancestry(
        &self,
        db: &Connection,
        anchor: &Anchor,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Vec<(u64, HistoryItem)>> {
        let mut next = anchor.head.clone();
        let mut rows = Vec::new();
        let mut seen = BTreeSet::new();
        while let Some(id) = next {
            check(cancel)?;
            if !seen.insert(id.clone()) {
                return Err(RuntimeError::Invalid("cyclic conversation ancestry".into()));
            }
            let (sequence, thread, run, raw): (u64, String, String, String) = db
                .query_row(
                    "SELECT rowid,thread_id,run_id,body FROM history WHERE id=?1",
                    [&id],
                    |row| Ok((read_number(row, 0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| RuntimeError::NotFound(id.clone()))?;
            let item: HistoryItem = serde_json::from_str(&raw)?;
            if item.id != id
                || item.thread_id != thread
                || thread != anchor.thread
                || item.run_id != run
            {
                return Err(RuntimeError::Invalid(
                    "history identity does not match anchored Thread".into(),
                ));
            }
            next = item.parent.clone();
            rows.push((sequence, item));
        }
        rows.reverse();
        Ok(rows)
    }
    fn semantic(
        &self,
        item: &HistoryItem,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(Value, String)> {
        let (mut body, _) = self
            .content
            .load_history_payload_cancellable(&item.content, cancelled)?;
        let kind = if let Ok(mut conversation) =
            serde_json::from_value::<ConversationItem>(body.clone())
        {
            conversation.opaque = None;
            let kind = serde_json::to_value(&conversation.content)?["kind"]
                .as_str()
                .ok_or_else(|| RuntimeError::Invalid("conversation content kind missing".into()))?
                .to_owned();
            body = serde_json::to_value(conversation)?;
            kind
        } else {
            "input".into()
        };
        Ok((body, kind))
    }
    fn association(
        &self,
        db: &Connection,
        item: &HistoryItem,
        body: &Value,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Option<ToolAssociation>> {
        let Ok(conversation) = serde_json::from_value::<ConversationItem>(body.clone()) else {
            return Ok(None);
        };
        match conversation.content {
            Content::ToolResult { result } => {
                let step: ModelStep = record(db, "model_steps", &result.request_id)?;
                if step.run_id != item.run_id {
                    return Err(RuntimeError::Invalid(
                        "history result belongs to another Run".into(),
                    ));
                }
                Ok(Some(ToolAssociation {
                    request_id: result.request_id,
                    call_id: result.call_id,
                    role: "result".into(),
                }))
            }
            Content::ToolCall { call } => {
                let mut statement=db.prepare("SELECT m.id,o.body FROM model_steps m JOIN tool_calls t ON t.request_id=m.id JOIN model_outputs o ON o.request_id=m.id WHERE m.run_id=?1 AND t.call_id=?2")?;
                for row in statement.query_map(params![item.run_id, call.call_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })? {
                    check(cancel)?;
                    let (request_id, reference) = row?;
                    let output = self
                        .content
                        .load_cancellable(&serde_json::from_str(&reference)?, cancel)?;
                    let record: crate::execution::ExecutionRecord =
                        serde_json::from_value(output["record"].clone())?;
                    if let crate::execution::ExecutionRecord::ModelFinished { items, .. } = record {
                        if items.iter().any(|provider|crate::execution::model_history_id(&request_id,&provider.id)==item.id&&matches!(&provider.content,Content::ToolCall{call:original}if original==&call)){
                            return Ok(Some(ToolAssociation{request_id,call_id:call.call_id,role:"call".into()}));
                        }
                    }
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }
    pub fn read(self, request: ReadRequest, cancel: &dyn Fn() -> bool) -> Result<ReadPage> {
        let db = self.open(cancel)?;
        let (limit, max_bytes, scan_limit) = request.query.budgets()?;
        let cursor = request
            .cursor
            .as_deref()
            .map(|cursor| self.decode::<ReadCursor>(cursor))
            .transpose()?;
        let cursor_anchor = cursor
            .as_ref()
            .map(|cursor| self.sign(&cursor.anchor))
            .transpose()?;
        let anchor = self.anchor(
            &db,
            request.run_id.as_deref(),
            request.anchor.as_deref().or(cursor_anchor.as_deref()),
        )?;
        if let Some(cursor) = &cursor {
            if cursor.kind != "family_read"
                || cursor.anchor != anchor
                || cursor.query != request.query
            {
                return Err(RuntimeError::Conflict(
                    "history cursor belongs to another query or anchor".into(),
                ));
            }
        }
        let ancestry = self.ancestry(&db, &anchor, cancel)?;
        if let Some(run_id) = &anchor.run {
            let run: Run = record(&db, "runs", run_id)?;
            if run.branch_id != anchor.branch
                && !ancestry.iter().any(|(_, item)| item.run_id == *run_id)
            {
                return Err(RuntimeError::Conflict(
                    "selected Run is not visible in this branch ancestry".into(),
                ));
            }
        }
        let mut lower = 0;
        let mut upper = ancestry.len();
        if let FamilyReadQuery::Range {
            after_id,
            before_id,
            ..
        } = &request.query
        {
            if let Some(after) = after_id {
                lower = ancestry
                    .iter()
                    .position(|(_, item)| &item.id == after)
                    .ok_or_else(|| {
                        RuntimeError::Conflict("range start is not on the anchored view".into())
                    })?
                    + 1;
            }
            if let Some(before) = before_id {
                upper = ancestry
                    .iter()
                    .position(|(_, item)| &item.id == before)
                    .ok_or_else(|| {
                        RuntimeError::Conflict("range end is not on the anchored view".into())
                    })?;
            }
            if lower > upper {
                return Err(RuntimeError::Invalid(
                    "history range boundaries are reversed".into(),
                ));
            }
        }
        let in_run = |index: usize| {
            anchor
                .run
                .as_ref()
                .is_none_or(|run| ancestry[index].1.run_id == *run)
        };
        let mut candidates = (lower..upper)
            .filter(|index| in_run(*index))
            .collect::<Vec<_>>();
        if request.query.direction() == Direction::Older {
            candidates.reverse();
        }
        if let Some(cursor) = &cursor {
            let position = candidates
                .iter()
                .position(|index| ancestry[*index].1.id == cursor.next)
                .ok_or_else(|| {
                    RuntimeError::Conflict("history cursor is not within its anchored range".into())
                })?;
            candidates.drain(..position);
        }
        let search = match &request.query {
            FamilyReadQuery::Search { text, .. } => Some(text.to_lowercase()),
            _ => None,
        };
        let mut items = Vec::new();
        let mut selected = Vec::new();
        let mut scanned = 0;
        for index in &candidates {
            if items.len() == limit || (search.is_some() && scanned == scan_limit) {
                break;
            }
            check(cancel)?;
            scanned += 1;
            let (sequence, item) = &ancestry[*index];
            let (body, kind) = self.semantic(item, cancel)?;
            let serialized = serde_json::to_string(&body)?;
            if search
                .as_ref()
                .is_some_and(|query| !contains_text(&body, query))
            {
                continue;
            }
            let end = utf8_end(&serialized, 0, max_bytes)?;
            let body_truncated = end < serialized.len();
            let tool = self.association(&db, item, &body, cancel)?;
            items.push(HistoryEntry {
                id: item.id.clone(),
                parent_id: item.parent.clone(),
                sequence: *sequence,
                run_id: item.run_id.clone(),
                source: item.source,
                kind,
                body: (!body_truncated).then_some(body),
                preview: serialized[..end].into(),
                body_bytes: serialized.len(),
                body_truncated,
                tool,
            });
            selected.push(*index);
        }
        let next_cursor = candidates
            .get(scanned)
            .map(|index| {
                self.sign(&ReadCursor {
                    kind: "family_read".into(),
                    anchor: anchor.clone(),
                    query: request.query,
                    next: ancestry[*index].1.id.clone(),
                })
            })
            .transpose()?;
        items.sort_by_key(|item| item.sequence);
        let window = if selected.is_empty() {
            &candidates[..scanned]
        } else {
            selected.as_slice()
        };
        // Context navigation stays inside the selected Run, but may cross the current
        // range boundaries or include records that do not match a search predicate.
        let has_earlier = window
            .iter()
            .min()
            .is_some_and(|index| (0..*index).any(in_run));
        let has_later = window
            .iter()
            .max()
            .is_some_and(|index| (index + 1..ancestry.len()).any(in_run));
        check(cancel)?;
        self.finish(cancel)?;
        Ok(ReadPage {
            thread_id: anchor.thread.clone(),
            branch_id: anchor.branch.clone(),
            run_id: anchor.run.clone(),
            head_id: anchor.head.clone(),
            anchor: self.sign(&anchor)?,
            items,
            scan_complete: next_cursor.is_none(),
            next_cursor,
            scanned,
            has_earlier,
            has_later,
        })
    }
    pub fn item(self, request: ItemRequest, cancel: &dyn Fn() -> bool) -> Result<ItemPage> {
        let db = self.open(cancel)?;
        let anchor = self.anchor(&db, request.run_id.as_deref(), Some(&request.anchor))?;
        let ancestry = self.ancestry(&db, &anchor, cancel)?;
        let (_, item) = ancestry
            .iter()
            .find(|(_, item)| item.id == request.item_id)
            .ok_or_else(|| RuntimeError::Conflict("item is not on the anchored view".into()))?;
        if anchor.run.as_ref().is_some_and(|run| *run != item.run_id) {
            return Err(RuntimeError::Conflict("item belongs to another Run".into()));
        }
        let (body, _) = self.semantic(item, cancel)?;
        check(cancel)?;
        let text = serde_json::to_string(&body)?;
        let offset = request.offset.unwrap_or(0);
        let end = utf8_end(&text, offset, request.max_bytes.unwrap_or(65536))?;
        self.finish(cancel)?;
        Ok(ItemPage {
            thread_id: anchor.thread,
            branch_id: anchor.branch,
            run_id: anchor.run,
            head_id: anchor.head,
            item_id: item.id.clone(),
            format: "conversation_json".into(),
            text: text[offset..end].into(),
            offset,
            next_offset: (end < text.len()).then_some(end),
            total_bytes: text.len(),
        })
    }
}
fn utf8_end(text: &str, offset: usize, budget: usize) -> Result<usize> {
    if budget == 0 || offset > text.len() || !text.is_char_boundary(offset) {
        return Err(RuntimeError::Invalid(
            "invalid UTF-8 conversation byte range".into(),
        ));
    }
    let mut end = offset.saturating_add(budget).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == offset && offset < text.len() {
        return Err(RuntimeError::Invalid(
            "maxBytes cannot hold the next UTF-8 character".into(),
        ));
    }
    Ok(end)
}

fn contains_text(value: &Value, query: &str) -> bool {
    match value {
        Value::String(text) => text.to_lowercase().contains(query),
        Value::Array(items) => items.iter().any(|item| contains_text(item, query)),
        Value::Object(fields) => fields
            .iter()
            .any(|(key, value)| key.to_lowercase().contains(query) || contains_text(value, query)),
        _ => value.to_string().contains(query),
    }
}
