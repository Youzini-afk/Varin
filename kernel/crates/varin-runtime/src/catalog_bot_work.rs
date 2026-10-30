//! Descriptive matters and explicit following links. Runs, messages and resource owners
//! remain authoritative for execution. Small revisions use the existing Catalog event log.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatterThread {
    pub thread_id: String,
    pub branch_id: String,
    #[serde(default)]
    pub send: bool,
    #[serde(default)]
    pub memory: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotMatter {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub description: String,
    pub archived: bool,
    pub threads: Vec<MatterThread>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatterUpdate {
    pub bot_id: String,
    pub key: String,
    pub expected_revision: u64,
    pub matter: BotMatter,
}
pub(super) fn entry(db: &Connection, bot: &str) -> Result<String> {
    db.query_row(
        "SELECT thread_id FROM bot_thread_bindings WHERE bot_id=?1 ORDER BY rowid LIMIT 1",
        [bot],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| RuntimeError::NotFound(format!("Bot {bot}")))
}
pub(super) fn matters(db: &Connection, bot: &str) -> Result<Vec<BotMatter>> {
    let mut query = db.prepare("SELECT e.data FROM events e WHERE e.subject=?1 AND e.kind='bot.matter.updated' AND NOT EXISTS(SELECT 1 FROM events later WHERE later.subject=e.subject AND later.kind='bot.matter.updated' AND json_extract(later.data,'$.id')=json_extract(e.data,'$.id') AND later.cursor>e.cursor) ORDER BY e.cursor DESC")?;
    let rows = query.query_map([format!("bot-work:{bot}")], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}
pub(super) fn linked(
    db: &Connection,
    caller: &str,
    target: &str,
    branch: Option<&str>,
    send: bool,
    memory: bool,
) -> Result<bool> {
    let bot: Option<String> = db
        .query_row(
            "SELECT bot_id FROM bot_thread_bindings WHERE thread_id=?1",
            [caller],
            |row| row.get(0),
        )
        .optional()?;
    let Some(bot) = bot else { return Ok(false) };
    db.query_row("SELECT EXISTS(SELECT 1 FROM events e,json_each(e.data,'$.threads') link WHERE e.subject=?1 AND e.kind='bot.matter.updated' AND json_extract(e.data,'$.archived')=0 AND json_extract(link.value,'$.threadId')=?2 AND (?3 IS NULL OR json_extract(link.value,'$.branchId')=?3) AND (NOT ?4 OR json_extract(link.value,'$.send')=1) AND (NOT ?5 OR json_extract(link.value,'$.memory')=1) AND NOT EXISTS(SELECT 1 FROM events later WHERE later.subject=e.subject AND later.kind='bot.matter.updated' AND json_extract(later.data,'$.id')=json_extract(e.data,'$.id') AND later.cursor>e.cursor))", params![format!("bot-work:{bot}"),target,branch,send,memory], |row|row.get(0)).map_err(Into::into)
}
pub(super) fn can_message(
    db: &Connection,
    sender: &str,
    branch: &str,
    target: &str,
    target_branch: &str,
) -> Result<bool> {
    Ok(
        linked(db, sender, target, Some(target_branch), true, false)?
            || linked(db, target, sender, Some(branch), true, false)?,
    )
}
pub(super) fn followers(db: &Connection, thread: &str, branch: &str) -> Result<Vec<String>> {
    let mut query=db.prepare("SELECT DISTINCT binding.bot_id FROM bot_thread_bindings binding JOIN events e ON e.subject='bot-work:'||binding.bot_id JOIN json_each(e.data,'$.threads') link WHERE e.kind='bot.matter.updated' AND json_extract(e.data,'$.archived')=0 AND json_extract(link.value,'$.threadId')=?1 AND json_extract(link.value,'$.branchId')=?2 AND NOT EXISTS(SELECT 1 FROM events later WHERE later.subject=e.subject AND later.kind='bot.matter.updated' AND json_extract(later.data,'$.id')=json_extract(e.data,'$.id') AND later.cursor>e.cursor)")?;
    let rows = query.query_map(params![thread, branch], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}
impl Catalog {
    pub fn cold_bot_work_receipt(&self, input_id: &str) -> Result<Option<Receipt>> {
        let receipt: Option<String> = self
            .db
            .query_row(
                "SELECT receipt FROM commands WHERE id=?1",
                [format!("bot-work-run:{input_id}")],
                |row| row.get(0),
            )
            .optional()?;
        receipt
            .map(|receipt| serde_json::from_str(&receipt).map_err(Into::into))
            .transpose()
    }
    pub fn pending_cold_bot_work(&self) -> Result<Vec<ColdBotWork>> {
        let mut query = self.db.prepare("SELECT q.body,b.bot_id FROM input_queue q JOIN branches branch ON branch.id=q.branch_id JOIN bot_thread_bindings b ON b.thread_id=branch.thread_id WHERE q.origin='work_event' AND q.state='queued' AND q.activation='activating' AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.branch_id=q.branch_id) ORDER BY q.cursor")?;
        let rows = query.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut result = Vec::new();
        let mut branches = std::collections::BTreeSet::new();
        for row in rows {
            let (body, bot_id) = row?;
            let input: inputs::QueuedInputMetadata = serde_json::from_str(&body)?;
            if ingress::hold(&self.db, &input, None)?.is_none()
                && branches.insert(input.branch_id.clone())
            {
                result.push(ColdBotWork {
                    bot_id,
                    input_id: input.id,
                    thread_id: input.thread_id,
                    branch_id: input.branch_id,
                    revision: input.revision,
                    owner_epoch: self.epoch,
                });
            }
        }
        Ok(result)
    }

    pub fn prepare_cold_bot_work(
        &self,
        work: ColdBotWork,
        configuration: Value,
        initial: context::ContextProposal,
        basis: personalization::PersonalizationBasis,
        resources: Option<resources::ContextResources>,
    ) -> Result<ColdBotPreparation> {
        if work.owner_epoch != self.epoch
            || !self.pending_cold_bot_work()?.contains(&work)
            || basis.mode != "bot"
            || basis.thread_role != "main"
            || basis.thread_id != work.thread_id
        {
            return Err(RuntimeError::RequestActivationStale);
        }
        let row: inputs::QueuedInputMetadata = record(&self.db, "input_queue", &work.input_id)?;
        let history: String = self.db.query_row(
            "SELECT body FROM input_history_content WHERE input_id=?1",
            [&row.id],
            |row| row.get(0),
        )?;
        let submission = self
            .prepare_submission(
                SubmitInput {
                    key: format!("bot-work-run:{}", row.id),
                    thread_id: row.thread_id.clone(),
                    branch_id: row.branch_id.clone(),
                    expected_head: self.head(&row.branch_id)?,
                    input: Value::Null,
                    configuration,
                },
                Some(initial),
                Some(basis),
            )?
            .with_resources(resources);
        Ok(ColdBotPreparation {
            work,
            row,
            history: serde_json::from_str(&history)?,
            submission,
        })
    }

    pub fn admit_cold_bot_work(&mut self, prepared: PreparedColdBotWork) -> Result<Receipt> {
        if let Some(receipt) = self.cold_bot_work_receipt(&prepared.work.input_id)? {
            return Ok(receipt);
        }
        if !self.pending_cold_bot_work()?.contains(&prepared.work) {
            return Err(RuntimeError::RequestActivationStale);
        }
        activation::validate_pending(&self.db, &prepared.row)?;
        let tx = self.db.transaction()?;
        let receipt = Self::submit_admission_tx(&tx, self.epoch, &prepared.submission, None)?;
        event(
            &tx,
            &prepared.row.id,
            prepared.row.revision + 1,
            "ingress.run_ready",
            json!({"input_id":receipt.input_id,"run_id":receipt.run_id}),
        )?;
        tx.commit()?;
        Ok(receipt)
    }

    pub fn bot_matters(&self, bot_id: &str) -> Result<Vec<BotMatter>> {
        entry(&self.db, bot_id)?;
        matters(&self.db, bot_id)
    }
    /// None is the authenticated product command. A model invocation may associate
    /// its own family or preserve an existing user grant, never grant itself access.
    pub fn update_bot_matter(
        &mut self,
        input: MatterUpdate,
        caller: Option<&crate::execution::ToolExecutionContext>,
    ) -> Result<BotMatter> {
        let root = entry(&self.db, &input.bot_id)?;
        let key = format!("bot-matter:{}:{}", input.bot_id, input.key);
        let intent = serde_json::to_value(&input)?;
        if let Some((old, receipt)) = self
            .db
            .query_row(
                "SELECT intent,receipt FROM commands WHERE id=?1",
                [&key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if serde_json::from_str::<Value>(&old)? != intent {
                return Err(RuntimeError::Conflict(
                    "matter command key has different content".into(),
                ));
            }
            return Ok(serde_json::from_str(&receipt)?);
        }
        let mut next = input.matter;
        if next.id.trim().is_empty() || next.title.trim().is_empty() || input.key.is_empty() {
            return Err(RuntimeError::Invalid(
                "matter id, title and command key are required".into(),
            ));
        }
        let prior = matters(&self.db, &input.bot_id)?
            .into_iter()
            .find(|row| row.id == next.id);
        if prior.as_ref().map(|row| row.revision).unwrap_or(0) != input.expected_revision {
            return Err(RuntimeError::Conflict(
                "matter changed after it was read".into(),
            ));
        }
        if let Some(caller) = caller {
            let run = self.run(&caller.run_id)?;
            fence(&run, self.epoch)?;
            let session_bot: Option<String> = self
                .db
                .query_row(
                    "SELECT bot_id FROM bot_thread_bindings WHERE thread_id=?1",
                    [&run.thread_id],
                    |row| row.get(0),
                )
                .optional()?;
            if session_bot.as_deref() != Some(input.bot_id.as_str()) || run.cancel_requested {
                return Err(RuntimeError::Conflict(
                    "matter update is outside its Bot session execution".into(),
                ));
            }
            tool_content::root_tool_context(&self.db, caller, true)?;
            for link in &next.threads {
                if scheduling::thread_family(&self.db, &link.thread_id)?
                    != scheduling::thread_family(&self.db, &run.thread_id)?
                    && !prior.as_ref().is_some_and(|matter| {
                        matter.threads.iter().any(|old| {
                            old.thread_id == link.thread_id
                                && old.branch_id == link.branch_id
                                && (!link.send || old.send)
                                && (!link.memory || old.memory)
                        })
                    })
                {
                    return Err(RuntimeError::Conflict(
                        "following another conversation requires an explicit user link".into(),
                    ));
                }
            }
        }
        for link in next.threads.iter().filter(|link| {
            !next.archived
                && !prior
                    .as_ref()
                    .is_some_and(|matter| matter.threads.contains(link))
        }) {
            threads::require_available(&self.db, &link.thread_id)?;
            threads::require_public(&self.db, &link.thread_id)?;
            let actual: String = self.db.query_row(
                "SELECT thread_id FROM branches WHERE id=?1",
                [&link.branch_id],
                |row| row.get(0),
            )?;
            if actual != link.thread_id {
                return Err(RuntimeError::Conflict(
                    "matter branch belongs to another conversation".into(),
                ));
            }
        }
        next.revision = input
            .expected_revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Invalid("matter revision exhausted".into()))?;
        let tx = self.db.transaction()?;
        event(
            &tx,
            &format!("bot-work:{}", input.bot_id),
            next.revision,
            "bot.matter.updated",
            serde_json::to_value(&next)?,
        )?;
        if caller.is_none() {
            let branch = super::threads::branch(&tx, &root)?;
            event(
                &tx,
                "bot-work-pending",
                next.revision,
                "bot.work_pending",
                json!({"kind":"matter_changed","botId":input.bot_id,"matterId":next.id,"matterRevision":next.revision,"targetThreadId":root,"targetBranchId":branch}),
            )?;
        }
        tx.execute(
            "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
            params![key, encode(&intent)?, encode(&next)?],
        )?;
        tx.commit()?;
        Ok(next)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColdBotWork {
    pub bot_id: String,
    pub input_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub revision: u64,
    pub owner_epoch: u64,
}
pub struct ColdBotPreparation {
    work: ColdBotWork,
    row: inputs::QueuedInputMetadata,
    history: Value,
    submission: submissions::SubmissionPreparation,
}
pub struct PreparedColdBotWork {
    work: ColdBotWork,
    row: inputs::QueuedInputMetadata,
    submission: submissions::PreparedSubmission,
}
impl ColdBotPreparation {
    pub fn load(self, launch: launches::LaunchSelection) -> Result<PreparedColdBotWork> {
        let submission = self
            .submission
            .load_ingress(launch, self.row.clone(), self.history)?;
        Ok(PreparedColdBotWork {
            work: self.work,
            row: self.row,
            submission,
        })
    }
}
