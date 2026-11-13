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
        #[serde(default, skip_serializing_if="Option::is_none")]
        organization: Option<super::organization::Placement>,
        key: String,
        id: String,
        configuration_id: String,
        harness: String,
        title: String,
        cwd: String,
        workspace_id: Option<String>,
        native_workspace: Option<super::launches::SourceSelection>,
        #[serde(default,skip_serializing_if="Option::is_none")]
        execution_source: Option<super::launches::SourceSelection>,
        parent: Option<Value>,
        private_workspace: Option<bool>,
        #[serde(default, deserialize_with = "principals::optional_principal", skip_serializing_if = "Option::is_none")]
        principal_id: Option<Option<String>>,
    },
    /// Recover accepted UI creation before rechecking mutable program/source readiness.
    CreateReceipt {
        key:String, configuration_id:String, cwd:Option<String>, title:Option<String>,
        #[serde(default)] source:Option<Value>,
        #[serde(default)] organization:Option<super::organization::Placement>,
        #[serde(default, deserialize_with="principals::optional_principal")] principal_id:Option<Option<String>>,
    },
    List,
    /// Trusted owner metadata, including tombstones; does not read Harness history.
    Inspect { id: String },
    UpdateReceipt { command: Box<ExternalCommand> },
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
        #[serde(default, skip_serializing_if="Option::is_none")]
        key: Option<String>,
        id: String,
        expected_revision: u64,
        title: Option<String>,
        pinned: Option<bool>,
        archived: Option<bool>,
        deleted: Option<bool>,
    },
    /// Durable target process admission; pending is not proof that dispatch failed.
    TransportPrepare { id: String },
    TransportBind { id: String, transport_id: String, authority_id: String, resource_epoch: String, configuration_identity: String },
    /// Trusted Host calls only after the original target confirms executor stop.
    TransportClosed { id: String, transport_id: String },
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
    fn external_creation_receipt_preserves_legacy_identity_after_principal_claim() {
        let directory=Fixture::new();let mut c=Catalog::open(directory.path()).unwrap();
        create(&mut c,"legacy-original-id");
        // The existing principal migration claims the original record, not its old receipt.
        c.db.execute("UPDATE external_conversations SET body=json_set(body,'$.principalId','owner') WHERE id='legacy-original-id'",[]).unwrap();
        let query=json!({"action":"create_receipt","key":"legacy-original-id","configurationId":"codex","cwd":"/workspace","title":"Task","principalId":"owner"});
        let receipt=call(&mut c,query.clone()).unwrap();assert_eq!(receipt["id"],"legacy-original-id");
        let mut changed=query.clone();changed["title"]=json!("Different");assert!(call(&mut c,changed).is_err());
        let mut foreign=query.clone();foreign["principalId"]=json!("other");assert_eq!(call(&mut c,foreign).unwrap(),Value::Null);
        drop(c);let mut c=Catalog::open(directory.path()).unwrap();assert_eq!(call(&mut c,query).unwrap()["id"],"legacy-original-id");
    }
    #[test]
    fn external_transport_retains_pending_identity_and_fences_replacement() {
        let directory=Fixture::new();let mut c=Catalog::open(directory.path()).unwrap();
        let source=json!({"resource_owner":{"kind":"local"},"mode":"live_root","workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":null,"revision":null,
            "live_root":{"hostId":"target","rootId":"root","canonicalRoot":"/workspace"}});
        call(&mut c,json!({"action":"create","id":"external","key":"external","configurationId":"codex","harness":"codex","title":"Remote","cwd":"/workspace","executionSource":source})).unwrap();
        let first=call(&mut c,json!({"action":"transport_prepare","id":"external"})).unwrap();
        assert_eq!(first["state"],"pending");
        drop(c);let mut c=Catalog::open(directory.path()).unwrap();
        assert_eq!(first,call(&mut c,json!({"action":"transport_prepare","id":"external"})).unwrap());
        let bind=json!({"action":"transport_bind","id":"external","transportId":first["id"],"authorityId":"authority","resourceEpoch":"epoch","configurationIdentity":"launch"});
        let bound=call(&mut c,bind.clone()).unwrap();assert_eq!(bound,call(&mut c,bind.clone()).unwrap());
        let mut changed=bind;changed["configurationIdentity"]=json!("changed");assert!(call(&mut c,changed).is_err());
        assert_eq!(bound,call(&mut c,json!({"action":"transport_prepare","id":"external"})).unwrap());
        call(&mut c,json!({"action":"transport_closed","id":"external","transportId":first["id"]})).unwrap();
        let next=call(&mut c,json!({"action":"transport_prepare","id":"external"})).unwrap();assert_ne!(first["id"],next["id"]);
        assert!(call(&mut c,json!({"action":"transport_closed","id":"external","transportId":first["id"]})).is_err());
        assert_eq!(call(&mut c,json!({"action":"inspect","id":"external"})).unwrap()["revision"],1);
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
    fn external_quotes_require_retained_bindings_and_survive_retry_and_reopen() {
        let directory = Fixture::new();
        let mut c = Catalog::open(directory.path()).unwrap();
        create(&mut c, "external:quotes");
        let text = "[引用点1] [图片7]";
        let quote = json!({"ref":"private-source","number":1,"title":"引用点1","text":"fixed original passage","source":{"kind":"chat","passages":[]}});
        let mut input = json!({"text":text,"contentReferences":[quote],"contentReferenceOccurrences":[
            {"kind":"content","ref":"private-source","start":0,"end":6},
            {"kind":"image","reference":7,"start":7,"end":12}]});
        let admit = |input: &Value| json!({"action":"admit","id":"external:quotes","key":"quoted","input":input});
        assert!(call(&mut c, admit(&input)).is_err(), "unbound image cannot become an accepted external input");
        input["attachments"] = json!([{"ref":"attachment:fixed","filename":"image.png","mimeType":"image/png","byteLength":4}]);
        input["attachmentImageReferences"] = json!({"attachment:other":7});
        assert!(call(&mut c, admit(&input)).is_err(), "file number must identify the actual attachment");
        input["attachmentImageReferences"] = json!({"attachment:fixed":7});
        let receipt = call(&mut c, admit(&input)).unwrap();
        assert_eq!(receipt, call(&mut c, admit(&input)).unwrap());
        drop(c);
        let mut c = Catalog::open(directory.path()).unwrap();
        assert_eq!(receipt, call(&mut c, admit(&input)).unwrap());
        let restored = call(&mut c, json!({"action":"input","id":"external:quotes","turnId":receipt["id"],"original":true})).unwrap();
        assert_eq!(restored, input);
        let markerless = json!({"action":"admit","id":"external:quotes","key":"markerless","input":{"text":"","contentReferences":[quote]}});
        assert!(call(&mut c, markerless).is_ok(), "retained quote alone is a complete input");
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
        CREATE TABLE external_items(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES external_conversations(id),turn_id TEXT NOT NULL REFERENCES external_turns(id),native_id TEXT NOT NULL,body TEXT NOT NULL,kind TEXT,tool_status TEXT,UNIQUE(turn_id,native_id));
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
    let mut statement=db.prepare("SELECT body FROM external_conversations")?;
    let rows=statement.query_map([],|row|row.get::<_,String>(0))?;
    for row in rows {
        let value:Value=serde_json::from_str(&row?)?;
        if let Some(source)=value.get("executionSource") { let source:super::launches::SourceSelection=serde_json::from_value(source.clone())?;source.validate()?; }
        if let Some(transport)=value.get("transport") {
            if transport["conversationId"]!=value["id"] || transport["source"]!=value["executionSource"] || transport["configurationId"]!=value["configurationId"]
                || transport["harness"]!=value["harness"] || transport["id"]!=transport["processId"]
                || !matches!(transport["state"].as_str(),Some("pending"|"bound"|"closed")) {
                return Err(RuntimeError::Invalid("External transport storage identity is invalid".into()));
            }
            required(transport["id"].as_str().unwrap_or(""))?;
            if transport["state"]=="bound" { for field in ["authorityId","resourceEpoch","configurationIdentity"] { required(transport[field].as_str().unwrap_or(""))?; } }
        }
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
                    && files.is_empty() && input.get("contentReferences").and_then(Value::as_array).is_none_or(Vec::is_empty) {
                    return Err(RuntimeError::Invalid("external input requires text, an image or an attachment".into()));
                }
                if input.get("contentReferences").is_some() || input.get("contentReferenceOccurrences").is_some() {
                    let mut quoted = json!({"text":input["text"], "fileAttachments":files});
                    for field in ["contentReferences", "contentReferenceOccurrences", "attachmentImageReferences"] { if let Some(value) = input.get(field) { quoted[field] = value.clone(); } }
                    if let Some(images) = input.get("images").and_then(Value::as_array) {
                        quoted["attachments"] = json!(images.iter().map(|image| json!({"media_type":image["mimeType"],"data_base64":image["data"]})).collect::<Vec<_>>());
                        if images.iter().any(|image| image.get("reference").is_some()) {
                            let mut next = images.iter().filter_map(|image|image["reference"].as_u64()).max().unwrap_or(0);
                            quoted["imageReferences"] = json!(images.iter().map(|image|image["reference"].as_u64().unwrap_or_else(|| { next += 1; next })).collect::<Vec<_>>());
                        }
                    }
                    let mut bindings = input.get("attachmentImageReferences").cloned().unwrap_or_else(|| json!({}));
                    for reference in input["contentReferences"].as_array().into_iter().flatten() {
                        if let Some((file, number)) = reference["attachmentRef"].as_str().zip(reference["imageReference"].as_u64()) {
                            if !files.iter().any(|attachment| attachment.reference == file && attachment.mime_type.starts_with("image/")) { continue; }
                            if bindings.get(file).is_some_and(|existing| existing.as_u64() != Some(number)) {
                                // Different annotated images may retain the same original file.
                                if quoted["imageReferences"].as_array().is_some_and(|images| images.iter().any(|image| image.as_u64() == Some(number))) { continue; }
                                return Err(RuntimeError::Invalid("quoted image disagrees with its original file binding".into()));
                            }
                            if !bindings.is_object() { return Err(RuntimeError::Invalid("invalid image attachment bindings".into())); }
                            bindings[file] = json!(number);
                        }
                    }
                    if bindings.as_object().is_some_and(|map| !map.is_empty()) { quoted["attachmentImageReferences"] = bindings; }
                    // External file-image bytes remain with their Harness owner. Prepared
                    // descriptors and number bindings still must resolve before admission.
                    crate::output::validate_user_metadata(&quoted)?;
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
            let quote_text_length = input["text"].as_str().map_or(0, |text| text.encode_utf16().count());
            let mut texts = Vec::new();
            let mut messages = Vec::new();
            let mut images = Vec::new();
            let mut quote_text_offset = 0usize;
            for (index, message) in inputs.into_iter().enumerate() {
                if let Some(text) = message["text"].as_str() {
                    if index < primary { quote_text_offset += text.encode_utf16().count() + 2; }
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
                if input.get("contentReferences").is_some() || input.get("contentReferenceOccurrences").is_some() {
                    input["_quoteTextOffset"] = json!(quote_text_offset);
                    input["_quoteTextLength"] = json!(quote_text_length);
                }
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
    super::model_references::admit_external_turn(tx,id,&turn_id,key)?;
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
            ExternalCommand::Create { key, principal_id: Some(Some(principal)), .. } => Some(format!("create:{}", serde_json::to_string(&(principal,key))?)),
            ExternalCommand::Create { key, .. } => Some(format!("create:{key}")),
            ExternalCommand::Admit { id, key, .. } => Some(format!("admit:{id}:{key}")),
            ExternalCommand::Update { id, key:Some(key), .. } => Some(format!("update:{id}:{key}")),
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
                if let ExternalCommand::Create {principal_id:Some(requested),..}=&p.command {
                    let receipt:Value=serde_json::from_str(&body)?;
                    if let Some(id)=receipt["id"].as_str() {
                        let current:Value=record(&tx,"external_conversations",id)?;
                        if current["principalId"].as_str()!=requested.as_deref(){return Err(RuntimeError::Conflict("Original external creation belongs to another principal".into()));}
                    }
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
            ExternalCommand::CreateReceipt {key,configuration_id,cwd,title,source,organization,principal_id} => {
                required(&key)?;required(&configuration_id)?;
                let principal=match principal_id {Some(value)=>value,None=>tx.query_row("SELECT owner_principal_id FROM catalog_principal_owner WHERE id=1",[],|r|r.get::<_,String>(0)).optional()?};
                if let Some(value)=&principal {principals::validate(value)?;}
                let scoped_key=principal.as_ref().map(|owner|serde_json::to_string(&(owner,&key)).map(|key|format!("create:{key}"))).transpose()?;
                let mut keys=scoped_key.iter().cloned().collect::<Vec<_>>();
                keys.push(format!("create:{key}"));
                let mut found=Value::Null;
                for command_key in keys {
                    let saved:Option<(String,String)>=tx.query_row("SELECT intent,receipt FROM external_commands WHERE id=?1",[&command_key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                    let Some((intent,body))=saved else{continue};
                    let receipt:Value=serde_json::from_str(&body)?;
                    let id=receipt["id"].as_str().ok_or_else(||RuntimeError::Invalid("External create receipt has no identity".into()))?.to_owned();
                    let current:Value=record(&tx,"external_conversations",&id)?;
                    if current["principalId"].as_str()!=principal.as_deref(){
                        if scoped_key.as_ref()==Some(&command_key){return Err(RuntimeError::Conflict("Original external creation belongs to another principal".into()));}
                        continue;
                    }
                    let selected_source=receipt.get("executionSource").cloned();
                    if let Some(input)=&source {
                        let owner=selected_source.as_ref().map(|s|s["resource_owner"].clone()).unwrap_or_else(||json!({"kind":"local"}));
                        let workspace=selected_source.as_ref().map(|s|s["workspace_id"].clone()).unwrap_or_else(||receipt["workspaceId"].clone());
                        if input["resourceOwner"]!=owner || input["path"]!=receipt["cwd"]
                            || input.get("expectedWorkspaceId").is_some_and(|expected| expected!=&workspace) {
                            return Err(RuntimeError::Conflict("External creation source changed".into()));
                        }
                    } else if selected_source.as_ref().is_some_and(|value| value["resource_owner"]["kind"]=="managed_host") {
                        return Err(RuntimeError::Conflict("External creation source was omitted".into()));
                    }
                    let requested_cwd=source.as_ref().and_then(|v|v["path"].as_str()).map(str::to_owned).or(cwd.clone());
                    let private=receipt["privateWorkspace"]==true;
                    if requested_cwd.as_ref().is_some_and(|path|receipt["cwd"]!=*path) || requested_cwd.is_none()!=private {
                        return Err(RuntimeError::Conflict("External creation directory changed".into()));
                    }
                    let mut matched=false;
                    for historical_principal in [None,Some(None),Some(principal.clone())] {
                        for historical_private in [Some(private),None] {
                            let original=ExternalCommand::Create {key:key.clone(),id:id.clone(),configuration_id:configuration_id.clone(),
                                harness:receipt["harness"].as_str().unwrap_or("").into(),title:title.clone().unwrap_or_else(||receipt["title"].as_str().unwrap_or("").into()),
                                cwd:receipt["cwd"].as_str().unwrap_or("").into(),workspace_id:receipt["workspaceId"].as_str().map(str::to_owned),
                                native_workspace:receipt.get("nativeWorkspace").cloned().map(serde_json::from_value).transpose()?,
                                execution_source:selected_source.clone().map(serde_json::from_value).transpose()?,parent:None,
                                private_workspace:historical_private,principal_id:historical_principal.clone(),organization:organization.clone()};
                            use sha2::{Digest,Sha256};
                            if hex::encode(Sha256::digest(serde_json::to_vec(&original)?))==intent {matched=true;break;}
                        }
                        if matched{break;}
                    }
                    if !matched{return Err(RuntimeError::Conflict("External creation key was reused with different input".into()));}
                    found=receipt;break;
                }
                found
            }
            ExternalCommand::Inspect { id } => record::<Value>(&tx,"external_conversations",&id)?,
            ExternalCommand::UpdateReceipt { command } => {
                use sha2::{Digest,Sha256};
                let ExternalCommand::Update{id,key:Some(key),..}=command.as_ref() else{return Err(RuntimeError::Invalid("metadata receipt requires the original keyed Update command".into()));};
                let intent=hex::encode(Sha256::digest(serde_json::to_vec(command.as_ref())?));
                let old:Option<(String,String)>=tx.query_row("SELECT intent,receipt FROM external_commands WHERE id=?1",[format!("update:{id}:{key}")],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((original,receipt))=old {if original!=intent{return Err(RuntimeError::Conflict("external command key was reused with different input".into()));}serde_json::from_str(&receipt)?}else{Value::Null}
            },
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
                organization,
                id,
                configuration_id,
                harness,
                title,
                cwd,
                workspace_id,
                native_workspace,
                execution_source,
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
                if let Some(source)=execution_source {
                    source.validate()?;
                    super::source_retention::assert_record_available(&tx,"external_conversations",&json!({"executionSource":source}))?;
                    v["executionSource"]=serde_json::to_value(source)?;
                }
                let owner = if let Some(parent_thread)=parent.as_ref().and_then(|p|p["threadId"].as_str()) {
                    principals::thread(&tx,parent_thread)?
                } else if let Some(principal)=principal_id { if let Some(value)=&principal {principals::validate(value)?;} principal }
                else { tx.query_row("SELECT owner_principal_id FROM catalog_principal_owner WHERE id=1",[],|r|r.get::<_,String>(0)).optional()? };
                v["principalId"]=json!(owner);
                let organization_parent = parent.as_ref().and_then(|p|p["threadId"].as_str()).map(|id|super::organization::ConversationRef::Native{id:id.into()});
                if let Some(parent) = parent { v["parent"] = parent; }
                if private_workspace == Some(true) {
                    v["privateWorkspace"] = json!(true);
                }
                tx.execute(
                    "INSERT INTO external_conversations VALUES(?1,?2)",
                    params![id, encode(&v)?],
                )?;
                super::organization::admit(&tx,owner.as_deref(),&super::organization::ConversationRef::External{id:id.clone()},organization.as_ref(),organization_parent.as_ref(),&format!("external-create:{id}"))?;
                super::model_references::admit_external_agent(&tx,&id)?;
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
                ..
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
            ExternalCommand::TransportPrepare { id } => {
                let mut v = conversation(&tx, &id)?;
                let source = v.get("executionSource").cloned().ok_or_else(|| RuntimeError::Invalid("External execution source is missing".into()))?;
                if let Some(old) = v.get("transport").filter(|old| old["state"] != "closed") {
                    if old["source"] != source { return Err(RuntimeError::Conflict("External transport source changed".into())); }
                    old.clone()
                } else {
                    let transport_id = format!("external-process:{}", Uuid::new_v4());
                    let receipt = json!({"id":transport_id,"processId":transport_id,"conversationId":id,"source":source,
                        "configurationId":v["configurationId"],"harness":v["harness"],"state":"pending"});
                    v["transport"] = receipt.clone();
                    put(&tx,"external_conversations",&id,&v)?;
                    receipt
                }
            }
            ExternalCommand::TransportBind { id, transport_id, authority_id, resource_epoch, configuration_identity } => {
                for value in [&transport_id,&authority_id,&resource_epoch,&configuration_identity] { required(value)?; }
                let mut v = conversation(&tx, &id)?;
                let mut receipt = v.get("transport").cloned().ok_or_else(|| RuntimeError::Conflict("External transport was not prepared".into()))?;
                if receipt["id"] != transport_id || receipt["state"] == "closed" {
                    return Err(RuntimeError::Conflict("External transport generation changed".into()));
                }
                if receipt["state"] == "bound" && (receipt["authorityId"] != authority_id || receipt["resourceEpoch"] != resource_epoch || receipt["configurationIdentity"] != configuration_identity) {
                    return Err(RuntimeError::Conflict("External transport binding changed".into()));
                }
                receipt["state"] = json!("bound"); receipt["authorityId"] = json!(authority_id);
                receipt["resourceEpoch"] = json!(resource_epoch); receipt["configurationIdentity"] = json!(configuration_identity);
                v["transport"] = receipt.clone(); put(&tx,"external_conversations",&id,&v)?; receipt
            }
            ExternalCommand::TransportClosed { id, transport_id } => {
                // Cleanup must also remain possible after product deletion.
                let mut v: Value = record(&tx,"external_conversations",&id)?;
                let mut receipt = v.get("transport").cloned().ok_or_else(|| RuntimeError::Conflict("External transport was not prepared".into()))?;
                if receipt["id"] != transport_id { return Err(RuntimeError::Conflict("External transport generation changed".into())); }
                if receipt["state"] != "closed" { receipt["state"] = json!("closed"); v["transport"] = receipt.clone(); put(&tx,"external_conversations",&id,&v)?; }
                receipt
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
                if old == "preparing" && status == "running" {
                    event(&tx,&turn_id,0,"external.execution_activity",json!({"atMs":now(),"kind":"turn_started"}))?;
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
                content,
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
                if content["kind"] == "tool" {
                    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM external_items WHERE turn_id=?1 AND native_id=?2)",params![turn_id,item_id],|row|row.get(0))?;
                    if !exists { event(&tx,&turn_id,0,"external.execution_activity",json!({"atMs":now(),"kind":"tool_invoked"}))?; }
                }
                tx.execute("INSERT INTO external_items(id,conversation_id,turn_id,native_id,body,kind,tool_status) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(turn_id,native_id) DO UPDATE SET body=excluded.body,kind=excluded.kind,tool_status=excluded.tool_status",params![format!("{turn_id}:{item_id}"),id,turn_id,item_id,encode(&p.body.unwrap())?,content["kind"].as_str(),content["tool"]["status"].as_str()])?;
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

/// Original external conversation overview: no native Run or synthetic child relationship.
pub struct ExternalOverviewRead {
    overview:Value,
    items:Vec<(Value,Option<String>,Option<String>)>,
    content:crate::content::ContentStore,
    _publication:crate::content::ContentPublication,
}
impl ExternalOverviewRead {
    pub fn load(mut self)->Result<Value> {
        let mut latest_assistant=None;let mut active=Vec::new();let mut recent_action=None;
        for (reference,kind,status) in self.items {
            // New observations have an original metadata index; only selected bodies hydrate.
            let known=kind.as_deref();
            let running=matches!(status.as_deref(),Some("running"|"pending"|"waiting"|"in_progress"));
            if known==Some("assistant") && latest_assistant.is_some(){continue;}
            if known==Some("tool") && !running && recent_action.is_some(){continue;}
            if known.is_some() && !matches!(known,Some("assistant"|"tool")){continue;}
            let item=self.content.load(&reference)?;
            if latest_assistant.is_none() && item["kind"]=="assistant" {latest_assistant=Some(item["text"].clone());}
            if item["kind"]=="tool" {
                let action=json!({"name":item["tool"]["name"],"status":item["tool"]["status"],"path":item["tool"]["path"],"command":item["tool"]["command"]});
                if matches!(item["tool"]["status"].as_str(),Some("running"|"pending"|"waiting"|"in_progress")){active.push(action.clone());}
                if recent_action.is_none(){recent_action=Some(action);}
            }
        }
        self.overview["latestAssistantMessage"]=json!(latest_assistant);
        self.overview["actions"]=if active.is_empty(){json!(recent_action.into_iter().collect::<Vec<_>>())}else{json!(active)};
        Ok(self.overview)
    }
}
impl Catalog {
    pub fn resolve_external_agent(&self,identity:&str)->Result<Option<String>> {
        if identity.contains('/') {
            return match self.resolve_execution_reference(identity) {
                Ok(super::model_references::ExecutionReference{target:super::model_references::ExecutionTarget::External{conversation_id,..},..})=>Ok(Some(conversation_id)),
                Ok(_)=>Ok(None),Err(RuntimeError::NotFound(_))=>Ok(None),Err(error)=>Err(error),
            };
        }
        Ok(self.db.query_row("SELECT id FROM external_conversations WHERE id=?1 OR id=(SELECT owner_id FROM model_agents WHERE owner_kind='external' AND agent_code=?2 COLLATE NOCASE)",params![identity,identity.to_uppercase()],|r|r.get(0)).optional()?)
    }
    pub fn capture_external_conversation_overview(&self,caller_run:&str,identity:&str)->Result<ExternalOverviewRead> {
        let caller=self.run(caller_run)?;
        let id=self.resolve_external_agent(identity)?.ok_or_else(||RuntimeError::NotFound("External Agent".into()))?;
        let conversation=conversation(&self.db,&id)?;
        let root=super::scheduling::thread_family(&self.db,&caller.thread_id)?;
        let readable:bool=self.db.query_row("WITH RECURSIVE family(id) AS (SELECT ?5 UNION SELECT c.child_thread_id FROM child_tasks c JOIN family f ON json_extract(c.body,'$.parent_thread_id')=f.id) SELECT EXISTS(SELECT 1 FROM bot_thread_bindings WHERE thread_id=?1) AND ?2 IS ?3 OR EXISTS(SELECT 1 FROM external_children c JOIN family f ON json_extract(c.body,'$.parent_thread_id')=f.id WHERE json_extract(c.body,'$.conversation_id')=?4)",params![caller.thread_id,caller.principal_id,conversation["principalId"].as_str(),id,root],|r|r.get(0))?;
        if !readable {return Err(RuntimeError::Invalid("External conversation is outside this Agent's readable work".into()));}
        let exact=if identity.contains('/') {Some(self.resolve_execution_reference(identity)?)}else{None};
        let selected_turn=exact.as_ref().and_then(|e|match &e.target{super::model_references::ExecutionTarget::External{turn_id,..}=>turn_id.clone(),_=>None});
        let turns:Vec<Value>=if let Some(turn_id)=selected_turn.as_deref(){vec![turn(&self.db,&id,turn_id)?]}else{
            let mut query=self.db.prepare("SELECT body FROM external_turns WHERE conversation_id=?1 AND (json_extract(body,'$.status') NOT IN ('completed','failed','cancelled','interrupted') OR rowid=(SELECT max(rowid) FROM external_turns WHERE conversation_id=?1)) ORDER BY rowid DESC")?;
            let rows=query.query_map([&id],|r|r.get::<_,String>(0))?;rows.map(|row|Ok(serde_json::from_str(&row?)?)).collect::<Result<_>>()?
        };
        let mut executions=Vec::new();
        for turn in &turns {
            let reference=self.execution_reference(turn["id"].as_str().ok_or_else(||RuntimeError::Invalid("External turn identity is missing".into()))?)?;
            executions.push(json!({"ref":reference.reference,"state":turn["status"],"waitingOn":followups::external::turn_hold(&self.db,turn)?,"error":turn["error"]}));
        }
        if turns.is_empty() {
            if let Some(reference)=&exact {executions.push(json!({"ref":reference.reference,"state":"preparing"}));}
        }
        let turn_ids=turns.iter().filter_map(|t|t["id"].as_str()).collect::<Vec<_>>();
        let items={let mut query=self.db.prepare("SELECT body,kind,tool_status FROM external_items WHERE conversation_id=?1 AND (?2 IS NULL OR turn_id IN(SELECT value FROM json_each(?2))) AND (kind IS NULL OR kind IN('assistant','tool')) ORDER BY rowid DESC")?;
            let rows=query.query_map(params![id,if turn_ids.is_empty(){None}else{Some(encode(&turn_ids)?)}],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?)))?;
            rows.map(|row|{let (reference,kind,status)=row?;Ok((serde_json::from_str(&reference)?,kind,status))}).collect::<Result<Vec<_>>>()?};
        Ok(ExternalOverviewRead{overview:json!({"agentId":self.external_agent_reference(&id)?,"name":conversation["title"],"harness":conversation["harness"],"state":executions.first().map(|e|e["state"].clone()).unwrap_or(json!("idle")),"executions":executions,"read":{"tool":super::family::READ_TOOL,"arguments":{"threadId":identity,"query":{"kind":"overview"}}}}),items,content:self.content.clone(),_publication:self.content.begin_publication()})
    }
}
