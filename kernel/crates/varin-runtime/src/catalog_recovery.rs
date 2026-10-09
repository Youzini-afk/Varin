//! Resume a locally committed model output; the saved transport request is never sent again.
use super::*;
use crate::execution::*;

pub struct ExecutionRecovery {
    pub event: PolicyEvent,
    pub pending: Option<(RequestSnapshot, Vec<ToolCall>)>,
    pub receipts: std::collections::BTreeMap<String, ToolResult>,
    pub decision: Option<PolicyDecision>,
}

impl Catalog {
    pub fn prepare_recovered_execution(
        &mut self,
        run_id: &str,
        binding: RequestBinding,
        policy: PolicyIdentity,
        initial_policy_state: Value,
    ) -> Result<(ExecutionInput, Option<ExecutionRecovery>)> {
        let run = self.run(run_id)?;
        if !matches!(
            run.state,
            RunState::Waiting | RunState::Runnable | RunState::Accepted
        ) {
            return self
                .prepare_execution(run_id, binding, policy, initial_policy_state)
                .map(|input| (input, None));
        }
        // Policy reads can be the first work in a Run. Restore their sole Operation before
        // looking for a ModelStep; the engine consumes the committed receipts directly.
        if let Some(job)=self.policy_model_job(run_id,self.epoch)? {
            if job.intent.checkpoint().0!=&policy{return Err(RuntimeError::Conflict("policy recovery version changed".into()));}
            if run.state==RunState::Waiting {
                let key=run.waiting_on.as_deref().ok_or_else(||RuntimeError::Conflict("missing recovery wait".into()))?;
                let mut wait:Wait=record(&self.db,"waits",key)?;
                if !matches!(wait.kind.as_str(),"recovery.reconciled"|"execution.reconciled"){return Err(RuntimeError::Conflict("Run waits on another condition".into()));}
                let tx=self.db.transaction()?;wait.cancelled=true;put(&tx,"waits",key,&wait)?;
                let mut resumed=run.clone();resumed.state=RunState::Runnable;resumed.waiting_on=None;resumed.revision+=1;put(&tx,"runs",run_id,&resumed)?;tx.commit()?;
            }
            return self.prepare_execution(run_id,binding,policy,initial_policy_state).map(|input|(input,None));
        }
        if let Some(graph)=self.policy_graph(run_id,self.epoch)? {
            if graph.intent.checkpoint().0!=&policy {return Err(RuntimeError::Conflict("policy recovery version changed".into()));}
            if run.state==RunState::Waiting {
                let key=run.waiting_on.as_deref().ok_or_else(||RuntimeError::Conflict("missing recovery wait".into()))?;
                let mut wait:Wait=record(&self.db,"waits",key)?;
                if !matches!(wait.kind.as_str(),"recovery.reconciled"|"execution.reconciled") {return Err(RuntimeError::Conflict("Run waits on another condition".into()));}
                let tx=self.db.transaction()?;
                wait.cancelled=true;put(&tx,"waits",key,&wait)?;
                let mut resumed=run.clone();resumed.state=RunState::Runnable;resumed.waiting_on=None;resumed.revision+=1;put(&tx,"runs",run_id,&resumed)?;tx.commit()?;
            }
            return self.prepare_execution(run_id,binding,policy,initial_policy_state).map(|input|(input,None));
        }
        let latest: Option<String> = self
            .db
            .query_row(
                "SELECT id FROM model_steps WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1",
                [run_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(request_id) = latest else {
            return self
                .prepare_execution(run_id, binding, policy, initial_policy_state)
                .map(|input| (input, None));
        };
        let mut step: ModelStep = record(&self.db, "model_steps", &request_id)?;
        if step.state != ModelStepState::Completed || step.superseded_by_input.is_some() {
            return self
                .prepare_execution(run_id, binding, policy, initial_policy_state)
                .map(|input| (input, None));
        }
        fence(&run, self.epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::Conflict(
                "Run cancellation is closing recovery admission".into(),
            ));
        }
        let unresolved:i64=self.db.query_row("SELECT count(*) FROM model_steps WHERE run_id=?1 AND state!='completed' AND json_extract(body,'$.superseded_by_input') IS NULL",[run_id],|r|r.get(0))?;
        if unresolved != 0 {
            return Err(RuntimeError::Conflict(
                "model send status still requires reconciliation".into(),
            ));
        }
        let snapshot: RequestSnapshot = serde_json::from_value(self.content.load(&step.request)?)?;
        if snapshot.view.binding.connection_identity != binding.connection_identity
            || snapshot.view.binding.provider_family != binding.provider_family
            || snapshot.view.binding.model != binding.model
            || snapshot.view.binding.tools != binding.tools
            || snapshot.view.binding.configuration_generation != binding.configuration_generation
            || snapshot.view.binding.tool_schema_generation != binding.tool_schema_generation
        {
            return Err(RuntimeError::Conflict(
                "completed exchange belongs to another frozen launch binding".into(),
            ));
        }
        let output = self
            .model_output(&request_id)?
            .ok_or_else(|| RuntimeError::Invalid("completed model has no durable output".into()))?;
        if output.get("status").and_then(Value::as_str) != Some("committed") {
            return Err(RuntimeError::Conflict(
                "rejected model output cannot be resumed".into(),
            ));
        }
        let completed_record: ExecutionRecord = serde_json::from_value(
            output
                .get("record")
                .cloned()
                .ok_or_else(|| RuntimeError::Invalid("model output record missing".into()))?,
        )?;
        let ExecutionRecord::ModelFinished {
            outcome: ModelOutcome::Completed,
            finish_reason: Some(reason),
            items,
            ..
        } = completed_record
        else {
            return Err(RuntimeError::Conflict(
                "model output is not complete".into(),
            ));
        };
        let mut calls = Vec::new();
        let mut receipts = std::collections::BTreeMap::new();
        let mut committed = 0;
        {
            let mut statement = self.db.prepare(
                "SELECT body,receipt,committed FROM tool_calls WHERE request_id=?1 ORDER BY rowid",
            )?;
            let rows = statement.query_map([&request_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (body, receipt, done) = row?;
                let call: ToolCall = serde_json::from_str(&body)?;
                if let Some(receipt) = receipt {
                    receipts.insert(
                        call.call_id.clone(),
                        serde_json::from_str::<ToolResult>(&receipt)?,
                    );
                }
                if done != 0 {
                    committed += 1;
                }
                calls.push(call);
            }
        }
        if committed != 0 && committed != calls.len() {
            return Err(RuntimeError::Invalid(
                "tool history has a partial batch commit".into(),
            ));
        }
        let unpaired_other:i64=self.db.query_row("SELECT count(*) FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.request_id!=?2 AND c.committed=0",params![run_id,request_id],|r|r.get(0))?;
        if unpaired_other != 0 {
            return Err(RuntimeError::Conflict(
                "an earlier tool exchange remains unresolved".into(),
            ));
        }
        for call in &calls {
            if receipts.contains_key(&call.call_id) {
                continue;
            }
            let key = format!("{}:tool:{}", request_id, call.call_id);
            if let Some(op) = optional_record::<Operation>(&self.db, "operations", &key)? {
                if op.cancel_requested
                    && op.phase == OperationPhase::Accepted
                    && op.effect == Effect::None
                {
                    receipts.insert(
                        call.call_id.clone(),
                        ToolResult {
                            request_id: request_id.clone(),
                            call_id: call.call_id.clone(),
                            completion: ToolCompletion::Result { outcome: Outcome::Cancelled, effect: Effect::None, content: json!({"error":"cancelled_before_dispatch"}) },
                        },
                    );
                    continue;
                }
                if op.effect == Effect::Unknown
                    || op.outcome == Some(Outcome::Indeterminate)
                    || (op.phase != OperationPhase::Terminal && op.effect != Effect::None)
                {
                    return Err(RuntimeError::Conflict(
                        "tool effect requires executor reconciliation before recovery".into(),
                    ));
                }
                if op.phase == OperationPhase::Terminal {
                    receipts.insert(
                        call.call_id.clone(),
                        ToolResult {
                            request_id: request_id.clone(),
                            call_id: call.call_id.clone(),
                            completion: ToolCompletion::Result {
                                outcome: op.outcome.ok_or_else(|| {
                                    RuntimeError::Invalid(
                                        "terminal operation has no outcome".into(),
                                    )
                                })?,
                                effect: op.effect,
                                content: op.result.unwrap_or(Value::Null),
                            },
                        },
                    );
                }
            }
        }
        let expected_head = if !calls.is_empty() && committed == calls.len() {
            Some(format!(
                "{}:result:{}",
                request_id,
                calls.last().unwrap().call_id
            ))
        } else {
            items.last().map(|item| item.id.clone()).or(snapshot
                .view
                .binding
                .history_range
                .leaf_id
                .clone())
        };
        let head = self.head(&run.branch_id)?;
        if head != expected_head {
            // New input has already established a later causal boundary. Never reuse an older completion decision.
            return self
                .prepare_execution(run_id, binding, policy, initial_policy_state)
                .map(|input| (input, None));
        }
        let active: Option<String> = self.db.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |r| r.get(0),
        )?;
        if active.as_deref() != Some(run_id) {
            return Err(RuntimeError::Conflict(
                "branch execution owner changed".into(),
            ));
        }
        if run.state == RunState::Waiting {
            let wait: Wait = record(
                &self.db,
                "waits",
                run.waiting_on.as_deref().ok_or_else(|| {
                    RuntimeError::Conflict("Run has no recovery condition".into())
                })?,
            )?;
            if !matches!(wait.kind.as_str(), "recovery.reconciled" | "execution.reconciled") {
                return Err(RuntimeError::Conflict(
                    "Run is waiting on another durable condition".into(),
                ));
            }
        }
        let saved: Option<(String, String, String)> = self
            .db
            .query_row(
                "SELECT identity,state,action FROM policy_checkpoints WHERE run_id=?1",
                [run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((identity, _, _)) = &saved {
            if serde_json::from_str::<PolicyIdentity>(identity)? != policy {
                return Err(RuntimeError::Conflict(
                    "policy recovery version changed".into(),
                ));
            }
        }
        let checkpoint_cursor:i64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind')='policy_checkpoint'",[run_id],|r|r.get(0))?;
        let outcome_cursor:i64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind') IN ('model_finished','tool_batch_committed')",[run_id],|r|r.get(0))?;
        let mut decision = if checkpoint_cursor > outcome_cursor {
            saved
                .as_ref()
                .map(|(_, state, action)| {
                    Ok::<PolicyDecision, RuntimeError>(PolicyDecision {
                        state: serde_json::from_str(state)?,
                        action: serde_json::from_str(action)?,
                    })
                })
                .transpose()?
        } else {
            None
        };
        // A consumed durable wait must be decided again, never replayed as another park.
        if let Some(PolicyDecision { action: PolicyAction::Wait { wait_id }, .. }) = &decision {
            let wait: Wait = record(&self.db, "waits", wait_id)?;
            if wait.trigger_cursor.is_some() || wait.cancelled { decision = None; }
        }
        let recovery_event = if !calls.is_empty() && committed == calls.len() {
            PolicyEvent::ToolsCompleted {
                results: calls
                    .iter()
                    .map(|call| {
                        receipts.get(&call.call_id).cloned().ok_or_else(|| {
                            RuntimeError::Invalid("committed tool receipt missing".into())
                        })
                    })
                    .collect::<Result<_>>()?,
            }
        } else {
            PolicyEvent::ModelCompleted {
                reason,
                tool_calls: calls.len(),
            }
        };
        let pending = if committed == 0 && !calls.is_empty() {
            Some((snapshot, calls))
        } else {
            None
        };
        let tx = self.db.transaction()?;
        let mut run = run;
        if let Some(wait_id) = run.waiting_on.take() {
            let mut wait: Wait = record(&tx, "waits", &wait_id)?;
            wait.cancelled = true;
            put(&tx, "waits", &wait_id, &wait)?;
        }
        run.state = RunState::Runnable;
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        step.epoch = self.epoch;
        put(&tx, "model_steps", &request_id, &step)?;
        event(
            &tx,
            run_id,
            run.revision,
            "run.execution_recovered",
            json!({"request_id":request_id}),
        )?;
        tx.commit()?;
        let input = self.prepare_execution_with_completed_tools(
            run_id,
            binding,
            policy,
            initial_policy_state,
        )?;
        Ok((
            input,
            Some(ExecutionRecovery {
                event: recovery_event,
                pending,
                receipts,
                decision,
            }),
        ))
    }
}
