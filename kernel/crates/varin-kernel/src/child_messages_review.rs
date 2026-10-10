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
        assert_eq!(replay.completion, public.call_completion);
        assert_eq!(db.admit_message(two).unwrap().completion, replay.completion);
        let mut changed = invocation.call.clone();
        changed.arguments["text"] = json!("conflicting retry");
        assert!(db
            .prepare_tool_message(
                &context,
                changed.clone(),
                crate::message_tools::schema(),
                serde_json::from_value(changed.arguments.clone()).unwrap()
            )
            .unwrap()
            .load()
            .is_err());
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
        assert_eq!(replay.completion, completion);
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
    assert!(start
        .tools
        .prepare(&call, &context, &CancellationToken::default())
        .is_err());
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
    assert!(f
        .catalog()
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
        .is_empty());
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

#[test]
fn explicit_followup_uses_both_real_origins_and_separates_registration_from_wait() {
    use varin_runtime::catalog::followups::{
        observation::FollowupObservationState, FollowupActor, NextRunWaitState,
    };
    for (trigger_kind, model) in ["at", "any", "all", "file"]
        .into_iter()
        .flat_map(|kind| [true, false].map(|model| (kind, model)))
    {
        for wait in [false, true] {
            let mut f = Fixture::with_tools(
                false,
                vec![crate::followup_tools::schema()],
                vec!["follow_up".into()],
            );
            if trigger_kind == "file" {
                enable_fixed_file_reader(&mut f);
            }
            let deadline = varin_runtime::catalog::observations::wall_time_ms().unwrap() + 60_000;
            let mut args = json!({"action":"register","trigger":{"kind":"at","atMs":deadline},"instruction":"Check this delegated task once at the requested time"});
            if trigger_kind == "file" {
                args["trigger"] = json!({"kind":"all","sources":[{"kind":"file","path":"result.txt","condition":"exists"},{"kind":"file","path":"result.txt","condition":"changed"}]});
            } else if trigger_kind != "at" {
                args["trigger"] = json!({"kind":trigger_kind,"sources":[{"kind":"at","atMs":deadline},{"kind":"at","atMs":deadline+1}]});
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
            if trigger_kind == "file" {
                assert!(value.sources[0].observed.is_some());
                assert!(value.sources[1].observed.is_none());
                assert!(value.sources[1].file.as_ref().unwrap().immutable);
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
            f.finish();
        }
    }
}

#[test]
#[cfg(target_os = "linux")]
fn native_followup_all_instants_deliver_original_wait_and_one_active_ingress_without_host_polling()
{
    use varin_runtime::catalog::followups::{
        observation::FollowupObservationState, NextRunWaitState,
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
        let calls=[json!({"action":"get","followupId":"user-instruction"}),json!({"action":"list"}),json!({"action":"control","followupId":"user-instruction","expectedRevision":1,"control":"cancel"})].into_iter().enumerate().map(|(n,arguments)|ToolCall{call_id:format!("manage-{n}"),name:"follow_up".into(),schema_version:crate::followup_tools::schema().version,arguments}).collect();
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
                if let Content::ToolResult { result } = item.content {
                    if result.call_id.starts_with("manage-") {
                        let ToolCompletion::Result {
                            outcome: varin_runtime::Outcome::Succeeded,
                            content,
                            ..
                        } = result.completion
                        else {
                            panic!("actual ModelStep management result failed")
                        };
                        values.push((result.call_id, content));
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
                values.push((node_id, serde_json::from_slice(&bytes).unwrap()));
            }
        }
        assert_eq!(values.len(), 3);
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
