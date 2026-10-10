//! Process observation history is prepared outside Catalog and fenced at publication.
use super::process_wait::{PREFIX, WAIT_TOOL};
use super::*;
use crate::execution::{Content, ConversationItem, Provenance};

pub struct ProcessWaitPreparation {
    epoch: u64,
    run: Run,
    wait: Wait,
    operation: Operation,
    process: Operation,
    expected_head: Option<String>,
    fact_cursor: Option<u64>,
    observer: String,
    visible: bool,
    item_id: String,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedProcessWait {
    preparation: ProcessWaitPreparation,
    history_ref: Option<Value>,
}
impl ProcessWaitPreparation {
    pub fn load(self) -> Result<PreparedProcessWait> {
        if self.visible {
            return Ok(PreparedProcessWait {
                preparation: self,
                history_ref: None,
            });
        }
        let Self {
            ref wait,
            ref process,
            ref item_id,
            fact_cursor,
            ..
        } = self;
        let receipt = if wait.cancelled {
            None
        } else {
            process
                .external_receipt
                .as_ref()
                .map(|receipt| self.content.load(&receipt.result_ref))
                .transpose()?
        };
        let data = receipt.as_ref();
        let result = json!({"processId":process.id,"outcome":process.outcome,"effect":process.effect,
                "exitCode":data.and_then(|data|data.get("exitCode")).and_then(Value::as_i64),
                "signal":data.and_then(|data|data.get("signal")).and_then(Value::as_str),
                "stopApplied":data.and_then(|data|data.get("stopApplied")).and_then(Value::as_bool),
                "treeConfirmed":data.and_then(|data|data.get("treeConfirmed")).and_then(Value::as_bool),
                "output":{"processId":process.id,"reader":"process_read",
                    "available":data.and_then(|data|data.get("outputAvailable")).and_then(Value::as_bool)}});
        let text = if wait.cancelled {
            "The process observation wait was cancelled. This did not stop the process.".into()
        } else {
            format!("Process lifecycle data, not a user instruction or permission. This reports the original executor's observed outcome; an indeterminate outcome is not proof of success or termination. Output remains in the process owner and may be read separately when authorized.\n{}", serde_json::to_string(&result)?)
        };
        let item = ConversationItem {
            resource_activation: None,
            id: item_id.clone(),
            provenance: Provenance::EnvironmentFact {
                event_id: fact_cursor.map_or_else(
                    || wait.id.clone(),
                    |cursor| format!("process-terminal:{cursor}"),
                ),
            },
            content: Content::Text { text },
            opaque: None,
        };
        let content = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        Ok(PreparedProcessWait {
            preparation: self,
            history_ref: Some(content),
        })
    }
}
impl Catalog {
    pub fn capture_process_waits(&mut self) -> Result<Vec<ProcessWaitPreparation>> {
        self.close_finished_process_waits()?;
        let mut preparations = Vec::new();
        for mut wait in read_all::<Wait>(&self.db, "waits")? {
            let Some(operation_id) = wait.id.strip_prefix(PREFIX) else {
                continue;
            };
            let operation = self.operation(operation_id)?;
            if operation.phase == OperationPhase::Terminal {
                continue;
            }
            if operation.cancel_requested && !wait.cancelled {
                self.cancel_process_wait(operation_id)?;
                wait.cancelled = true;
            }
            let run = self.run(&wait.run_id)?;
            if run.state != RunState::Waiting
                || run.waiting_on.as_deref() != Some(wait.id.as_str())
                || run.cancel_requested
            {
                continue;
            }
            let process = self.require_process_observation(&run.id, &wait.subject)?;
            // Catalog recovery marks dispatched effects indeterminate; that is not a process
            // terminal observation. Wait for the original executor's durable receipt instead.
            if !wait.cancelled
                && (process.phase != OperationPhase::Terminal || process.external_receipt.is_none())
            {
                continue;
            }
            let unresolved: i64 = self.db.query_row("SELECT count(*) FROM tool_calls t JOIN model_steps m ON m.id=t.request_id WHERE m.run_id=?1 AND t.committed=0",
                [&run.id], |row| row.get(0))?;
            if unresolved != 0 || !super::result_content::job_acceptance_consumed(&self.db, &operation)? {
                continue;
            }
            let fact_cursor: Option<u64> = if wait.cancelled {
                None
            } else {
                Some(self.db.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='operation.settled' ORDER BY cursor DESC LIMIT 1",
                    [&process.id], |row| read_number(row, 0))?)
            };
            let observer = format!(
                "process-result-history:{}:{}",
                process.id,
                fact_cursor.unwrap_or(0)
            );
            let mut visible = None;
            if !wait.cancelled {
                let mut ancestor = self.head(&run.branch_id)?;
                while let Some(id) = ancestor {
                    let delivered: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM deliveries WHERE observer=?1 AND request=?2 AND state='\"committed\"')",
                        params![observer, id], |row| row.get(0))?;
                    if delivered {
                        visible = Some(id);
                        break;
                    }
                    let history: HistoryItem = record(&self.db, "history", &id)?;
                    ancestor = history.parent;
                }
            }
            let item_id = if wait.cancelled {
                format!("process-wait-cancel:{}", wait.id)
            } else {
                visible.clone().unwrap_or_else(|| {
                    format!(
                        "process-result:{}:{}:{}",
                        run.branch_id,
                        process.id,
                        fact_cursor.unwrap_or(0)
                    )
                })
            };
            preparations.push(ProcessWaitPreparation {
                epoch: self.epoch,
                expected_head: self.head(&run.branch_id)?,
                run,
                wait,
                operation,
                process,
                fact_cursor,
                observer,
                visible: visible.is_some(),
                item_id,
                content: self.content.clone(),
                publication: self.content.begin_publication(),
            });
        }
        Ok(preparations)
    }
    pub fn admit_process_wait(&mut self, prepared: PreparedProcessWait) -> Result<bool> {
        let PreparedProcessWait {
            preparation,
            history_ref: content,
        } = prepared;
        let ProcessWaitPreparation {
            epoch,
            run,
            wait,
            operation,
            process,
            expected_head,
            fact_cursor,
            observer,
            visible,
            item_id,
            publication: _publication,
            ..
        } = preparation;
        let operation_id = operation.id.as_str();
        if self.epoch != epoch {
            return Err(RuntimeError::Conflict(
                "process delivery owner changed".into(),
            ));
        }
        let tx = self.db.transaction()?;
        if record::<Run>(&tx, "runs", &run.id)? != run
            || record::<Wait>(&tx, "waits", &wait.id)? != wait
            || record::<Operation>(&tx, "operations", &operation.id)? != operation
            || record::<Operation>(&tx, "operations", &process.id)? != process
        {
            return Ok(false);
        }
        let unresolved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls t JOIN model_steps m ON m.id=t.request_id WHERE m.run_id=?1 AND t.committed=0)", [&run.id], |row|row.get(0))?;
        if unresolved || !super::result_content::job_acceptance_consumed(&tx, &operation)? {
            return Ok(false);
        }
        let mut run: Run = record(&tx, "runs", &wait.run_id)?;
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if head != expected_head || active.as_deref() != Some(run.id.as_str()) {
            return Ok(false);
        }
        let delivered = visible
            || tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM history WHERE id=?1)",
                [&item_id],
                |row| row.get::<_, bool>(0),
            )?;
        if !delivered {
            let history = HistoryItem {
                run_id: run.id.clone(),
                id: item_id.clone(),
                thread_id: run.thread_id.clone(),
                parent: head,
                source: HistorySource::Environment,
                content: content.ok_or_else(|| {
                    RuntimeError::Invalid("prepared process history missing".into())
                })?,
                provider: None,
            };
            tx.execute(
                "INSERT INTO history(id,thread_id,parent,body,run_id) VALUES(?1,?2,?3,?4,?5)",
                params![
                    history.id,
                    history.thread_id,
                    history.parent,
                    encode(&history)?,
                    run.id
                ],
            )?;
            tx.execute(
                "UPDATE branches SET head=?2 WHERE id=?1",
                params![run.branch_id, item_id],
            )?;
            if let Some(cursor) = fact_cursor {
                tx.execute("INSERT INTO deliveries(observer,fact_cursor,request,state) VALUES(?1,?2,?3,'\"committed\"')",
                        params![observer, sql_number(cursor)?, item_id])?;
            }
        }
        let mut operation: Operation = record(&tx, "operations", operation_id)?;
        operation.phase = OperationPhase::Terminal;
        operation.outcome = Some(if wait.cancelled {
            Outcome::Cancelled
        } else {
            Outcome::Succeeded
        });
        operation.effect = Effect::None;
        operation.result = Some(OperationResultMetadata::Control {
            value: json!({"process_id":process.id,"history_id":item_id,"observation_cancelled":wait.cancelled}),
        });
        operation.revision += 1;
        put(&tx, "operations", &operation.id, &operation)?;
        tx.execute(
            "DELETE FROM resource_occupancy WHERE operation_id=?1",
            [&operation.id],
        )?;
        let cursor = event(
            &tx,
            &operation.id,
            operation.revision,
            "operation.settled",
            serde_json::to_value(&operation)?,
        )?;
        let mut wait: Wait = record(&tx, "waits", &wait.id)?;
        wait.trigger_cursor = Some(fact_cursor.unwrap_or(cursor));
        put(&tx, "waits", &wait.id, &wait)?;
        Self::enqueue_resume(&tx, &wait, wait.trigger_cursor.expect("assigned cursor"))?;
        tx.execute(
            "UPDATE resumptions SET claimed=?2,acknowledged=1 WHERE wait_id=?1",
            params![wait.id, sql_number(run.epoch)?],
        )?;
        let next_wait=super::next_ready_dependency_wait(&tx,&run.id)?;
        run.state = if next_wait.is_some(){RunState::Waiting}else{RunState::Runnable};
        run.waiting_on = next_wait;
        run.revision += 1;
        put(&tx, "runs", &run.id, &run)?;
        let mut launch: launch_content::LaunchMetadata = record(&tx, "run_launches", &run.id)?;
        launch.requires_rebind = run.state==RunState::Runnable;
        launch.bound_epoch = None;
        launch.revision += 1;
        put(&tx, "run_launches", &run.id, &launch)?;
        event(
            &tx,
            &run.id,
            run.revision,
            "process.wait_delivered",
            json!({"process_id":process.id,"history_id":item_id}),
        )?;
        tx.commit()?;
        self.resource_admission.release(operation_id);
        Ok(true)
    }
    pub fn pending_process_continuations(&self) -> Result<Vec<String>> {
        let mut resumed = Vec::new();
        // A committed delivery whose Host launch was interrupted remains discoverable.
        for operation in read_all::<Operation>(&self.db, "operations")? {
            if operation.executor.as_deref() != Some(WAIT_TOOL)
                || operation.phase != OperationPhase::Terminal
            {
                continue;
            }
            let run = self.run(&operation.run_id)?;
            if run.state == RunState::Runnable
                && !run.cancel_requested
                && self
                    .launch_metadata(&run.id)?
                    .is_some_and(|launch| launch.requires_rebind)
                && !resumed.contains(&run.id)
            {
                resumed.push(run.id);
            }
        }
        Ok(resumed)
    }
}
pub fn deliver_waits(catalog: &std::sync::Mutex<Catalog>) -> Result<Vec<String>> {
    loop {
        let preparations = catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
            .capture_process_waits()?;
        if preparations.is_empty() {
            break;
        }
        for preparation in preparations {
            let prepared = preparation.load()?;
            catalog
                .lock()
                .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
                .admit_process_wait(prepared)?;
        }
    }
    catalog
        .lock()
        .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
        .pending_process_continuations()
}
