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
    /// Host-observed metadata, separate from user configuration and its revision.
    InspectCapabilities {
        configuration_id: String,
        configuration: Value,
    },
    ClaimCapabilities {
        configuration_id: String,
        configuration: Value,
    },
    CacheCapabilities {
        configuration_id: String,
        configuration: Value,
        generation: u64,
        /// A detection invalidation compares this original generation, then fences old writers.
        invalidate: Option<bool>,
        agent_version: Option<String>,
        capabilities: Option<Value>,
    },
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
        native_workspace: Option<super::launches::SourceSelection>,
        parent: Option<Value>,
        private_workspace: Option<bool>,
        #[serde(default, deserialize_with = "principals::optional_principal", skip_serializing_if = "Option::is_none")]
        principal_id: Option<Option<String>>,
    },
    List,
    ArrangementPending,
    Defer { id: String, turn_id: String, reason: String },
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
    fn external_capability_cache_preserves_defaults_and_fences_launch_and_version_changes() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        let mut agent = json!({"id":"codex","name":"Codex","harness":"codex","enabled":true,
            "command":"codex","args":[],"defaults":{"model":"chosen","thinking":"high"}});
        let configure = |agent: &Value, revision: u64| json!({"action":"configure","key":format!("settings-{revision}"),
            "expectedRevision":revision,"value":{"agents":[agent],"defaultAgent":"codex"}});
        call(&mut c, configure(&agent, 0)).unwrap();
        let configuration = capability_configuration(&agent);
        let claim = |catalog: &mut Catalog| call(catalog, json!({"action":"claim_capabilities","configurationId":"codex","configuration":configuration})).unwrap().as_u64().unwrap();
        let cache = |version: &str, generation: u64| json!({"action":"cache_capabilities","configurationId":"codex",
            "configuration":configuration,"agentVersion":version,"generation":generation,
            "capabilities":{"models":[{"id":version,"name":version}],"images":true,"resume":true,"steering":false}});
        let first_generation = claim(&mut c);
        call(&mut c, cache("v1", first_generation)).unwrap();
        let settings = call(&mut c, json!({"action":"settings"})).unwrap();
        assert_eq!(settings["revision"], 1);
        assert_eq!(settings["capabilityCache"]["codex"]["agentVersion"], "v1");
        assert!(settings["capabilityCache"]["codex"].get("configuration").is_none());
        assert!(settings["capabilityCache"]["codex"].get("generation").is_none());
        agent["defaults"]["model"] = json!("changed-default");
        agent["name"] = json!("Renamed");
        call(&mut c, configure(&agent, 1)).unwrap();
        drop(c);
        let mut c = Catalog::open(directory.path()).unwrap();
        let settings = call(&mut c, json!({"action":"settings"})).unwrap();
        assert_eq!(settings["agents"][0]["defaults"]["model"], "changed-default");
        assert_eq!(settings["capabilityCache"]["codex"]["agentVersion"], "v1");
        assert_eq!(call(&mut c, json!({"action":"inspect_capabilities","configurationId":"codex",
            "configuration":configuration})).unwrap()["generation"], first_generation);
        let second_generation = claim(&mut c);
        assert!(second_generation > first_generation);
        call(&mut c, cache("v2", second_generation)).unwrap();
        call(&mut c, json!({"action":"cache_capabilities","configurationId":"codex",
            "configuration":configuration,"generation":second_generation,"agentVersion":"v2"})).unwrap();
        // A known-version metadata-query failure retains its earlier real catalog.
        assert_eq!(call(&mut c, json!({"action":"settings"})).unwrap()["capabilityCache"]["codex"]["agentVersion"], "v2");
        call(&mut c, cache("v1", first_generation)).unwrap();
        assert_eq!(call(&mut c, json!({"action":"settings"})).unwrap()["capabilityCache"]["codex"]["agentVersion"], "v2");
        let invalidation_generation = claim(&mut c);
        call(&mut c, json!({"action":"cache_capabilities","configurationId":"codex",
            "configuration":configuration,"generation":invalidation_generation})).unwrap();
        call(&mut c, cache("v2", second_generation)).unwrap();
        assert_eq!(call(&mut c, json!({"action":"settings"})).unwrap()["capabilityCache"], json!({}));
        let third_generation = claim(&mut c);
        call(&mut c, cache("v3", third_generation)).unwrap();
        agent["args"] = json!(["--new-launch"]);
        call(&mut c, configure(&agent, 2)).unwrap();
        call(&mut c, cache("v3", third_generation)).unwrap();
        assert_eq!(call(&mut c, json!({"action":"settings"})).unwrap()["capabilityCache"], json!({}));
    }
    #[test]
    fn external_detection_invalidates_only_its_original_capability_generation() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        let agent = json!({"id":"codex","harness":"codex","command":"codex","args":[]});
        let configuration = capability_configuration(&agent);
        call(&mut c, json!({"action":"configure","key":"settings","expectedRevision":0,
            "value":{"agents":[agent],"defaultAgent":null}})).unwrap();
        let inspect = json!({"action":"inspect_capabilities","configurationId":"codex","configuration":configuration});
        assert_eq!(call(&mut c, inspect.clone()).unwrap(), Value::Null);
        let claim = json!({"action":"claim_capabilities","configurationId":"codex","configuration":configuration});
        let old = call(&mut c, claim.clone()).unwrap();
        // The initial claim itself must be durable before any capability write.
        assert_eq!(call(&mut c, inspect.clone()).unwrap()["generation"], old);
        let cache = |generation: &Value, version: &str| json!({"action":"cache_capabilities","configurationId":"codex",
            "configuration":configuration,"generation":generation,"agentVersion":version,
            "capabilities":{"models":[{"id":version,"name":version}],"resume":true,"images":false,"steering":false}});
        call(&mut c, cache(&old, "v1")).unwrap();
        let observed = call(&mut c, inspect.clone()).unwrap();
        assert_eq!(observed["generation"], old);
        // Looking at a same-version catalog is read-only and does not fence live updates.
        call(&mut c, inspect.clone()).unwrap();
        call(&mut c, cache(&old, "v1")).unwrap();
        assert_eq!(call(&mut c, inspect.clone()).unwrap()["generation"], old);
        let latest = call(&mut c, claim.clone()).unwrap();
        call(&mut c, cache(&latest, "v2")).unwrap();
        let invalidate = |generation: &Value| json!({"action":"cache_capabilities","configurationId":"codex",
            "configuration":configuration,"generation":generation,"invalidate":true});
        // A slow old detection returns after the newer connection has populated its catalog.
        call(&mut c, invalidate(&observed["generation"])).unwrap();
        assert_eq!(call(&mut c, inspect.clone()).unwrap()["generation"], latest);
        call(&mut c, cache(&latest, "v2")).unwrap();
        assert_eq!(call(&mut c, json!({"action":"settings"})).unwrap()["capabilityCache"]["codex"]["agentVersion"], "v2");
        // A current failed/changed detection clears the catalog and also fences its old writer.
        call(&mut c, invalidate(&latest)).unwrap();
        call(&mut c, cache(&latest, "v2")).unwrap();
        assert_eq!(call(&mut c, json!({"action":"settings"})).unwrap()["capabilityCache"], json!({}));
        assert!(call(&mut c, inspect).unwrap()["generation"].as_u64().unwrap() > latest.as_u64().unwrap());
    }
    #[test]
    fn external_defaults_do_not_reinterpret_admitted_input() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        create(&mut c, "external:defaults");
        let receipt = call(&mut c, json!({"action":"admit","id":"external:defaults","key":"first",
            "input":{"text":"original","model":"frozen"}})).unwrap();
        call(&mut c, json!({"action":"configure","key":"settings","expectedRevision":0,"value":{
            "agents":[{"id":"codex","harness":"codex","command":"codex","args":[],
                "defaults":{"model":"new-default","mode":"plan"}}],"defaultAgent":"codex"}})).unwrap();
        assert_eq!(call(&mut c, json!({"action":"input","id":"external:defaults","turnId":receipt["id"]})).unwrap(),
            json!({"text":"original","model":"frozen"}));
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
    #[test]
    fn external_completion_cannot_replace_the_original_native_turn_identity() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        create(&mut c, "external:a");
        let admitted = call(&mut c, json!({"action":"admit","id":"external:a","key":"input","input":{"text":"work"}})).unwrap();
        let turn = &admitted["id"];
        call(&mut c, json!({"action":"begin","id":"external:a","turnId":turn})).unwrap();
        call(&mut c, json!({"action":"native_turn","id":"external:a","turnId":turn,"nativeId":"native-current"})).unwrap();
        assert!(call(&mut c, json!({"action":"observe","id":"external:a","turnId":turn,"status":"completed","nativeId":"native-stale"})).is_err());
        let snapshot = call(&mut c, json!({"action":"read","id":"external:a"})).unwrap();
        assert_eq!(snapshot["turns"][0]["nativeId"], "native-current");
        assert_eq!(snapshot["conversation"]["activeTurn"], *turn);
        call(&mut c, json!({"action":"observe","id":"external:a","turnId":turn,"status":"completed","nativeId":"native-current"})).unwrap();
    }

    #[test]
    fn external_attachment_only_input_is_fixed_across_retry_and_restart() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        create(&mut c, "external:files");
        let attachment = json!({"ref":"attachment:fixed","filename":"raw.bin","mimeType":"application/octet-stream","byteLength":4});
        let input = json!({"action":"admit","id":"external:files","key":"files","input":{"text":"","attachments":[attachment],"_attachmentSelections":[{"path":"raw.bin"}]}});
        let receipt = call(&mut c, input.clone()).unwrap();
        assert_eq!(receipt, call(&mut c, input.clone()).unwrap());
        drop(c);
        let mut c = Catalog::open(directory.path()).unwrap();
        assert_eq!(receipt, call(&mut c, input).unwrap());
        let restored = call(&mut c, json!({"action":"input","id":"external:files","turnId":receipt["id"]})).unwrap();
        assert_eq!(restored["attachments"][0], attachment);
        assert!(call(&mut c, json!({"action":"admit","id":"external:files","key":"files","input":{"text":"","attachments":[{"ref":"attachment:other","filename":"raw.bin","mimeType":"application/octet-stream","byteLength":4}]}})).is_err());
        assert_eq!(call(&mut c, json!({"action":"read","id":"external:files"})).unwrap()["turns"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn external_incomplete_attachment_never_admits_the_text_half_of_a_message() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        create(&mut c, "external:files");
        assert!(call(&mut c, json!({"action":"admit","id":"external:files","key":"bad","input":{"text":"Do not deliver without file","attachments":[{"ref":"attachment:missing"}]}})).is_err());
        assert!(call(&mut c, json!({"action":"read","id":"external:files"})).unwrap()["turns"].as_array().unwrap().is_empty());
    }

}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(super) fn terminal(s: &str) -> bool {
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
            ExternalCommand::Admit { input, .. } => {
                let files: Vec<super::attachments::Attachment> = input.get("attachments").cloned()
                    .map(serde_json::from_value).transpose()?.unwrap_or_default();
                for file in &files { file.validate()?; }
                if input.get("text").and_then(Value::as_str).is_none_or(|text| text.trim().is_empty())
                    && input.get("images").and_then(Value::as_array).is_none_or(Vec::is_empty)
                    && files.is_empty() {
                    return Err(RuntimeError::Invalid("external input requires text, an image or an attachment".into()));
                }
                Some(self.content.save(input)?)
            },
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
            let original = self.content.load(reference)?;
            let mut inputs = Vec::new();
            for reference in self.result["externalInforms"].as_array().into_iter().flatten() {
                inputs.push(self.content.load(reference)?);
            }
            let primary = inputs.len();
            inputs.push(original);
            for reference in self.result["externalTrailingInforms"].as_array().into_iter().flatten() {
                inputs.push(self.content.load(reference)?);
            }
            if self.result["projectEventInputs"] == true {
                followups::external::project_inputs(&self.content, &mut inputs)?;
            }
            let mut input = inputs[primary].clone();
            let mut texts = Vec::new();
            let mut messages = Vec::new();
            let mut images = Vec::new();
            for (index, message) in inputs.into_iter().enumerate() {
                if let Some(text) = message["text"].as_str() {
                    texts.push(text.to_owned());
                }
                if let Some(media)=message["images"].as_array() {images.extend(media.iter().cloned());}
                if index != primary { messages.push(message); }
            }
            if !messages.is_empty() {
                input["task"] = input
                    .get("task")
                    .cloned()
                    .unwrap_or_else(|| input["text"].clone());
                input["text"] = json!(texts.join("\n\n"));
                input["messages"] = json!(messages);
                if !images.is_empty() {
                    input["images"]=json!(images);
                }
            }
            return Ok(input);
        }
        Ok(self.result)
    }
}
fn capability_configuration(agent: &Value) -> Value {
    json!({"harness":agent["harness"],"command":agent["command"],"args":agent["args"]})
}
fn capability_cache(db: &Connection) -> Result<Value> {
    let body: Option<String> = db.query_row("SELECT body FROM external_settings WHERE id='capabilities'", [], |row| row.get(0)).optional()?;
    let value: Value = body.map(|body| serde_json::from_str(&body)).transpose()?.unwrap_or_else(|| json!({}));
    if !value.is_object() { return Err(RuntimeError::Invalid("invalid external capability cache".into())); }
    Ok(value)
}
/// These additive metadata rows may not exist in an already-opened Catalog. The
/// general `put` helper only updates existing records and must not be used here.
fn save_capability_metadata<T: Serialize>(tx: &Transaction<'_>, key: &str, value: &T) -> Result<()> {
    tx.execute(
        "INSERT INTO external_settings(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        params![key, encode(value)?],
    )?;
    Ok(())
}
fn next_capability_generation(tx: &Transaction<'_>) -> Result<u64> {
    let previous: Option<String> = tx.query_row("SELECT body FROM external_settings WHERE id='capability_sequence'", [], |row| row.get(0)).optional()?;
    let previous: u64 = previous.map(|body| serde_json::from_str(&body)).transpose()?.unwrap_or(0);
    let generation = previous.checked_add(1).ok_or_else(|| RuntimeError::Invalid("external capability sequence exhausted".into()))?;
    save_capability_metadata(tx, "capability_sequence", &generation)?;
    Ok(generation)
}
fn external_settings(db: &Connection) -> Result<Value> {
    let mut settings: Value = record(db, "external_settings", "settings")?;
    let cache = capability_cache(db)?;
    let mut visible = serde_json::Map::new();
    for agent in settings["agents"].as_array().into_iter().flatten() {
        let Some(id) = agent["id"].as_str() else { continue };
        let entry = &cache[id];
        if entry["configuration"] == capability_configuration(agent) && entry["capabilities"].is_object()
            && entry["agentVersion"].as_str().is_some_and(|version| !version.is_empty()) {
            let mut entry = entry.clone();
            entry.as_object_mut().unwrap().remove("configuration");
            entry.as_object_mut().unwrap().remove("generation");
            visible.insert(id.to_owned(), entry);
        }
    }
    settings["capabilityCache"] = Value::Object(visible);
    Ok(settings)
}
pub(super) fn conversation(db: &Connection, id: &str) -> Result<Value> {
    let v: Value = record(db, "external_conversations", id)?;
    if v["deleted"] == true {
        return Err(RuntimeError::NotFound(
            "external conversation was deleted".into(),
        ));
    }
    Ok(v)
}
pub(super) fn turn(db: &Connection, id: &str, turn_id: &str) -> Result<Value> {
    let v: Value = record(db, "external_turns", turn_id)?;
    if v["conversationId"] != id {
        return Err(RuntimeError::Invalid(
            "external turn belongs to another conversation".into(),
        ));
    }
    Ok(v)
}
/// Shared short admission used by direct sends and durable arrangements. Content is already stored.
pub(super) fn admit_turn(tx: &Transaction<'_>, id: &str, key: &str, input_ref: &Value, epoch: u64) -> Result<Value> {
    required(key)?;
    let old: Option<String> = tx.query_row("SELECT body FROM external_turns WHERE conversation_id=?1 AND request_key=?2",params![id,key],|r|r.get(0)).optional()?;
    if let Some(raw)=old {
        let turn:Value=serde_json::from_str(&raw)?;
        if turn["inputRef"] != *input_ref {return Err(RuntimeError::Conflict("external input key changed".into()));}
        return Ok(turn);
    }
    let mut c=conversation(tx,id)?;
    let turn_id=format!("external-turn:{}",Uuid::new_v4());
    let turn=json!({"id":turn_id,"conversationId":id,"key":key,"status":"queued","inputRef":input_ref,"createdAt":now(),"updatedAt":now(),"epoch":epoch});
    tx.execute("INSERT INTO external_turns VALUES(?1,?2,?3,?4)",params![turn_id,id,key,encode(&turn)?])?;
    touch(tx,&mut c)?;
    Ok(turn)
}
pub(super) fn assign_legacy_principals(tx: &Transaction<'_>) -> Result<()> {
    tx.execute("UPDATE external_conversations SET body=json_set(body,'$.principalId',(SELECT principal_id FROM threads WHERE id=json_extract(external_conversations.body,'$.parent.threadId'))) WHERE json_type(body,'$.principalId') IS NULL AND json_type(body,'$.parent.threadId')='text'",[])?;
    tx.execute("UPDATE external_conversations SET body=json_set(body,'$.principalId',(SELECT owner_principal_id FROM catalog_principal_owner WHERE id=1 AND claim_legacy=1)) WHERE json_type(body,'$.principalId') IS NULL",[])?;
    Ok(())
}
/// Called only by the first authenticated-owner legacy-claim transaction, never by
/// ordinary startup. Explicitly public work created after that claim stays public.
pub(super) fn claim_public_principals(tx: &Transaction<'_>, owner: &str) -> Result<()> {
    tx.execute("UPDATE external_conversations SET body=json_set(body,'$.principalId',coalesce((SELECT principal_id FROM threads WHERE id=json_extract(external_conversations.body,'$.parent.threadId')),?1)) WHERE json_extract(body,'$.principalId') IS NULL",[owner])?;
    Ok(())
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
            ExternalCommand::Settings => external_settings(&tx)?,
            ExternalCommand::ArrangementPending => json!(followups::external::pending(&tx)?),
            ExternalCommand::Defer { id,turn_id,reason } => followups::external::deferred(&tx,&id,&turn_id,&reason)?,
            ExternalCommand::InspectCapabilities { configuration_id, configuration } => {
                let cache = capability_cache(&tx)?;
                let entry = &cache[&configuration_id];
                if entry["configuration"] == configuration && entry["generation"].as_u64().is_some() {
                    json!({"generation":entry["generation"],"agentVersion":entry["agentVersion"]})
                } else { Value::Null }
            },
            ExternalCommand::ClaimCapabilities { configuration_id, configuration } => {
                let settings: Value = record(&tx, "external_settings", "settings")?;
                let current = settings["agents"].as_array().and_then(|agents|
                    agents.iter().find(|agent| agent["id"] == configuration_id));
                if current.is_some_and(|agent| capability_configuration(agent) == configuration) {
                    let generation = next_capability_generation(&tx)?;
                    let mut cache = capability_cache(&tx)?;
                    if cache[&configuration_id]["configuration"] != configuration {
                        cache[&configuration_id] = json!({"configuration":configuration});
                    }
                    cache[&configuration_id]["generation"] = json!(generation);
                    save_capability_metadata(&tx, "capabilities", &cache)?;
                    json!(generation)
                } else { Value::Null }
            },
            ExternalCommand::CacheCapabilities { configuration_id, configuration, generation, invalidate, agent_version, capabilities } => {
                let settings: Value = record(&tx, "external_settings", "settings")?;
                // A late reply from an old process must not replace a newer launch's metadata.
                let current = settings["agents"].as_array().and_then(|agents|
                    agents.iter().find(|agent| agent["id"] == configuration_id));
                if current.is_some_and(|agent| capability_configuration(agent) == configuration) {
                    let mut cache = capability_cache(&tx)?;
                    let entry = &cache[&configuration_id];
                    // The original Catalog assigns this claim before probing/connecting. Wall
                    // clocks, slow handshakes and late old-version callbacks cannot defeat it.
                    let stale = entry["generation"].as_u64() != Some(generation);
                    if stale { return Ok(ExternalRead { result: Value::Null, content: self.content.clone(), _publication: p._publication }); }
                    if invalidate == Some(true) {
                        let generation = next_capability_generation(&tx)?;
                        cache[&configuration_id] = json!({"configuration":configuration,"generation":generation});
                    } else if let Some(capabilities) = capabilities {
                        let version = agent_version.as_deref().filter(|version| !version.trim().is_empty())
                            .ok_or_else(|| RuntimeError::Invalid("capability cache requires an actual program version".into()))?;
                        if !capabilities.is_object() || !capabilities["models"].is_array() {
                            return Err(RuntimeError::Invalid("invalid external capabilities".into()));
                        }
                        cache[&configuration_id] = json!({"configuration":configuration,
                            "agentVersion":version,"generation":generation,"capabilities":capabilities,"cachedAt":now()});
                    } else if agent_version.is_some() && cache[&configuration_id]["agentVersion"].as_str() == agent_version.as_deref()
                        && cache[&configuration_id]["capabilities"].is_object() {
                        // A transient metadata-query failure does not invalidate a known catalog
                        // from this exact program version. It remains explicitly cached, not ready.
                        cache[&configuration_id]["generation"] = json!(generation);
                    } else {
                        cache[&configuration_id] = json!({"configuration":configuration,
                            "agentVersion":agent_version,"generation":generation});
                    }
                    save_capability_metadata(&tx, "capabilities", &cache)?;
                }
                Value::Null
            },
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
                // Clients configure defaults, never metadata. Retain only cache belonging to
                // unchanged launch identities; defaults/name/enabled edits are independent.
                value.as_object_mut().unwrap().remove("capabilityCache");
                let mut cache = capability_cache(&tx)?;
                cache.as_object_mut().unwrap().retain(|id, entry| value["agents"].as_array().unwrap().iter()
                    .any(|agent| agent["id"] == *id && capability_configuration(agent) == entry["configuration"]));
                save_capability_metadata(&tx, "capabilities", &cache)?;
                value["revision"] = json!(expected_revision + 1);
                put(&tx, "external_settings", "settings", &value)?;
                event(
                    &tx,
                    "external-settings",
                    expected_revision + 1,
                    "external.settings",
                    Value::Null,
                )?;
                external_settings(&tx)?
            }
            ExternalCommand::Create {
                id,
                configuration_id,
                harness,
                title,
                cwd,
                workspace_id,
                native_workspace,
                parent,
                private_workspace,
                principal_id,
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
                if let Some(source)=native_workspace{
                    source.validate()?;
                    super::source_retention::assert_record_available(&tx,"external_conversations",&json!({"nativeWorkspace":source}))?;
                    if source.mode!=crate::SourceMode::NativeWorkspace||!source.resource_owner.is_local(){return Err(RuntimeError::Invalid("External workspace must be a native source on its execution Host".into()));}
                    v["nativeWorkspace"]=serde_json::to_value(source)?;
                }
                let owner = if let Some(parent_thread)=parent.as_ref().and_then(|p|p["threadId"].as_str()) {
                    principals::thread(&tx,parent_thread)?
                } else if let Some(principal)=principal_id { if let Some(value)=&principal {principals::validate(value)?;} principal }
                else { tx.query_row("SELECT owner_principal_id FROM catalog_principal_owner WHERE id=1",[],|r|r.get::<_,String>(0)).optional()? };
                v["principalId"]=json!(owner);
                if let Some(parent) = parent { v["parent"] = parent; }
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
                        if matches!(v["status"].as_str(),Some("queued"|"preparing"|"awaiting_input")) {
                            if let Some(reason)=followups::external::turn_hold(&tx,&v)? { v["arrangementHoldReason"]=json!(reason); }
                        }
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
                        // Keep compact original arrangement receipts after target deletion. Unsent
                        // input stays attributable until the arrangement is rerouted or discarded.
                        tx.execute("DELETE FROM external_turns WHERE conversation_id=?1 AND json_extract(body,'$.arrangementOccurrenceId') IS NULL AND id NOT IN (SELECT json_extract(body,'$.consumedByTurnId') FROM external_turns WHERE conversation_id=?1 AND json_extract(body,'$.consumedByTurnId') IS NOT NULL)", [&id])?;
                        tx.execute("UPDATE external_turns SET body=json_set(body,'$.inputRef',NULL) WHERE conversation_id=?1 AND json_extract(body,'$.status') IN ('completed','failed','cancelled','interrupted')",[&id])?;
                        attachments::retire(&tx)?;
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
                tx.execute("UPDATE external_turns SET body=json_remove(body,'$.blockedReason') WHERE conversation_id=?1 AND json_extract(body,'$.status')='queued'",[&id])?;
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
            ExternalCommand::Admit { id, key, .. } => admit_turn(&tx,&id,&key,&p.body.unwrap(),self.epoch)?,
            ExternalCommand::Begin { id, turn_id } => {
                let mut v = conversation(&tx, &id)?;
                let mut t = turn(&tx, &id, &turn_id)?;
                if t["status"] != "queued" || v.get("activeTurn").is_some() {
                    return Err(RuntimeError::Conflict(
                        "external turn is already active or no longer queued".into(),
                    ));
                }
                let mut q=tx.prepare("SELECT body FROM external_turns WHERE conversation_id=?1 AND json_extract(body,'$.status')='queued' ORDER BY rowid")?;
                let queued=q.query_map([&id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
                let mut first=None;
                for raw in queued {
                    let candidate:Value=serde_json::from_str(&raw)?;
                    if candidate["blockedReason"].is_null() && followups::external::turn_hold(&tx,&candidate)?.is_none() {first=candidate["id"].as_str().map(str::to_owned);break;}
                }
                if first.as_deref() != Some(turn_id.as_str()) {
                    return Err(RuntimeError::Conflict(
                        "an earlier external input is queued".into(),
                    ));
                }
                if let Some(reason)=followups::external::turn_hold(&tx,&t)? {
                    // No state changes and no synthetic execution while its original control is held.
                    return Err(RuntimeError::Conflict(reason));
                }
                t["arrangementInforms"]=json!(followups::external::bind_pending(&tx,&id,&turn_id)?);
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
                let old = t["status"].as_str().unwrap_or("").to_owned();
                if !terminal(&status)
                    && !matches!(status.as_str(), "running" | "waiting_user" | "stopping")
                {
                    return Err(RuntimeError::Invalid("invalid external observation".into()));
                }
                if terminal(&old) || t["epoch"].as_u64() != Some(self.epoch) {
                    return Err(RuntimeError::Conflict(
                        "external observation belongs to a settled or stale turn".into(),
                    ));
                }
                if matches!(old.as_str(),"queued"|"awaiting_input") && status != "cancelled" {
                    return Err(RuntimeError::Conflict("external turn was not begun".into()));
                }
                if old == "stopping" && !terminal(&status) && status != "stopping" {
                    return Err(RuntimeError::Conflict("external turn is stopping".into()));
                }
                if old == "preparing" && status == "running" {
                    if let Some(reason)=followups::external::dispatch_hold(&tx,&t)? { return Err(RuntimeError::Conflict(reason)); }
                }
                t["status"] = json!(status);
                t["updatedAt"] = json!(now());
                if let Some(n) = native_id {
                    required(&n)?;
                    if t.get("nativeId").is_some_and(|original| original != &n) {
                        return Err(RuntimeError::Conflict("external native turn identity changed".into()));
                    }
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
                if status == "running" || terminal(&status) {
                    tx.execute("UPDATE external_turns SET body=json_set(body,'$.status',?3,'$.updatedAt',?4) WHERE conversation_id=?1 AND json_extract(body,'$.consumedByTurnId')=?2",params![id,turn_id,status,sql_number(now())?])?;
                }
                if old == "preparing" && status == "running" {followups::external::delivered(&tx,&t)?;}
                if terminal(&status) {
                    event(&tx, &turn_id, 0, "usage.updated", json!({}))?;
                    followups::external::publish_reports(&tx,&t)?;
                }
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
                let mut informs = if original == Some(true) {
                    vec![]
                } else {
                    s.query_map(params![id, turn_id], |r| r.get::<_, String>(0))?
                        .map(|v| Ok(serde_json::from_str::<Value>(&v?)?))
                        .collect::<Result<Vec<_>>>()?
                };
                let mut trailing = Vec::new();
                if original != Some(true) {
                    let mut q=tx.prepare("SELECT json_extract(body,'$.inputRef'), rowid < (SELECT rowid FROM external_turns WHERE id=?2) FROM external_turns WHERE conversation_id=?1 AND json_extract(body,'$.consumedByTurnId')=?2 ORDER BY rowid")?;
                    for row in q.query_map(params![id,turn_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?)))? {
                        let (reference, before) = row?;
                        let reference = serde_json::from_str::<Value>(&reference)?;
                        if before { informs.push(reference); } else { trailing.push(reference); }
                    }
                }
                json!({"externalInputRef":turn(&tx,&id,&turn_id)?["inputRef"],"externalInforms":informs,"externalTrailingInforms":trailing,"projectEventInputs":original!=Some(true)})
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
        let interrupted={let mut q=tx.prepare("SELECT id FROM external_turns WHERE json_extract(body,'$.status') IN ('preparing','running','waiting_user','stopping') AND json_extract(body,'$.consumedByTurnId') IS NULL")?;
            let ids=q.query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?; ids};
        tx.execute("UPDATE external_turns SET body=json_set(body,'$.status','interrupted','$.error','The Host connection ended before this turn was confirmed complete. Reconnect to inspect the original session.') WHERE json_extract(body,'$.status') IN ('preparing','running','waiting_user','stopping')",[])?;
        for id in interrupted {
            let turn:Value=record(&tx,"external_turns",&id)?;
            followups::external::publish_reports(&tx,&turn)?;
        }
        tx.execute("UPDATE external_conversations SET body=json_set(json_remove(body,'$.activeTurn'),'$.needsReview',json('true')) WHERE json_type(body,'$.activeTurn') IS NOT NULL",[])?;
        tx.commit()?;
        Ok(())
    }
}
