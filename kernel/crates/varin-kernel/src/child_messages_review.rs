//! Actual child assembly and ordinary Operation path, both frozen invocation origins.
use super::*;
use varin_runtime::catalog::messages::*;
#[test]
fn selected_send_is_a_durable_effect_from_model_and_policy_with_real_agent_actor() {
    for (model, kind) in [
        (true, "inform"),
        (false, "inform"),
        (true, "request"),
        (false, "request"),
    ] {
        let f = Fixture::with_tools(
            false,
            vec![crate::message_tools::schema()],
            vec!["send".into()],
        );
        let calls = vec![ToolCall {
            call_id: "message".into(),
            name: "send".into(),
            schema_version: "3".into(),
            arguments: json!({"targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":kind,"text":"Child original progress"}),
        }];
        execute(&f, model, calls, &mut OwnerReplies::default(), false);
        let catalog = f.catalog();
        let mut db = catalog.lock().unwrap();
        let page = db
            .capture_message_list(
                "thread:parent".into(),
                "branch:parent".into(),
                MessageDirection::Incoming,
                None,
                None,
            )
            .unwrap()
            .load(&|| false)
            .unwrap();
        assert_eq!(page.messages.len(), 1);
        let receipt = &page.messages[0].receipt;
        let MessageActor::Agent {
            run_id,
            operation_id,
            origin,
        } = &receipt.identity.actor
        else {
            panic!("real Agent required")
        };
        assert_eq!(run_id, &f.run.id);
        assert_eq!(matches!(origin, ToolOrigin::ModelStep { .. }), model);
        let operation = db.operation(operation_id).unwrap();
        let public = db.capture_operation_read(operation.clone()).load().unwrap();
        let invocation: ToolInvocation = serde_json::from_value(public.intent.clone()).unwrap();
        let context = ToolExecutionContext {
            run_id: run_id.clone(),
            operation_id: operation_id.clone(),
            origin: origin.clone(),
        };
        let one = db
            .prepare_tool_message(
                &context,
                invocation.call.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(invocation.call.arguments.clone()).unwrap(),
            )
            .unwrap()
            .load()
            .unwrap();
        let two = db
            .prepare_tool_message(
                &context,
                invocation.call.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(invocation.call.arguments.clone()).unwrap(),
            )
            .unwrap()
            .load()
            .unwrap();
        let replay = db.admit_message(one).unwrap();
        assert!(!replay.accepted);
        assert_eq!(&replay.receipt, receipt);
        assert_eq!(
            serde_json::to_value(&replay.completion).unwrap(),
            serde_json::to_value(&public.call_completion).unwrap()
        );
        assert_eq!(db.admit_message(two).unwrap().completion, replay.completion);
        let mut changed = invocation.call.clone();
        changed.arguments["text"] = json!("conflicting retry");
        assert!(
            db.prepare_tool_message(
                &context,
                changed.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(changed.arguments.clone()).unwrap()
            )
            .unwrap()
            .load()
            .is_err()
        );
        assert_eq!(operation.effect, Effect::Confirmed);
        assert!(operation.call_completion.is_some());
        assert!(page.messages[0].delivered_run_id.is_none());
        let parent = db.child_task(&f.child.operation_id).unwrap().parent_run_id;
        let head = db.head("branch:parent").unwrap();
        let prepared = db
            .prepare_input_delivery(&parent, db.epoch(), head.as_deref())
            .unwrap()
            .load()
            .unwrap();
        let batch = db.admit_input_delivery(prepared).unwrap().unwrap();
        assert_eq!(batch.activating, kind == "request");
        assert_eq!(batch.items.len(), 1);
        assert!(
            matches!(&batch.items[0].provenance,Provenance::AgentMessage{thread_id} if thread_id==&f.run.thread_id)
        );
        assert_eq!(
            db.history("branch:parent").unwrap().last().unwrap().source,
            varin_runtime::HistorySource::Agent
        );
        assert_eq!(
            db.execution_history("branch:parent")
                .unwrap()
                .last()
                .unwrap(),
            &batch.items[0]
        );
        let receipt = receipt.clone();
        let completion = public.call_completion;
        drop(db);
        drop(catalog);
        let f = f.reopen();
        let catalog = f.catalog();
        let mut db = catalog.lock().unwrap();
        let prepared = db
            .prepare_tool_message(
                &context,
                invocation.call.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(invocation.call.arguments.clone()).unwrap(),
            )
            .unwrap()
            .load()
            .unwrap();
        let replay = db.admit_message(prepared).unwrap();
        assert_eq!(replay.receipt, receipt);
        assert_eq!(
            serde_json::to_value(&replay.completion).unwrap(),
            serde_json::to_value(&completion).unwrap()
        );
        assert_eq!(
            db.capture_message(
                "thread:parent",
                "branch:parent",
                &receipt.identity.message_id
            )
            .unwrap()
            .load()
            .unwrap()
            .text,
            "Child original progress"
        );
        drop(db);
        drop(catalog);
        f.finish();
    }
}
#[test]
fn send_rejects_unselected_and_model_supplied_sender_before_any_message_is_accepted() {
    let f = Fixture::with_tools(
        false,
        vec![crate::message_tools::schema()],
        vec!["helper".into()],
    );
    f.prepare_policy(0, "http://127.0.0.1:1/unused");
    let start = f.start(0);
    let context = FrozenToolContext {
        run_id: f.run.id.clone(),
        origin: ToolOrigin::ModelStep {
            request_id: "not-admitted".into(),
        },
        tools: Arc::new(start.binding.tools.clone()),
        tool_schema_generation: start.binding.tool_schema_generation,
        source: f.original.source.clone(),
        child_dispatch: None,
        resource_checkpoint_id: None,
        resource_activations: vec![],
    };
    let call = ToolCall {
        call_id: "reject".into(),
        name: "send".into(),
        schema_version: "3".into(),
        arguments: json!({"targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":"inform","text":"not selected"}),
    };
    assert!(
        start
            .tools
            .prepare(&call, &context, &CancellationToken::default())
            .is_err()
    );
    assert!(!start.binding.tools.iter().any(|tool| tool.name == "send"));
    drop(start);
    let f = f.reopen();
    let start = f.start(0);
    assert!(!start.binding.tools.iter().any(|tool| tool.name == "send"));
    drop(start);
    f.finish();
    let f = Fixture::with_tools(
        false,
        vec![crate::message_tools::schema()],
        vec!["send".into()],
    );
    execute(
        &f,
        true,
        vec![ToolCall {
            call_id: "reject".into(),
            name: "send".into(),
            schema_version: "3".into(),
            arguments: json!({"targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":"inform","text":"forged user","actor":{"kind":"user"}}),
        }],
        &mut OwnerReplies::default(),
        false,
    );
    assert!(
        f.catalog()
            .lock()
            .unwrap()
            .capture_message_list(
                "thread:parent".into(),
                "branch:parent".into(),
                MessageDirection::Incoming,
                None,
                None
            )
            .unwrap()
            .load(&|| false)
            .unwrap()
            .messages
            .is_empty()
    );
    f.finish();
}

#[path = "message_wait_review.rs"]
mod wait_review;

fn enable_fixed_file_reader(f: &mut Fixture) {
    let source = f.original.source.as_ref().unwrap();
    let root = f.root.join("file-storage");
    let mut storage = crate::storage::Storage::open(&root, "child-file-host").unwrap();
    for (id, capabilities) in [
        ("writer", vec!["storage.admin"]),
        ("child-source-grant", vec!["storage.read"]),
    ] {
        storage.issue_grant(&json!({"grantId":id,"hostGeneration":"child-files","capabilities":capabilities,"pathScopes":[""],"threadId":f.run.thread_id,"runId":f.run.id,"owningWorkspace":source.workspace_id,"executionWorkspace":source.execution_workspace_id}),"child-file-host","child-files",&root.to_string_lossy(),EPOCH).unwrap();
    }
    let mut invoke = |method: &str, params: Value| {
        let (grant, params) = storage
            .authorize(
                Some("writer"),
                EPOCH,
                "child-file-host",
                "child-files",
                method,
                &params,
            )
            .unwrap();
        storage
            .dispatch(method, &params, Some("writer"), &grant)
            .unwrap()
    };
    invoke(
        "branch.create.begin",
        json!({"operationId":"file-fixture","builderId":"file-fixture","workspaceId":source.workspace_id,"branchId":source.branch_id,"draftBasePaths":[],"captureScopes":[]}),
    );
    invoke(
        "branch.create.append",
        json!({"builderId":"file-fixture","sequence":0,"entries":[{"path":"result.txt","state":{"kind":"directory","mode":493}}]}),
    );
    let branch = invoke(
        "branch.create.finish",
        json!({"operationId":"file-fixture","builderId":"file-fixture"}),
    );
    assert_eq!(branch["headRevision"], json!(source.revision.unwrap()));
    let storage = Arc::new(Mutex::new(storage));
    let (tx, _rx) = mpsc::sync_channel(1);
    let bridge = crate::host_query::OwnerChannel::new("file-observation", tx);
    let client = crate::file_observation::Client::new(
        move |command| {
            command.serve(
                Some(&mut storage.lock().unwrap()),
                EPOCH,
                "child-file-host",
                "child-files",
            );
            Ok(())
        },
        bridge,
    );
    f.assembly.resources = f.assembly.resources.clone().with_file_observations(client);
}

fn accepted_family_job(
    f: &Fixture,
    key: &str,
) -> varin_runtime::catalog::host_jobs::HostJobBinding {
    let owner = f.catalog();
    let mut db = owner.lock().unwrap();
    let parent = db.child_task(&f.child.operation_id).unwrap().parent_run_id;
    let run = db.run(&parent).unwrap();
    let prepared = db
        .prepare_result_content()
        .write_result(&json!({"requestId":key}))
        .unwrap();
    let op = db
        .admit_user_host_job(
            &run.thread_id,
            &run.branch_id,
            &run.id,
            key,
            "research.experiment",
            1,
            &format!("attempt:{key}"),
            prepared,
        )
        .unwrap();
    let binding = op.host_job.unwrap().binding;
    db.begin_host_job(binding.clone()).unwrap();
    let varin_runtime::catalog::host_jobs::HostJobSubject::Workspace { subject_id, .. } = &binding.subject else { panic!("research workspace subject required") };
    let accepted=db.prepare_result_content().write_result(&json!({"attempt":{"attemptId":subject_id},"text":"accepted original family experiment"})).unwrap();
    db.accept_host_job(binding.clone(), accepted).unwrap();
    binding
}
fn stop_family_job(f: &Fixture, binding: &varin_runtime::catalog::host_jobs::HostJobBinding) {
    let varin_runtime::catalog::host_jobs::HostJobSubject::Workspace { subject_id, .. } = &binding.subject else { panic!("research workspace subject required") };
    let owner = f.catalog();
    let mut db = owner.lock().unwrap();
    let op = db.operation(&binding.operation_id).unwrap();
    let varin_runtime::ExecutorOwner::External { epoch, .. } = &binding.execution_owner else {
        panic!()
    };
    let receipt = db
        .prepare_result_content()
        .write_external_receipt(varin_runtime::ExternalReceipt {
            executor: op.executor.unwrap(),
            identity: op.id,
            epoch: epoch.clone(),
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            result: json!({"attemptId":subject_id,"collectionState":"pending"}).into(),
        })
        .unwrap();
    db.record_host_job_terminal(binding, receipt, true).unwrap();
}

#[test]
fn explicit_followup_uses_both_real_origins_and_separates_registration_from_wait() {
    use varin_runtime::catalog::followups::{
        FollowupActor, NextRunWaitState, observation::FollowupObservationState,
    };
    for (trigger_kind, model) in [
        "at",
        "any",
        "all",
        "file",
        "repeating_file",
        "job_stopped",
        "any_job",
        "all_job",
        "artifact",
        "collection",
        "any_artifact",
        "all_artifact",
        "each_artifact",
        "each_collection",
    ]
    .into_iter()
    .flat_map(|kind| [true, false].map(|model| (kind, model)))
    {
        for wait in [false, true] {
            let mut f = Fixture::with_tools(
                false,
                vec![crate::followup_tools::schema()],
                vec!["follow_up".into()],
            );
            if matches!(trigger_kind, "file" | "repeating_file") {
                enable_fixed_file_reader(&mut f);
            }
            let deadline = varin_runtime::catalog::observations::wall_time_ms().unwrap() + 60_000;
            let mut args = json!({"action":"register","trigger":{"kind":"at","atMs":deadline},"instruction":"Check this delegated task once at the requested time"});
            let job = (trigger_kind.contains("job")
                || trigger_kind.contains("artifact")
                || trigger_kind.contains("collection"))
            .then(|| accepted_family_job(&f, "followup-family"));
            if let Some(job) = &job {
                let leaf = json!({"kind":if trigger_kind.contains("collection") {"collection"} else if trigger_kind.contains("artifact") {"artifact"} else {"job_stopped"},"operationId":job.operation_id});
                args["trigger"] = if !trigger_kind.starts_with("any_")
                    && !trigger_kind.starts_with("all_")
                {
                    leaf
                } else {
                    json!({"kind":if trigger_kind.starts_with("any_") {"any"} else {"all"},"sources":[leaf,{"kind":"at","atMs":deadline}]})
                };
            } else if matches!(trigger_kind, "file" | "repeating_file") {
                args["trigger"] = json!({"kind":"all","sources":[{"kind":"file","path":"result.txt","condition":"exists"},{"kind":"file","path":"result.txt","condition":"changed"}]});
            } else if trigger_kind != "at" {
                args["trigger"] = json!({"kind":trigger_kind,"sources":[{"kind":"at","atMs":deadline},{"kind":"at","atMs":deadline+1}]});
            }
            if trigger_kind == "repeating_file" {
                args["repeat"] = json!("each");
                args["trigger"] = json!({"kind":"file","path":"result.txt","condition":"changed"});
            }
            if trigger_kind.starts_with("each_") {
                args["repeat"] = json!("each");
            }
            if wait {
                args["wait"] = json!({});
            }
            let calls = vec![ToolCall {
                call_id: "one-check".into(),
                name: "follow_up".into(),
                schema_version: crate::followup_tools::schema().version,
                arguments: args,
            }];
            if wait {
                wait_review::waiting(&f, model, calls)
            } else {
                execute(&f, model, calls, &mut OwnerReplies::default(), false);
            }
            let owner = f.catalog();
            let mut db = owner.lock().unwrap();
            let followups = db.followups(&f.run.thread_id).unwrap();
            assert_eq!(followups.len(), 1);
            let value = &followups[0];
            if trigger_kind == "repeating_file" {
                assert_eq!(
                    value.repeat,
                    varin_runtime::catalog::followups::FollowupRepeat::Each
                );
                assert!(value.sources[0].observed.is_none());
                assert!(value.sources[0].file.as_ref().unwrap().immutable);
            }
            if trigger_kind == "file" {
                assert!(value.sources[0].observed.is_some());
                assert!(value.sources[1].observed.is_none());
                assert!(value.sources[1].file.as_ref().unwrap().immutable);
            }
            if let Some(job) = &job {
                assert_eq!(db.host_job_sources(&f.run.id).unwrap()[0].binding, *job);
                assert_ne!(
                    db.host_job_sources(&f.run.id).unwrap()[0].source_run_id,
                    f.run.id
                );
                assert_eq!(value.source_run_id, f.run.id);
                assert!(!db.operation(&job.operation_id).unwrap().cancel_requested);
            }
            let FollowupActor::Agent {
                run_id,
                operation_id,
                origin,
            } = &value.actor
            else {
                panic!("actual agent actor")
            };
            assert_eq!(run_id, &f.run.id);
            assert_eq!(matches!(origin, ToolOrigin::ModelStep { .. }), model);
            let op = db.operation(operation_id).unwrap();
            assert_eq!(op.effect, Effect::Confirmed);
            let view = db.capture_followup(&value.id).unwrap();
            if wait {
                assert_eq!(op.phase, varin_runtime::OperationPhase::Waiting);
                assert_eq!(
                    value.observation.as_ref().unwrap().state,
                    FollowupObservationState::Waiting
                );
                assert_eq!(
                    db.run(&f.run.id).unwrap().state,
                    varin_runtime::RunState::Waiting
                );
                // Original User input ends only this observation, retaining the accepted intent.
                db.enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
                    key: "new-user".into(),
                    thread_id: f.run.thread_id.clone(),
                    branch_id: f.run.branch_id.clone(),
                    mode: varin_runtime::InputMode::Boundary,
                    configuration: None,
                    input: json!("Continue with something else"),
                })
                .unwrap();
                assert_eq!(
                    db.followup(&value.id).unwrap().wait.state,
                    NextRunWaitState::Waiting
                );
            } else {
                assert!(value.observation.is_none());
                assert_eq!(op.phase, varin_runtime::OperationPhase::Terminal);
            }
            drop(db);
            assert_eq!(
                view.load().unwrap().instruction.as_deref(),
                Some("Check this delegated task once at the requested time")
            );
            drop(owner);
            f.finish();
        }
    }
}

#[test]
#[cfg(target_os = "linux")]
fn native_followup_all_instants_deliver_original_wait_and_one_active_ingress_without_host_polling()
{
    use varin_runtime::catalog::followups::{
        NextRunWaitState, observation::FollowupObservationState,
    };
    let f = Fixture::with_tools(
        false,
        vec![crate::followup_tools::schema()],
        vec!["follow_up".into()],
    );
    let deadline = varin_runtime::catalog::observations::wall_time_ms().unwrap() + 200;
    wait_review::waiting(
        &f,
        true,
        vec![ToolCall {
            call_id: "wake-once".into(),
            name: "follow_up".into(),
            schema_version: crate::followup_tools::schema().version,
            arguments: json!({"action":"register","trigger":{"kind":"all","sources":[{"kind":"at","atMs":deadline-100},{"kind":"at","atMs":deadline}]},"instruction":"Inspect current work once","wait":{}}),
        }],
    );
    let (signal, wakes) = crate::continuation_wake::channel().unwrap();
    let (events, rx) = mpsc::sync_channel(1);
    f.catalog()
        .lock()
        .unwrap()
        .set_event_notifier(events)
        .unwrap();
    let owner = Arc::downgrade(&f.assembly.runtime);
    let worker = std::thread::spawn(move || crate::continuation_wake::drive(owner, wakes));
    let guard = crate::continuation_wake::StopGuard(signal.clone());
    signal.notify();
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        rx.recv_timeout(end.saturating_duration_since(Instant::now()))
            .expect("native At event");
        signal.notify();
        let db = f.catalog();
        let db = db.lock().unwrap();
        let followup = db.followups(&f.run.thread_id).unwrap().remove(0);
        if followup.observation.as_ref().is_some_and(|o| o.delivered)
            && followup
                .occurrence
                .as_ref()
                .is_some_and(|o| o.delivery.is_some())
        {
            assert_eq!(followup.wait.state, NextRunWaitState::Observed);
            assert_eq!(
                followup.observation.unwrap().state,
                FollowupObservationState::Triggered
            );
            assert_eq!(
                followup
                    .occurrence
                    .unwrap()
                    .delivery
                    .unwrap()
                    .run_id
                    .as_deref(),
                Some(f.run.id.as_str())
            );
            assert_eq!(db.nearest_wait_deadline().unwrap(), None);
            break;
        }
    }
    drop(guard);
    worker.join().unwrap();
    f.finish();
}

#[test]
fn followup_get_list_and_control_consume_real_retained_user_instruction_from_both_origins() {
    use varin_runtime::catalog::followups::*;
    for model in [true, false] {
        let f = Fixture::with_tools(
            false,
            vec![crate::followup_tools::schema()],
            vec!["follow_up".into()],
        );
        let owner = f.catalog();
        let at_ms = varin_runtime::catalog::observations::wall_time_ms().unwrap() + 60_000;
        let prepared = owner
            .lock()
            .unwrap()
            .prepare_followup_registration(
                "user-instruction",
                &f.run.id,
                FollowupRegistration {
                    repeat: varin_runtime::catalog::followups::FollowupRepeat::Once,
                    trigger: FollowupRegistrationTrigger::At { at_ms },
                    instruction: "User retained original instruction".into(),
                    wait: None,
                },
            )
            .unwrap()
            .load()
            .unwrap();
        owner
            .lock()
            .unwrap()
            .admit_followup_registration(prepared)
            .unwrap();
        let job = accepted_family_job(&f, "discover-family");
        let calls=[json!({"action":"get","followupId":"user-instruction"}),json!({"action":"list"}),json!({"action":"jobs"}),json!({"action":"occurrences","followupId":"user-instruction"}),json!({"action":"control","followupId":"user-instruction","expectedRevision":1,"control":"cancel"})].into_iter().enumerate().map(|(n,arguments)|ToolCall{call_id:format!("manage-{n}"),name:"follow_up".into(),schema_version:crate::followup_tools::schema().version,arguments}).collect();
        execute(&f, model, calls, &mut OwnerReplies::default(), false);
        let read = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
        let mut values = Vec::new();
        if model {
            for item in owner
                .lock()
                .unwrap()
                .execution_history(&f.run.branch_id)
                .unwrap()
            {
                if let Content::ToolResult { result } = &item.content {
                    if result.call_id.starts_with("manage-") {
                        let ToolCompletion::Result {
                            outcome: varin_runtime::Outcome::Succeeded,
                            content,
                            ..
                        } = &result.completion
                        else {
                            panic!("actual ModelStep management result failed")
                        };
                        values.push((result.call_id.clone(), content.data.clone()));
                    }
                }
            }
        } else {
            let mut q=read.prepare("SELECT n.action_id,n.node_id,n.receipt FROM policy_graph_nodes n JOIN operations o ON o.id=n.action_id WHERE o.run_id=?1 ORDER BY n.rowid").unwrap();
            let rows = q
                .query_map([&f.run.id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            for (action_id, node_id, receipt) in rows {
                let receipt: Value = serde_json::from_str(&receipt).unwrap();
                assert_eq!(receipt["completion"]["outcome"], "succeeded");
                let reference = PolicyEvidenceRef {
                    action_id,
                    node_id: node_id.clone(),
                    content_ref: receipt["completion"]["content_ref"]["content_object"]
                        .as_str()
                        .unwrap()
                        .into(),
                };
                let db = owner.lock().unwrap();
                // This is the original durable node output, not a new terminal policy read.
                let first = db
                    .policy_output_chunk(
                        &f.run.id,
                        &reference.action_id,
                        &reference.node_id,
                        &reference.content_ref,
                        0,
                    )
                    .unwrap();
                let mut bytes = first.bytes;
                for index in 1..first.chunk_count {
                    bytes.extend(
                        db.policy_output_chunk(
                            &f.run.id,
                            &reference.action_id,
                            &reference.node_id,
                            &reference.content_ref,
                            index,
                        )
                        .unwrap()
                        .bytes,
                    );
                }
                let body: OutputBody = serde_json::from_slice(&bytes).unwrap();
                values.push((node_id, body.data));
            }
        }
        assert_eq!(values.len(), 5);
        let jobs = &values.iter().find(|(id, _)| id == "manage-2").unwrap().1;
        assert_eq!(jobs[0]["binding"]["operationId"], job.operation_id);
        assert_ne!(jobs[0]["sourceRunId"], f.run.id);
        assert!(jobs[0].get("accepted").is_none() && jobs[0].get("intent").is_none());
        assert_eq!(
            values.iter().find(|(id, _)| id == "manage-0").unwrap().1["instruction"],
            "User retained original instruction"
        );

        assert_eq!(
            owner
                .lock()
                .unwrap()
                .followup("user-instruction")
                .unwrap()
                .state,
            FollowupState::Cancelled
        );
        drop(read);
        drop(owner);
        f.finish();
    }
}

#[test]
#[cfg(target_os = "linux")]
fn native_calendar_deadline_observes_one_true_cold_thread_without_host_timer_or_model() {
    use varin_runtime::catalog::calendar::*;
    let f = Fixture::with_tools(
        false,
        vec![crate::followup_tools::schema()],
        vec!["follow_up".into()],
    );
    let owner = f.catalog();
    let input = DefinitionInput {
        task_id: "native-calendar".into(),
        asset_revision: "asset:1".into(),
        asset_kind: AssetKind::Gui,
        name: "Native calendar".into(),
        enabled: true,
        activation_hold: None,
        once_acceptance: None,
        timezone: "UTC".into(),
        rule: Rule::Once {
            date: "2026-10-10".into(),
            time: "09:00".into(),
        },
        missed_policy: MissedPolicy::CoalesceOnce,
        target: Target::NewWork {
            model: ModelSelection {
                provider_id: "fixture".into(),
                model_id: "fixture".into(),
                thinking_level: None,
                temperature: None,
            },
            source: varin_runtime::catalog::calendar::Source::Project,
            source_mode: varin_runtime::SourceMode::LiveRoot,
            goal: None,
        },
        instruction: "Prepare real cold work when due".into(),
    };
    let prepared = owner
        .lock()
        .unwrap()
        .prepare_calendar_sync("project-fixture".into(), None, vec![input])
        .unwrap()
        .load()
        .unwrap();
    let definition = owner
        .lock()
        .unwrap()
        .admit_calendar_sync(prepared)
        .unwrap()
        .definitions
        .remove(0);
    let calculation = owner
        .lock()
        .unwrap()
        .calendar_pending()
        .unwrap()
        .calculations
        .pop()
        .unwrap();
    let deadline = varin_runtime::catalog::observations::wall_time_ms().unwrap() + 200;
    let slot = Slot {
        at_ms: deadline,
        following_at_ms: None,
    };
    owner
        .lock()
        .unwrap()
        .admit_calendar_calculation(
            calculation,
            Some(CalculationResult {
                next: Some(slot.clone()),
                latest_due: None,
                next_future: Some(slot),
            }),
            None,
        )
        .unwrap();
    let (signal, wakes) = crate::continuation_wake::channel().unwrap();
    let (events, rx) = mpsc::sync_channel(1);
    owner.lock().unwrap().set_event_notifier(events).unwrap();
    let runtime = Arc::downgrade(&f.assembly.runtime);
    let worker = std::thread::spawn(move || crate::continuation_wake::drive(runtime, wakes));
    let guard = crate::continuation_wake::StopGuard(signal.clone());
    signal.notify();
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        rx.recv_timeout(end.saturating_duration_since(Instant::now()))
            .expect("native calendar event");
        signal.notify();
        let db = owner.lock().unwrap();
        let occurrences = db.calendar_occurrences(&definition.id).unwrap();
        if let Some(occurrence) = occurrences.first() {
            assert_eq!(occurrences.len(), 1);
            assert_eq!(
                occurrence.reason,
                OccurrenceReason::Scheduled { at_ms: deadline }
            );
            assert!(occurrence.observed_at_ms >= deadline);
            assert!(occurrence.thread_id.starts_with("thread:"));
            assert!(occurrence.run_id.is_none() && occurrence.input_id.is_none());
            assert!(db.history(&occurrence.branch_id).unwrap().is_empty());
            assert_eq!(
                db.calendar_pending().unwrap().preparations[0].id,
                occurrence.id
            );
            assert_eq!(db.nearest_wait_deadline().unwrap(), None);
            break;
        }
    }
    drop(guard);
    worker.join().unwrap();
    drop(owner);
    f.finish();
}

#[test]
#[cfg(target_os = "linux")]
fn accepted_job_stop_wakes_original_followup_observation_and_active_child_ingress() {
    use varin_runtime::catalog::followups::observation::FollowupObservationState;
    let f = Fixture::with_tools(
        false,
        vec![crate::followup_tools::schema()],
        vec!["follow_up".into()],
    );
    let job = accepted_family_job(&f, "wake-job");
    wait_review::waiting(
        &f,
        true,
        vec![ToolCall {
            call_id: "await-job".into(),
            name: "follow_up".into(),
            schema_version: crate::followup_tools::schema().version,
            arguments: json!({"action":"register","trigger":{"kind":"job_stopped","operationId":job.operation_id},"instruction":"Inspect original experiment when it stops","wait":{}}),
        }],
    );
    let (signal, wakes) = crate::continuation_wake::channel().unwrap();
    let (events, rx) = mpsc::sync_channel(1);
    f.catalog()
        .lock()
        .unwrap()
        .set_event_notifier(events)
        .unwrap();
    let owner = Arc::downgrade(&f.assembly.runtime);
    let worker = std::thread::spawn(move || crate::continuation_wake::drive(owner, wakes));
    let guard = crate::continuation_wake::StopGuard(signal.clone());
    stop_family_job(&f, &job);
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        rx.recv_timeout(end.saturating_duration_since(Instant::now()))
            .expect("original stop event wake");
        signal.notify();
        let owner = f.catalog();
        let db = owner.lock().unwrap();
        let value = db.followups(&f.run.thread_id).unwrap().remove(0);
        if value.observation.as_ref().is_some_and(|o| o.delivered)
            && value
                .occurrence
                .as_ref()
                .is_some_and(|o| o.delivery.is_some())
        {
            assert_eq!(
                value.observation.unwrap().state,
                FollowupObservationState::Triggered
            );
            assert_eq!(
                value
                    .occurrence
                    .unwrap()
                    .delivery
                    .unwrap()
                    .run_id
                    .as_deref(),
                Some(f.run.id.as_str())
            );
            assert!(db.host_job_sources(&f.run.id).unwrap()[0].executor_stopped);
            break;
        }
    }
    drop(guard);
    worker.join().unwrap();
    f.finish();
}

#[test]
fn repeating_family_job_then_time_uses_real_idle_and_active_child_occurrences() {
    use varin_runtime::catalog::{delegated::DelegatedTrigger, followups::*};
    for event_kind in ["job_stopped", "artifact", "collection"] {
        let mut f = Fixture::with_tools(
            false,
            vec![crate::followup_tools::schema()],
            vec!["follow_up".into()],
        );
        enable_fixed_file_reader(&mut f);
        let job = accepted_family_job(&f, "cold-child-job");
        execute(
            &f,
            false,
            vec![ToolCall {
                call_id: "after-job".into(),
                name: "follow_up".into(),
                schema_version: crate::followup_tools::schema().version,
                arguments: json!({"action":"register","repeat":"each","trigger":{"kind":"any","sources":[{"kind":event_kind,"operationId":job.operation_id},{"kind":"at","atMs":varin_runtime::catalog::observations::MAX_DEADLINE_MS},{"kind":"file","path":"result.txt","condition":"changed"}]},"instruction":"Continue the child's original work after the family experiment stops"}),
            }],
            &mut OwnerReplies::default(),
            false,
        );
        let owner = f.catalog();
        let reports = owner
            .lock()
            .unwrap()
            .capture_child_reports()
            .unwrap()
            .load()
            .unwrap();
        for report in reports {
            owner.lock().unwrap().admit_child_report(report).unwrap();
        }
        assert!(
            owner
                .lock()
                .unwrap()
                .run(&f.run.id)
                .unwrap()
                .state
                .terminal()
        );
        if event_kind == "job_stopped" {
            stop_family_job(&f, &job);
        } else {
            publish_research_fact(&f, &job, event_kind, 1);
        }
        drop(owner);
        let f = f.reopen();
        let owner = f.catalog();
        reconcile(&owner).unwrap();
        let mut db = owner.lock().unwrap();
        let value = db.followups(&f.run.thread_id).unwrap().remove(0);
        let child = db
            .delegated_executions(Some(&f.child.operation_id))
            .unwrap()
            .into_iter()
            .find(|v| matches!(v.trigger, DelegatedTrigger::Followup { .. }))
            .expect("real follow-up child execution");
        assert_ne!(child.execution_id, f.child.operation_id);
        assert_eq!(value.source_run_id, f.run.id);
        assert_eq!(
            value
                .occurrence
                .as_ref()
                .unwrap()
                .delivery
                .as_ref()
                .unwrap()
                .execution_id
                .as_deref(),
            Some(child.execution_id.as_str())
        );
        assert!(child.receipt.is_none());
        assert_eq!(
            child.source_basis.as_ref().unwrap().source().workspace_id,
            f.original.source.as_ref().unwrap().workspace_id
        );
        // Prepare through the same original child source/context owner. No original Run is revived.
        let mut source = child.source_basis.as_ref().unwrap().source().clone();
        source.branch_id = Some(format!("child-source:{}", child.execution_id));
        source.revision = Some(0);
        source.environment_run_id = None;
        let root = child.source_basis.as_ref().unwrap().root().to_owned();
        let prepared = db
            .prepare_child_source(
                &child.execution_id,
                varin_runtime::catalog::collaboration::ChildSourcePin {
                    pin_id: format!("child-source-pin:{}", child.execution_id),
                    root: root.clone(),
                    source: source.clone(),
                },
                source.clone(),
                varin_runtime::catalog::collaboration::ChildSourceProvenance::FixedRoot {
                    root,
                    resources: None,
                },
            )
            .unwrap()
            .load()
            .unwrap();
        db.attach_child_source(prepared).unwrap();
        let task = db.execution_task(&child.execution_id).unwrap();
        let proposal = varin_runtime::catalog::context::ContextProposal {
            key: "job-followup-child-context".into(),
            branch_id: task.child_branch_id.clone(),
            through_id: None,
            expected_revision: 0,
            summary: String::new(),
            effective_system_prompt: "Independent continuation".into(),
            instruction_sources: vec![],
            memory_checkpoint: None,
        };
        let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"job-child","memorySnapshot":{"revision":0,"memories":[]},"threadId":task.child_thread_id,"projectId":task.project_id,"originalSections":[{"name":"system","content":"Independent continuation"}],"instructionSources":[]})).unwrap();
        let p = db
            .capture_child_preparation(&child.execution_id, Some(source), proposal, basis)
            .unwrap()
            .load()
            .unwrap();
        let admitted = db.admit_child(p).unwrap();
        let next = admitted.receipt.unwrap().run_id;
        assert_ne!(next, f.run.id);
        assert_eq!(db.run(&f.run.id).unwrap().state, RunState::Completed);
        let history = db.execution_history(&f.run.branch_id).unwrap();
        let original_fact = if event_kind == "job_stopped" {
            "accepted original family experiment"
        } else {
            "result available"
        };
        assert!(history.iter().any(
            |item| matches!(&item.content, Content::Output { output } if output.data.to_string().contains(original_fact))
        ));
        // A later accepted edge keeps the same definition and enters the actual new
        // child Run; it cannot borrow the earlier occurrence's input or execution ID.
        let epoch = db.epoch();
        db.commit_execution(
            &next,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        db.reconcile_followup_facts_at(varin_runtime::catalog::observations::MAX_DEADLINE_MS)
            .unwrap();
        let definition_id = value.id.clone();
        drop(db);
        reconcile(&owner).unwrap();
        let mut db = owner.lock().unwrap();
        let page = db.followup_occurrences(&definition_id, None).unwrap();
        assert_eq!(page.occurrences.len(), 2);
        assert_ne!(page.occurrences[0].id, page.occurrences[1].id);
        assert_eq!(
            page.occurrences[1]
                .delivery
                .as_ref()
                .unwrap()
                .run_id
                .as_deref(),
            Some(next.as_str())
        );
        let p = db
            .prepare_input_delivery(
                &next,
                db.epoch(),
                db.head(&f.run.branch_id).unwrap().as_deref(),
            )
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(db.admit_input_delivery(p).unwrap().unwrap().items.len(), 1);
        assert_eq!(
            db.followup(&definition_id).unwrap().wait.state,
            NextRunWaitState::Waiting
        );
        drop(db);
        reconcile(&owner).unwrap();
        assert_eq!(
            owner
                .lock()
                .unwrap()
                .delegated_executions(Some(&f.child.operation_id))
                .unwrap()
                .into_iter()
                .filter(|v| matches!(v.trigger, DelegatedTrigger::Followup { .. }))
                .count(),
            1
        );
        drop(owner);
        f.finish();
    }
}

#[test]
fn stopped_job_cannot_answer_a_real_child_question_or_clear_its_recovered_wait() {
    use varin_runtime::catalog::followups::*;
    let f = Fixture::with_tools(
        false,
        vec![crate::questions::schema(), crate::followup_tools::schema()],
        vec!["ask_user".into(), "follow_up".into()],
    );
    let job = accepted_family_job(&f, "question-job");
    let owner = f.catalog();
    let p = owner
        .lock()
        .unwrap()
        .prepare_followup_registration(
            "question-followup",
            &f.run.id,
            FollowupRegistration {
                repeat: varin_runtime::catalog::followups::FollowupRepeat::Once,
                trigger: FollowupRegistrationTrigger::JobStopped {
                    operation_id: job.operation_id.clone(),
                },
                instruction: "Inspect the accepted result under current controls".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    owner
        .lock()
        .unwrap()
        .admit_followup_registration(p)
        .unwrap();
    drop(owner);
    wait_review::waiting(
        &f,
        true,
        vec![ToolCall {
            call_id: "question".into(),
            name: "ask_user".into(),
            schema_version: crate::questions::schema().version,
            arguments: json!({"question":"Which result should I use?"}),
        }],
    );
    let wait = f
        .catalog()
        .lock()
        .unwrap()
        .run(&f.run.id)
        .unwrap()
        .waiting_on
        .unwrap();
    stop_family_job(&f, &job);
    let f = f.reopen();
    let owner = f.catalog();
    reconcile(&owner).unwrap();
    let db = owner.lock().unwrap();
    let value = db.followup("question-followup").unwrap();
    assert_eq!(
        value.occurrence.unwrap().hold_reason,
        Some(HoldReason::Question)
    );
    assert_eq!(
        db.run(&f.run.id).unwrap().waiting_on.as_deref(),
        Some(wait.as_str())
    );
    assert_eq!(db.run(&f.run.id).unwrap().state, RunState::Waiting);
    drop(db);
    drop(owner);
    f.finish();
}

#[test]
fn repeating_tool_wait_returns_first_occurrence_even_when_later_edges_precede_wait_delivery() {
    use varin_runtime::catalog::followups::*;
    for model in [true, false] {
        let mut f = Fixture::with_tools(
            false,
            vec![crate::followup_tools::schema()],
            vec!["follow_up".into()],
        );
        enable_fixed_file_reader(&mut f);
        let deadline = varin_runtime::catalog::observations::wall_time_ms().unwrap() + 60_000;
        wait_review::waiting(
            &f,
            model,
            vec![ToolCall {
                call_id: "await-first".into(),
                name: "follow_up".into(),
                schema_version: crate::followup_tools::schema().version,
                arguments: json!({"action":"register","repeat":"each","trigger":{"kind":"any","sources":[{"kind":"at","atMs":deadline},{"kind":"at","atMs":deadline+1},{"kind":"file","path":"result.txt","condition":"changed"}]},"instruction":"Continue for each observed edge","wait":{}}),
            }],
        );
        let owner = f.catalog();
        let mut db = owner.lock().unwrap();
        db.reconcile_followup_facts_at(deadline + 1).unwrap();
        db.reconcile_waits().unwrap();
        let d = db.followups(&f.run.thread_id).unwrap().remove(0);
        let history = db.followup_occurrences(&d.id, None).unwrap().occurrences;
        assert_eq!(history.len(), 2);
        assert_eq!(d.occurrence.unwrap().id, history[1].id);
        let waits = db.capture_followup_waits().unwrap();
        assert_eq!(waits.len(), 1);
        assert!(
            db.admit_followup_wait(waits.into_iter().next().unwrap().load().unwrap())
                .unwrap()
        );
        let item = db
            .execution_history(&f.run.branch_id)
            .unwrap()
            .into_iter()
            .find(|item| item.id.starts_with("followup-observation-result:"))
            .unwrap();
        let Content::Text { text } = &item.content else {
            panic!("observation fact")
        };
        assert!(text.contains(&history[0].id));
        assert!(!text.contains(&history[1].id));
        assert_eq!(
            db.followup(&d.id).unwrap().wait.state,
            NextRunWaitState::Waiting
        );
        assert_eq!(db.followup(&d.id).unwrap().pending_occurrences, 2);
        drop(db);
        drop(owner);
        f.finish();
    }
}

fn publish_research_fact(
    f: &Fixture,
    binding: &varin_runtime::catalog::host_jobs::HostJobBinding,
    kind: &str,
    revision: u64,
) {
    use varin_runtime::catalog::followups::*;
    let owner = f.catalog();
    let db = owner.lock().unwrap();
    let work = db
        .followup_research_works(None)
        .unwrap()
        .0
        .into_iter()
        .find(|w| w.key.followup_id.starts_with("followup:tool:") && w.binding == *binding)
        .unwrap();
    assert_eq!(work.observer.thread_id, f.run.thread_id);
    let evidence = if kind == "artifact" {
        FollowupLeafEvidence::Artifact {
            binding: binding.clone(),
            fact: FollowupArtifactFact::ArtifactAvailable {
                artifact_id: "result".into(),
                record_revision: revision,
            },
            gap: false,
        }
    } else {
        FollowupLeafEvidence::Collection {
            binding: binding.clone(),
            completion_revision: revision,
            outcome: ResearchCollectionOutcome::Done,
            counts: ResearchArtifactCounts {
                available: 1,
                ..Default::default()
            },
            gap: false,
        }
    };
    let p = db
        .prepare_research_observation(FollowupResearchObservation {
            key: work.key,
            evidence,
            content: json!({"originalArtifactMetadata":"result available","revision":revision}),
        })
        .unwrap()
        .unwrap();
    drop(db);
    let p = p.load().unwrap();
    assert!(owner.lock().unwrap().apply_research_observation(p).unwrap());
}

#[test]
fn original_artifact_and_collection_facts_reach_real_child_observations_from_both_tool_origins() {
    use varin_runtime::catalog::followups::*;
    for model in [true, false] {
        for kind in ["artifact", "collection"] {
            let f = Fixture::with_tools(
                false,
                vec![crate::followup_tools::schema()],
                vec!["follow_up".into()],
            );
            let job = accepted_family_job(&f, "research-wait");
            wait_review::waiting(
                &f,
                model,
                vec![ToolCall {
                    call_id: "await-artifact".into(),
                    name: "follow_up".into(),
                    schema_version: crate::followup_tools::schema().version,
                    arguments: json!({"action":"register","repeat":"each","trigger":{"kind":kind,"operationId":job.operation_id},"instruction":"Read actual collected metadata","wait":{}}),
                }],
            );
            publish_research_fact(&f, &job, kind, 1);
            f.assembly.runtime.reconcile_observations().unwrap();
            // Original native wake first settles Waits, then independently admits continuation input.
            reconcile(&f.catalog()).unwrap();
            let owner = f.catalog();
            let mut db = owner.lock().unwrap();
            let definition = db.followups(&f.run.thread_id).unwrap().remove(0);
            assert!(definition.observation.unwrap().delivered);
            let occurrence = definition.occurrence.unwrap();
            assert_eq!(
                occurrence.delivery.as_ref().unwrap().run_id.as_deref(),
                Some(f.run.id.as_str())
            );
            let detail = db
                .capture_followup_occurrence(&definition.id, &occurrence.id)
                .unwrap()
                .load()
                .unwrap();
            assert_eq!(
                detail.facts[0].content["originalArtifactMetadata"],
                "result available"
            );
            let p = db
                .prepare_input_delivery(
                    &f.run.id,
                    db.epoch(),
                    db.head(&f.run.branch_id).unwrap().as_deref(),
                )
                .unwrap()
                .load()
                .unwrap();
            let delivery = db.admit_input_delivery(p).unwrap().unwrap();
            assert_eq!(delivery.items.len(), 1);
            assert!(
                serde_json::to_string(&delivery.items)
                    .unwrap()
                    .contains("originalArtifactMetadata")
            );
            assert!(!db.operation(&job.operation_id).unwrap().cancel_requested);
            assert_eq!(
                db.followup(&definition.id).unwrap().wait.state,
                NextRunWaitState::Waiting
            );
            drop(db);
            drop(owner);
            f.finish();
        }
    }
}

#[path = "log_followup_review.rs"]
mod log_followups;

#[path = "metric_followup_review.rs"]
mod metric_followups;
