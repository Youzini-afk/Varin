//! Stable model-facing names for typed original resources. This index stores no content and
//! grants no authority: consumers still validate access and versions with the original owner.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    Message,
    Item,
    File,
    Media,
    Read,
    Process,
    Script,
    Page,
    Observation,
    Settings,
    Material,
    Followup,
    Forward,
    Job,
    Report,
    Container,
}
impl ReferenceKind {
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Message => "msg",
            Self::Item => "item",
            Self::File => "file",
            Self::Media => "media",
            Self::Read => "read",
            Self::Process => "proc",
            Self::Script => "env",
            Self::Page => "page",
            Self::Observation => "obs",
            Self::Settings => "settings",
            Self::Material => "material",
            Self::Followup => "followup",
            Self::Forward => "forward",
            Self::Job => "job",
            Self::Report => "report",
            Self::Container => "container",
        }
    }
    pub fn from_prefix(prefix: &str) -> Option<Self> {
        [
            Self::Message,
            Self::Item,
            Self::File,
            Self::Media,
            Self::Read,
            Self::Process,
            Self::Script,
            Self::Page,
            Self::Observation,
            Self::Settings,
            Self::Material,
            Self::Followup,
            Self::Forward,
            Self::Job,
            Self::Report,
            Self::Container,
        ]
        .into_iter()
        .find(|kind| kind.prefix() == prefix)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelReference {
    pub reference: String,
    pub space_id: String,
    pub kind: ReferenceKind,
    pub owner: String,
    pub target: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionTarget {
    Delegated {
        execution_id: String,
        operation_id: String,
        thread_id: String,
        branch_id: String,
        run_id: Option<String>,
    },
    Native {
        run_id: String,
        thread_id: String,
        branch_id: String,
    },
    External {
        conversation_id: String,
        turn_id: Option<String>,
        operation_id: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionReference {
    pub reference: String,
    pub agent_id: String,
    pub sequence: u64,
    pub target: ExecutionTarget,
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE model_reference_space(id INTEGER PRIMARY KEY CHECK(id=1),space_id TEXT NOT NULL);
        CREATE TABLE model_references(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,owner TEXT NOT NULL,target TEXT NOT NULL,UNIQUE(kind,owner,target));
        CREATE TABLE model_reference_holders(reference_id INTEGER NOT NULL REFERENCES model_references(id) ON DELETE CASCADE,holder TEXT NOT NULL,PRIMARY KEY(reference_id,holder));
        CREATE INDEX model_reference_holder_lookup ON model_reference_holders(holder);
        CREATE TABLE model_agents(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,agent_code TEXT NOT NULL UNIQUE,high_water INTEGER NOT NULL DEFAULT 0 CHECK(high_water>=0),PRIMARY KEY(owner_kind,owner_id));
        CREATE TABLE model_executions(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),kind TEXT NOT NULL,identity TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id,sequence),UNIQUE(kind,identity));
        CREATE TABLE model_bound_targets(operation_id TEXT NOT NULL,purpose TEXT NOT NULL,original TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(operation_id,purpose));
        CREATE TABLE model_execution_aliases(kind TEXT NOT NULL,identity TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(kind,identity));")?;
    db.execute("INSERT INTO model_reference_space VALUES(1,?1)", [id()])?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT space_id FROM model_reference_space WHERE id=1")?;
    db.prepare("SELECT kind,tool_status FROM external_items")?;
    db.prepare("SELECT id,kind,owner,target FROM model_references")?;
    db.prepare("SELECT reference_id,holder FROM model_reference_holders")?;
    db.prepare("SELECT owner_kind,owner_id,agent_code,high_water FROM model_agents")?;
    db.prepare("SELECT owner_kind,owner_id,sequence,kind,identity FROM model_executions")?;
    db.prepare("SELECT kind,identity,owner_kind,owner_id,sequence FROM model_execution_aliases")?;
    db.prepare("SELECT operation_id,purpose,original,target FROM model_bound_targets")?;
    let invalid: bool = db.query_row(
        "SELECT (SELECT count(*) FROM model_reference_space)!=1
        OR (SELECT count(*) FROM model_reference_space WHERE id=1 AND typeof(space_id)='text' AND length(space_id)>0)!=1
        OR EXISTS(SELECT 1 FROM model_references WHERE typeof(id)!='integer' OR id<=0
            OR typeof(kind)!='text' OR kind NOT IN ('msg','item','file','media','read','proc','env','page','obs','settings','material','followup','forward','job','report','container')
            OR typeof(owner)!='text' OR length(owner)=0 OR typeof(target)!='text'
            OR CASE WHEN json_valid(target) THEN json_type(target)!='object' ELSE 1 END)
        OR EXISTS(SELECT 1 FROM model_agents WHERE typeof(owner_kind)!='text' OR owner_kind NOT IN ('thread','external')
            OR typeof(owner_id)!='text' OR length(owner_id)=0 OR typeof(agent_code)!='text' OR length(agent_code)=0 OR instr(agent_code,'/')>0
            OR typeof(high_water)!='integer' OR high_water<0)
        OR EXISTS(SELECT 1 FROM model_executions e LEFT JOIN model_agents a USING(owner_kind,owner_id)
            WHERE a.owner_id IS NULL OR typeof(e.sequence)!='integer' OR e.sequence>a.high_water OR e.sequence<=0
            OR typeof(e.kind)!='text' OR e.kind NOT IN ('delegated','native','external_child','external_turn')
            OR typeof(e.identity)!='text' OR length(e.identity)=0
            OR (e.owner_kind='thread')!=(e.kind IN ('delegated','native')))
        OR EXISTS(SELECT 1 FROM model_execution_aliases a LEFT JOIN model_executions e USING(owner_kind,owner_id,sequence)
            WHERE e.identity IS NULL OR typeof(a.sequence)!='integer'
            OR typeof(a.kind)!='text' OR a.kind NOT IN ('delegated','native','external_child','external_turn')
            OR typeof(a.identity)!='text' OR length(a.identity)=0
            OR (a.owner_kind='thread')!=(a.kind IN ('delegated','native')))
        OR EXISTS(SELECT 1 FROM model_reference_holders h LEFT JOIN model_references r ON r.id=h.reference_id
            WHERE r.id IS NULL OR typeof(h.reference_id)!='integer' OR typeof(h.holder)!='text' OR length(h.holder)=0)
        OR EXISTS(SELECT 1 FROM model_bound_targets WHERE typeof(operation_id)!='text' OR length(operation_id)=0
            OR typeof(purpose)!='text' OR length(purpose)=0 OR typeof(original)!='text' OR NOT json_valid(original)
            OR typeof(target)!='text' OR NOT json_valid(target))
        OR (SELECT count(*) FROM sqlite_sequence WHERE name='model_references')>1
        OR EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='model_references'
            AND (typeof(seq)!='integer' OR seq<0 OR seq<coalesce((SELECT max(id) FROM model_references),0)))
        OR (EXISTS(SELECT 1 FROM model_references) AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='model_references'))",
        [],
        |row| row.get(0),
    )?;
    if invalid {
        return Err(RuntimeError::Invalid(
            "invalid model reference index; data was preserved".into(),
        ));
    }
    Ok(())
}
fn agent(db: &Connection, kind: &str, owner: &str) -> Result<String> {
    if let Some(code) = db
        .query_row(
            "SELECT agent_code FROM model_agents WHERE owner_kind=?1 AND owner_id=?2",
            params![kind, owner],
            |r| r.get(0),
        )
        .optional()?
    {
        return Ok(code);
    }
    let code: String = if kind == "thread" {
        db.query_row("SELECT agent_code FROM threads WHERE id=?1", [owner], |r| {
            r.get(0)
        })?
    } else {
        loop {
            let code = Uuid::new_v4().simple().to_string()[..8].to_uppercase();
            let used:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM model_agents WHERE agent_code=?1 COLLATE NOCASE UNION ALL SELECT 1 FROM threads WHERE agent_code=?1 COLLATE NOCASE UNION ALL SELECT 1 FROM retired_agent_codes WHERE code=?1 COLLATE NOCASE)",[&code],|r|r.get(0))?;
            if !used {
                break code;
            }
        }
    };
    db.execute(
        "INSERT INTO model_agents(owner_kind,owner_id,agent_code) VALUES(?1,?2,?3)",
        params![kind, owner, code],
    )?;
    Ok(code)
}
fn admit(db: &Connection, owner_kind: &str, owner: &str, kind: &str, identity: &str) -> Result<()> {
    if db.query_row(
        "SELECT EXISTS(SELECT 1 FROM model_execution_aliases WHERE kind=?1 AND identity=?2)",
        params![kind, identity],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    agent(db, owner_kind, owner)?;
    let sequence:i64=db.query_row("UPDATE model_agents SET high_water=high_water+1 WHERE owner_kind=?1 AND owner_id=?2 RETURNING high_water",params![owner_kind,owner],|r|r.get(0))?;
    db.execute(
        "INSERT INTO model_executions VALUES(?1,?2,?3,?4,?5)",
        params![owner_kind, owner, sequence, kind, identity],
    )?;
    db.execute(
        "INSERT INTO model_execution_aliases VALUES(?1,?2,?3,?4,?5)",
        params![kind, identity, owner_kind, owner, sequence],
    )?;
    Ok(())
}
pub(super) fn admit_delegated(
    db: &Connection,
    execution: &delegated::DelegatedExecution,
) -> Result<()> {
    let relation = delegated::relation(db, &execution.child_operation_id)?;
    admit(
        db,
        "thread",
        &relation.child_thread_id,
        "delegated",
        &execution.execution_id,
    )
}
pub(super) fn admit_native(db: &Connection, run: &Run) -> Result<()> {
    admit(db, "thread", &run.thread_id, "native", &run.id)
}
pub(super) fn bind_delegated_run(db: &Connection, execution: &str, run: &str) -> Result<()> {
    db.execute("INSERT OR IGNORE INTO model_execution_aliases SELECT 'native',?2,owner_kind,owner_id,sequence FROM model_execution_aliases WHERE kind='delegated' AND identity=?1",params![execution,run])?;
    Ok(())
}
pub(super) fn admit_external_agent(db: &Connection, conversation: &str) -> Result<()> {
    agent(db, "external", conversation).map(|_| ())
}
pub(super) fn admit_external_child(
    db: &Connection,
    child: &external_children::ExternalChild,
) -> Result<()> {
    if child.message_kind == Some(MessageKind::Inform) {
        return Ok(());
    }
    admit(
        db,
        "external",
        &child.conversation_id,
        "external_child",
        &child.operation_id,
    )?;
    if let Some(turn) = &child.turn_id {
        bind_external_turn(db, &child.operation_id, turn)?;
    }
    Ok(())
}
fn bind_external_turn(db: &Connection, operation: &str, turn: &str) -> Result<bool> {
    Ok(db.execute("INSERT OR IGNORE INTO model_execution_aliases SELECT 'external_turn',?2,owner_kind,owner_id,sequence FROM model_execution_aliases WHERE kind='external_child' AND identity=?1",params![operation,turn])?>0)
}
pub(super) fn admit_external_turn(
    db: &Connection,
    conversation: &str,
    turn: &str,
    key: &str,
) -> Result<()> {
    if !bind_external_turn(db, key, turn)? {
        admit(db, "external", conversation, "external_turn", turn)?;
    }
    Ok(())
}
// A published index is indivisible: a missing space row or table must never be
// interpreted as permission to allocate a replacement namespace.
fn existing_index(db: &Connection) -> Result<bool> {
    let (objects, tables): (i64, i64) = db.query_row(
        "SELECT count(*),coalesce(sum(type='table'),0) FROM sqlite_master WHERE name IN (
            'model_reference_space','model_references','model_reference_holders',
            'model_agents','model_executions','model_bound_targets','model_execution_aliases')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if objects == 0 {
        let residual_lookup: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='model_reference_holder_lookup')",
            [],
            |row| row.get(0),
        )?;
        if residual_lookup {
            return Err(RuntimeError::Invalid(
                "incomplete model reference schema; data was preserved".into(),
            ));
        }
        return Ok(false);
    }
    if objects != 7 || tables != 7 {
        return Err(RuntimeError::Invalid(
            "incomplete model reference schema; data was preserved".into(),
        ));
    }
    check_format(db)?;
    Ok(true)
}

fn external_index_columns(db: &Connection) -> Result<usize> {
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(external_items)")?
        .query_map([], |row| row.get(1))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(columns
        .iter()
        .filter(|name| matches!(name.as_str(), "kind" | "tool_status"))
        .count())
}

/// Catalog 92 was published both with quote-only bodies and with the complete
/// model-reference index. Only those two layouts are valid upgrade sources.
pub(super) fn check_optional_format(db: &Connection) -> Result<()> {
    if existing_index(db)? || external_index_columns(db)? == 0 {
        return Ok(());
    }
    Err(RuntimeError::Invalid(
        "incomplete model reference schema; data was preserved".into(),
    ))
}

/// Upgrade only small original metadata, ordered by durable admission facts, never history bodies.
pub(super) fn upgrade(db: &Connection) -> Result<()> {
    // Preserve a compatible already-published index when merging independent Catalog
    // generations. Never reset the reference space, execution numbers or high water.
    if existing_index(db)? {
        return Ok(());
    }
    let columns = external_index_columns(db)?;
    if columns == 1 {
        return Err(RuntimeError::Invalid(
            "incomplete external model reference columns; data was preserved".into(),
        ));
    }
    initialize(db)?;
    // Earlier steps (notably 78 -> 79) use today's external initializer and may
    // already have added both columns in this same transaction. Stored Catalog 92
    // is checked more strictly by check_optional_format before opening a writer.
    if columns == 0 {
        db.execute_batch("ALTER TABLE external_items ADD COLUMN kind TEXT;ALTER TABLE external_items ADD COLUMN tool_status TEXT;")?;
    }
    let conversations: Vec<String> = db
        .prepare("SELECT id FROM external_conversations ORDER BY rowid")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    for conversation in conversations {
        admit_external_agent(db, &conversation)?;
    }
    // Native admissions use their original event cursor. External turns predate a
    // per-turn event, so their own creation time (not the conversation's first event)
    // orders them against external-child accepted_at_ms. Row order breaks same-tick
    // ties deterministically. These are different Agent namespaces.
    let admissions:Vec<(String,String)>=db.prepare("SELECT kind,id FROM (
        SELECT 'delegated' AS kind,d.id AS id,coalesce((SELECT min(cursor) FROM events WHERE subject=d.id AND kind IN ('child.accepted','child.execution_accepted')),json_extract(d.body,'$.cursor'),0) AS admitted,0 AS tie,d.rowid AS position FROM delegated_executions d
        UNION ALL SELECT 'native',r.id,coalesce((SELECT min(cursor) FROM events WHERE subject=r.id AND kind='run.accepted'),0),1,r.rowid FROM runs r JOIN branches b ON b.id=r.branch_id WHERE NOT EXISTS(SELECT 1 FROM delegated_executions d WHERE d.run_id=r.id) AND NOT EXISTS(SELECT 1 FROM context_jobs j WHERE j.run_id=r.id)
        UNION ALL SELECT 'external_child',x.id,coalesce(json_extract(x.body,'$.accepted_at_ms'),0),2,x.rowid FROM external_children x WHERE json_extract(x.body,'$.message_kind') IS NOT 'inform'
        UNION ALL SELECT 'external_turn',t.id,coalesce(json_extract(t.body,'$.createdAt'),0),3,t.rowid FROM external_turns t WHERE NOT EXISTS(SELECT 1 FROM external_children x WHERE json_extract(x.body,'$.turn_id')=t.id OR x.id=t.request_key)) ORDER BY admitted,tie,position")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<std::result::Result<_,_>>()?;
    for (kind, identity) in admissions {
        match kind.as_str() {
            "delegated" => {
                let work = delegated::execution(db, &identity)?;
                admit_delegated(db, &work)?;
                if let Some(receipt) = work.receipt {
                    bind_delegated_run(db, &identity, &receipt.run_id)?;
                }
            }
            "native" => admit_native(db, &record(db, "runs", &identity)?)?,
            "external_child" => {
                admit_external_child(db, &record(db, "external_children", &identity)?)?
            }
            "external_turn" => {
                let turn: Value = record(db, "external_turns", &identity)?;
                admit_external_turn(
                    db,
                    turn["conversationId"].as_str().ok_or_else(|| {
                        RuntimeError::Invalid("external conversation missing".into())
                    })?,
                    &identity,
                    turn["key"].as_str().unwrap_or(""),
                )?;
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}
fn parse(reference: &str) -> Result<(ReferenceKind, u64)> {
    let (prefix, number) = reference.split_once(':').ok_or_else(|| {
        RuntimeError::Invalid("Choose a reference returned by the requested tool".into())
    })?;
    let kind = ReferenceKind::from_prefix(prefix).ok_or_else(|| {
        RuntimeError::Invalid(
            "Unknown reference type; use the reference returned by the tool".into(),
        )
    })?;
    let number = number
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| RuntimeError::Invalid("Invalid reference number".into()))?;
    Ok((kind, number))
}
fn resolve_execution(
    db: &Connection,
    owner_kind: &str,
    owner: &str,
    sequence: u64,
) -> Result<ExecutionReference> {
    let (code,kind,identity):(String,String,String)=db.query_row("SELECT a.agent_code,e.kind,e.identity FROM model_executions e JOIN model_agents a USING(owner_kind,owner_id) WHERE e.owner_kind=?1 AND e.owner_id=?2 AND e.sequence=?3",params![owner_kind,owner,sql_number(sequence)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||RuntimeError::NotFound("Execution reference is no longer available".into()))?;
    let target = match kind.as_str() {
        "delegated" => {
            let execution = delegated::execution(db, &identity)?;
            let relation = delegated::relation(db, &execution.child_operation_id)?;
            ExecutionTarget::Delegated {
                execution_id: identity,
                operation_id: execution.child_operation_id,
                thread_id: relation.child_thread_id,
                branch_id: execution
                    .receipt
                    .as_ref()
                    .map(|r| r.branch_id.clone())
                    .unwrap_or(relation.child_branch_id),
                run_id: execution.receipt.map(|r| r.run_id),
            }
        }
        "native" => {
            let run: Run = record(db, "runs", &identity)?;
            ExecutionTarget::Native {
                run_id: identity,
                thread_id: run.thread_id,
                branch_id: run.branch_id,
            }
        }
        "external_child" => {
            let child: external_children::ExternalChild =
                record(db, "external_children", &identity)?;
            ExecutionTarget::External {
                conversation_id: child.conversation_id,
                turn_id: child.turn_id,
                operation_id: Some(identity),
            }
        }
        "external_turn" => {
            let turn: Value = record(db, "external_turns", &identity)?;
            ExecutionTarget::External {
                conversation_id: turn["conversationId"]
                    .as_str()
                    .ok_or_else(|| RuntimeError::Invalid("external conversation missing".into()))?
                    .into(),
                turn_id: Some(identity),
                operation_id: None,
            }
        }
        _ => {
            return Err(RuntimeError::Invalid(
                "Unknown execution reference type".into(),
            ));
        }
    };
    Ok(ExecutionReference {
        reference: format!("{code}/{sequence}"),
        agent_id: code,
        sequence,
        target,
    })
}
pub(super) fn execution_reference(db: &Connection, identity: &str) -> Result<ExecutionReference> {
    if identity.contains('/') {
        return resolve_execution_reference(db, identity);
    }
    let (kind,owner,sequence):(String,String,u64)=db.query_row("SELECT owner_kind,owner_id,sequence FROM model_execution_aliases WHERE identity=?1 ORDER BY CASE kind WHEN 'delegated' THEN 0 ELSE 1 END LIMIT 1",[identity],|r|Ok((r.get(0)?,r.get(1)?,read_number(r,2)?))).optional()?.ok_or_else(||RuntimeError::NotFound("No original admitted execution for this identity".into()))?;
    resolve_execution(db, &kind, &owner, sequence)
}
pub(super) fn resolve_execution_reference(
    db: &Connection,
    reference: &str,
) -> Result<ExecutionReference> {
    let (code, number) = reference.rsplit_once('/').ok_or_else(|| {
        RuntimeError::Invalid("Select an exact execution reference such as ABCD1234/2".into())
    })?;
    let number = number
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| RuntimeError::Invalid("Invalid execution number".into()))?;
    let (kind, owner): (String, String) = db
        .query_row(
            "SELECT owner_kind,owner_id FROM model_agents WHERE agent_code=?1 COLLATE NOCASE",
            [code],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| RuntimeError::NotFound("Agent reference is unavailable".into()))?;
    resolve_execution(db, &kind, &owner, number)
}
impl Catalog {
    pub fn model_target(
        &self,
        operation_id: &str,
        purpose: &str,
        original: &Value,
    ) -> Result<Option<Value>> {
        let row:Option<(String,String)>=self.db.query_row("SELECT original,target FROM model_bound_targets WHERE operation_id=?1 AND purpose=?2",params![operation_id,purpose],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        match row {
            None => Ok(None),
            Some((before, target)) => {
                if serde_json::from_str::<Value>(&before)? != *original {
                    return Err(RuntimeError::Conflict(
                        "Original target selection changed for an admitted operation".into(),
                    ));
                }
                Ok(Some(serde_json::from_str(&target)?))
            }
        }
    }
    pub fn freeze_model_target(
        &mut self,
        operation_id: &str,
        purpose: &str,
        original: &Value,
        target: &Value,
    ) -> Result<Value> {
        if operation_id.is_empty() || purpose.is_empty() {
            return Err(RuntimeError::Invalid(
                "A fixed target requires its original admission identity".into(),
            ));
        }
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let row:Option<(String,String)>=tx.query_row("SELECT original,target FROM model_bound_targets WHERE operation_id=?1 AND purpose=?2",params![operation_id,purpose],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let result = if let Some((before, target)) = row {
            if serde_json::from_str::<Value>(&before)? != *original {
                return Err(RuntimeError::Conflict(
                    "Original target selection changed for an admitted operation".into(),
                ));
            }
            serde_json::from_str(&target)?
        } else {
            tx.execute(
                "INSERT INTO model_bound_targets VALUES(?1,?2,?3,?4)",
                params![operation_id, purpose, encode(original)?, encode(target)?],
            )?;
            target.clone()
        };
        tx.commit()?;
        Ok(result)
    }
    pub fn model_reference_space(&self) -> Result<String> {
        Ok(self.db.query_row(
            "SELECT space_id FROM model_reference_space WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
    /// Called under the original Catalog owner lock, outside any existing transaction.
    /// Shared captures may allocate this small index without loading or copying resource bodies.
    pub fn register_model_reference(
        &self,
        kind: ReferenceKind,
        owner: &str,
        target: &Value,
        holder: &str,
    ) -> Result<String> {
        if owner.is_empty() || holder.is_empty() || !target.is_object() {
            return Err(RuntimeError::Invalid(
                "A typed reference requires its original owner, fixed object and holder".into(),
            ));
        }
        let tx = rusqlite::Transaction::new_unchecked(
            &self.db,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let target = encode(target)?;
        // Avoid AUTOINCREMENT advancement and writes for an already-held observation.
        let previous: Option<u64> = tx
            .query_row(
                "SELECT id FROM model_references WHERE kind=?1 AND owner=?2 AND target=?3",
                params![kind.prefix(), owner, target],
                |r| read_number(r, 0),
            )
            .optional()?;
        let number = match previous {
            Some(n) => n,
            None => {
                tx.execute(
                    "INSERT INTO model_references(kind,owner,target) VALUES(?1,?2,?3)",
                    params![kind.prefix(), owner, target],
                )?;
                tx.last_insert_rowid() as u64
            }
        };
        tx.execute(
            "INSERT OR IGNORE INTO model_reference_holders VALUES(?1,?2)",
            params![sql_number(number)?, holder],
        )?;
        tx.commit()?;
        Ok(format!("{}:{number}", kind.prefix()))
    }
    pub fn resolve_model_reference(
        &self,
        kind: ReferenceKind,
        reference: &str,
    ) -> Result<ModelReference> {
        let (actual, number) = parse(reference)?;
        if actual != kind {
            return Err(RuntimeError::Invalid(format!(
                "This is a {} reference; this tool needs {}",
                actual.prefix(),
                kind.prefix()
            )));
        }
        let (owner, target): (String, String) = self
            .db
            .query_row(
                "SELECT owner,target FROM model_references WHERE id=?1 AND kind=?2",
                params![sql_number(number)?, kind.prefix()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                RuntimeError::NotFound(
                    "Reference is unavailable or has been retired; read the original object again"
                        .into(),
                )
            })?;
        Ok(ModelReference {
            reference: reference.into(),
            space_id: self.model_reference_space()?,
            kind,
            owner,
            target: serde_json::from_str(&target)?,
        })
    }
    pub fn retain_model_reference(&mut self, reference: &str, holder: &str) -> Result<()> {
        let (kind, number) = parse(reference)?;
        self.resolve_model_reference(kind, reference)?;
        if holder.is_empty() {
            return Err(RuntimeError::Invalid("Reference holder is empty".into()));
        }
        self.db.execute(
            "INSERT OR IGNORE INTO model_reference_holders VALUES(?1,?2)",
            params![sql_number(number)?, holder],
        )?;
        Ok(())
    }
    /// Same-Catalog delivery retains the original mapping. Foreign objects must first
    /// be localized by their typed attachment/material owner; opaque IDs (especially
    /// resource_owner=Local) cannot be safely copied into this Catalog's namespace.
    pub fn import_model_reference(
        &mut self,
        source: &ModelReference,
        holder: &str,
    ) -> Result<String> {
        if source.space_id == self.model_reference_space()? {
            let existing = self.resolve_model_reference(source.kind, &source.reference)?;
            if existing.owner != source.owner || existing.target != source.target {
                return Err(RuntimeError::Conflict(
                    "Reference identity differs from its original object".into(),
                ));
            }
            self.retain_model_reference(&source.reference, holder)?;
            return Ok(source.reference.clone());
        }
        Err(RuntimeError::Invalid("This reference belongs to another Catalog. Transfer the original resource through its attachment or material owner before registering a local reference".into()))
    }
    pub fn execution_reference(&self, identity: &str) -> Result<ExecutionReference> {
        execution_reference(&self.db, identity)
    }
    pub fn resolve_execution_reference(&self, reference: &str) -> Result<ExecutionReference> {
        resolve_execution_reference(&self.db, reference)
    }
    pub fn external_agent_reference(&self, conversation: &str) -> Result<String> {
        self.db
            .query_row(
                "SELECT agent_code FROM model_agents WHERE owner_kind='external' AND owner_id=?1",
                [conversation],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| RuntimeError::NotFound("External Agent has no admitted work".into()))
    }
}
/// Small references never keep resource bytes alive. Retire their holders with the original
/// Catalog records and keep SQLite's allocation high water so an old name can never be reused.
pub(super) fn collect_unheld(
    db: &Connection,
    content: &crate::content::ContentStore,
) -> Result<usize> {
    // The existing publication guard spans reference registration, unlocked content
    // writes and original admission. Do not mistake a future real input holder for
    // an orphan while any preparation is in flight; a later collection retries.
    if content.publication_active() {
        return Ok(0);
    }
    db.execute("DELETE FROM model_reference_holders WHERE NOT EXISTS(SELECT 1 FROM operations WHERE id=holder) AND NOT EXISTS(SELECT 1 FROM runs WHERE id=holder) AND NOT EXISTS(SELECT 1 FROM history WHERE id=holder) AND NOT EXISTS(SELECT 1 FROM input_queue WHERE id=holder) AND NOT EXISTS(SELECT 1 FROM delegated_executions WHERE id=holder) AND NOT EXISTS(SELECT 1 FROM external_turns WHERE id=holder)",[])?;
    db.execute("DELETE FROM model_bound_targets WHERE NOT EXISTS(SELECT 1 FROM operations WHERE id=operation_id) AND NOT EXISTS(SELECT 1 FROM runs WHERE id=operation_id)",[])?;
    db.execute("DELETE FROM model_executions WHERE (kind='native' AND NOT EXISTS(SELECT 1 FROM runs WHERE id=identity)) OR (kind='delegated' AND NOT EXISTS(SELECT 1 FROM delegated_executions WHERE id=identity)) OR (kind='external_turn' AND NOT EXISTS(SELECT 1 FROM external_turns WHERE id=identity)) OR (kind='external_child' AND NOT EXISTS(SELECT 1 FROM external_children WHERE id=identity))",[])?;
    db.execute("DELETE FROM model_execution_aliases WHERE NOT EXISTS(SELECT 1 FROM model_executions e WHERE e.owner_kind=model_execution_aliases.owner_kind AND e.owner_id=model_execution_aliases.owner_id AND e.sequence=model_execution_aliases.sequence)",[])?;
    Ok(db.execute("DELETE FROM model_references WHERE NOT EXISTS(SELECT 1 FROM model_reference_holders WHERE reference_id=model_references.id)",[])?)
}
#[cfg(test)]
#[path = "catalog_model_references_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "catalog_model_reference_upgrade_tests.rs"]
mod upgrade_tests;
