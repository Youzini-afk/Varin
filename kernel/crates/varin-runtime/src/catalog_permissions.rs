//! One-action permission rendezvous on the admitted Operation and existing Wait authority.
//! This is not a policy store. The Host evaluates existing rules; only authenticated user
//! decisions reach decide_permission. A decision is unusable after an owner/kernel restart.
use super::permission_content::PreparedPermission;
use super::tool_content::ToolIntent;
use super::*;

impl Catalog {
    pub fn open_permission(
        &mut self,
        operation_id: &str,
        permission_id: &str,
        call: Value,
        scope: Value,
    ) -> Result<Operation> {
        let prepared = self.prepare_permission(call, scope).load()?;
        self.open_permission_prepared(operation_id, permission_id, prepared)
    }
    pub fn open_permission_prepared(
        &mut self,
        operation_id: &str,
        permission_id: &str,
        prepared: PreparedPermission,
    ) -> Result<Operation> {
        if permission_id.is_empty() {
            return Err(RuntimeError::Invalid("invalid permission identity".into()));
        }
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let tool = ToolIntent::from_operation(&op)?;
        let call = &prepared.identity;
        if tool.origin()!=&(crate::execution::ToolOrigin::ModelStep{request_id:call.request_id.clone()})
            || call.run_id != op.run_id
            || call.operation_id != op.id
            || call.call_id != tool.call().call_id
            || call.name != tool.call().name
            || call.schema_version != tool.call().schema_version
            || prepared.arguments_ref != tool.call().arguments_ref
            || format!("{}:tool:{}", call.request_id, call.call_id) != op.id
            || op.phase != OperationPhase::Accepted
            || op.effect != Effect::None
            || op.cancel_requested
            || run.cancel_requested
            || run.state.terminal()
            || op.epoch != run.epoch
        {
            return Err(RuntimeError::Conflict(
                "permission action is no longer admitted".into(),
            ));
        }
        let active: Option<String> = tx.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |r| r.get(0),
        )?;
        if active.as_deref() != Some(&run.id) {
            return Err(RuntimeError::Conflict(
                "permission branch owner changed".into(),
            ));
        }
        let launch: launch_content::LaunchMetadata = record(&tx, "run_launches", &run.id)?;
        let wait_id = format!("permission:{permission_id}");
        let cursor = tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
            read_number(r, 0)
        })?;
        let wait = Wait {
            id: wait_id.clone(),
            run_id: run.id.clone(),
            subject: op.id.clone(),
            kind: "permission.decided".into(),
            after_cursor: cursor,
            trigger_cursor: None,
            cancelled: false,
        };
        tx.execute(
            "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
            params![wait.id, wait.run_id, encode(&wait)?],
        )?;
        op.phase = OperationPhase::Waiting;
        op.waiting_on = Some(wait_id);
        op.result = Some(OperationResultMetadata::Control { value:
            json!({"permission":{"id":permission_id,"call_ref":prepared.call_ref,"scope_ref":prepared.scope_ref,"actor":launch.selection.credential_scope,"epoch":run.epoch,"decision":null,"consumed":false}}),
         });
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "permission.opened",
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }

    pub fn decide_permission(
        &mut self,
        operation_id: &str,
        permission_id: &str,
        decision: &str,
    ) -> Result<Operation> {
        if !matches!(decision, "allow_once" | "deny") {
            return Err(RuntimeError::Invalid("invalid permission decision".into()));
        }
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let mut permission = permission_record(&op, permission_id)?;
        validate_live_permission(&tx, &op, &run, &permission)?;
        if !permission["decision"].is_null() {
            if permission["decision"] == decision {
                return Ok(op);
            }
            return Err(RuntimeError::Conflict("permission already decided".into()));
        }
        permission["decision"] = json!(decision);
        op.result = Some(OperationResultMetadata::Control { value: json!({"permission":permission}) });
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        let cursor = event(
            &tx,
            &op.id,
            op.revision,
            "permission.decided",
            json!({"permission_id":permission_id,"decision":decision}),
        )?;
        let mut wait: Wait = record(&tx, "waits", op.waiting_on.as_deref().unwrap())?;
        wait.trigger_cursor = Some(cursor);
        put(&tx, "waits", &wait.id, &wait)?;
        tx.commit()?;
        Ok(op)
    }

    /// Only the live authorizing Host consumes the exact decision. There is no session grant.
    pub fn consume_permission(
        &mut self,
        operation_id: &str,
        permission_id: &str,
        call: Value,
        scope: Value,
    ) -> Result<Operation> {
        let prepared = self.prepare_permission(call, scope).load()?;
        self.consume_permission_prepared(operation_id, permission_id, prepared)
    }
    pub fn consume_permission_prepared(
        &mut self,
        operation_id: &str,
        permission_id: &str,
        prepared: PreparedPermission,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let mut permission = permission_record(&op, permission_id)?;
        validate_live_permission(&tx, &op, &run, &permission)?;
        if permission["call_ref"] != prepared.call_ref
            || permission["scope_ref"] != prepared.scope_ref
            || permission["decision"] != "allow_once"
        {
            return Err(RuntimeError::Conflict(
                "permission does not authorize this action".into(),
            ));
        }
        permission["consumed"] = json!(true);
        op.result = Some(OperationResultMetadata::Control { value: json!({"permission":permission}) });
        op.phase = OperationPhase::Accepted;
        op.waiting_on = None;
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "permission.consumed",
            json!({"permission_id":permission_id}),
        )?;
        tx.commit()?;
        Ok(op)
    }
}
fn permission_record(op: &Operation, id: &str) -> Result<Value> {
    let value = op
        .result
        .as_ref()
        .map(OperationResultMetadata::control).transpose()?
        .and_then(|v| v.get("permission"))
        .cloned()
        .ok_or_else(|| RuntimeError::Conflict("permission unavailable".into()))?;
    if value["id"] != id {
        return Err(RuntimeError::Conflict("permission identity changed".into()));
    }
    Ok(value)
}
fn validate_live_permission(
    tx: &Transaction<'_>,
    op: &Operation,
    run: &Run,
    permission: &Value,
) -> Result<()> {
    let launch: launch_content::LaunchMetadata = record(tx, "run_launches", &run.id)?;
    let active: Option<String> = tx.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [&run.branch_id],
        |r| r.get(0),
    )?;
    let wait: Wait = record(
        tx,
        "waits",
        op.waiting_on
            .as_deref()
            .ok_or_else(|| RuntimeError::Conflict("permission not waiting".into()))?,
    )?;
    if active.as_deref() != Some(&run.id)
        || op.phase != OperationPhase::Waiting
        || op.effect != Effect::None
        || op.cancel_requested
        || run.cancel_requested
        || run.state.terminal()
        || op.epoch != run.epoch
        || permission["epoch"] != run.epoch
        || permission["consumed"] != false
        || wait.cancelled
        || permission["actor"] != serde_json::to_value(launch.selection.credential_scope)?
    {
        return Err(RuntimeError::Conflict(
            "permission expired or cancelled".into(),
        ));
    }
    Ok(())
}
