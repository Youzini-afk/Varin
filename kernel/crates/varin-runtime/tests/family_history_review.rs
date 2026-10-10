//! Real lineage, original history producers and fixed read views. No Pi or filesystem authority.
#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::{
    catalog::{collaboration::ChildTask, context::ContextProposal, family::*},
    execution::*,
    *,
};

fn recent(limit: usize) -> FamilyReadQuery {
    FamilyReadQuery::Recent {
        limit: Some(limit),
        max_item_bytes: None,
    }
}
fn request(query: FamilyReadQuery) -> ReadRequest {
    ReadRequest {
        run_id: None,
        anchor: None,
        cursor: None,
        query,
    }
}
fn read(f: &Fixture, caller: &str, thread: &str, branch: &str, r: ReadRequest) -> ReadPage {
    f.db.capture_family_read(caller, Some(thread), Some(branch))
        .unwrap()
        .read(r, &|| false)
        .unwrap()
}
fn append(f: &mut Fixture, run: &str, text: &str) -> HistoryItem {
    let r = f.db.run(run).unwrap();
    let head = f.db.head(&r.branch_id).unwrap();
    f.db.append_history(run,f.db.epoch(),head.as_deref(),HistorySource::Assistant,json!({"id":uuid::Uuid::new_v4().to_string(),"provenance":{"kind":"assistant"},"content":{"kind":"text","text":text},"opaque":null}),None).unwrap()
}
fn prepare(f: &mut Fixture, child: ChildTask) -> ChildTask {
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal = ContextProposal {
        key: format!("context:{}", child.operation_id),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "child".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"family-test","memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":child.project_id,"originalSections":[],"instructionSources":[]})).unwrap();
    f.db.prepare_child(&child.operation_id, source, proposal, basis)
        .unwrap()
}
fn schema(name: &str) -> ToolSchema {
    ToolSchema {
        name: name.into(),
        version: "1".into(),
        description: String::new(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    }
}
fn nested_fixture() -> (Fixture, ChildTask, ChildTask, ChildTask) {
    let mut f = Fixture::new_parent_custom(
        7,
        schema("file_read"),
        schema("dispatch"),
        false,
        false,
        false,
        |input, _| input.tools = Some(vec!["file_read".into(), "dispatch".into()]),
    );
    f.launch.tools.push(schema("dispatch"));
    let first = f.accept();
    f.settle_exchange();
    let c = f.admit_policy_call(ToolCall {
        call_id: "sibling".into(),
        name: "dispatch".into(),
        schema_version: "1".into(),
        arguments: serde_json::to_value(&f.input).unwrap(),
    });
    let sibling =
        f.db.accept_child(&c, f.input.clone(), f.pin.clone(), f.launch.clone())
            .unwrap();
    f.settle_policy_call(&c, "preparing_child");
    let first = prepare(&mut f, first);
    let child_run = first.receipt.as_ref().unwrap().run_id.clone();
    let launch = f.db.launch_intent(&child_run).unwrap().unwrap().selection;
    let model = varin_runtime::catalog::dispatch::ChildModelBinding {
        configuration: serde_json::from_value(f.db.run(&child_run).unwrap().configuration).unwrap(),
        credential_scope: launch.credential_scope.clone(),
    };
    let prepared =
        f.db.prepare_child_dispatch_binding(
            &child_run,
            model,
            launch.tool_schema_generation,
            launch.tools.clone(),
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.bind_child_dispatch(&child_run, prepared).unwrap();
    f.context.run_id = child_run;
    let c = f.admit_policy_call(ToolCall {
        call_id: "nested".into(),
        name: "dispatch".into(),
        schema_version: "1".into(),
        arguments: serde_json::to_value(&f.input).unwrap(),
    });
    let mut pin = f.pin.clone();
    pin.source = launch.source.clone().unwrap();
    pin.pin_id = "nested-fixed-pin".into();
    let mut nested_launch = f.launch.clone();
    nested_launch.source = launch.source;
    let nested =
        f.db.accept_child(&c, f.input.clone(), pin, nested_launch)
            .unwrap();
    f.settle_policy_call(&c, "preparing_child");
    (f, first, sibling, nested)
}

#[test]
fn real_main_sibling_nested_discovery_survives_terminal_and_never_grants_control() {
    let (mut f, first, sibling, nested) = nested_fixture();
    f.db.create_thread("unrelated", "unrelated-branch").unwrap();
    for caller in [
        "thread:parent",
        first.child_thread_id.as_str(),
        sibling.child_thread_id.as_str(),
        nested.child_thread_id.as_str(),
    ] {
        let list =
            f.db.capture_family_read(caller, None, None)
                .unwrap()
                .list(false, &|| false)
                .unwrap();
        assert_eq!(list.root_thread_id, "thread:parent");
        assert_eq!(list.members.len(), 3);
        assert!(
            !list
                .members
                .iter()
                .any(|m| m.thread_id == caller || m.thread_id == "unrelated")
        );
        let all =
            f.db.capture_family_read(caller, None, None)
                .unwrap()
                .list(true, &|| false)
                .unwrap();
        assert_eq!(all.members.len(), 4);
        assert!(
            f.db.capture_family_read(caller, Some("unrelated"), Some("unrelated-branch"))
                .unwrap()
                .read(request(recent(2)), &|| false)
                .is_err()
        );
    }
    let page = read(
        &f,
        &nested.child_thread_id,
        "thread:parent",
        "branch:parent",
        request(recent(20)),
    );
    assert!(!page.items.is_empty());
    assert!(
        page.items
            .iter()
            .all(|item| item.run_id != f.context.run_id)
    );
    assert!(
        f.db.require_child_parent(&f.context.run_id, &sibling.operation_id)
            .is_err()
    );
    f.db.cancel_child(&sibling.operation_id).unwrap();
    let list =
        f.db.capture_family_read(&nested.child_thread_id, None, None)
            .unwrap()
            .list(false, &|| false)
            .unwrap();
    assert_eq!(
        list.members
            .iter()
            .find(|m| m.thread_id == sibling.child_thread_id)
            .unwrap()
            .state,
        "cancelled"
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn anchors_pagination_run_selection_search_and_semantic_item_expansion_are_fixed() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let a = append(&mut f, &run, "one path/src.rs");
    let large = append(&mut f, &run, &"中文🙂 path/src.rs ".repeat(500));
    let b = append(&mut f, &run, "last path/src.rs");
    let query = FamilyReadQuery::Recent {
        limit: Some(2),
        max_item_bytes: Some(17),
    };
    let first = read(
        &f,
        &child.child_thread_id,
        "thread:parent",
        "branch:parent",
        request(query.clone()),
    );
    assert_eq!(first.head_id.as_deref(), Some(b.id.as_str()));
    assert!(first.has_earlier);
    assert!(!first.has_later);
    assert!(!first.scan_complete);
    assert!(first.items[0].body_truncated);
    let captured =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent"),
        )
        .unwrap();
    let newer = append(&mut f, &run, "new append never retargets cursor");
    let old = captured.read(request(recent(1)), &|| false).unwrap();
    assert_eq!(old.items[0].id, b.id);
    let second = read(
        &f,
        &child.child_thread_id,
        "thread:parent",
        "branch:parent",
        ReadRequest {
            run_id: None,
            anchor: Some(first.anchor.clone()),
            cursor: first.next_cursor.clone(),
            query: query.clone(),
        },
    );
    assert!(second.items.iter().all(|item| item.id != newer.id));
    assert_eq!(second.items.last().unwrap().id, a.id);
    let mut accumulated = String::new();
    let mut offset = 0;
    loop {
        let item =
            f.db.capture_family_read(
                &child.child_thread_id,
                Some("thread:parent"),
                Some("branch:parent"),
            )
            .unwrap()
            .item(
                ItemRequest {
                    run_id: None,
                    anchor: first.anchor.clone(),
                    item_id: large.id.clone(),
                    offset: Some(offset),
                    max_bytes: Some(17),
                },
                &|| false,
            )
            .unwrap();
        assert_eq!(item.format, "conversation_json");
        accumulated.push_str(&item.text);
        if let Some(next) = item.next_offset {
            assert!(next > offset);
            offset = next;
        } else {
            break;
        }
    }
    let semantic: serde_json::Value = serde_json::from_str(&accumulated).unwrap();
    assert!(semantic.get("provider").is_none());
    assert_eq!(
        semantic["content"]["text"],
        "中文🙂 path/src.rs ".repeat(500)
    );
    let search = FamilyReadQuery::Search {
        text: "PATH/src.rs".into(),
        direction: Direction::Older,
        limit: Some(10),
        max_item_bytes: None,
        scan_limit: Some(1),
    };
    let mut next = None;
    let mut found = Vec::new();
    loop {
        let page = read(
            &f,
            &child.child_thread_id,
            "thread:parent",
            "branch:parent",
            ReadRequest {
                run_id: None,
                anchor: Some(first.anchor.clone()),
                cursor: next,
                query: search.clone(),
            },
        );
        assert!(page.scanned <= 1);
        found.extend(page.items.into_iter().map(|item| item.id));
        next = page.next_cursor;
        if next.is_none() {
            assert!(page.scan_complete);
            break;
        }
    }
    assert_eq!(found, vec![b.id.clone(), large.id.clone(), a.id.clone()]);
    let forward = read(
        &f,
        &child.child_thread_id,
        "thread:parent",
        "branch:parent",
        request(FamilyReadQuery::Range {
            after_id: Some(a.id),
            before_id: Some(newer.id),
            direction: Direction::Newer,
            limit: Some(1),
            max_item_bytes: None,
        }),
    );
    assert_eq!(forward.items[0].id, large.id);
    assert!(forward.next_cursor.is_some());
    let mut bad = first.anchor.clone();
    bad.push('x');
    assert!(
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent")
        )
        .unwrap()
        .item(
            ItemRequest {
                run_id: None,
                anchor: bad,
                item_id: b.id,
                offset: None,
                max_bytes: None
            },
            &|| false
        )
        .is_err()
    );
    f.db.commit_execution(
        &run,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    let receipt =
        f.db.submit(&SubmitInput {
            key: "next".into(),
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
            expected_head: f.db.head("branch:parent").unwrap(),
            input: json!("new Run"),
            configuration: json!({}),
        })
        .unwrap();
    let selected = read(
        &f,
        &child.child_thread_id,
        "thread:parent",
        "branch:parent",
        ReadRequest {
            run_id: Some(run.clone()),
            ..request(recent(100))
        },
    );
    assert!(selected.items.iter().all(|item| item.run_id == run));
    assert!(selected.scan_complete);
    assert!(!selected.has_earlier);
    assert!(!selected.has_later);
    assert!(
        !selected
            .items
            .iter()
            .any(|item| item.id == receipt.input_id)
    );
    for direction in [Direction::Older, Direction::Newer] {
        for query in [
            FamilyReadQuery::Search {
                text: "中文🙂".into(),
                direction: direction.clone(),
                limit: Some(100),
                max_item_bytes: None,
                scan_limit: None,
            },
            FamilyReadQuery::Range {
                after_id: Some(selected.items.first().unwrap().id.clone()),
                before_id: Some(selected.items.last().unwrap().id.clone()),
                direction,
                limit: Some(100),
                max_item_bytes: None,
            },
        ] {
            let context = read(
                &f,
                &child.child_thread_id,
                "thread:parent",
                "branch:parent",
                ReadRequest {
                    run_id: Some(run.clone()),
                    anchor: Some(selected.anchor.clone()),
                    cursor: None,
                    query,
                },
            );
            assert!(!context.items.is_empty());
            assert!(context.items.iter().all(|item| item.run_id == run));
            assert!(context.scan_complete);
            assert!(context.has_earlier, "context may precede the query window");
            assert!(context.has_later, "context may follow the query window");
        }
    }
    let runs =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent"),
        )
        .unwrap()
        .runs(None, Some(1), &|| false)
        .unwrap();
    assert_eq!(runs.runs[0].run_id, receipt.run_id);
    let older =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent"),
        )
        .unwrap()
        .runs(runs.next_cursor.as_deref(), Some(1), &|| false)
        .unwrap();
    assert_eq!(older.runs[0].run_id, run);
    assert!(older.next_cursor.is_none());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn original_model_call_result_association_and_provider_secrets_stay_in_their_owner() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let page = read(
        &f,
        &child.child_thread_id,
        "thread:parent",
        "branch:parent",
        request(recent(100)),
    );
    let calls = page
        .items
        .iter()
        .filter_map(|item| item.tool.as_ref())
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].role, "call");
    assert_eq!(calls[1].role, "result");
    assert_eq!(calls[0].request_id, calls[1].request_id);
    assert_eq!(calls[0].call_id, calls[1].call_id);
    assert!(page.items.iter().all(|item| {
        item.body
            .as_ref()
            .is_none_or(|body| body.get("provider").is_none())
    }));
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn captured_reader_is_cancelled_without_cancelling_target_and_gc_and_epoch_are_fenced() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let item = append(&mut f, &run, "retained body");
    let capture =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent"),
        )
        .unwrap();
    // A captured reader participates in the existing content publication protocol.
    assert_eq!(
        f.db.prepare_content_collection(Default::default())
            .run()
            .status,
        ContentCollectionStatus::Deferred
    );
    let page = capture.read(request(recent(1)), &|| false).unwrap();
    assert_eq!(page.items[0].id, item.id);
    assert!(
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent")
        )
        .unwrap()
        .read(request(recent(1)), &|| true)
        .is_err()
    );
    assert!(!f.db.run(&run).unwrap().cancel_requested);
    content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap();
    let old =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent"),
        )
        .unwrap();
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert!(old.read(request(recent(1)), &|| false).is_err());
    assert!(
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent")
        )
        .unwrap()
        .read(
            ReadRequest {
                anchor: Some(page.anchor),
                ..request(recent(1))
            },
            &|| false
        )
        .is_err()
    );
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn paused_read_worker_does_not_own_catalog_and_append_fork_cancel_preserve_its_view() {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let target = f.context.run_id.clone();
    let item = append(&mut f, &target, "anchored before concurrent append");
    let read =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent"),
        )
        .unwrap();
    let (ready, seen) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let gate = Mutex::new(gate);
    let calls = AtomicUsize::new(0);
    let worker = std::thread::spawn(move || {
        read.read(request(recent(1)), &|| {
            if calls.fetch_add(1, Ordering::SeqCst) == 2 {
                ready.send(()).unwrap();
                gate.lock().unwrap().recv().unwrap();
            }
            false
        })
    });
    seen.recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let newest = append(&mut f, &target, "concurrent new tail");
    f.db.fork_branch("branch:parent", "family-fork", Some(&item.id))
        .unwrap();
    let owner = Arc::new(Mutex::new(f.db));
    assert_eq!(
        owner
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default())
            .run()
            .status,
        ContentCollectionStatus::Deferred
    );
    // Cancellation is a short independent control write; an already captured public view is still readable.
    owner.lock().unwrap().request_cancel_run(&target).unwrap();
    release.send(()).unwrap();
    let page = worker.join().unwrap().unwrap();
    assert_eq!(page.items[0].id, item.id);
    assert_ne!(page.items[0].id, newest.id);
    assert!(
        owner
            .lock()
            .unwrap()
            .capture_family_read(
                &child.child_thread_id,
                Some("thread:parent"),
                Some("family-fork")
            )
            .unwrap()
            .item(
                ItemRequest {
                    run_id: None,
                    anchor: page.anchor,
                    item_id: item.id,
                    offset: None,
                    max_bytes: None
                },
                &|| false
            )
            .is_err(),
        "an anchor cannot be retargeted to a fork"
    );
    drop(owner);
    std::fs::remove_dir_all(f.root).unwrap();
}

#[test]
fn empty_missing_foreign_corrupt_and_changed_cursor_queries_remain_distinct() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let empty = read(
        &f,
        "thread:parent",
        &child.child_thread_id,
        &child.child_branch_id,
        request(recent(2)),
    );
    assert!(empty.items.is_empty());
    assert!(empty.head_id.is_none());
    assert!(empty.scan_complete);
    assert!(empty.next_cursor.is_none());
    assert!(f.db.capture_family_read("unknown", None, None).is_err());
    assert!(
        f.db.capture_family_read(
            "thread:parent",
            Some(&child.child_thread_id),
            Some("branch:parent")
        )
        .is_err()
    );
    let page = read(
        &f,
        &child.child_thread_id,
        "thread:parent",
        "branch:parent",
        request(recent(1)),
    );
    assert!(
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent")
        )
        .unwrap()
        .read(
            ReadRequest {
                cursor: page.next_cursor.clone(),
                ..request(recent(2))
            },
            &|| false
        )
        .is_err()
    );
    assert!(
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent")
        )
        .unwrap()
        .item(
            ItemRequest {
                run_id: None,
                anchor: page.anchor,
                item_id: "not-an-item".into(),
                offset: None,
                max_bytes: None
            },
            &|| false
        )
        .is_err()
    );
    let root = f.root.clone();
    let raw = rusqlite::Connection::open_with_flags(
        root.join("conversation.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let body: String = raw
        .query_row(
            "SELECT body FROM history WHERE id=?1",
            [&page.items[0].id],
            |row| row.get(0),
        )
        .unwrap();
    let stored: HistoryItem = serde_json::from_str(&body).unwrap();
    let path = varin_runtime::content::object_path(
        &root.join("content"),
        stored.content["content_object"].as_str().unwrap(),
    )
    .unwrap();
    std::fs::write(path, b"corrupt retained body").unwrap();
    assert!(
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent")
        )
        .unwrap()
        .read(request(recent(1)), &|| false)
        .is_err()
    );
    drop(raw);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn opaque_provider_continuations_are_retained_but_never_returned_or_searched() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let head = f.db.head("branch:parent").unwrap();
    let original = ProviderOriginal {
        connection_identity: "private-provider-owner".into(),
        adapter: "fixture".into(),
        version: "1".into(),
        item: json!({"opaque":"OPAQUE_SECRET"}),
    };
    let item=f.db.append_history(&run,f.db.epoch(),head.as_deref(),HistorySource::Assistant,json!({"id":"visible-item","provenance":{"kind":"assistant"},"content":{"kind":"text","text":"visible C:\\src\\file.rs"},"opaque":{"family":"fixture","adapter_version":"1","connection_identity":"private-provider-owner","value":"OPAQUE_SECRET"}}),Some(original.clone())).unwrap();
    let page = read(
        &f,
        &child.child_thread_id,
        "thread:parent",
        "branch:parent",
        request(recent(1)),
    );
    let body = page.items[0].body.as_ref().unwrap();
    assert!(body["opaque"].is_null());
    assert!(!page.items[0].preview.contains("OPAQUE_SECRET"));
    let expanded =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent"),
        )
        .unwrap()
        .item(
            ItemRequest {
                run_id: None,
                anchor: page.anchor,
                item_id: item.id.clone(),
                offset: None,
                max_bytes: None,
            },
            &|| false,
        )
        .unwrap();
    assert!(!expanded.text.contains("OPAQUE_SECRET"));
    for (query, count) in [("OPAQUE_SECRET", 0), ("C:\\src\\file.rs", 1)] {
        let found = read(
            &f,
            &child.child_thread_id,
            "thread:parent",
            "branch:parent",
            request(FamilyReadQuery::Search {
                text: query.into(),
                direction: Direction::Older,
                limit: Some(10),
                max_item_bytes: None,
                scan_limit: None,
            }),
        );
        assert_eq!(found.items.len(), count);
    }
    assert_eq!(
        f.db.history("branch:parent")
            .unwrap()
            .last()
            .unwrap()
            .provider,
        Some(original)
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn request_and_policy_origins_cannot_impersonate_a_selected_family_call() {
    for policy in [false, true] {
        let f = if policy {
            Fixture::new_policy()
        } else {
            Fixture::new()
        };
        let call = ToolCall {
            call_id: "dispatch-call".into(),
            name: "threads".into(),
            schema_version: "1".into(),
            arguments: json!({}),
        };
        let selected = schema("threads");
        let captured =
            f.db.capture_family_tool(
                f.context.clone(),
                call.clone(),
                selected.clone(),
                None,
                None,
            )
            .unwrap();
        assert!(
            captured.list(false, &|| false).is_err(),
            "a real origin does not authorize a different tool/arguments"
        );
        let mut wrong = f.context.clone();
        wrong.run_id = "other-run".into();
        assert!(
            f.db.capture_family_tool(wrong, call.clone(), selected.clone(), None, None)
                .is_err()
        );
        let root = f.root.clone();
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn fork_lists_and_filters_visible_original_runs_without_reassigning_their_branch() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let original = f.context.run_id.clone();
    let inherited = append(&mut f, &original, "inherited from original Run");
    f.db.fork_branch("branch:parent", "fork-visible", Some(&inherited.id))
        .unwrap();
    let receipt =
        f.db.submit(&SubmitInput {
            key: "fork-run".into(),
            thread_id: "thread:parent".into(),
            branch_id: "fork-visible".into(),
            expected_head: Some(inherited.id.clone()),
            input: json!("work on the fork"),
            configuration: json!({}),
        })
        .unwrap();
    let first =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("fork-visible"),
        )
        .unwrap()
        .runs(None, Some(1), &|| false)
        .unwrap();
    assert_eq!(first.runs[0].run_id, receipt.run_id);
    assert_eq!(first.runs[0].branch_id, "fork-visible");
    let older =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("fork-visible"),
        )
        .unwrap()
        .runs(first.next_cursor.as_deref(), Some(1), &|| false)
        .unwrap();
    assert_eq!(older.runs[0].run_id, original);
    assert_eq!(older.runs[0].branch_id, "branch:parent");
    assert!(older.next_cursor.is_none());
    let selected = read(
        &f,
        &child.child_thread_id,
        "thread:parent",
        "fork-visible",
        ReadRequest {
            run_id: Some(original.clone()),
            ..request(recent(100))
        },
    );
    assert_eq!(selected.items.last().unwrap().id, inherited.id);
    assert!(selected.items.iter().all(|item| item.run_id == original));
    let item =
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("fork-visible"),
        )
        .unwrap()
        .item(
            ItemRequest {
                run_id: Some(original),
                anchor: selected.anchor,
                item_id: inherited.id,
                offset: None,
                max_bytes: None,
            },
            &|| false,
        )
        .unwrap();
    assert!(item.text.contains("inherited from original Run"));
    // A Run on a different branch with no inherited record is not made visible by sharing a Thread.
    f.db.fork_branch("branch:parent", "empty-fork", None)
        .unwrap();
    assert!(
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("empty-fork")
        )
        .unwrap()
        .read(
            ReadRequest {
                run_id: Some(receipt.run_id),
                ..request(recent(100))
            },
            &|| false
        )
        .is_err()
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn owner_replacement_after_sqlite_snapshot_opens_rejects_family_and_existing_history_pages() {
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    for existing_page in [false, true] {
        let mut f = Fixture::new();
        let child = f.accept();
        f.settle_exchange();
        let family =
            f.db.capture_family_read(
                &child.child_thread_id,
                Some("thread:parent"),
                Some("branch:parent"),
            )
            .unwrap();
        let old_page = f.db.capture_history_page("branch:parent").unwrap();
        let head = f.db.head("branch:parent").unwrap().unwrap();
        let body = f.db.history_body_reader(&head).unwrap();
        let (ready, seen) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let gate = Mutex::new(gate);
        let calls = AtomicUsize::new(0);
        let worker = std::thread::spawn(move || {
            let cancelled = || {
                if calls.fetch_add(1, Ordering::SeqCst) == 2 {
                    ready.send(()).unwrap();
                    gate.lock().unwrap().recv().unwrap();
                }
                false
            };
            if existing_page {
                old_page.load(None, None, 2, &cancelled).map(|_| ())
            } else {
                family.read(request(recent(2)), &cancelled).map(|_| ())
            }
        });
        seen.recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let root = f.root.clone();
        drop(f.db);
        f.db = Catalog::open(&root).unwrap();
        release.send(()).unwrap();
        assert!(
            matches!(worker.join().unwrap(),Err(RuntimeError::Conflict(message)) if message.contains("previous owner epoch")),
            "old snapshot must not return success after ownership changed"
        );
        assert!(body.chunk(0).is_err());
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn selected_run_navigation_excludes_other_runs_before_and_after() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let first_run = f.context.run_id.clone();
    append(&mut f, &first_run, "first Run final record");
    f.db.commit_execution(
        &first_run,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    let next =
        f.db.submit(&SubmitInput {
            key: "review-next-run-navigation".into(),
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
            expected_head: f.db.head("branch:parent").unwrap(),
            input: json!("second Run input"),
            configuration: json!({}),
        })
        .unwrap();
    append(&mut f, &next.run_id, "second Run output");
    for selected in [&first_run, &next.run_id] {
        let page = read(
            &f,
            &child.child_thread_id,
            "thread:parent",
            "branch:parent",
            ReadRequest {
                run_id: Some(selected.clone()),
                ..request(recent(100))
            },
        );
        assert!(page.scan_complete);
        assert!(page.items.iter().all(|item| &item.run_id == selected));
        assert!(
            !page.has_earlier,
            "complete selected Run has no earlier in-scope records"
        );
        assert!(
            !page.has_later,
            "complete selected Run has no later in-scope records"
        );
    }
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_completed_fork_does_not_relabel_an_active_root_thread_as_completed() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let root_run = f.context.run_id.clone();
    let head = f.db.head("branch:parent").unwrap();
    f.db.fork_branch("branch:parent", "later-completed-fork", head.as_deref())
        .unwrap();
    let fork =
        f.db.submit(&SubmitInput {
            key: "review-later-completed-fork".into(),
            thread_id: "thread:parent".into(),
            branch_id: "later-completed-fork".into(),
            expected_head: head,
            input: json!("independent work on fork"),
            configuration: json!({}),
        })
        .unwrap();
    f.db.commit_execution(
        &fork.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    f.db.commit_execution(
        &fork.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    let still_active = f.db.run(&root_run).unwrap();
    assert!(!still_active.state.terminal());
    let family =
        f.db.capture_family_read(&child.child_thread_id, None, None)
            .unwrap()
            .list(false, &|| false)
            .unwrap();
    let root_member = family
        .members
        .iter()
        .find(|member| member.thread_id == "thread:parent")
        .unwrap();
    assert!(
        root_member
            .branches
            .iter()
            .any(|branch| branch.active_run_id.as_deref() == Some(root_run.as_str()))
    );
    assert_eq!(
        root_member.state,
        serde_json::to_value(still_active.state)
            .unwrap()
            .as_str()
            .unwrap(),
        "the sole active Run, rather than later branch creation order, determines current root status"
    );
    let state = |f: &Fixture| {
        f.db.capture_family_read(&child.child_thread_id, None, None)
            .unwrap()
            .list(false, &|| false)
            .unwrap()
            .members
            .into_iter()
            .find(|member| member.thread_id == "thread:parent")
            .unwrap()
            .state
    };
    let change = |f: &mut Fixture, run: &str, state| {
        f.db.commit_execution(
            run,
            f.db.epoch(),
            &ExecutionRecord::StateChanged {
                state,
                waiting_on: None,
            },
        )
        .unwrap();
    };
    let next =
        f.db.submit(&SubmitInput {
            key: "review-mixed-active-fork".into(),
            thread_id: "thread:parent".into(),
            branch_id: "later-completed-fork".into(),
            expected_head: f.db.head("later-completed-fork").unwrap(),
            input: json!("new fork admission"),
            configuration: json!({}),
        })
        .unwrap();
    assert_eq!(f.db.run(&next.run_id).unwrap().state, RunState::Accepted);
    assert_eq!(
        state(&f),
        "active",
        "different active phases have no single RunState"
    );
    change(&mut f, &next.run_id, RunState::Runnable);
    assert_eq!(
        state(&f),
        "runnable",
        "equal active phases retain their actual state"
    );
    change(&mut f, &root_run, RunState::Completed);
    assert_eq!(state(&f), "runnable");
    change(&mut f, &next.run_id, RunState::Failed);
    assert_eq!(state(&f), "failed");
    let latest =
        f.db.submit(&SubmitInput {
            key: "review-newest-admission-oldest-branch".into(),
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
            expected_head: f.db.head("branch:parent").unwrap(),
            input: json!("newest admission on the first-created branch"),
            configuration: json!({}),
        })
        .unwrap();
    change(&mut f, &latest.run_id, RunState::Runnable);
    change(&mut f, &latest.run_id, RunState::Completed);
    assert_eq!(
        state(&f),
        "completed",
        "inactive root uses Run admission order"
    );
    let family =
        f.db.capture_family_read("thread:parent", None, None)
            .unwrap()
            .list(false, &|| false)
            .unwrap();
    assert_eq!(
        family
            .members
            .iter()
            .find(|member| member.thread_id == child.child_thread_id)
            .unwrap()
            .state,
        child.state,
        "unstarted child retains its task stage"
    );
    let prepared = prepare(&mut f, child.clone());
    let active_child = f.db.run(&prepared.receipt.unwrap().run_id).unwrap();
    let family =
        f.db.capture_family_read("thread:parent", None, None)
            .unwrap()
            .list(false, &|| false)
            .unwrap();
    assert_eq!(
        family
            .members
            .iter()
            .find(|member| member.thread_id == child.child_thread_id)
            .unwrap()
            .state,
        serde_json::to_value(active_child.state)
            .unwrap()
            .as_str()
            .unwrap()
    );
    f.db.create_thread("idle-root", "idle-branch").unwrap();
    let idle =
        f.db.capture_family_read("idle-root", None, None)
            .unwrap()
            .list(true, &|| false)
            .unwrap();
    assert_eq!(idle.members[0].state, "idle");
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
