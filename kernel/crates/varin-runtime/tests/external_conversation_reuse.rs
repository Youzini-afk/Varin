//! Real Catalog admissions: contact an existing external session without adopting it.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
use fixture::Fixture;
use serde_json::{json, Value};
use varin_runtime::catalog::{external::ExternalCommand, messages::MessageInput};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Lifetime};

fn schema(name: &str) -> ToolSchema {
    ToolSchema {requirements:None,name:name.into(),version:"1".into(),description:String::new(),schema:json!({"type":"object"}),output_schema:None,metadata:None}
}
fn external(db: &mut Catalog, command: Value) -> Value {
    let command: ExternalCommand = serde_json::from_value(command).unwrap();
    let prepared = db.prepare_external(command).load().unwrap();
    db.execute_external(prepared).unwrap().load().unwrap()
}
fn setup() -> Fixture {
    // This suite admits its own policy send. Do not seed an unrelated model
    // dispatch with an unfinished tool exchange (or manufacture a child to close it).
    let mut f = Fixture::new_policy_parent_with_schemas(7,schema("send"),schema("dispatch"));
    external(&mut f.db,json!({"action":"create","key":"manual","id":"manual","configurationId":"codex","harness":"codex","title":"Existing user work","cwd":"/original"}));
    external(&mut f.db,json!({"action":"bind","id":"manual","sessionId":"original-native-session"}));
    f
}
fn admit(f: &mut Fixture, text: &str, wait: bool) -> String {
    let input: MessageInput = serde_json::from_value(json!({"targetThreadId":"manual","kind":"request","text":text,"afterCurrent":true,
        "wait":if wait {json!({})} else {Value::Null}})).unwrap();
    let call = ToolCall {call_id:format!("send-{text}"),name:"send".into(),schema_version:"1".into(),arguments:serde_json::to_value(&input).unwrap()};
    let context = f.admit_policy_call_with_contract(call.clone(), ToolContract {name:call.name.clone(),schema_version:call.schema_version.clone(),read_only:false,
        completion:if wait {CompletionKind::Job} else {CompletionKind::Result},lifetime:if wait {Lifetime::Thread} else {Lifetime::Run},resources:vec![]});
    let prepared = f.db.prepare_external_message(&context,call.clone(),input.clone()).unwrap().load().unwrap();
    let receipt = f.db.admit_external_message(prepared).unwrap();
    let replay = f.db.prepare_external_message(&context,call,input).unwrap().load().unwrap();
    assert_eq!(serde_json::to_value(f.db.admit_external_message(replay).unwrap()).unwrap(),serde_json::to_value(receipt).unwrap());
    context.operation_id
}
#[test]
fn existing_manual_session_keeps_its_owner_and_returns_actual_request_identity() {
    let mut f = setup();
    let original = external(&mut f.db,json!({"action":"inspect","id":"manual"}));
    let op = admit(&mut f,"continue-user-work",true);
    let request = f.db.external_child(&op).unwrap().unwrap();
    assert_eq!(request.parent_run_id,f.context.run_id);
    assert_eq!(request.parent_thread_id,"thread:parent");
    assert_eq!(request.parent_branch_id,"branch:parent");
    assert!(request.dispatch_operation_id.is_none());
    assert!(request.handoff.is_none() && request.source.is_none() && request.project_source.is_none());
    assert!(request.resources_released);
    let after = external(&mut f.db,json!({"action":"read","id":"manual"}));
    assert_eq!(after["conversation"]["sessionId"],original["sessionId"]);
    assert_eq!(after["conversation"]["cwd"],"/original");
    assert!(after["conversation"]["parent"].is_null());
    assert_eq!(after["turns"].as_array().unwrap().len(),1);
    let input = external(&mut f.db,json!({"action":"input","id":"manual","turnId":request.turn_id,"original":true}));
    assert_eq!(input["senderThreadId"],"thread:parent");
    assert_eq!(input["senderBranchId"],"branch:parent");
    assert!(input["_launch"].is_null() && input["model"].is_null());
    assert_eq!(input["_preferSteering"],false);
    assert!(f.db.external_message_target(&f.context.run_id,"manual").unwrap().is_none());
    // A communication record conveys no source exchange authority.
    assert!(request.source.is_none());
}
#[test]
fn external_access_is_principal_scoped_and_archived_targets_are_not_redirected() {
    let mut f = setup();
    assert!(f.db.external_conversation_message_target(&f.context.run_id,"manual").unwrap().is_some());
    external(&mut f.db,json!({"action":"create","key":"foreign","id":"foreign","configurationId":"codex","harness":"codex","title":"Other owner","cwd":"/other","principalId":"other-owner"}));
    assert!(f.db.external_conversation_message_target(&f.context.run_id,"foreign").is_err());
    let c=external(&mut f.db,json!({"action":"inspect","id":"manual"}));
    external(&mut f.db,json!({"action":"update","id":"manual","expectedRevision":c["revision"],"archived":true}));
    assert!(f.db.external_conversation_message_target(&f.context.run_id,"manual").unwrap_err().to_string().contains("archived"));
    assert!(f.db.capture_external_conversation_overview(&f.context.run_id,"manual").unwrap().load().unwrap()["archived"]==true);
}
#[test]
fn external_history_pages_hold_original_item_versions_and_never_start_a_turn() {
    let mut f = setup();
    let turn=external(&mut f.db,json!({"action":"admit","id":"manual","key":"user","input":{"text":"Original user task"}}));
    external(&mut f.db,json!({"action":"begin","id":"manual","turnId":turn["id"]}));
    for (id,text) in [("first","Original first answer"),("second","Original second answer")] {
        external(&mut f.db,json!({"action":"item","id":"manual","turnId":turn["id"],"itemId":id,"content":{"id":id,"turnId":turn["id"],"kind":"assistant","text":text,"complete":true}}));
    }
    let read=f.db.capture_external_conversation_history(&f.context.run_id,"manual",json!({"kind":"recent","limit":1,"maxItemBytes":64})).unwrap().load().unwrap();
    let first=f.db.publish_external_history_page(&f.context.run_id,read).unwrap();
    assert_eq!(first.data["page"]["items"][0]["itemId"],"second");
    let next=first.data["page"]["nextRead"]["arguments"]["ref"].as_str().unwrap().to_owned();
    external(&mut f.db,json!({"action":"item","id":"manual","turnId":turn["id"],"itemId":"first","content":{"id":"first","turnId":turn["id"],"kind":"assistant","text":"Changed later","complete":true}}));
    let collection=f.db.prepare_content_collection(Default::default()).run();
    assert_eq!(collection.status, varin_runtime::ContentCollectionStatus::Completed, "{collection:?}");
    let fixed=f.db.capture_external_history_reference(&f.context.run_id,&next).unwrap().unwrap().load().unwrap();
    let page=f.db.publish_external_history_page(&f.context.run_id,fixed).unwrap();
    let item_ref=page.data["page"]["items"][0]["read"]["arguments"]["ref"].as_str().unwrap();
    let original=f.db.capture_external_history_reference(&f.context.run_id,item_ref).unwrap().unwrap().load().unwrap();
    let original=f.db.publish_external_history_page(&f.context.run_id,original).unwrap();
    assert!(original.data["page"]["item"]["text"].as_str().unwrap().contains("Original first answer"));
    assert!(first.data.get("retainedContent").is_none());
    let view=external(&mut f.db,json!({"action":"read","id":"manual"}));
    assert_eq!(view["turns"].as_array().unwrap().len(),1);
    assert_eq!(view["conversation"]["sessionId"],"original-native-session");
}

#[test]
fn shared_execution_reports_the_actual_answer_once_without_inheriting_requester_cancellation() {
    let mut f = setup();
    let original = external(&mut f.db,json!({"action":"admit","id":"manual","key":"original-user","input":{"text":"User-owned work"}}));
    external(&mut f.db,json!({"action":"begin","id":"manual","turnId":original["id"]}));
    external(&mut f.db,json!({"action":"observe","id":"manual","turnId":original["id"],"status":"running","nativeId":"native-original"}));
    let operation = admit(&mut f,"supplement",false);
    let request = f.db.external_child(&operation).unwrap().unwrap();
    external(&mut f.db,json!({"action":"steer_prepare","id":"manual","turnId":request.turn_id,"targetTurnId":original["id"]}));
    external(&mut f.db,json!({"action":"steer_dispatch","id":"manual","turnId":request.turn_id}));
    external(&mut f.db,json!({"action":"steer_receipt","id":"manual","turnId":request.turn_id,"state":"appended","nativeId":"native-original"}));
    assert!(f.db.cancel_external_child(&f.context.run_id,&operation).unwrap_err().to_string().contains("independent receiver"));
    f.db.request_cancel_run(&f.context.run_id).unwrap();
    let owner = std::sync::Mutex::new(f.db);
    let active=varin_runtime::catalog::external_children::execute(&owner,json!({"action":"child_list","activeOnly":true})).unwrap();
    assert_eq!(active[0]["cancel_requested"],false);
    assert_eq!(active[0]["state"],"running");
    {
        let mut db=owner.lock().unwrap();
        external(&mut db,json!({"action":"item","id":"manual","turnId":original["id"],"itemId":"real-answer",
            "content":{"id":"real-answer","turnId":original["id"],"kind":"assistant","text":"Shared real execution answer","complete":true}}));
        external(&mut db,json!({"action":"observe","id":"manual","turnId":original["id"],"status":"completed","nativeId":"native-original"}));
    }
    let finished=varin_runtime::catalog::external_children::execute(&owner,json!({"action":"child_finish","operationId":operation,"released":true})).unwrap();
    assert_eq!(finished["report"]["turnId"],json!(request.turn_id));
    assert_eq!(finished["report"]["executionTurnId"],original["id"]);
    assert_eq!(finished["report"]["sharedExecution"],true);
    assert!(finished["report"]["executionRef"].as_str().unwrap().contains('/'));
    assert_eq!(finished["report"]["items"][0]["itemId"],"real-answer");
    let replay=varin_runtime::catalog::external_children::execute(&owner,json!({"action":"child_finish","operationId":operation,"released":true})).unwrap();
    assert_eq!(replay,finished);
    let db=owner.lock().unwrap();
    let report=db.capture_external_child(&f.context.run_id,&operation).unwrap().unwrap().report(None,0,1024).unwrap();
    assert_eq!(report["page"]["text"],"Shared real execution answer");
    let events=db.events_after(0,1000).unwrap();
    let reports=events.iter().filter(|event|event.kind=="bot.work_pending" && event.data["kind"]=="external_report").collect::<Vec<_>>();
    assert_eq!(reports.len(),1);
    assert_eq!(reports[0].data["targetThreadId"],"thread:parent");
    assert_eq!(reports[0].data["targetBranchId"],"branch:parent");
}
