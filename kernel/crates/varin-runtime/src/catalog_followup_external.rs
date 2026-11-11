//! Arrangement inputs use the external harness's original turn ledger and dispatch boundary.
//! An external conversation is never a native Thread, branch, Run, or tool invocation.
use super::*;
use super::super::external as harness;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExternalEventDelivery {
    pub conversation_id: String,
    pub turn_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExternalEventDeliveryView {
    pub conversation_id: String,
    pub turn_id: String,
    pub state: String,
    pub hold_reason: Option<String>,
    pub consumed_by_turn_id: Option<String>,
}
pub(super) fn validate_target(db: &Connection, principal: Option<&str>, id: &str) -> Result<()> {
    let c = harness::conversation(db, id)?;
    // Missing ownership is not the same as intentionally public work. Only the upgrade owner
    // may attribute legacy direct conversations; workspace branch identities cannot do it.
    if !c.as_object().is_some_and(|value| value.contains_key("principalId"))
        || c["principalId"].as_str() != principal {
        return Err(RuntimeError::Conflict("external conversation belongs to another principal or has no attributed owner".into()));
    }
    if c["archived"] == true { return Err(RuntimeError::Conflict("external conversation is archived".into())); }
    Ok(())
}
fn configuration(db: &Connection, c: &Value) -> Result<Option<Value>> {
    let settings: Value = record(db, "external_settings", "settings")?;
    Ok(settings["agents"].as_array().and_then(|agents| agents.iter().find(|agent| agent["id"] == c["configurationId"])).cloned())
}
pub(super) fn target_hold(db: &Connection, id: &str) -> Result<Option<HoldReason>> {
    Ok(target_reason(db, id)?.map(|_| HoldReason::TargetUnavailable))
}
fn target_reason(db: &Connection, id: &str) -> Result<Option<String>> {
    let Some(c) = optional_record::<Value>(db, "external_conversations", id)? else { return Ok(Some("external_target_missing".into())); };
    let reason = if c["deleted"] == true { Some("external_target_deleted") }
        else if c["archived"] == true { Some("external_target_archived") }
        else if c["needsReview"] == true { Some("external_session_needs_review") }
        else { match configuration(db, &c)? {
            None => Some("external_configuration_missing"),
            Some(config) if config["enabled"] != true => Some("external_agent_disabled"),
            Some(config) if config["harness"] != c["harness"] => Some("external_harness_changed"),
            _ => None,
        }};
    Ok(reason.map(str::to_owned))
}
/// ContentStore reads and large conversion happen outside the Catalog mutex.
pub(super) fn prepare_input(content: &crate::content::ContentStore, history: &Value) -> Result<Value> {
    let (value, _) = content.load_history_payload(history)?;
    let item: ConversationItem = serde_json::from_value(value)?;
    let input = input_value(item, history)?;
    content.save_with_dependencies(&input, history["content_object"].as_str().map(str::to_owned).into_iter().collect())
}
fn input_value(item: ConversationItem, history: &Value) -> Result<Value> {
    let user_input=matches!(item.provenance,Provenance::UserInstruction {..});
    let mut texts = vec![];
    let mut files = vec![];
    let mut images = vec![];
    match item.content {
        Content::Output { output } => {
            if !output.model_data().is_null() { texts.push(serde_json::to_string(output.model_data())?); }
            for part in output.parts { match part {
                crate::output::OutputPart::Text { text } => texts.push(text),
                crate::output::OutputPart::Attachment { attachment } => files.push(attachment),
                crate::output::OutputPart::Media { media } => {
                    if !media.media_type.starts_with("image/") { return Err(RuntimeError::Invalid("external harness cannot accept this event media type".into())); }
                    images.push(json!({"data":media.data_base64,"mimeType":media.media_type}));
                }
            }}
        }
        Content::Text { text } => texts.push(text),
        _ => return Err(RuntimeError::Invalid("external event input requires its original text and material".into())),
    }
    let text = texts.join("\n\n");
    Ok(json!({"text":text,"task":text,"attachments":files,"images":images,"_eventHistory":history,"_arrangement":true,"_userInput":user_input}))
}
pub(crate) fn project_inputs(content: &crate::content::ContentStore, inputs: &mut [Value]) -> Result<()> {
    let references = inputs.iter().map(|input| {
        if input["_userInput"] == true { None } else { input.get("_eventHistory").cloned() }
    }).collect::<Vec<_>>();
    for (input, projection) in inputs.iter_mut().zip(super::event_input::project_batch(content, &references)?) {
        if let Some(projection) = projection { *input = input_value(projection.item, &input["_eventHistory"])?; }
    }
    Ok(())
}
pub(super) fn accept(tx: &Transaction<'_>, conversation: &str, occurrence: &str, input_ref: &Value, passive: bool, epoch: u64) -> Result<ExternalEventDelivery> {
    let c = harness::conversation(tx, conversation)?;
    let config = configuration(tx, &c)?.ok_or_else(|| RuntimeError::Conflict("external configuration is unavailable".into()))?;
    let mut turn = harness::admit_turn(tx, conversation, &format!("followup:{occurrence}"), input_ref, epoch)?;
    if turn.get("arrangementOccurrenceId").is_none() {
        turn["arrangementOccurrenceId"] = json!(occurrence);
        turn["arrangementLaunch"] = json!({"command":config["command"],"args":config["args"]});
        turn["status"] = json!(if passive { "awaiting_input" } else { "queued" });
        put(tx, "external_turns", turn["id"].as_str().unwrap(), &turn)?;
    }
    Ok(ExternalEventDelivery { conversation_id: conversation.into(), turn_id: turn["id"].as_str().unwrap().into() })
}
fn occurrence_for_turn(db: &Connection, turn: &Value) -> Result<Option<(Definition, Occurrence)>> {
    let Some(id) = turn["arrangementOccurrenceId"].as_str() else { return Ok(None) };
    let raw: Option<(String, String)> = db.query_row("SELECT f.body,o.body FROM followup_occurrences o JOIN followups f ON f.id=o.followup_id WHERE o.id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    raw.map(|(d,v)| Ok((serde_json::from_str(&d)?,serde_json::from_str(&v)?))).transpose()
}
/// This checks facts at both Begin and the real beforeDispatch/Observe boundary.
pub(crate) fn turn_hold(db: &Connection, turn: &Value) -> Result<Option<String>> {
    let Some((d,v)) = occurrence_for_turn(db, turn)? else {
        return Ok(turn.get("arrangementOccurrenceId").map(|_|"arrangement_unavailable".into()));
    };
    if d.state == FollowupState::Cancelled || v.cancelled { return Ok(Some("arrangement_cancelled".into())); }
    if d.state == FollowupState::Paused { return Ok(Some("arrangement_paused".into())); }
    if let FollowupOwner::Bot { bot_id } = &d.owner {
        if !bot::permitted(db, bot_id, bot::current_epoch(db)?)? { return Ok(Some("bot_suspended".into())); }
    }
    let anchor=v.target.as_ref().map_or(d.thread_id.as_str(),|target|target.thread_id.as_str());
    let branch=v.target.as_ref().map_or(d.branch_id.as_str(),|target|target.branch_id.as_str());
    let available:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM threads t JOIN branches b ON b.thread_id=t.id WHERE t.id=?1 AND b.id=?2 AND t.deleted_at_ms IS NULL AND t.archived=0 AND t.principal_id IS ?3)",params![anchor,branch,d.principal_id],|r|r.get(0))?;
    if !available || threads::branch_deleted(db,branch)? {return Ok(Some("arrangement_owner_unavailable".into()));}
    let id = turn["conversationId"].as_str().unwrap_or_default();
    if let Some(reason) = target_reason(db, id)? { return Ok(Some(reason)); }
    let c = harness::conversation(db, id)?;
    if c["principalId"].as_str() != d.principal_id.as_deref() { return Ok(Some("external_target_owner_changed".into())); }
    if let Some(config) = configuration(db, &c)? {
        if turn["arrangementLaunch"] != json!({"command":config["command"],"args":config["args"]}) { return Ok(Some("external_configuration_changed".into())); }
    }
    Ok(turn["blockedReason"].as_str().map(str::to_owned))
}
pub(super) fn project(db: &Connection, delivery: &ExternalEventDelivery) -> Result<ExternalEventDeliveryView> {
    let turn = harness::turn(db, &delivery.conversation_id, &delivery.turn_id)?;
    let consumed = turn["consumedByTurnId"].as_str().map(str::to_owned);
    let actual = consumed.as_deref().map(|id| harness::turn(db, &delivery.conversation_id, id)).transpose()?.unwrap_or_else(||turn.clone());
    let state = actual["status"].as_str().unwrap_or("unknown").to_owned();
    let hold = if matches!(state.as_str(), "queued"|"preparing"|"awaiting_input") { turn_hold(db,&turn)? } else { None };
    Ok(ExternalEventDeliveryView { conversation_id:delivery.conversation_id.clone(),turn_id:delivery.turn_id.clone(),state,hold_reason:hold,consumed_by_turn_id:consumed })
}
pub(super) fn cancel(tx: &Transaction<'_>, delivery: &ExternalEventDelivery) -> Result<bool> {
    let mut t = harness::turn(tx, &delivery.conversation_id, &delivery.turn_id)?;
    if let Some(consumer)=t["consumedByTurnId"].as_str() {
        let actual=harness::turn(tx,&delivery.conversation_id,consumer)?;
        if !matches!(actual["status"].as_str(),Some("queued"|"preparing")) {return Ok(false);}
        // Begin fixes the original set on the consumer. Its beforeDispatch check will
        // reject this withdrawn input even if Host has already loaded its old body.
        t.as_object_mut().unwrap().remove("consumedByTurnId");
    }
    if !matches!(t["status"].as_str(),Some("queued"|"awaiting_input"|"preparing")) { return Ok(false) }
    t["status"] = json!("cancelled");
    t["inputRef"] = Value::Null;
    put(tx,"external_turns",&delivery.turn_id,&t)?;
    // Withdrawing one arrangement before dispatch does not withdraw other intentions.
    tx.execute("UPDATE external_turns SET body=json_remove(body,'$.consumedByTurnId') WHERE conversation_id=?1 AND json_extract(body,'$.consumedByTurnId')=?2",params![delivery.conversation_id,delivery.turn_id])?;
    tx.execute("DELETE FROM attachment_deliveries WHERE holder_kind='external_turn' AND holder_id=?1",[&delivery.turn_id])?;
    let mut c:Value = record(tx,"external_conversations",&delivery.conversation_id)?;
    if c["activeTurn"] == delivery.turn_id { c.as_object_mut().unwrap().remove("activeTurn"); }
    harness::touch(tx,&mut c)?;
    Ok(true)
}
pub(super) fn retry(tx: &Transaction<'_>, delivery: &ExternalEventDelivery) -> Result<()> {
    let mut turn = harness::turn(tx,&delivery.conversation_id,&delivery.turn_id)?;
    if matches!(turn["status"].as_str(),Some("queued"|"awaiting_input")) && turn.get("consumedByTurnId").is_none() {
        turn["status"] = json!("queued");
        turn.as_object_mut().unwrap().remove("blockedReason");
        put(tx,"external_turns",&delivery.turn_id,&turn)?;
        let mut c = harness::conversation(tx,&delivery.conversation_id)?;
        harness::touch(tx,&mut c)?;
    }
    Ok(())
}
pub(crate) fn bind_pending(tx: &Transaction<'_>, conversation: &str, turn: &str) -> Result<Vec<String>> {
    let mut q = tx.prepare("SELECT body FROM external_turns WHERE conversation_id=?1 AND json_extract(body,'$.status') IN ('awaiting_input','queued') AND json_extract(body,'$.consumedByTurnId') IS NULL ORDER BY rowid")?;
    let rows = q.query_map([conversation], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let mut bound=vec![];
    let mut passed_current = false;
    let mut join_queued = true;
    for raw in rows {
        let mut input: Value = serde_json::from_str(&raw)?;
        if input["id"] == turn { passed_current = true; continue; }
        if input["status"] == "queued" {
            if !passed_current || !join_queued { continue; }
            // Do not jump an ordinary queued user message or merge its trust boundary.
            if !occurrence_for_turn(tx, &input)?.is_some_and(|(_, v)| !v.user_input) {
                join_queued = false;
                continue;
            }
        }
        if turn_hold(tx,&input)?.is_some() { continue; }
        input["consumedByTurnId"] = json!(turn);
        bound.push(input["id"].as_str().unwrap().to_owned());
        put(tx,"external_turns",input["id"].as_str().unwrap(),&input)?;
    }
    Ok(bound)
}
pub(crate) fn dispatch_hold(db: &Connection, turn: &Value) -> Result<Option<String>> {
    if let Some(reason) = turn_hold(db,turn)? { return Ok(Some(reason)); }
    for id in turn["arrangementInforms"].as_array().into_iter().flatten() {
        let Some(id)=id.as_str() else {return Err(RuntimeError::Invalid("external input identity is invalid".into()));};
        let input=harness::turn(db,turn["conversationId"].as_str().unwrap_or_default(),id)?;
        if input["consumedByTurnId"] != turn["id"] || input["status"]=="cancelled" {return Ok(Some("arrangement_input_changed".into()));}
    }
    let mut q = db.prepare("SELECT body FROM external_turns WHERE conversation_id=?1 AND json_extract(body,'$.consumedByTurnId')=?2")?;
    let rows = q.query_map(params![turn["conversationId"].as_str(),turn["id"].as_str()], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for raw in rows { if let Some(reason) = turn_hold(db,&serde_json::from_str(&raw)?)? { return Ok(Some(reason)); } }
    Ok(None)
}
pub(crate) fn pending(db: &Connection) -> Result<Vec<String>> {
    let mut q = db.prepare("SELECT t.body FROM external_turns t JOIN external_conversations c ON c.id=t.conversation_id WHERE json_extract(t.body,'$.status')='queued' AND json_extract(t.body,'$.arrangementOccurrenceId') IS NOT NULL AND json_extract(c.body,'$.activeTurn') IS NULL ORDER BY t.rowid")?;
    let rows = q.query_map([], |r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let mut ids=vec![];
    for raw in rows { let turn:Value=serde_json::from_str(&raw)?; if turn_hold(db,&turn)?.is_none() { let id=turn["conversationId"].as_str().unwrap().to_owned(); if !ids.contains(&id) { ids.push(id); } } }
    Ok(ids)
}
pub(crate) fn deferred(tx: &Transaction<'_>, id: &str, turn: &str, reason: &str) -> Result<Value> {
    let mut t = harness::turn(tx,id,turn)?;
    if !matches!(t["status"].as_str(),Some("preparing"|"queued")) { return Err(RuntimeError::Conflict("only an unsent external turn can be deferred".into())); }
    // Passive input preparation can hold an ordinary turn too. Its next Begin takes only
    // currently eligible informs, so no user input is discarded or replayed after dispatch.
    let held=dispatch_hold(tx,&t)?.is_some();
    t["status"] = json!("queued");
    t.as_object_mut().unwrap().remove("arrangementInforms");
    if !held { t["blockedReason"]=json!(reason); }
    put(tx,"external_turns",turn,&t)?;
    tx.execute("UPDATE external_turns SET body=json_remove(body,'$.consumedByTurnId') WHERE conversation_id=?1 AND json_extract(body,'$.consumedByTurnId')=?2",params![id,turn])?;
    let mut c=harness::conversation(tx,id)?;
    if c["activeTurn"] == turn { c.as_object_mut().unwrap().remove("activeTurn"); }
    harness::touch(tx,&mut c)?;
    Ok(t)
}
pub(crate) fn delivered(tx: &Transaction<'_>, actual: &Value) -> Result<()> {
    let mut q=tx.prepare("SELECT body FROM external_turns WHERE id=?1 OR json_extract(body,'$.consumedByTurnId')=?1 ORDER BY rowid")?;
    let rows=q.query_map([actual["id"].as_str().unwrap()],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for raw in rows {
        let turn:Value=serde_json::from_str(&raw)?;
        if let Some((mut d,v))=occurrence_for_turn(tx,&turn)? {
            if d.repeat==FollowupRepeat::Once && super::pending_occurrence_count(tx,&d)?==0 {d.wait.state=NextRunWaitState::Consumed;put(tx,"followups",&d.id,&d)?;}
            event(tx,&d.id,d.revision,"followup.delivered",json!({"occurrence_id":v.id,"external_conversation_id":actual["conversationId"],"external_turn_id":actual["id"]}))?;
        }
    }
    Ok(())
}
/// A completion belongs to this new real turn, never to the original child's already
/// published dispatch receipt. Existing Bot work ingress consumes this durable fact.
pub(crate) fn publish_reports(tx: &Transaction<'_>, completed: &Value) -> Result<()> {
    let turn_id=completed["id"].as_str().unwrap();
    let mut q=tx.prepare("SELECT body FROM external_turns WHERE id=?1 OR json_extract(body,'$.consumedByTurnId')=?1 ORDER BY rowid")?;
    let turns=q.query_map([turn_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let mut reports = std::collections::BTreeMap::<(String, String), (u64, Vec<Value>)>::new();
    for raw in turns {
        let turn:Value=serde_json::from_str(&raw)?;
        let Some((d,v))=occurrence_for_turn(tx,&turn)? else {continue};
        let target=v.target.as_ref().map_or(d.thread_id.as_str(),|t|t.thread_id.as_str());
        let branch=v.target.as_ref().map_or(d.branch_id.as_str(),|t|t.branch_id.as_str());
        let parent=harness::conversation(tx,completed["conversationId"].as_str().unwrap())?;
        let (target,branch)=if let (Some(thread),Some(branch))=(parent["parent"]["threadId"].as_str(),parent["parent"]["branchId"].as_str()) {
            (thread,branch)
        } else {(target,branch)};
        let report = reports.entry((target.into(), branch.into())).or_insert_with(|| (d.revision, Vec::new()));
        report.1.push(json!({"occurrenceId":v.id,"followupId":d.id}));
    }
    for ((target, branch), (revision, arrangements)) in reports {
        event(tx,"bot-work-pending",revision,"bot.work_pending",json!({"kind":"external_arrangement_report","targetThreadId":target,"targetBranchId":branch,"conversationId":completed["conversationId"],"turnId":turn_id,"occurrenceId":arrangements[0]["occurrenceId"],"followupId":arrangements[0]["followupId"],"arrangements":arrangements,"state":completed["status"],"error":completed["error"]}))?;
    }
    Ok(())
}
pub(crate) fn report_refs(db:&Connection, data:&Value)->Result<Vec<Value>> {
    let turn=harness::turn(db,data["conversationId"].as_str().unwrap_or_default(),data["turnId"].as_str().unwrap_or_default())?;
    if !harness::terminal(turn["status"].as_str().unwrap_or_default()) {return Err(RuntimeError::Conflict("external report has no completed turn".into()));}
    let mut q=db.prepare("SELECT body FROM external_items WHERE turn_id=?1 ORDER BY rowid")?;
    let mut result=q.query_map([turn["id"].as_str().unwrap()],|r|r.get::<_,String>(0))?.map(|r|Ok(serde_json::from_str(&r?)?)).collect::<Result<Vec<Value>>>()?;
    if turn["inputRef"].is_object() {result.push(turn["inputRef"].clone());}
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self { Self(std::env::temp_dir().join(format!("varin-external-arrangement-{}",Uuid::new_v4()))) }
        fn open(&self) -> Catalog { Catalog::open(&self.0).unwrap() }
    }
    impl Drop for Fixture {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
    fn command(db:&mut Catalog,value:Value)->Result<Value>{let p=db.prepare_external(serde_json::from_value(value)?).load()?;db.execute_external(p)?.load()}
    fn gate(db:&mut Catalog,permitted:bool,revision:u64){db.publish_bot_gate(bot::BotGate{bot_id:"bot".into(),profile_revision:revision,activity_operation_id:None,permitted}).unwrap();}
    fn setup(db:&mut Catalog){
        gate(db,true,1);db.create_bot_thread("owner","main","bot").unwrap();
        command(db,json!({"action":"configure","key":"config","expectedRevision":0,"value":{"agents":[{"id":"agent","name":"Agent","harness":"codex","enabled":true,"command":"codex","args":[]}],"defaultAgent":"agent"}})).unwrap();
        command(db,json!({"action":"create","key":"target","id":"external:task","configurationId":"agent","harness":"codex","title":"Existing work","cwd":"/workspace","principalId":null})).unwrap();
    }
    fn arrangement(db:&mut Catalog,timing:Value)->Followup {
        named_arrangement(db,"watch","Continue the original investigation with new replies",timing)
    }
    fn named_arrangement(db:&mut Catalog,key:&str,instruction:&str,timing:Value)->Followup {
        let input=serde_json::from_value(json!({"key":key,"botId":"bot","threadId":"owner","branchId":"main","externalConversationId":"external:task","name":"Watch replies","instruction":instruction,"source":{"extensionId":"mail","sourceId":"replies","connectionId":"account","accountId":"account"},"filter":{},"timing":timing,"repeat":"each"})).unwrap();
        let p=db.prepare_arrangement(input).unwrap().load().unwrap();db.admit_arrangement(p).unwrap()
    }
    fn receive(db:&mut Catalog){
        let input=serde_json::from_value(json!({"identity":{"principalId":null,"source":{"extensionId":"mail","sourceId":"replies","connectionId":"account","accountId":"account"}},"events":[{"eventId":"reply-1","objectId":"customer-thread","occurredAtMs":1,"attributes":{},"content":{"data":null,"parts":[{"kind":"text","text":"Customer supplied actual new evidence"}]}}]})).unwrap();
        let p=db.prepare_event_receive(input).unwrap().load().unwrap();db.admit_event_receive(p).unwrap();
    }
    fn deliver(db:&mut Catalog)->ExternalEventDelivery {
        let p=db.capture_followup_continuations().unwrap().remove(0).load().unwrap();
        assert!(matches!(db.admit_followup_continuation(p).unwrap(),ContinuationAdmission::Admitted(_)));
        let v:Occurrence=record(&db.db,"followup_occurrences",&db.db.query_row("SELECT id FROM followup_occurrences WHERE followup_id='watch' ORDER BY accepted_cursor DESC LIMIT 1",[],|r|r.get::<_,String>(0)).unwrap()).unwrap();
        v.external_delivery.unwrap()
    }
    fn deliver_all(db:&mut Catalog)->Vec<Value> {
        for p in db.capture_followup_continuations().unwrap() {
            db.admit_followup_continuation(p.load().unwrap()).unwrap();
        }
        let mut query=db.db.prepare("SELECT body FROM external_turns ORDER BY rowid").unwrap();
        query.query_map([],|r|r.get::<_,String>(0)).unwrap().map(|r|serde_json::from_str(&r.unwrap()).unwrap()).collect()
    }
    #[test]
    fn overlapping_arrangements_share_one_external_turn_and_keep_independent_receipts(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);
        named_arrangement(&mut db,"watch","Investigate the new evidence",json!({"kind":"immediate"}));
        named_arrangement(&mut db,"digest","Include this reply in the digest",json!({"kind":"immediate"}));
        receive(&mut db);let turns=deliver_all(&mut db);assert_eq!(turns.len(),2);
        let first=turns[0]["id"].as_str().unwrap();let second=turns[1]["id"].as_str().unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":first})).unwrap();
        let input=command(&mut db,json!({"action":"input","id":"external:task","turnId":first})).unwrap();
        let text=input["text"].as_str().unwrap();
        assert_eq!(text.matches("Customer supplied actual new evidence").count(),1);
        assert!(text.contains("Investigate the new evidence") && text.contains("Include this reply in the digest"));
        assert_eq!(harness::turn(&db.db,"external:task",second).unwrap()["consumedByTurnId"],first);
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":first,"status":"running"})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":first,"status":"completed"})).unwrap();
        assert_eq!(harness::turn(&db.db,"external:task",second).unwrap()["status"],"completed");
        let original=command(&mut db,json!({"action":"input","id":"external:task","turnId":second,"original":true})).unwrap();
        assert!(original["text"].as_str().unwrap().contains("Customer supplied actual new evidence"));
        assert!(pending(&db.db).unwrap().is_empty());
        let reports:Vec<Value> = db.db.prepare("SELECT data FROM events WHERE kind='bot.work_pending' AND json_extract(data,'$.kind')='external_arrangement_report'").unwrap()
            .query_map([],|r|r.get::<_,String>(0)).unwrap().map(|r|serde_json::from_str(&r.unwrap()).unwrap()).collect();
        assert_eq!(reports.len(),1);assert_eq!(reports[0]["arrangements"].as_array().unwrap().len(),2);
    }
    #[test]
    fn withdrawing_the_leading_external_arrangement_releases_its_other_unsent_intentions(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);
        named_arrangement(&mut db,"watch","Investigate",json!({"kind":"immediate"}));
        named_arrangement(&mut db,"digest","Digest",json!({"kind":"immediate"}));
        receive(&mut db);let turns=deliver_all(&mut db);
        let first=turns[0]["id"].as_str().unwrap();let second=turns[1]["id"].as_str().unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":first})).unwrap();
        let (d,_)=occurrence_for_turn(&db.db,&turns[0]).unwrap().unwrap();
        db.control_followup(&d.id,d.revision,FollowupControlAction::Cancel).unwrap();
        assert!(harness::turn(&db.db,"external:task",second).unwrap()["consumedByTurnId"].is_null());
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":second})).unwrap();
        let input=command(&mut db,json!({"action":"input","id":"external:task","turnId":second})).unwrap();
        assert!(input["text"].as_str().unwrap().contains("Customer supplied actual new evidence"));
        assert!(!input["text"].as_str().unwrap().contains("sharedWith"));
    }
    #[test]
    fn original_event_file_is_readable_only_through_its_real_external_delivery(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);arrangement(&mut db,json!({"kind":"immediate"}));
        let input=serde_json::from_value(json!({"identity":{"principalId":null,"source":{"extensionId":"mail","sourceId":"replies","connectionId":"account","accountId":"account"}},"events":[{"eventId":"file-reply","occurredAtMs":1,"attributes":{},"content":{"data":null,"parts":[{"kind":"text","text":"Read the attached original PDF"}]},"files":[{"fileId":"document","filename":"evidence.pdf","mimeType":"application/pdf","bytesBase64":"JVBERi0xLjQK"}]}]})).unwrap();
        let prepared=db.prepare_event_receive(input).unwrap().load().unwrap();db.admit_event_receive(prepared).unwrap();
        let delivery=deliver(&mut db);
        let edge=db.attachment_delivery("external_turn",&delivery.turn_id).unwrap().unwrap();
        assert_eq!(edge.thread_id,"external:task");assert_eq!(edge.branch_id,"");
        let descriptor=edge.attachments[0].clone();
        let read=EventAttachmentReadInput {thread_id:"external:task".into(),reference:descriptor.reference.clone(),offset:0,length:64};
        assert_eq!(db.prepare_event_attachment_read(read.clone()).unwrap().load().unwrap().bytes_base64,"JVBERi0xLjQK");
        command(&mut db,json!({"action":"create","key":"other","id":"external:other","configurationId":"agent","harness":"codex","title":"Other work","cwd":"/workspace","principalId":null})).unwrap();
        let mut other=read.clone();other.thread_id="external:other".into();assert!(db.prepare_event_attachment_read(other).is_err());
        let mut anchor=read.clone();anchor.thread_id="owner".into();assert!(db.prepare_event_attachment_read(anchor).is_err());
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":delivery.turn_id})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":delivery.turn_id,"status":"running"})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":delivery.turn_id,"status":"completed"})).unwrap();
        db.reconcile_followup_facts_at(observations::wall_time_ms().unwrap()).unwrap();
        let collection=db.prepare_content_collection(Default::default()).run();
        assert_eq!(collection.status,crate::catalog::ContentCollectionStatus::Completed);
        assert_eq!(db.prepare_event_attachment_read(read).unwrap().load().unwrap().bytes_base64,"JVBERi0xLjQK");
    }
    #[test]
    fn ownership_claim_is_once_and_does_not_reassign_later_public_work(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);
        db.initialize_principals("account-owner",true).unwrap();
        assert!(validate_target(&db.db,Some("account-owner"),"external:task").is_ok());
        command(&mut db,json!({"action":"create","key":"later-public","id":"external:public","configurationId":"agent","harness":"codex","title":"Explicit public work","cwd":"/workspace","principalId":null})).unwrap();
        db.initialize_principals("account-owner",true).unwrap();
        assert!(validate_target(&db.db,None,"external:public").is_ok());
        assert!(validate_target(&db.db,Some("account-owner"),"external:public").is_err());
        drop(db);let db=f.open();
        assert!(validate_target(&db.db,None,"external:public").is_ok());
        assert!(validate_target(&db.db,Some("different-account"),"external:task").is_err());
    }
    #[test]
    fn explicit_native_object_route_overrides_an_external_default(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);arrangement(&mut db,json!({"kind":"immediate"}));
        db.create_thread("ordinary","ordinary-main").unwrap();
        db.put_event_source_route(serde_json::from_value(json!({"followupId":"watch","expectedRevision":1,"objectId":"customer-thread","threadId":"ordinary","branchId":"ordinary-main","externalConversationId":null,"userInput":false})).unwrap()).unwrap();
        receive(&mut db);
        let prepared=db.capture_followup_continuations().unwrap().remove(0).load().unwrap();
        assert!(matches!(db.admit_followup_continuation(prepared).unwrap(),ContinuationAdmission::Admitted(_)));
        assert_eq!(db.db.query_row("SELECT count(*) FROM external_turns",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(db.db.query_row("SELECT count(*) FROM input_queue WHERE branch_id='ordinary-main'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        command(&mut db,json!({"action":"update","id":"external:task","expectedRevision":1,"archived":true})).unwrap();
        let queued_id=db.db.query_row("SELECT id FROM input_queue WHERE branch_id='ordinary-main'",[],|r|r.get::<_,String>(0)).unwrap();
        let queued:QueuedInputMetadata=record(&db.db,"input_queue",&queued_id).unwrap();
        assert_eq!(super::super::ingress_hold(&db.db,&queued,None).unwrap(),None);
    }
    #[test]
    fn scheduled_external_completion_is_real_and_cancel_releases_only_unsent_turn(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);
        let input=serde_json::from_value(json!({"taskId":"calendar","assetRevision":"1","assetKind":"gui","name":"Review replies","enabled":true,"timezone":"UTC","rule":{"kind":"daily","times":["09:00"]},"missedPolicy":"skip","target":{"kind":"existing_work","threadId":"owner","branchId":"main"},"instruction":"Review pending replies"})).unwrap();
        let prepared=db.prepare_calendar_sync("bot:bot".into(),None,vec![input]).unwrap().load().unwrap();
        let calendar=db.admit_calendar_sync(prepared).unwrap().definitions.remove(0);
        arrangement(&mut db,json!({"kind":"scheduled","calendarId":calendar.id,"runEmpty":true}));receive(&mut db);
        let slot=db.run_calendar_now(&calendar.id,calendar.revision,"first-slot").unwrap();
        let delivery=deliver(&mut db);
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":delivery.turn_id})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":delivery.turn_id,"status":"running"})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":delivery.turn_id,"status":"completed"})).unwrap();
        db.reconcile_followup_facts_at(observations::wall_time_ms().unwrap()).unwrap();
        assert_eq!(db.calendar_occurrence(&slot.id).unwrap().state,calendar::OccurrenceState::Completed);
        let next=db.run_calendar_now(&calendar.id,calendar.revision,"second-slot").unwrap();
        let pending=deliver(&mut db);
        let current=db.calendar_occurrence(&next.id).unwrap();
        db.control_calendar_occurrence(&next.id,current.revision,calendar::OccurrenceControlAction::Cancel).unwrap();
        assert_eq!(project(&db.db,&pending).unwrap().state,"cancelled");
        let ordinary=command(&mut db,json!({"action":"admit","id":"external:task","key":"after-slot","input":{"text":"Ordinary user input"}})).unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":ordinary["id"]})).unwrap();
    }
    fn scheduled_calendar(db:&mut Catalog)->calendar::DefinitionView {
        let input=serde_json::from_value(json!({"taskId":"calendar","assetRevision":"1","assetKind":"gui","name":"Review replies","enabled":true,"timezone":"UTC","rule":{"kind":"daily","times":["09:00"]},"missedPolicy":"skip","target":{"kind":"existing_work","threadId":"owner","branchId":"main"},"instruction":"Review pending replies"})).unwrap();
        let prepared=db.prepare_calendar_sync("bot:bot".into(),None,vec![input]).unwrap().load().unwrap();
        db.admit_calendar_sync(prepared).unwrap().definitions.remove(0)
    }
    #[test]
    fn scheduled_retarget_keeps_retired_receipt_without_cancelling_the_replacement(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);
        let calendar=scheduled_calendar(&mut db);
        arrangement(&mut db,json!({"kind":"scheduled","calendarId":calendar.id,"runEmpty":false}));receive(&mut db);
        let slot=db.run_calendar_now(&calendar.id,calendar.revision,"retarget-slot").unwrap();
        let original=deliver(&mut db);
        command(&mut db,json!({"action":"create","key":"replacement","id":"external:replacement","configurationId":"agent","harness":"codex","title":"Replacement work","cwd":"/workspace","principalId":null})).unwrap();
        let definition=db.followup("watch").unwrap();
        db.put_event_source_route(serde_json::from_value(json!({"followupId":"watch","expectedRevision":definition.revision,"objectId":"customer-thread","threadId":"owner","branchId":"main","externalConversationId":"external:replacement","userInput":false})).unwrap()).unwrap();
        let replacement=deliver(&mut db);
        assert_eq!(project(&db.db,&original).unwrap().state,"cancelled");
        assert_eq!(replacement.conversation_id,"external:replacement");assert_ne!(replacement.turn_id,original.turn_id);
        command(&mut db,json!({"action":"begin","id":replacement.conversation_id,"turnId":replacement.turn_id})).unwrap();
        command(&mut db,json!({"action":"observe","id":replacement.conversation_id,"turnId":replacement.turn_id,"status":"running"})).unwrap();
        command(&mut db,json!({"action":"observe","id":replacement.conversation_id,"turnId":replacement.turn_id,"status":"waiting_user"})).unwrap();
        assert_eq!(db.calendar_occurrence(&slot.id).unwrap().state,calendar::OccurrenceState::Delivered);
        command(&mut db,json!({"action":"observe","id":replacement.conversation_id,"turnId":replacement.turn_id,"status":"completed"})).unwrap();
        db.reconcile_followup_facts_at(observations::wall_time_ms().unwrap()).unwrap();
        assert_eq!(db.calendar_occurrence(&slot.id).unwrap().state,calendar::OccurrenceState::Completed);
        assert_eq!(project(&db.db,&original).unwrap().state,"cancelled");
    }
    #[test]
    fn mixed_calendar_preserves_external_waiting_and_failure_after_native_completion(){
        use crate::test_submission::InputAdmission;
        let f=Fixture::new();let mut db=f.open();setup(&mut db);
        db.create_thread("ordinary","ordinary-main").unwrap();
        let work=db.submit(&SubmitInput {key:"ordinary-start".into(),thread_id:"ordinary".into(),branch_id:"ordinary-main".into(),expected_head:None,input:json!({"text":"Continue the user's original task"}),configuration:json!({})}).unwrap();
        let run=db.run(&work.run_id).unwrap();db.transition_run(&run.id,db.epoch(),run.revision,RunState::Runnable).unwrap();
        let calendar=scheduled_calendar(&mut db);
        arrangement(&mut db,json!({"kind":"scheduled","calendarId":calendar.id,"runEmpty":false}));
        db.put_event_source_route(serde_json::from_value(json!({"followupId":"watch","expectedRevision":1,"objectId":"customer-thread","threadId":"ordinary","branchId":"ordinary-main","externalConversationId":null,"userInput":false})).unwrap()).unwrap();
        receive(&mut db);
        let input=serde_json::from_value(json!({"identity":{"principalId":null,"source":{"extensionId":"mail","sourceId":"replies","connectionId":"account","accountId":"account"}},"events":[{"eventId":"external-reply","objectId":"external-object","occurredAtMs":1,"attributes":{},"content":{"data":null,"parts":[{"kind":"text","text":"Evidence for the original external task"}]}}]})).unwrap();
        let prepared=db.prepare_event_receive(input).unwrap().load().unwrap();db.admit_event_receive(prepared).unwrap();
        let slot=db.run_calendar_now(&calendar.id,calendar.revision,"mixed-slot").unwrap();
        let candidates=db.capture_followup_continuations().unwrap();assert_eq!(candidates.len(),2);
        for preparation in candidates {db.admit_followup_continuation(preparation.load().unwrap()).unwrap();}
        let head=db.head("ordinary-main").unwrap();
        let native=db.prepare_input_delivery(&work.run_id,db.epoch(),head.as_deref()).unwrap().load().unwrap();
        db.admit_input_delivery(native).unwrap().unwrap();
        let run=db.run(&work.run_id).unwrap();db.transition_run(&run.id,db.epoch(),run.revision,RunState::Completed).unwrap();
        let receipt:ExternalEventDelivery=serde_json::from_str(&db.db.query_row("SELECT json_extract(body,'$.external_delivery') FROM followup_occurrences WHERE followup_id='watch' AND json_type(body,'$.external_delivery')='object'",[],|r|r.get::<_,String>(0)).unwrap()).unwrap();
        command(&mut db,json!({"action":"begin","id":receipt.conversation_id,"turnId":receipt.turn_id})).unwrap();
        command(&mut db,json!({"action":"observe","id":receipt.conversation_id,"turnId":receipt.turn_id,"status":"running"})).unwrap();
        command(&mut db,json!({"action":"observe","id":receipt.conversation_id,"turnId":receipt.turn_id,"status":"waiting_user"})).unwrap();
        assert_eq!(db.calendar_occurrence(&slot.id).unwrap().state,calendar::OccurrenceState::Delivered);
        let definition=db.followup("watch").unwrap();
        db.control_followup("watch",definition.revision,FollowupControlAction::Cancel).unwrap();
        assert_eq!(db.calendar_occurrence(&slot.id).unwrap().state,calendar::OccurrenceState::Delivered);
        assert!(!super::super::events::calendar_batches_ended(&db.db,&slot.id).unwrap());
        command(&mut db,json!({"action":"observe","id":receipt.conversation_id,"turnId":receipt.turn_id,"status":"failed","error":"Original harness failed"})).unwrap();
        assert_eq!(db.calendar_occurrence(&slot.id).unwrap().state,calendar::OccurrenceState::Failed);
        assert!(super::super::events::calendar_batches_ended(&db.db,&slot.id).unwrap());
    }
    #[test]
    fn external_event_uses_original_turn_and_honors_dispatch_controls_and_report_identity(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);arrangement(&mut db,json!({"kind":"immediate"}));receive(&mut db);
        let delivery=deliver(&mut db);
        assert_eq!(db.db.query_row("SELECT count(*) FROM threads",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.db.query_row("SELECT count(*) FROM runs",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(db.db.query_row("SELECT count(*) FROM input_queue",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert!(db.capture_followup_continuations().unwrap().is_empty());
        command(&mut db,json!({"action":"begin","id":delivery.conversation_id,"turnId":delivery.turn_id})).unwrap();
        gate(&mut db,false,2);
        assert!(command(&mut db,json!({"action":"observe","id":delivery.conversation_id,"turnId":delivery.turn_id,"status":"running"})).is_err());
        command(&mut db,json!({"action":"defer","id":delivery.conversation_id,"turnId":delivery.turn_id,"reason":"bot_suspended"})).unwrap();
        assert_eq!(project(&db.db,&delivery).unwrap().hold_reason.as_deref(),Some("bot_suspended"));
        let ordinary=command(&mut db,json!({"action":"admit","id":"external:task","key":"independent-user","input":{"text":"Continue the ordinary task while the Bot sleeps"}})).unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":ordinary["id"]})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":ordinary["id"],"status":"running"})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":ordinary["id"],"status":"completed"})).unwrap();
        gate(&mut db,true,3);
        command(&mut db,json!({"action":"begin","id":delivery.conversation_id,"turnId":delivery.turn_id})).unwrap();
        command(&mut db,json!({"action":"observe","id":delivery.conversation_id,"turnId":delivery.turn_id,"status":"running"})).unwrap();
        let answer = format!("{}Verified the new evidence", "事实🧪".repeat(20000));
        command(&mut db,json!({"action":"item","id":delivery.conversation_id,"turnId":delivery.turn_id,"itemId":"first-answer","content":{"kind":"assistant","text":"First original result","complete":true}})).unwrap();
        command(&mut db,json!({"action":"item","id":delivery.conversation_id,"turnId":delivery.turn_id,"itemId":"answer","content":{"kind":"assistant","text":answer,"complete":true,
            "attachments":[{"ref":"attachment:external-result","filename":"evidence.csv","mimeType":"text/csv","byteLength":42}]}})).unwrap();
        command(&mut db,json!({"action":"observe","id":delivery.conversation_id,"turnId":delivery.turn_id,"status":"completed"})).unwrap();
        assert_eq!(project(&db.db,&delivery).unwrap().state,"completed");
        assert_eq!(db.db.query_row("SELECT count(*) FROM events WHERE kind='bot.work_pending' AND json_extract(data,'$.kind')='external_arrangement_report'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let owner=Mutex::new(db);
        super::super::super::bot_work_events::deliver(&owner).unwrap();
        let mut db=owner.lock().unwrap();
        assert_eq!(db.db.query_row("SELECT count(*) FROM input_queue WHERE origin='work_event' AND branch_id='main'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.db.query_row("SELECT count(*) FROM external_children",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        let (input_id, reference):(String,String)=db.db.query_row("SELECT q.id,c.body FROM input_queue q JOIN input_history_content c ON c.input_id=q.id WHERE q.origin='work_event'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let value=db.content.load_history_payload(&serde_json::from_str(&reference).unwrap()).unwrap().0;
        let item:crate::execution::ConversationItem=serde_json::from_value(value).unwrap();
        let crate::execution::Content::Output{output}=item.content else {panic!("original report output")};
        let model=output.model_data.as_ref().unwrap();
        let execution=db.execution_reference(&delivery.turn_id).unwrap();
        assert_eq!(model["executionRef"],execution.reference);
        assert_eq!(model["previewPartial"],true);
        assert_eq!(output.data["source"]["turnId"],delivery.turn_id);
        let original=format!("First original result\n\n{answer}");
        assert_eq!(output.data["report"]["text"],original);
        assert_eq!(output.data["report"]["items"].as_array().unwrap().len(),2);
        let text=output.parts.iter().find_map(|part|match part {crate::output::OutputPart::Text{text}=>Some(text.as_str()),_=>None}).unwrap();
        assert!(text.contains("First original result") && !text.contains("Verified the new evidence"));
        assert!(!text.contains(&delivery.turn_id));
        assert!(text.split_once('\n').unwrap().1.len()<=65536);
        let file=output.parts.iter().find_map(|part|match part {crate::output::OutputPart::Attachment{attachment}=>Some(attachment),_=>None}).unwrap();
        assert_eq!(file.reference,"attachment:external-result");
        assert!(file.model_ref.as_ref().unwrap().starts_with("file:"));
        // Once the original ingress is consumed, its returned read directly pages the
        // preserved full report through the normal history owner and access checks.
        use crate::test_submission::InputAdmission;
        let receipt=db.submit(&SubmitInput{key:"read-report".into(),thread_id:"owner".into(),branch_id:"main".into(),expected_head:None,
            input:json!({"text":"Read the result"}),configuration:json!({"provider":"test"})}).unwrap();
        let head=db.head("main").unwrap();let epoch=db.epoch();
        db.consume_inputs(&receipt.run_id,epoch,head.as_deref()).unwrap();
        let selected=db.resolve_model_reference(super::super::super::model_references::ReferenceKind::Item,model["read"]["arguments"]["ref"].as_str().unwrap()).unwrap();
        let args=db.model_history_read_arguments(&receipt.run_id,&selected.target).unwrap();
        assert_eq!(args["query"]["itemId"],input_id);
        let page=db.capture_family_read("owner",Some("owner"),Some("main")).unwrap().output(super::super::super::family::OutputRequest{
            run_id:None,anchor:None,item_id:input_id,pointer:args["query"]["pointer"].as_str().unwrap().into(),offset:None,max_bytes:Some(original.len()+1)},&||false).unwrap();
        assert_eq!(page["value"],original);
        assert_eq!(db.db.query_row("SELECT count(*) FROM external_children",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn passive_event_waits_for_real_input_and_pause_detaches_only_unsent_evidence(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);arrangement(&mut db,json!({"kind":"passive"}));receive(&mut db);
        let delivery=deliver(&mut db);assert_eq!(project(&db.db,&delivery).unwrap().state,"awaiting_input");
        assert!(pending(&db.db).unwrap().is_empty());
        let turn=command(&mut db,json!({"action":"admit","id":"external:task","key":"user-input","input":{"text":"Continue our work"}})).unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":turn["id"]})).unwrap();
        let input=command(&mut db,json!({"action":"input","id":"external:task","turnId":turn["id"]})).unwrap();
        assert!(input["text"].as_str().unwrap().contains("Customer supplied actual new evidence"));
        assert_eq!(project(&db.db,&delivery).unwrap().consumed_by_turn_id.as_deref(),turn["id"].as_str());
        gate(&mut db,false,2);
        assert!(command(&mut db,json!({"action":"observe","id":"external:task","turnId":turn["id"],"status":"running"})).is_err());
        command(&mut db,json!({"action":"defer","id":"external:task","turnId":turn["id"],"reason":"bot_suspended"})).unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":turn["id"]})).unwrap();
        let input=command(&mut db,json!({"action":"input","id":"external:task","turnId":turn["id"]})).unwrap();
        assert_eq!(input["text"],"Continue our work");
        assert_eq!(project(&db.db,&delivery).unwrap().consumed_by_turn_id,None);
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":turn["id"],"status":"running"})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":turn["id"],"status":"completed"})).unwrap();
        gate(&mut db,true,3);
        let tx=db.db.transaction().unwrap();retry(&tx,&delivery).unwrap();tx.commit().unwrap();
        assert_eq!(project(&db.db,&delivery).unwrap().state,"queued");
        assert_eq!(pending(&db.db).unwrap(),vec!["external:task"]);
    }
    #[test]
    fn withdrawing_bound_passive_evidence_fences_the_already_loaded_prompt(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);arrangement(&mut db,json!({"kind":"passive"}));receive(&mut db);
        let delivery=deliver(&mut db);
        let turn=command(&mut db,json!({"action":"admit","id":"external:task","key":"user-input","input":{"text":"User work"}})).unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":turn["id"]})).unwrap();
        let loaded=command(&mut db,json!({"action":"input","id":"external:task","turnId":turn["id"]})).unwrap();
        assert!(loaded["text"].as_str().unwrap().contains("Customer supplied"));
        let tx=db.db.transaction().unwrap();assert!(cancel(&tx,&delivery).unwrap());tx.commit().unwrap();
        assert!(command(&mut db,json!({"action":"observe","id":"external:task","turnId":turn["id"],"status":"running"})).is_err());
        command(&mut db,json!({"action":"defer","id":"external:task","turnId":turn["id"],"reason":"arrangement_input_changed"})).unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":turn["id"]})).unwrap();
        assert_eq!(command(&mut db,json!({"action":"input","id":"external:task","turnId":turn["id"]})).unwrap()["text"],"User work");
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":turn["id"],"status":"running"})).unwrap();
        assert_eq!(project(&db.db,&delivery).unwrap().state,"cancelled");
    }
    #[test]
    fn external_owner_and_unrecoverable_errors_remain_explicit_without_replaying(){
        let f=Fixture::new();let mut db=f.open();setup(&mut db);
        assert!(validate_target(&db.db,Some("different-user"),"external:task").is_err());
        arrangement(&mut db,json!({"kind":"immediate"}));receive(&mut db);let delivery=deliver(&mut db);
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":delivery.turn_id})).unwrap();
        command(&mut db,json!({"action":"defer","id":"external:task","turnId":delivery.turn_id,"reason":"This native session cannot be resumed"})).unwrap();
        assert_eq!(project(&db.db,&delivery).unwrap().hold_reason.as_deref(),Some("This native session cannot be resumed"));
        assert!(pending(&db.db).unwrap().is_empty());
        drop(db);let mut db=f.open();gate(&mut db,true,4);
        assert_eq!(project(&db.db,&delivery).unwrap().state,"queued");
        assert!(db.capture_followup_continuations().unwrap().is_empty());
        let tx=db.db.transaction().unwrap();retry(&tx,&delivery).unwrap();tx.commit().unwrap();
        command(&mut db,json!({"action":"begin","id":"external:task","turnId":delivery.turn_id})).unwrap();
        command(&mut db,json!({"action":"observe","id":"external:task","turnId":delivery.turn_id,"status":"running"})).unwrap();
        drop(db);let mut db=f.open();gate(&mut db,true,5);
        assert_eq!(project(&db.db,&delivery).unwrap().state,"interrupted");
        assert_eq!(db.db.query_row("SELECT count(*) FROM events WHERE kind='bot.work_pending' AND json_extract(data,'$.kind')='external_arrangement_report' AND json_extract(data,'$.state')='interrupted'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert!(db.capture_followup_continuations().unwrap().is_empty());
        assert_eq!(db.db.query_row("SELECT count(*) FROM external_turns",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
}
