//! Server user-input facts attached to a real MCP Operation. No execution or Run resumption owner.
use super::*;
use crate::{
    McpInteractionAvailability as Availability, McpInteractionChoice as Choice,
    McpInteractionDelivery as Delivery, McpInteractionMode as Mode,
};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum McpRequestId {
    String(String),
    Number(serde_json::Number),
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum McpInteractionRelation {
    RpcResponseStream { outgoing_request_id: McpRequestId },
    Task { task_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpInteractionBinding {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub endpoint: host_jobs::McpEndpoint,
    pub connection_id: String,
    pub request_id: McpRequestId,
    pub relation: McpInteractionRelation,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpInteractionRecord {
    pub id: String,
    pub revision: u64,
    pub binding: McpInteractionBinding,
    pub run_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub mode: Mode,
    pub availability: Availability,
    pub choice: Option<Choice>,
    pub delivery: Delivery,
    pub completion_reported: bool,
    pub problem: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    #[serde(flatten)]
    record: McpInteractionRecord,
    epoch: u64,
    source_scope: launches::McpExecutionScope,
    request_ref: Value,
    response_ref: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInteractionView {
    pub record: McpInteractionRecord,
    pub request: Value,
    pub presentation: Value,
    pub response: Option<Value>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInteractionPage {
    pub items: Vec<McpInteractionView>,
    pub next_cursor: Option<String>,
}
pub struct McpInteractionRead {
    metadata: Metadata,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl McpInteractionRead {
    pub fn load(self) -> Result<McpInteractionView> {
        let body = self.content.load(&self.metadata.request_ref)?;
        Ok(McpInteractionView {
            record: self.metadata.record,
            request: body["request"].clone(),
            presentation: body["presentation"].clone(),
            response: self
                .metadata
                .response_ref
                .map(|r| self.content.load(&r))
                .transpose()?,
        })
    }
}
pub struct McpInteractionPageRead {
    items: Vec<McpInteractionRead>,
    next_cursor: Option<String>,
}
impl McpInteractionPageRead {
    pub fn load(self) -> Result<McpInteractionPage> {
        Ok(McpInteractionPage {
            items: self
                .items
                .into_iter()
                .map(McpInteractionRead::load)
                .collect::<Result<_>>()?,
            next_cursor: self.next_cursor,
        })
    }
}
pub(super) fn initialize_new(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE mcp_interactions(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id),connection_id TEXT NOT NULL,request_key TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(connection_id,request_key)); CREATE INDEX mcp_interactions_operation ON mcp_interactions(operation_id);")?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,operation_id,connection_id,request_key,body FROM mcp_interactions")?;
    Ok(())
}
fn conflict() -> RuntimeError {
    RuntimeError::Conflict("mcp_interaction_conflict".into())
}
fn linked(m: &Metadata, b: &McpInteractionBinding) -> Result<()> {
    if &m.record.binding != b {
        return Err(conflict());
    }
    Ok(())
}
fn publish(tx: &Transaction<'_>, m: &mut Metadata, kind: &str) -> Result<()> {
    m.record.revision += 1;
    put(tx, "mcp_interactions", &m.record.id, m)?;
    event(
        tx,
        &m.record.id,
        m.record.revision,
        kind,
        json!({"operationId":m.record.binding.operation_id,"runId":m.record.run_id,"threadId":m.record.thread_id,"branchId":m.record.branch_id}),
    )?;
    Ok(())
}
fn original_live(db: &Connection, m: &Metadata, epoch: u64) -> Result<()> {
    let r = &m.record;
    if m.epoch != epoch || r.availability != Availability::Live {
        return Err(RuntimeError::Conflict("mcp_interaction_not_live".into()));
    }
    let op: Operation = record(db, "operations", &r.binding.operation_id)?;
    let run: Run = record(db, "runs", &op.run_id)?;
    if op.execution_owner.as_ref() != Some(&r.binding.execution_owner)
        || op.cancel_requested
        || run.cancel_requested
        || run.id != r.run_id
        || run.thread_id != r.thread_id
        || run.branch_id != r.branch_id
    {
        return Err(conflict());
    }
    let intent = tool_content::ToolIntent::from_operation(&op)?;
    let context = crate::execution::ToolExecutionContext {
        run_id: op.run_id.clone(),
        operation_id: op.id.clone(),
        origin: intent.origin().clone(),
    };
    if !goals::tool_allowed(db, &context)? {
        return Err(RuntimeError::GoalChanged);
    }
    if m.source_scope == launches::McpExecutionScope::Workspace {
        let retired: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='mcp.interaction_source_retired') OR EXISTS(SELECT 1 FROM delegated_executions WHERE run_id=?1 AND json_extract(body,'$.resources_released')=1)", [&run.id], |row| row.get(0))?;
        if retired {
            return Err(RuntimeError::Conflict(
                "mcp_interaction_source_unavailable".into(),
            ));
        }
    }
    match &r.binding.relation {
        McpInteractionRelation::RpcResponseStream { .. } => {
            if run.state.terminal()
                || op.phase != OperationPhase::Running
                || op.call_completion.is_some()
            {
                return Err(RuntimeError::Conflict("mcp_interaction_rpc_closed".into()));
            }
        }
        McpInteractionRelation::Task { task_id } => {
            let Some(link) = op.host_job.as_ref() else {
                return Err(conflict());
            };
            let Some(task) = link.mcp_task.as_ref() else {
                return Err(conflict());
            };
            if link.acceptance_ref.is_none()
                || task.task.task_id != *task_id
                || task.task.status.terminal()
                || !matches!(&link.binding.subject,host_jobs::HostJobSubject::Mcp { endpoint, .. } if endpoint == &r.binding.endpoint)
            {
                return Err(conflict());
            }
        }
    }
    Ok(())
}
impl Catalog {
    pub fn open_mcp_interaction(
        &mut self,
        id: String,
        binding: McpInteractionBinding,
        mode: Mode,
        body: result_content::PreparedOperationResult,
        snapshot: &tool_content::ToolInvocationSnapshot,
        frozen: &launches::HostToolBinding,
    ) -> Result<McpInteractionRecord> {
        self.validate_tool_invocation(snapshot, false)?;
        let op = self.operation(&binding.operation_id)?;
        let run = self.run(&op.run_id)?;
        let selected = frozen.provenance.servers.get(&binding.endpoint.server);
        let resource = frozen.resources.get(&snapshot.call.name);
        let route = frozen.routes.get(&snapshot.call.name);
        // Explicit unsubscribe is a new, real control invocation of a retained observer.
        // Its exact target supplies the old endpoint; background cleanup has no caller.
        let cleanup = if let Some(crate::McpRoute::ResourceUnsubscribe { argument }) = route {
            let target_id = snapshot.call.arguments[argument]
                .as_str()
                .ok_or_else(conflict)?;
            let target = self.access_mcp_resource(&run.id, target_id, true)?;
            Some(
                target
                    .mcp_resource_subscription
                    .ok_or_else(conflict)?
                    .binding
                    .endpoint,
            )
        } else {
            None
        };
        let server_arg = match route {
            Some(
                crate::McpRoute::ServerArgument { argument }
                | crate::McpRoute::ServerTaskArgument { argument }
                | crate::McpRoute::ResourceSubscribe { argument },
            ) => snapshot.call.arguments[argument].as_str(),
            Some(
                crate::McpRoute::Direct
                | crate::McpRoute::DirectTask
                | crate::McpRoute::ResourceUnsubscribe { .. },
            ) => None,
            _ => return Err(conflict()),
        };
        if id.is_empty()
            || binding.connection_id.is_empty()
            || !binding.execution_owner.validate()
            || binding.endpoint.credential_version.is_empty()
            || snapshot.context.operation_id != binding.operation_id
            || op.execution_owner.as_ref() != Some(&binding.execution_owner)
            || cleanup
                .as_ref()
                .is_some_and(|endpoint| endpoint != &binding.endpoint)
            || (cleanup.is_none()
                && (selected.is_none_or(|s| {
                    s.definition_version != binding.endpoint.configuration_version
                        || s.resource_key != binding.endpoint.resource_key
                }) || server_arg.is_some_and(|s| s != binding.endpoint.server)
                    || (server_arg.is_none() && resource != Some(&binding.endpoint.resource_key))))
        {
            return Err(conflict());
        }
        let mut m = Metadata {
            record: McpInteractionRecord {
                id,
                revision: 0,
                binding,
                run_id: run.id,
                thread_id: run.thread_id,
                branch_id: run.branch_id,
                mode,
                availability: Availability::Live,
                choice: None,
                delivery: Delivery::NotStarted,
                completion_reported: false,
                problem: None,
            },
            epoch: self.epoch,
            source_scope: frozen.provenance.execution_scope,
            request_ref: body.reference.clone(),
            response_ref: None,
        };
        if let Some(old) = optional_record::<Metadata>(&self.db, "mcp_interactions", &m.record.id)?
        {
            if old.record.binding != m.record.binding || old.request_ref != m.request_ref {
                return Err(conflict());
            }
            return Ok(old.record);
        }
        original_live(&self.db, &m, self.epoch)?;
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO mcp_interactions(id,operation_id,connection_id,request_key,body) VALUES(?1,?2,?3,?4,?5)",params![m.record.id,m.record.binding.operation_id,m.record.binding.connection_id,encode(&m.record.binding.request_id)?,encode(&m)?])?;
        publish(&tx, &mut m, "mcp.interaction.opened")?;
        tx.commit()?;
        Ok(m.record)
    }
    pub fn capture_mcp_interaction(
        &self,
        operation_id: &str,
        id: &str,
    ) -> Result<McpInteractionRead> {
        let metadata: Metadata = record(&self.db, "mcp_interactions", id)?;
        if metadata.record.binding.operation_id != operation_id {
            return Err(conflict());
        }
        Ok(McpInteractionRead {
            metadata,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn capture_mcp_interactions(
        &self,
        thread: &str,
        branch: &str,
        cursor: Option<&str>,
        limit: u64,
    ) -> Result<McpInteractionPageRead> {
        if limit == 0 {
            return Err(RuntimeError::Invalid(
                "interaction page size must be positive".into(),
            ));
        }
        let owner: String = self.db.query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [branch],
            |r| r.get(0),
        )?;
        if owner != thread {
            return Err(conflict());
        }
        let after = cursor
            .map(|c| {
                let (g, n) = c.split_once(':').ok_or_else(conflict)?;
                Ok::<_, RuntimeError>((
                    g.parse::<i64>().map_err(|_| conflict())?,
                    n.parse::<i64>().map_err(|_| conflict())?,
                ))
            })
            .transpose()?;
        let mut q=self.db.prepare("SELECT m.rowid,m.body,CASE WHEN json_extract(m.body,'$.availability')='live' AND json_extract(m.body,'$.choice') IS NULL THEN 0 ELSE 1 END AS bucket FROM mcp_interactions m JOIN operations o ON o.id=m.operation_id JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND b.id=?2 AND (?3 IS NULL OR bucket>?3 OR (bucket=?3 AND m.rowid<?4)) ORDER BY bucket,m.rowid DESC LIMIT ?5")?;
        let rows = q
            .query_map(
                params![
                    thread,
                    branch,
                    after.map(|x| x.0),
                    after.map(|x| x.1),
                    sql_number(limit.saturating_add(1))?
                ],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let more = rows.len() as u64 > limit;
        let mut next_cursor = None;
        let mut items = Vec::new();
        for (rowid, body, bucket) in rows
            .into_iter()
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
        {
            let metadata: Metadata = serde_json::from_str(&body)?;
            next_cursor = Some(format!("{bucket}:{rowid}"));
            items.push(McpInteractionRead {
                metadata,
                content: self.content.clone(),
                _publication: self.content.begin_publication(),
            });
        }
        Ok(McpInteractionPageRead {
            items,
            next_cursor: if more { next_cursor } else { None },
        })
    }
    pub fn respond_mcp_interaction(
        &mut self,
        operation_id: &str,
        id: &str,
        revision: u64,
        choice: Choice,
        body: result_content::PreparedOperationResult,
    ) -> Result<McpInteractionRecord> {
        let mut m: Metadata = record(&self.db, "mcp_interactions", id)?;
        if m.record.binding.operation_id != operation_id {
            return Err(conflict());
        }
        if m.record.choice.is_some() {
            if m.record.choice == Some(choice) && m.response_ref.as_ref() == Some(&body.reference) {
                return Ok(m.record);
            }
            return Err(conflict());
        }
        original_live(&self.db, &m, self.epoch)?;
        if m.record.revision != revision {
            return Err(conflict());
        }
        m.record.choice = Some(choice);
        m.response_ref = Some(body.reference.clone());
        let tx = self.db.transaction()?;
        publish(&tx, &mut m, "mcp.interaction.responded")?;
        tx.commit()?;
        Ok(m.record)
    }
    pub fn begin_mcp_interaction_response(
        &mut self,
        binding: &McpInteractionBinding,
        id: &str,
    ) -> Result<McpInteractionRecord> {
        let mut m: Metadata = record(&self.db, "mcp_interactions", id)?;
        linked(&m, binding)?;
        original_live(&self.db, &m, self.epoch)?;
        if m.record.choice.is_none()
            || m.response_ref.is_none()
            || m.record.delivery != Delivery::NotStarted
        {
            return Err(conflict());
        }
        m.record.delivery = Delivery::Sending;
        let tx = self.db.transaction()?;
        publish(&tx, &mut m, "mcp.interaction.sending")?;
        tx.commit()?;
        Ok(m.record)
    }
    pub fn settle_mcp_interaction_response(
        &mut self,
        binding: &McpInteractionBinding,
        id: &str,
        delivery: Delivery,
    ) -> Result<McpInteractionRecord> {
        let mut m: Metadata = record(&self.db, "mcp_interactions", id)?;
        linked(&m, binding)?;
        if !matches!(
            delivery,
            Delivery::Sent | Delivery::Unknown | Delivery::NotSent
        ) {
            return Err(conflict());
        }
        if m.record.delivery == delivery {
            return Ok(m.record);
        }
        if m.record.delivery == Delivery::Sent
            || m.record.delivery == Delivery::NotSent
            || delivery == Delivery::Sent && m.record.choice.is_none()
        {
            return Err(conflict());
        }
        m.record.delivery = delivery;
        let tx = self.db.transaction()?;
        publish(&tx, &mut m, "mcp.interaction.response_settled")?;
        tx.commit()?;
        Ok(m.record)
    }
    pub fn close_mcp_interaction(
        &mut self,
        binding: &McpInteractionBinding,
        id: &str,
        availability: Availability,
        problem: Option<String>,
    ) -> Result<McpInteractionRecord> {
        if availability == Availability::Live {
            return Err(conflict());
        }
        let mut m: Metadata = record(&self.db, "mcp_interactions", id)?;
        linked(&m, binding)?;
        let retained_completion = m.record.availability == Availability::RpcClosed
            && m.record.mode == Mode::Url
            && m.record.choice == Some(Choice::Accept)
            && !m.record.completion_reported
            && m.record.delivery != Delivery::NotSent;
        if m.record.availability == availability
            || (m.record.availability != Availability::Live && !retained_completion)
        {
            return Ok(m.record);
        }
        let tx = self.db.transaction()?;
        close(&tx, &mut m, availability, problem)?;
        tx.commit()?;
        Ok(m.record)
    }
    pub fn complete_mcp_interaction(
        &mut self,
        binding: &McpInteractionBinding,
        id: &str,
    ) -> Result<McpInteractionRecord> {
        let mut m: Metadata = record(&self.db, "mcp_interactions", id)?;
        linked(&m, binding)?;
        if m.record.mode != Mode::Url || m.record.completion_reported {
            return Ok(m.record);
        }
        m.record.completion_reported = true;
        let tx = self.db.transaction()?;
        publish(&tx, &mut m, "mcp.interaction.external_completed")?;
        tx.commit()?;
        Ok(m.record)
    }
    pub fn pending_mcp_interactions(&mut self) -> Result<Vec<McpInteractionRecord>> {
        let ids = {
            let mut q=self.db.prepare("SELECT id FROM mcp_interactions WHERE json_extract(body,'$.availability')='live' OR json_extract(body,'$.delivery')='sending' OR (json_extract(body,'$.availability')='rpc_closed' AND json_extract(body,'$.mode')='url' AND json_extract(body,'$.choice')='accept' AND json_extract(body,'$.completionReported')=0 AND json_extract(body,'$.delivery')!='not_sent')")?;
            let rows = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let mut result = Vec::new();
        for id in ids {
            let mut m: Metadata = record(&self.db, "mcp_interactions", &id)?;
            if let Err(error) = original_live(&self.db, &m, self.epoch) {
                if m.record.availability != Availability::Live {
                    result.push(m.record);
                    continue;
                }
                let availability = if matches!(&error, RuntimeError::Conflict(code) if code == "mcp_interaction_rpc_closed")
                {
                    Availability::RpcClosed
                } else {
                    Availability::OwnerUnavailable
                };
                let tx = self.db.transaction()?;
                close(
                    &tx,
                    &mut m,
                    availability,
                    Some("mcp_interaction_owner_unavailable".into()),
                )?;
                tx.commit()?;
            }
            result.push(m.record);
        }
        Ok(result)
    }
    pub fn release_mcp_interaction_source(&mut self, run_id: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        cancel_run(&tx, run_id, true)?;
        event(
            &tx,
            run_id,
            0,
            "mcp.interaction_source_retired",
            Value::Null,
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn recover_mcp_interactions(&mut self) -> Result<()> {
        let tx = self.db.transaction()?;
        let ids = {
            let mut q=tx.prepare("SELECT id FROM mcp_interactions WHERE json_extract(body,'$.availability')='live' OR json_extract(body,'$.delivery')='sending' OR (json_extract(body,'$.availability')='rpc_closed' AND json_extract(body,'$.mode')='url' AND json_extract(body,'$.choice')='accept' AND json_extract(body,'$.completionReported')=0 AND json_extract(body,'$.delivery')!='not_sent')")?;
            let rows = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        for id in ids {
            let mut m: Metadata = record(&tx, "mcp_interactions", &id)?;
            close(
                &tx,
                &mut m,
                Availability::ConnectionLost,
                Some("mcp_interaction_connection_lost".into()),
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
fn close(
    tx: &Transaction<'_>,
    m: &mut Metadata,
    availability: Availability,
    problem: Option<String>,
) -> Result<()> {
    m.record.availability = availability;
    m.record.problem = problem;
    if m.record.delivery == Delivery::Sending {
        m.record.delivery = Delivery::Unknown;
    }
    publish(tx, m, "mcp.interaction.closed")
}
pub(super) fn cancel_operation(tx: &Transaction<'_>, operation: &str) -> Result<()> {
    let ids = {
        let mut q=tx.prepare("SELECT id FROM mcp_interactions WHERE operation_id=?1 AND (json_extract(body,'$.availability')='live' OR (json_extract(body,'$.availability')='rpc_closed' AND json_extract(body,'$.mode')='url' AND json_extract(body,'$.choice')='accept' AND json_extract(body,'$.completionReported')=0 AND json_extract(body,'$.delivery')!='not_sent'))")?;
        let rows = q
            .query_map([operation], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for id in ids {
        let mut m: Metadata = record(tx, "mcp_interactions", &id)?;
        close(tx, &mut m, Availability::Cancelled, None)?;
    }
    Ok(())
}
pub(super) fn cancel_run(tx: &Transaction<'_>, run: &str, source_only: bool) -> Result<()> {
    let ids = {
        let mut q=tx.prepare("SELECT m.id FROM mcp_interactions m JOIN operations o ON o.id=m.operation_id WHERE o.run_id=?1 AND (json_extract(m.body,'$.availability')='live' OR (json_extract(m.body,'$.availability')='rpc_closed' AND json_extract(m.body,'$.mode')='url' AND json_extract(m.body,'$.choice')='accept' AND json_extract(m.body,'$.completionReported')=0 AND json_extract(m.body,'$.delivery')!='not_sent')) AND (?2=0 OR json_extract(m.body,'$.sourceScope')='workspace')")?;
        let rows = q
            .query_map(params![run, source_only], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for id in ids {
        let mut m: Metadata = record(tx, "mcp_interactions", &id)?;
        close(tx, &mut m, Availability::Cancelled, None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interaction_listing_uses_persisted_catalog_branch_ownership() {
        let root = std::env::temp_dir().join(format!("varin-mcp-interaction-list-{}", id()));
        {
            let mut db = Catalog::open(&root).unwrap();
            db.create_thread("thread-a", "branch-a").unwrap();
            db.create_thread("thread-b", "branch-b").unwrap();
            let page = db
                .capture_mcp_interactions("thread-a", "branch-a", None, 1)
                .unwrap()
                .load()
                .unwrap();
            assert!(page.items.is_empty());
            assert!(page.next_cursor.is_none());
            assert!(
                db.capture_mcp_interactions("thread-b", "branch-a", None, 1)
                    .is_err()
            );
        }
        let db = Catalog::open(&root).unwrap();
        assert!(
            db.capture_mcp_interactions("thread-b", "branch-b", None, 1)
                .unwrap()
                .load()
                .unwrap()
                .items
                .is_empty()
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
