//! Actual frozen children consume model-visible pages, not handcrafted continuation DTOs.
use super::*;
#[allow(dead_code)]
#[path = "fixtures/query_schemas_v93.rs"]
mod original;

type Step = Box<dyn Fn(&RequestSnapshot) -> (String, Value) + Send + Sync>;
struct QuerySequence { schemas: Vec<ToolSchema>, steps: Vec<Step>, next: AtomicUsize }
fn accepts(schema: &Value, value: &Value) -> bool {
    if schema.get("const").is_some_and(|expected| expected != value) { return false; }
    if schema["enum"].as_array().is_some_and(|values| !values.contains(value)) { return false; }
    if schema["required"].as_array().is_some_and(|keys| keys.iter().any(|key| value.get(key.as_str().unwrap()).is_none())) { return false; }
    if let Some(properties) = schema["properties"].as_object() {
        let Some(fields) = value.as_object() else { return false; };
        if schema["additionalProperties"] == false && fields.keys().any(|key| !properties.contains_key(key)) { return false; }
        if fields.iter().any(|(key, value)| properties.get(key).is_some_and(|schema| !accepts(schema, value))) { return false; }
    }
    if schema["oneOf"].as_array().is_some_and(|variants| variants.iter().filter(|schema| accepts(schema, value)).count() != 1) { return false; }
    if schema["anyOf"].as_array().is_some_and(|variants| !variants.iter().any(|schema| accepts(schema, value))) { return false; }
    true
}
fn output(request: &RequestSnapshot, step: usize) -> &varin_runtime::output::OutputBody {
    let result = request.view.history.iter().find_map(|item| match &item.content {
        Content::ToolResult { result } if result.call_id == format!("query-contract-{step}") => Some(&result.completion),
        _ => None,
    }).expect("the next model step must consume the persisted original result");
    match result {
        ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. }
        | ToolCompletion::JobAccepted { content: Some(content), .. } => content,
        _ => panic!("original query failed: {result:?}"),
    }
}
fn initial(name: &str, arguments: Value) -> Step {
    let name = name.to_owned();
    Box::new(move |_| (name.clone(), arguments.clone()))
}
impl ModelProvider for QuerySequence {
    fn serialize(&self, view: &RequestView, _: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(&self, request: &RequestSnapshot, _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>) -> Result<FinishReason, ModelFailure> {
        for schema in &self.schemas { assert!(request.view.binding.tools.contains(schema)); }
        let step = self.next.fetch_add(1, Ordering::SeqCst);
        let call = self.steps.get(step).map(|make| {
            let (name, arguments) = make(request);
            let schema = self.schemas.iter().find(|schema| schema.name == name).unwrap();
            assert!(accepts(&schema.schema, &arguments), "call must be expressible using the original declaration: {name} {arguments}");
            ToolCall { call_id: format!("query-contract-{step}"), name,
                schema_version: schema.version.clone(), arguments }
        });
        if call.is_none() { for step in 0..self.steps.len() { output(request, step); } }
        let called = call.is_some();
        emit(ProviderEvent::ItemCompleted { item: ProviderItem { id: request.view.request_id.clone(), opaque: None,
            content: call.map_or(Content::Text { text: "The original reader completed its continuation".into() }, |call| Content::ToolCall { call }) } }).unwrap();
        Ok(if called { FinishReason::ToolCalls } else { FinishReason::Stop })
    }
}
fn run_sequence(f: &Fixture, schemas: Vec<ToolSchema>, steps: Vec<Step>) {
    let schemas=schemas.into_iter().filter(|schema|f.original.tools.contains(schema)).collect();
    let count = vec![ToolCall { call_id: String::new(), name: String::new(), schema_version: String::new(), arguments: Value::Null }; steps.len()];
    execute_with_provider(f, true, count, &mut OwnerReplies::default(), false,
        Arc::new(QuerySequence { schemas, steps, next: AtomicUsize::new(0) }));
}
fn retained(f: &Fixture, step: usize) -> varin_runtime::output::OutputBody {
    f.catalog().lock().unwrap().execution_history(&f.run.branch_id).unwrap().into_iter().find_map(|item| match &item.content {
        Content::ToolResult { result } if result.call_id == format!("query-contract-{step}") => match &result.completion {
            ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. }
            | ToolCompletion::JobAccepted { content: Some(content), .. } => Some(content.clone()),
            other => panic!("query completion: {other:?}"),
        }, _ => None,
    }).unwrap()
}

#[test]
fn frozen_family_queries_continue_visible_cursors_and_offsets_after_reopen() {
    for legacy in [true, false] {
        let schemas = if legacy { original::family_schemas() } else { crate::family_tools::schemas() };
        let f = Fixture::with_tools(false, schemas.clone(), vec!["threads".into(), "read_thread".into()]);
        let item = {
            let catalog=f.catalog(); let mut db=catalog.lock().unwrap();
            let parent=db.history("branch:parent").unwrap().last().unwrap().clone();
            let epoch=db.epoch();
            db.append_history(&parent.run_id,epoch,Some(&parent.id),varin_runtime::HistorySource::Assistant,
                json!({"id":"original-large-history","provenance":{"kind":"assistant"},"opaque":null,
                    "content":{"kind":"text","text":"Original UTF-8 history 原文🙂 ".repeat(100)}}),None).unwrap().id
        };
        let f = f.reopen();
        let mut steps = vec![initial("threads", json!({"includeSelf":true,"limit":1}))];
        steps.push(Box::new(move |request| {
            let page=&output(request,0).model_data()["page"];
            let arguments=if legacy { assert!(page["nextCursor"].is_string()); json!({"includeSelf":true,"limit":1,"cursor":page["nextCursor"]}) }
                else { assert!(page.get("nextCursor").is_none()); page["nextRead"]["arguments"].clone() };
            ("threads".into(),arguments)
        }));
        steps.push(initial("read_thread",json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"recent","limit":1}})));
        steps.push(Box::new(move |request| {
            let page=&output(request,2).model_data()["page"];
            let arguments=if legacy { assert!(page["anchor"].is_string()); assert!(page["nextCursor"].is_string());
                json!({"threadId":page["threadId"],"branchId":page["branchId"],"anchor":page["anchor"],"cursor":page["nextCursor"],"query":{"kind":"recent","limit":1}}) }
                else { assert!(page.get("anchor").is_none()); page["nextRead"]["arguments"].clone() };
            ("read_thread".into(),arguments)
        }));
        steps.push(initial("read_thread",json!({"threadId":"thread:parent","branchId":"branch:parent","query":{"kind":"item","itemId":item,"maxBytes":31}})));
        steps.push(Box::new(move |request| {
            let page=&output(request,4).model_data()["page"];
            let arguments=if legacy { assert!(page["nextOffset"].as_u64().unwrap()>0);
                json!({"threadId":page["threadId"],"branchId":page["branchId"],"anchor":page["anchor"],
                    "query":{"kind":"item","itemId":page["itemId"],"offset":page["nextOffset"],"maxBytes":31}}) }
                else { assert!(page["ref"].is_string()); page["nextRead"]["arguments"].clone() };
            ("read_thread".into(),arguments)
        }));
        run_sequence(&f, schemas, steps);
        let f=f.reopen();
        assert_ne!(retained(&f,0).data["page"]["members"][0]["threadId"],retained(&f,1).data["page"]["members"][0]["threadId"]);
        assert_ne!(retained(&f,2).data["page"]["items"][0]["id"],retained(&f,3).data["page"]["items"][0]["id"]);
        assert_eq!(retained(&f,5).data["page"]["offset"],retained(&f,4).data["page"]["nextOffset"]);
        assert_eq!(f.catalog().lock().unwrap().launch_intent(&f.run.id).unwrap().unwrap().selection.tools,f.original.tools);
        f.finish();
    }
}

#[test]
fn frozen_followup_queries_continue_original_occurrences_after_reopen() {
    use varin_runtime::catalog::followups::*;
    for legacy in [true,false] {
        let schema=if legacy {original::followup_schema()} else {crate::followup_tools::schema()};
        let f=Fixture::with_tools(false,vec![schema.clone()],vec!["follow_up".into()]);
        let job=accepted_family_job(&f,"original-query-pages");
        let id={
            let owner=f.catalog();let mut db=owner.lock().unwrap();
            let p=db.prepare_followup_registration("original-query-log",&f.run.id,FollowupRegistration {
                repeat:FollowupRepeat::Each,trigger:FollowupRegistrationTrigger::LogLiteral {
                    operation_id:job.operation_id.clone(),stream:LogStream::Stdout,literal:"record".into(),from_offset:None},
                instruction:"Inspect every original record".into(),wait:None}).unwrap().load().unwrap();
            let admitted=db.admit_followup_registration(p).unwrap();
            for n in 0..66u64 {
                let work=db.followup_research_works(None).unwrap().0.into_iter().find(|work|work.key.followup_id==admitted.followup.id).unwrap();
                let expected=work.log.clone().unwrap();let end=(n+1)*6;
                db.apply_log_observation(FollowupLogObservation {key:work.key,binding:job.clone(),expected,
                    next:FollowupLogState {offset:end,matched_prefix:0,ended:false,failure_code:None},
                    evidence:Some(FollowupLogEvidence::LogLiteral {binding:job.clone(),stream:LogStream::Stdout,
                        start_offset:n*6,end_offset:end,published_bytes:end,job_revision:n+2})}).unwrap();
            }
            admitted.followup.id
        };
        let f=f.reopen();
        let continuation_id=id.clone();let occurrence_id=id.clone();
        let steps=vec![initial("follow_up",json!({"action":"occurrences","followupId":id})),
            Box::new(move |request:&RequestSnapshot| {
                let page=output(request,0).model_data();
                let arguments=if legacy {assert!(page["nextCursor"].is_u64());json!({"action":"occurrences","followupId":continuation_id,"after":page["nextCursor"]})}
                    else {assert!(page.get("nextCursor").is_none());page["nextRead"]["arguments"].clone()};
                ("follow_up".into(),arguments)
            }) as Step,
            Box::new(move |request:&RequestSnapshot| {
                let page=output(request,1).model_data();assert_eq!(page["occurrences"].as_array().unwrap().len(),2);
                let arguments=if legacy {json!({"action":"occurrence","followupId":occurrence_id,"occurrenceId":page["occurrences"][0]["id"]})}
                    else {page["occurrences"][0]["read"]["arguments"].clone()};
                ("follow_up".into(),arguments)
            }) as Step];
        run_sequence(&f,vec![schema],steps);
        let f=f.reopen();
        assert_eq!(retained(&f,0).data["occurrences"].as_array().unwrap().len(),64);
        assert_eq!(retained(&f,1).data["occurrences"][0]["id"],retained(&f,2).data["occurrence"]["id"]);
        assert_eq!(f.catalog().lock().unwrap().launch_intent(&f.run.id).unwrap().unwrap().selection.tools,f.original.tools);
        f.finish();
    }
}

#[test]
fn frozen_message_receipts_advertise_a_declared_family_reader() {
    for legacy in [true,false] {
        let mut schemas=if legacy {original::family_schemas()} else {crate::family_tools::schemas()};
        schemas.push(crate::message_tools::schema());schemas.sort_by(|a,b|a.name.cmp(&b.name));
        let f=Fixture::with_tools(false,schemas.clone(),vec!["send".into(),"read_thread".into()]).reopen();
        let steps=vec![initial("send",json!({"targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":"inform","text":"The original child can still inspect its recipient"})),
            Box::new(move |request:&RequestSnapshot| {
                let message=&output(request,0).model_data()["message"];
                assert!(message["ref"].as_str().unwrap().starts_with("msg:"));
                if legacy {assert!(message["nextRead"]["arguments"].get("ref").is_none());}
                else {assert!(message["nextRead"]["arguments"]["ref"].is_string());}
                ("read_thread".into(),message["nextRead"]["arguments"].clone())
            }) as Step];
        run_sequence(&f,schemas,steps);f.finish();
    }
}
