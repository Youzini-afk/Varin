//! Durable product records for independently executing harnesses; no synthetic model Run.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExternalCommand {
    Settings,
    Configure {
        key: String,
        expected_revision: u64,
        value: Value,
    },
    Create {
        key: String,
        id: String,
        configuration_id: String,
        harness: String,
        title: String,
        cwd: String,
        workspace_id: Option<String>,
        parent: Option<Value>,
        private_workspace: Option<bool>,
    },
    List,
    CleanupList,
    Cleaned {
        id: String,
    },
    Read {
        id: String,
        before: Option<u64>,
        limit: Option<u64>,
    },
    Update {
        id: String,
        expected_revision: u64,
        title: Option<String>,
        pinned: Option<bool>,
        archived: Option<bool>,
        deleted: Option<bool>,
    },
    Bind {
        id: String,
        session_id: String,
    },
    Reconnected {
        id: String,
        session_id: String,
    },
    NativeTurn {
        id: String,
        turn_id: String,
        native_id: String,
    },
    Admit {
        id: String,
        key: String,
        input: Value,
    },
    Begin {
        id: String,
        turn_id: String,
    },
    Observe {
        id: String,
        turn_id: String,
        status: String,
        native_id: Option<String>,
        error: Option<String>,
        usage: Option<Value>,
    },
    Item {
        id: String,
        turn_id: String,
        item_id: String,
        content: Value,
    },
    Input {
        id: String,
        turn_id: String,
        original: Option<bool>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("varin-external-{}", Uuid::new_v4())))
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn call(catalog: &mut Catalog, value: Value) -> Result<Value> {
        let command = serde_json::from_value(value)?;
        let prepared = catalog.prepare_external(command).load()?;
        catalog.execute_external(prepared)?.load()
    }
    fn create(c: &mut Catalog, id: &str) {
        call(c,json!({"action":"create","id":id,"key":id,"configurationId":"codex","harness":"codex","title":"Task","cwd":"/workspace"})).unwrap();
    }
    #[test]
    fn external_conversations_preserve_input_receipts_history_and_restart_state() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        create(&mut c, "external:a");
        let input =
            json!({"action":"admit","id":"external:a","key":"first","input":{"text":"中文\nwork"}});
        let first = call(&mut c, input.clone()).unwrap();
        assert_eq!(first, call(&mut c, input).unwrap());
        assert!(
            call(
                &mut c,
                json!({"action":"admit","id":"external:a","key":"first","input":{"text":"changed"}})
            )
            .is_err()
        );
        let turn = first["id"].as_str().unwrap();
        assert_eq!(
            call(
                &mut c,
                json!({"action":"input","id":"external:a","turnId":turn})
            )
            .unwrap()["text"],
            "中文\nwork"
        );
        call(
            &mut c,
            json!({"action":"begin","id":"external:a","turnId":turn}),
        )
        .unwrap();
        call(
            &mut c,
            json!({"action":"observe","id":"external:a","turnId":turn,"status":"running"}),
        )
        .unwrap();
        call(&mut c,json!({"action":"item","id":"external:a","turnId":turn,"itemId":"answer","content":{"id":"answer","turnId":turn,"kind":"assistant","text":"saved answer"}})).unwrap();
        drop(c);
        let mut reopened = Catalog::open(directory.path()).unwrap();
        let read = call(&mut reopened, json!({"action":"read","id":"external:a"})).unwrap();
        assert_eq!(read["turns"][0]["status"], "interrupted");
        assert!(read["conversation"].get("activeTurn").is_none());
        assert_eq!(read["items"][0]["text"], "saved answer");
        assert!(call(&mut reopened,json!({"action":"item","id":"external:a","turnId":turn,"itemId":"late","content":{}})).is_err());
    }
    #[test]
    fn external_conversations_fence_queue_order_and_cross_conversation_observations() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        create(&mut c, "external:a");
        create(&mut c, "external:b");
        let first = call(
            &mut c,
            json!({"action":"admit","id":"external:a","key":"one","input":{"text":"one"}}),
        )
        .unwrap();
        let second = call(
            &mut c,
            json!({"action":"admit","id":"external:a","key":"two","input":{"text":"two"}}),
        )
        .unwrap();
        let a = &first["id"];
        let b = &second["id"];
        assert!(
            call(
                &mut c,
                json!({"action":"begin","id":"external:a","turnId":b})
            )
            .is_err()
        );
        call(
            &mut c,
            json!({"action":"begin","id":"external:a","turnId":a}),
        )
        .unwrap();
        assert!(
            call(
                &mut c,
                json!({"action":"observe","id":"external:b","turnId":a,"status":"completed"})
            )
            .is_err()
        );
        call(
            &mut c,
            json!({"action":"observe","id":"external:a","turnId":a,"status":"completed"}),
        )
        .unwrap();
        assert!(
            call(
                &mut c,
                json!({"action":"observe","id":"external:a","turnId":a,"status":"running"})
            )
            .is_err()
        );
        call(
            &mut c,
            json!({"action":"begin","id":"external:a","turnId":b}),
        )
        .unwrap();
    }
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn terminal(s: &str) -> bool {
    matches!(s, "completed" | "failed" | "cancelled" | "interrupted")
}
fn required(s: &str) -> Result<()> {
    if s.trim().is_empty() {
        Err(RuntimeError::Invalid("external identity is empty".into()))
    } else {
        Ok(())
    }
}
pub(super) fn initialize_new(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE external_settings(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE external_conversations(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE external_turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES external_conversations(id),request_key TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(conversation_id,request_key));
        CREATE TABLE external_items(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES external_conversations(id),turn_id TEXT NOT NULL REFERENCES external_turns(id),native_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(turn_id,native_id));
        CREATE INDEX external_items_conversation ON external_items(conversation_id);
        CREATE TABLE external_commands(id TEXT PRIMARY KEY,intent TEXT NOT NULL,receipt TEXT NOT NULL);
        CREATE TABLE external_children(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE INDEX external_children_pending ON external_children(id) WHERE json_extract(body,'$.receipt_published')=0 OR json_extract(body,'$.resources_released')=0;")?;
    tx.execute(
        "INSERT INTO external_settings VALUES('settings',?1)",
        [encode(
            &json!({"revision":0,"defaultAgent":null,"agents":[]}),
        )?],
    )?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    for sql in [
        "SELECT id,body FROM external_settings",
        "SELECT id,body FROM external_conversations",
        "SELECT id,conversation_id,request_key,body FROM external_turns",
        "SELECT id,conversation_id,turn_id,native_id,body FROM external_items",
        "SELECT id,intent,receipt FROM external_commands",
        "SELECT id,body FROM external_children",
    ] {
        db.prepare(sql)?;
    }
    Ok(())
}
pub struct ExternalPreparation {
    command: ExternalCommand,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedExternalCommand {
    command: ExternalCommand,
    body: Option<Value>,
    intent: String,
    _publication: crate::content::ContentPublication,
}
impl ExternalPreparation {
    pub fn load(self) -> Result<PreparedExternalCommand> {
        use sha2::{Digest, Sha256};
        let intent = hex::encode(Sha256::digest(serde_json::to_vec(&self.command)?));
        let body = match &self.command {
            ExternalCommand::Admit { input, .. } => Some(self.content.save(input)?),
            ExternalCommand::Item { content, .. } => Some(self.content.save(content)?),
            _ => None,
        };
        Ok(PreparedExternalCommand {
            command: self.command,
            body,
            intent,
            _publication: self.publication,
        })
    }
}
pub struct ExternalRead {
    result: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ExternalRead {
    pub fn load(mut self) -> Result<Value> {
        if let Some(items) = self.result.get_mut("items").and_then(Value::as_array_mut) {
            for item in items {
                *item = self.content.load(item)?;
            }
        }
        if let Some(reference) = self.result.get("externalInputRef") {
            let mut input = self.content.load(reference)?;
            let mut texts = Vec::new();
            let mut messages = Vec::new();
            for reference in self.result["externalInforms"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let message = self.content.load(reference)?;
                if let Some(text) = message["text"].as_str() {
                    texts.push(text.to_owned());
                }
                messages.push(message);
            }
            if !messages.is_empty() {
                texts.push(input["text"].as_str().unwrap_or("").to_owned());
                input["task"] = input
                    .get("task")
                    .cloned()
                    .unwrap_or_else(|| input["text"].clone());
                input["text"] = json!(texts.join("\n\n"));
                input["messages"] = json!(messages);
            }
            return Ok(input);
        }
        Ok(self.result)
    }
}
fn conversation(db: &Connection, id: &str) -> Result<Value> {
    let v: Value = record(db, "external_conversations", id)?;
    if v["deleted"] == true {
        return Err(RuntimeError::NotFound(
            "external conversation was deleted".into(),
        ));
    }
    Ok(v)
}
fn turn(db: &Connection, id: &str, turn_id: &str) -> Result<Value> {
    let v: Value = record(db, "external_turns", turn_id)?;
    if v["conversationId"] != id {
        return Err(RuntimeError::Invalid(
            "external turn belongs to another conversation".into(),
        ));
    }
    Ok(v)
}
pub(super) fn touch(tx: &Transaction<'_>, v: &mut Value) -> Result<()> {
    v["revision"] = json!(v["revision"].as_u64().unwrap_or(0) + 1);
    v["updatedAt"] = json!(now());
    let id = v["id"].as_str().unwrap();
    put(tx, "external_conversations", id, v)?;
    event(
        tx,
        id,
        v["revision"].as_u64().unwrap(),
        "external.changed",
        json!({"conversationId":id}),
    )?;
    Ok(())
}
impl Catalog {
    pub fn prepare_external(&self, command: ExternalCommand) -> ExternalPreparation {
        ExternalPreparation {
            command,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    pub fn execute_external(&mut self, p: PreparedExternalCommand) -> Result<ExternalRead> {
        let tx = self.db.transaction()?;
        let key = match &p.command {
            ExternalCommand::Configure { key, .. } => Some(format!("configure:{key}")),
            ExternalCommand::Create { key, .. } => Some(format!("create:{key}")),
            ExternalCommand::Admit { id, key, .. } => Some(format!("admit:{id}:{key}")),
            _ => None,
        };
        if let Some(key) = &key {
            let old: Option<(String, String)> = tx
                .query_row(
                    "SELECT intent,receipt FROM external_commands WHERE id=?1",
                    [key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((intent, body)) = old {
                if intent != p.intent {
                    return Err(RuntimeError::Conflict(
                        "external command key was reused with different input".into(),
                    ));
                }
                return Ok(ExternalRead {
                    result: serde_json::from_str(&body)?,
                    content: self.content.clone(),
                    _publication: p._publication,
                });
            }
        }
        let result = match p.command {
            ExternalCommand::Settings => record(&tx, "external_settings", "settings")?,
            ExternalCommand::Configure {
                expected_revision,
                mut value,
                ..
            } => {
                let old: Value = record(&tx, "external_settings", "settings")?;
                if old["revision"].as_u64() != Some(expected_revision) {
                    return Err(RuntimeError::Conflict(
                        "external Agent settings changed".into(),
                    ));
                }
                if !value.is_object() || !value["agents"].is_array() {
                    return Err(RuntimeError::Invalid(
                        "invalid external Agent settings".into(),
                    ));
                }
                value["revision"] = json!(expected_revision + 1);
                put(&tx, "external_settings", "settings", &value)?;
                event(
                    &tx,
                    "external-settings",
                    expected_revision + 1,
                    "external.settings",
                    Value::Null,
                )?;
                value
            }
            ExternalCommand::Create {
                id,
                configuration_id,
                harness,
                title,
                cwd,
                workspace_id,
                parent,
                private_workspace,
                ..
            } => {
                for s in [&id, &configuration_id, &title, &cwd] {
                    required(s)?;
                }
                if !matches!(harness.as_str(), "codex" | "claude" | "pi" | "acp") {
                    return Err(RuntimeError::Invalid("unsupported external harness".into()));
                }
                let mut v = json!({"id":id,"configurationId":configuration_id,"harness":harness,"title":title,"cwd":cwd,"revision":1,"createdAt":now(),"updatedAt":now(),"archived":false,"pinned":false,"deleted":false});
                if let Some(workspace) = workspace_id {
                    v["workspaceId"] = json!(workspace);
                }
                if let Some(parent) = parent {
                    v["parent"] = parent;
                }
                if private_workspace == Some(true) {
                    v["privateWorkspace"] = json!(true);
                }
                tx.execute(
                    "INSERT INTO external_conversations VALUES(?1,?2)",
                    params![id, encode(&v)?],
                )?;
                event(
                    &tx,
                    &id,
                    1,
                    "external.created",
                    json!({"conversationId":id}),
                )?;
                v
            }
            ExternalCommand::List => {
                let mut s=tx.prepare("SELECT body FROM external_conversations WHERE json_extract(body,'$.deleted')=0 ORDER BY json_extract(body,'$.updatedAt') DESC")?;
                let values = s
                    .query_map([], |r| r.get::<_, String>(0))?
                    .map(|row| Ok(serde_json::from_str::<Value>(&row?)?))
                    .collect::<Result<Vec<_>>>()?;
                json!(values)
            }
            ExternalCommand::CleanupList => {
                let mut s=tx.prepare("SELECT body FROM external_conversations WHERE json_extract(body,'$.deleted')=1 AND json_extract(body,'$.cleanupPending')=1")?;
                let rows = s
                    .query_map([], |r| r.get::<_, String>(0))?
                    .map(|v| Ok(serde_json::from_str::<Value>(&v?)?))
                    .collect::<Result<Vec<_>>>()?;
                json!(rows)
            }
            ExternalCommand::Cleaned { id } => {
                let mut v: Value = record(&tx, "external_conversations", &id)?;
                if v["deleted"] != true {
                    return Err(RuntimeError::Invalid(
                        "external conversation is not deleted".into(),
                    ));
                }
                v["cleanupPending"] = json!(false);
                touch(&tx, &mut v)?;
                tx.execute("UPDATE external_children SET body=json_set(body,'$.input_ref',NULL,'$.source',NULL) WHERE json_extract(body,'$.conversation_id')=?1 AND json_extract(body,'$.report') IS NOT NULL",[&id])?;
                v
            }
            ExternalCommand::Read { id, before, limit } => {
                let v = conversation(&tx, &id)?;
                let mut s = tx.prepare(
                    "SELECT body FROM external_turns WHERE conversation_id=?1 ORDER BY rowid",
                )?;
                let turns = s
                    .query_map([&id], |r| r.get::<_, String>(0))?
                    .map(|row| {
                        let mut v: Value = serde_json::from_str(&row?)?;
                        v.as_object_mut().unwrap().remove("inputRef");
                        v.as_object_mut().unwrap().remove("epoch");
                        Ok(v)
                    })
                    .collect::<Result<Vec<_>>>()?;
                let limit = limit.unwrap_or(100);
                if limit == 0 {
                    return Err(RuntimeError::Invalid("page length must be positive".into()));
                }
                let mut s=tx.prepare("SELECT rowid,body FROM external_items WHERE conversation_id=?1 AND (?2 IS NULL OR rowid<?2) ORDER BY rowid DESC LIMIT ?3")?;
                let mut items = s
                    .query_map(
                        params![id, before.map(sql_number).transpose()?, sql_number(limit)?],
                        |r| Ok((read_number(r, 0)?, r.get::<_, String>(1)?)),
                    )?
                    .map(|row| {
                        let (cursor, body) = row?;
                        Ok((cursor, serde_json::from_str::<Value>(&body)?))
                    })
                    .collect::<Result<Vec<_>>>()?;
                let previous = if items.len() as u64 == limit {
                    items.last().map(|v| v.0)
                } else {
                    None
                };
                items.reverse();
                json!({"conversation":v,"turns":turns,"items":items.into_iter().map(|v|v.1).collect::<Vec<_>>(),"previous":previous})
            }
            ExternalCommand::Update {
                id,
                expected_revision,
                title,
                pinned,
                archived,
                deleted,
            } => {
                let mut v = conversation(&tx, &id)?;
                if v["revision"].as_u64() != Some(expected_revision) {
                    return Err(RuntimeError::Conflict(
                        "external conversation changed".into(),
                    ));
                }
                if deleted == Some(true) && v.get("activeTurn").is_some() {
                    return Err(RuntimeError::Conflict(
                        "stop the active external turn before deleting its conversation".into(),
                    ));
                }
                if deleted == Some(true) {
                    for mut child in read_all::<super::external_children::ExternalChild>(
                        &tx,
                        "external_children",
                    )? {
                        if child.conversation_id != id
                            || child.message_kind != Some(MessageKind::Inform)
                            || child.turn_id.is_some()
                            || child.report.is_some()
                        {
                            continue;
                        }
                        child.state = "cancelled".into();
                        child.report = Some(
                            json!({"conversationId":id,"status":"cancelled","items":[],"detail":"The external conversation was deleted before this passive message was consumed."}),
                        );
                        child.receipt_published = true;
                        child.resources_released = true;
                        child.finished_at_ms = Some(now());
                        child.revision += 1;
                        put(&tx, "external_children", &child.operation_id, &child)?;
                        event(
                            &tx,
                            &child.operation_id,
                            child.revision,
                            "external.child_settled",
                            Value::Null,
                        )?;
                    }
                }
                if deleted==Some(true) && tx.query_row("SELECT EXISTS(SELECT 1 FROM external_children WHERE json_extract(body,'$.conversation_id')=?1 AND json_extract(body,'$.report') IS NULL)",[&id],|r|r.get::<_,bool>(0))? {
                    return Err(RuntimeError::Conflict("wait for the original external delegation to settle before deleting its conversation".into()));
                }
                if let Some(title) = title {
                    required(&title)?;
                    v["title"] = json!(title);
                }
                if let Some(pinned) = pinned {
                    v["pinned"] = json!(pinned);
                }
                if let Some(archived) = archived {
                    v["archived"] = json!(archived);
                }
                if let Some(deleted) = deleted {
                    v["deleted"] = json!(deleted);
                    if deleted {
                        v["cleanupPending"] = json!(true);
                        tx.execute("DELETE FROM external_items WHERE conversation_id=?1", [&id])?;
                        tx.execute("DELETE FROM external_turns WHERE conversation_id=?1", [&id])?;
                        tx.execute("DELETE FROM external_commands WHERE json_extract(receipt,'$.conversationId')=?1 OR json_extract(receipt,'$.id')=?1",[&id])?;
                    }
                }
                touch(&tx, &mut v)?;
                v
            }
            ExternalCommand::Bind { id, session_id } => {
                required(&session_id)?;
                let mut v = conversation(&tx, &id)?;
                if v.get("sessionId").is_some_and(|old| old != &session_id) {
                    return Err(RuntimeError::Conflict(
                        "external session identity changed".into(),
                    ));
                }
                v["sessionId"] = json!(session_id);
                touch(&tx, &mut v)?;
                v
            }
            ExternalCommand::Reconnected { id, session_id } => {
                let mut v = conversation(&tx, &id)?;
                if v["sessionId"] != session_id {
                    return Err(RuntimeError::Conflict(
                        "external session identity changed".into(),
                    ));
                }
                v.as_object_mut().unwrap().remove("needsReview");
                touch(&tx, &mut v)?;
                v
            }
            ExternalCommand::NativeTurn {
                id,
                turn_id,
                native_id,
            } => {
                let mut t = turn(&tx, &id, &turn_id)?;
                if t["epoch"].as_u64() != Some(self.epoch)
                    || terminal(t["status"].as_str().unwrap_or(""))
                {
                    return Err(RuntimeError::Conflict("external turn already ended".into()));
                }
                if t.get("nativeId").is_some_and(|value| value != &native_id) {
                    return Err(RuntimeError::Conflict(
                        "external native turn identity changed".into(),
                    ));
                }
                t["nativeId"] = json!(native_id);
                put(&tx, "external_turns", &turn_id, &t)?;
                t
            }
            ExternalCommand::Admit { id, key, .. } => {
                required(&key)?;
                let mut v = conversation(&tx, &id)?;
                let turn_id = format!("external-turn:{}", Uuid::new_v4());
                let turn = json!({"id":turn_id,"conversationId":id,"key":key,"status":"queued","inputRef":p.body.unwrap(),"createdAt":now(),"updatedAt":now(),"epoch":self.epoch});
                tx.execute(
                    "INSERT INTO external_turns VALUES(?1,?2,?3,?4)",
                    params![turn_id, id, key, encode(&turn)?],
                )?;
                touch(&tx, &mut v)?;
                turn
            }
            ExternalCommand::Begin { id, turn_id } => {
                let mut v = conversation(&tx, &id)?;
                let mut t = turn(&tx, &id, &turn_id)?;
                if t["status"] != "queued" || v.get("activeTurn").is_some() {
                    return Err(RuntimeError::Conflict(
                        "external turn is already active or no longer queued".into(),
                    ));
                }
                let first:String=tx.query_row("SELECT id FROM external_turns WHERE conversation_id=?1 AND json_extract(body,'$.status')='queued' ORDER BY rowid LIMIT 1",[&id],|r|r.get(0))?;
                if first != turn_id {
                    return Err(RuntimeError::Conflict(
                        "an earlier external input is queued".into(),
                    ));
                }
                t["status"] = json!("preparing");
                t["epoch"] = json!(self.epoch);
                t["updatedAt"] = json!(now());
                put(&tx, "external_turns", &turn_id, &t)?;
                v["activeTurn"] = json!(turn_id);
                tx.execute("UPDATE external_children SET body=json_set(body,'$.turn_id',?2,'$.state','queued','$.revision',json_extract(body,'$.revision')+1) WHERE json_extract(body,'$.conversation_id')=?1 AND json_extract(body,'$.message_kind')='inform' AND json_extract(body,'$.turn_id') IS NULL AND json_extract(body,'$.report') IS NULL AND json_extract(body,'$.cancel_requested')=0",params![id,turn_id])?;
                touch(&tx, &mut v)?;
                t
            }
            ExternalCommand::Observe {
                id,
                turn_id,
                status,
                native_id,
                error,
                usage,
            } => {
                let mut v = conversation(&tx, &id)?;
                let mut t = turn(&tx, &id, &turn_id)?;
                let old = t["status"].as_str().unwrap_or("");
                if !terminal(&status)
                    && !matches!(status.as_str(), "running" | "waiting_user" | "stopping")
                {
                    return Err(RuntimeError::Invalid("invalid external observation".into()));
                }
                if terminal(old) || t["epoch"].as_u64() != Some(self.epoch) {
                    return Err(RuntimeError::Conflict(
                        "external observation belongs to a settled or stale turn".into(),
                    ));
                }
                if old == "queued" && status != "cancelled" {
                    return Err(RuntimeError::Conflict("external turn was not begun".into()));
                }
                if old == "stopping" && !terminal(&status) && status != "stopping" {
                    return Err(RuntimeError::Conflict("external turn is stopping".into()));
                }
                t["status"] = json!(status);
                t["updatedAt"] = json!(now());
                if let Some(n) = native_id {
                    t["nativeId"] = json!(n);
                }
                if let Some(e) = error {
                    t["error"] = json!(e);
                }
                if let Some(u) = usage {
                    t["usage"] = u;
                }
                if terminal(&status) && v["activeTurn"] == turn_id {
                    v.as_object_mut().unwrap().remove("activeTurn");
                }
                if status == "interrupted" {
                    v["needsReview"] = json!(true);
                }
                put(&tx, "external_turns", &turn_id, &t)?;
                touch(&tx, &mut v)?;
                t
            }
            ExternalCommand::Item {
                id,
                turn_id,
                item_id,
                ..
            } => {
                required(&item_id)?;
                let mut v = conversation(&tx, &id)?;
                let t = turn(&tx, &id, &turn_id)?;
                if t["epoch"].as_u64() != Some(self.epoch)
                    || terminal(t["status"].as_str().unwrap_or(""))
                {
                    return Err(RuntimeError::Conflict(
                        "external item belongs to a settled or stale turn".into(),
                    ));
                }
                tx.execute("INSERT INTO external_items(id,conversation_id,turn_id,native_id,body) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(turn_id,native_id) DO UPDATE SET body=excluded.body",params![format!("{turn_id}:{item_id}"),id,turn_id,item_id,encode(&p.body.unwrap())?])?;
                touch(&tx, &mut v)?;
                Value::Null
            }
            ExternalCommand::Input {
                id,
                turn_id,
                original,
            } => {
                conversation(&tx, &id)?;
                let mut s=tx.prepare("SELECT json_extract(body,'$.input_ref') FROM external_children WHERE json_extract(body,'$.conversation_id')=?1 AND json_extract(body,'$.turn_id')=?2 AND json_extract(body,'$.message_kind')='inform' ORDER BY rowid")?;
                let informs = if original == Some(true) {
                    vec![]
                } else {
                    s.query_map(params![id, turn_id], |r| r.get::<_, String>(0))?
                        .map(|v| Ok(serde_json::from_str::<Value>(&v?)?))
                        .collect::<Result<Vec<_>>>()?
                };
                json!({"externalInputRef":turn(&tx,&id,&turn_id)?["inputRef"],"externalInforms":informs})
            }
        };
        if let Some(key) = key {
            tx.execute(
                "INSERT INTO external_commands VALUES(?1,?2,?3)",
                params![key, p.intent, encode(&result)?],
            )?;
        }
        tx.commit()?;
        Ok(ExternalRead {
            result,
            content: self.content.clone(),
            _publication: p._publication,
        })
    }
    pub(super) fn recover_external(&mut self) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute("UPDATE external_turns SET body=json_set(body,'$.status','interrupted','$.error','The Host connection ended before this turn was confirmed complete. Reconnect to inspect the original session.') WHERE json_extract(body,'$.status') IN ('preparing','running','waiting_user','stopping')",[])?;
        tx.execute("UPDATE external_conversations SET body=json_set(json_remove(body,'$.activeTurn'),'$.needsReview',json('true')) WHERE json_type(body,'$.activeTurn') IS NOT NULL",[])?;
        tx.commit()?;
        Ok(())
    }
}
