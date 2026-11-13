//! One coherent Catalog view for a conversation. No Host-side RPC fan-out.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

/// Assistant item identities encode the UTF-8 byte length of the original request id.
pub(super) fn model_request_id(item: &HistoryItem) -> Option<String> {
    if item.source != HistorySource::Assistant {
        return None;
    }
    let encoded = item
        .content
        .get("id")?
        .as_str()?
        .strip_prefix("model-item:")?;
    let (length, rest) = encoded.split_once(':')?;
    let end = length.parse::<usize>().ok()?;
    rest.get(..end).map(str::to_owned)
}
fn effectful(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("dispatched" | "partial" | "confirmed" | "unknown")
    )
}

impl Catalog {
    pub fn thread_view(
        &self,
        thread_id: &str,
        branch_id: &str,
        history_limit: u32,
        after_head_id: Option<&str>,
    ) -> Result<Value> {
        self.thread_view_cancellable(thread_id, branch_id, history_limit, after_head_id, &|| {
            false
        })
    }

    /// Cancellation retires obsolete hydration work, not just the eventual response.
    /// The caller continues to own the request/transaction until this method returns.
    pub fn thread_view_cancellable(
        &self,
        thread_id: &str,
        branch_id: &str,
        history_limit: u32,
        after_head_id: Option<&str>,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Value> {
        let check = || {
            if cancelled() {
                Err(RuntimeError::DispatchCancelled)
            } else {
                Ok(())
            }
        };
        check()?;
        // The read pool already owns a transaction; direct callers get the same contract.
        let _publication = self.content.begin_publication();
        let _transaction = self
            .db
            .is_autocommit()
            .then(|| self.db.unchecked_transaction())
            .transpose()?;
        let event_cursor = self.event_cursor()?;
        let thread = self.inspect_thread(thread_id)?;
        let branch = thread["branches"]
            .as_array()
            .and_then(|branches| {
                branches
                    .iter()
                    .find(|branch| branch["branch_id"].as_str() == Some(branch_id))
            })
            .ok_or_else(|| {
                RuntimeError::Invalid("Branch does not belong to the selected thread".into())
            })?;
        if history_limit == 0 {
            return Err(RuntimeError::Invalid(
                "History page size must be positive".into(),
            ));
        }
        let head = branch["head"].as_str().map(str::to_owned);
        let mut cursor = head.clone();
        let mut history = Vec::new();
        // The full current window supplies Operation receipts even when the history body is a delta.
        while history.len() < history_limit as usize {
            check()?;
            let Some(id) = cursor else {
                break;
            };
            let item: HistoryItem = record(&self.db, "history", &id)?;
            cursor = item.parent.clone();
            history.push(self.content.load_stored_history_item(item, cancelled)?);
        }
        history.reverse();
        let previous = cursor
            .as_ref()
            .and_then(|_| history.first())
            .map(|item| item.id.clone());
        let delta_start = after_head_id.and_then(|after| {
            if head.as_deref() == Some(after) {
                Some(history.len())
            } else if let Some(index) = history.iter().position(|item| item.id == after) {
                Some(index + 1)
            } else if cursor.as_deref() == Some(after) {
                Some(0)
            } else {
                None
            }
        });
        let requests = history
            .iter()
            .filter_map(model_request_id)
            .collect::<BTreeSet<_>>();
        let presentations = self
            .capture_model_presentations(&requests.into_iter().collect::<Vec<_>>(), false)?
            .load(cancelled)?
            .into_iter()
            .map(|view| (view.request_id.clone(), view))
            .collect::<BTreeMap<_, _>>();
        let mut operations = self
            .active_thread_operations(thread_id, Some(branch_id))?
            .into_iter()
            .map(|operation| (operation.id.clone(), operation))
            .collect::<BTreeMap<_, _>>();
        let mut references = BTreeMap::<String, bool>::new();
        for item in &history {
            check()?;
            let content = &item.content;
            let result = &content["content"]["result"];
            let completion = &result["completion"];
            if content["content"]["kind"] == "tool_result" {
                if completion["kind"] == "job_accepted" {
                    if let Some(id) = completion["operation_id"].as_str() {
                        references.insert(id.into(), false);
                    }
                } else if completion["kind"] == "result" && effectful(&completion["effect"]) {
                    if let (Some(request), Some(call)) =
                        (result["request_id"].as_str(), result["call_id"].as_str())
                    {
                        references.insert(format!("{request}:tool:{call}"), true);
                    }
                }
            }
            if content["provenance"]["kind"] == "policy_tool_data"
                && content["content"]["kind"] == "output"
            {
                let reference = &content["provenance"]["reference"];
                if let (Some(action), Some(node)) = (
                    reference["action_id"].as_str(),
                    reference["node_id"].as_str(),
                ) {
                    let id = format!("{action}:node:{node}");
                    if content["content"]["output"]["data"]["operationId"].as_str() == Some(&id) {
                        references.insert(id, true);
                    }
                }
            }
        }
        for (id, observer) in references {
            check()?;
            if operations.contains_key(&id) {
                continue;
            }
            let operation: Option<Operation> = optional_record(&self.db, "operations", &id)?;
            let Some(operation) = operation else {
                if observer {
                    continue;
                }
                return Err(RuntimeError::NotFound(id));
            };
            if observer
                && (operation.mcp_resource_subscription.is_none()
                    || !effectful(&serde_json::to_value(&operation.effect)?))
            {
                continue;
            }
            let run = self.run(&operation.run_id)?;
            if run.thread_id == thread_id && run.branch_id == branch_id {
                operations.insert(id, operation);
            }
        }
        let history = history
            .into_iter()
            .skip(delta_start.unwrap_or(0))
            .map(|item| {
                check()?;
                let request_id = model_request_id(&item);
                let mut value = serde_json::to_value(item)?;
                if let Some(presentation) = request_id.and_then(|id| presentations.get(&id)) {
                    value["modelRequest"] = serde_json::to_value(presentation)?;
                }
                Ok(value)
            })
            .collect::<Result<Vec<_>>>()?;
        let inputs = self
            .capture_queued_inputs(branch_id)?
            .into_iter()
            .map(|read| {
                check()?;
                read.load()
            })
            .collect::<Result<Vec<_>>>()?;
        let checkpoint = self
            .capture_active_checkpoint(branch_id)?
            .map(|read| {
                check()?;
                read.load()
            })
            .transpose()?;
        let jobs = self
            .capture_context_jobs(branch_id)?
            .into_iter()
            .map(|read| {
                check()?;
                let job = read.load()?;
                let run = self.run(&job.receipt.run_id)?;
                Ok(json!({"job":job,"run":run}))
            })
            .collect::<Result<Vec<_>>>()?;
        check()?;
        let followups = self
            .followups(thread_id)?
            .into_iter()
            .filter(|item| item.branch_id == branch_id)
            .collect::<Vec<_>>();
        let goals = self
            .capture_goals(thread_id)?
            .into_iter()
            .map(|read| {
                check()?;
                read.load()
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|item| item.branch_id == branch_id)
            .collect::<Vec<_>>();
        let mut directory = self
            .capture_family_read(thread_id, None, None)?
            .list_page_in(
                &self.db,
                false,
                family::FamilyListQuery {
                    parent_thread_id: Some(thread_id.into()),
                    parent_branch_id: Some(branch_id.into()),
                    scope: Some("current".into()),
                    archived: Some("include".into()),
                    ..Default::default()
                },
                true,
                cancelled,
            )?;
        let mut children = Vec::new();
        let mut child_executions = Vec::new();
        let mut child_activity = serde_json::Map::new();
        let mut visible_children = BTreeSet::new();
        for member in &directory.members {
            check()?;
            if member.parent_thread_id.as_deref() != Some(thread_id) {
                continue;
            }
            let (Some(operation_id), Some(execution_id)) =
                (&member.operation_id, &member.latest_execution_id)
            else {
                continue;
            };
            let child = self.child_task(operation_id)?;
            if child.parent_branch_id != branch_id {
                continue;
            }
            let execution = self.delegated_execution(execution_id)?;
            if execution.state() == "ready" {
                if let Some(receipt) = &execution.receipt {
                    let run = self.run(&receipt.run_id)?;
                    let launch = self
                        .capture_launch(&run.id)?
                        .map(|read| {
                            check()?;
                            read.load()
                        })
                        .transpose()?;
                    let activity = if let Some(launch) = launch
                        .as_ref()
                        .filter(|launch| launch.preparation_failure.is_some())
                    {
                        json!({"state":"preparation_failed", "reason":launch.preparation_failure_detail.as_ref().or(launch.preparation_failure.as_ref())})
                    } else if run
                        .waiting_on
                        .as_deref()
                        .is_some_and(|wait| wait.starts_with("preparation:"))
                    {
                        json!({"state":"preparing"})
                    } else if matches!(
                        run.state,
                        RunState::Completed | RunState::Failed | RunState::Cancelled
                    ) {
                        json!({"state":"settling"})
                    } else if run.state == RunState::Waiting
                        && launch.as_ref().is_some_and(|launch| launch.pause.is_some())
                    {
                        json!({"state":"waiting"})
                    } else {
                        json!({"state":"running"})
                    };
                    child_activity.insert(execution.execution_id.clone(), activity);
                }
            }
            visible_children.insert(child.child_thread_id.clone());
            check()?;
            children.push(self.capture_child_read(child).load()?);
            check()?;
            child_executions.push(self.capture_delegated_execution(execution)?.load()?);
        }
        directory
            .members
            .retain(|member| visible_children.contains(&member.thread_id));
        let mut delegated_executions = Vec::new();
        if let Some(child) = self.child_task_for_thread(thread_id)? {
            if child.child_branch_id == branch_id {
                for execution in self.delegated_executions(Some(&child.operation_id))? {
                    check()?;
                    delegated_executions.push(self.capture_delegated_execution(execution)?.load()?);
                }
            }
        }
        check()?;
        let active_run = branch["active_run_id"]
            .as_str()
            .map(|id| self.run(id))
            .transpose()?;
        let latest_run = branch
            .get("latest_run")
            .filter(|value| !value.is_null())
            .map(|value| serde_json::from_value::<Run>(value.clone()))
            .transpose()?;
        let shown_run = active_run.as_ref().or(latest_run.as_ref());
        let run_failure = shown_run
            .filter(|run| run.state == RunState::Failed)
            .map(|run| {
                check()?;
                self.run_failure(&run.id)
            })
            .transpose()?
            .flatten();
        let launch = shown_run
            .map(|run| self.capture_launch(&run.id))
            .transpose()?
            .flatten()
            .map(|read| {
                check()?;
                read.load()
            })
            .transpose()?;
        let model_selection = shown_run
            .map(|run| {
                check()?;
                self.model_selections(&run.id)
                    .and_then(|value| Ok(serde_json::to_value(value)?))
            })
            .transpose()?
            .unwrap_or_else(|| json!({"desired":null,"active":null}));
        let policy_selection = shown_run
            .filter(|_| launch.is_some())
            .map(|run| {
                check()?;
                self.policy_selections(&run.id)?.load()
            })
            .transpose()?;
        let mut history_page = json!({"head":head,"previous":previous});
        if delta_start.is_some() {
            history_page["afterHeadId"] = json!(after_head_id);
        }
        let operations = operations
            .into_values()
            .map(|operation| {
                check()?;
                self.capture_operation_read(operation).load()
            })
            .collect::<Result<Vec<_>>>()?;
        check()?;
        Ok(
            json!({"identity":{"runtime":"agent","threadId":thread_id,"branchId":branch_id},
            "eventCursor":event_cursor,"thread":thread,"history":history,"historyPage":history_page,
            "inputs":inputs,"operations":operations,
            "context":{"checkpoint":checkpoint,"jobs":jobs},"followups":followups,"goals":goals,
            "children":children,"childExecutions":child_executions,"childDirectory":directory,"childActivity":child_activity,
            "delegatedExecutions":delegated_executions,"activeRun":active_run,"runFailure":run_failure,
            "launch":launch,"modelSelection":model_selection,"policySelection":policy_selection}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_submission::InputAdmission;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("varin-thread-view-{}", id())))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn public_thread_history_retains_original_media_holders_in_full_and_delta_views() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        use crate::output::{IncomingMedia, MediaReadParams, OutputMediaHolder, OutputSource};
        let f = Fixture::new();
        let mut db = Catalog::open(&f.0).unwrap();
        db.create_thread("thread", "main").unwrap();
        let bytes = vec![17u8; 700_000];
        let encoded = STANDARD.encode(&bytes);
        let receipt = db.submit(&SubmitInput {
            key: "media-input".into(), thread_id: "thread".into(), branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"原始图片", "attachments":[{"media_type":"image/png","data_base64":encoded}]}),
            configuration: json!({}),
        }).unwrap();
        let media = IncomingMedia { media_type: "image/png".into(), data_base64: encoded.clone() }
            .admit(OutputSource::Operation { operation_id: "original-output".into() }).unwrap();
        let assistant = db.append_history(&receipt.run_id, db.epoch(), Some(&receipt.input_id),
            HistorySource::Assistant,
            json!({"id":"answer","provenance":{"kind":"assistant"},"content":{"kind":"media","media":media},"opaque":null}),
            None).unwrap();
        // append_history is the untyped fixture API. Persist the assistant item through
        // the same typed content owner used by execution's ModelFinished publication.
        let conversation = serde_json::from_value(assistant.content.clone()).unwrap();
        let mut stored_assistant: HistoryItem = record(&db.db, "history", &assistant.id).unwrap();
        stored_assistant.content = db.content.save_conversation(&conversation, &None).unwrap();
        db.db.execute("UPDATE history SET body=?2 WHERE id=?1",
            params![assistant.id, encode(&stored_assistant).unwrap()]).unwrap();
        let full = db.thread_view("thread", "main", 20, None).unwrap();
        let delta = db.thread_view("thread", "main", 20, Some(&receipt.input_id)).unwrap();
        assert_eq!(full["history"].as_array().unwrap().len(), 2);
        assert_eq!(delta["history"], json!([full["history"][1]]));
        assert_eq!(delta["historyPage"]["afterHeadId"], receipt.input_id);
        assert!(serde_json::to_vec(&full).unwrap().len() < 20_000,
            "public views must not resolve media bytes into provider history");
        drop(db);
        let mut db = Catalog::open(&f.0).unwrap();
        assert_eq!(db.thread_view("thread", "main", 20, None).unwrap()["history"], full["history"]);
        for (index, item_id, pointer) in [
            (0, receipt.input_id.as_str(), "/content/attachments/0"),
            (1, assistant.id.as_str(), "/content/content/media"),
        ] {
            let item = &full["history"][index];
            let media = item.pointer(pointer).unwrap();
            assert!(media.get("data_base64").is_none());
            let reference = media["content_ref"]["content_object"].as_str().unwrap();
            let raw: HistoryItem = record(&db.db, "history", item_id).unwrap();
            let (stored, _) = db.content.load_stored_history_payload(&raw.content, &|| false).unwrap();
            assert_eq!(item["content"], stored, "same public payload as history.body");
            let request = MediaReadParams {
                thread_id: "thread".into(), branch_id: "main".into(),
                holder: OutputMediaHolder::History { item_id: item_id.into() },
                part_index: 0, chunk_index: 0, expected_content_ref: reference.into(),
            };
            let chunk = db.capture_media_read(&request).unwrap().chunk(&|| false).unwrap();
            let mut actual = STANDARD.decode(&chunk.bytes_base64).unwrap();
            for chunk_index in 1..chunk.chunk_count {
                let mut request = request.clone();
                request.chunk_index = chunk_index;
                actual.extend(STANDARD.decode(db.capture_media_read(&request).unwrap().chunk(&|| false).unwrap().bytes_base64).unwrap());
            }
            assert_eq!(actual, bytes, "original holder must remain readable");
            let hydrated = db.content.hydrate_history(raw).unwrap();
            let provider_media = hydrated.content.pointer(pointer.strip_prefix("/content").unwrap()).unwrap();
            assert_eq!(provider_media["data_base64"], encoded, "provider reads still resolve original bytes");
        }
        db.create_thread("unrelated", "other").unwrap();
        let foreign = MediaReadParams { thread_id: "unrelated".into(), branch_id: "other".into(),
            holder: OutputMediaHolder::History { item_id: assistant.id }, part_index: 0, chunk_index: 0,
            expected_content_ref: full["history"][1]["content"]["content"]["media"]["content_ref"]["content_object"].as_str().unwrap().into() };
        assert!(db.capture_media_read(&foreign).unwrap().chunk(&|| false).is_err());
    }
    #[test]
    fn cancellation_stops_history_hydration_and_releases_the_reader_snapshot() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let f = Fixture::new();
        let mut db = Catalog::open(&f.0).unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"original"}),
                configuration: json!({}),
            })
            .unwrap();
        db.append_history(
            &receipt.run_id,
            db.epoch(),
            Some(&receipt.input_id),
            HistorySource::User,
            json!({"text":"newest"}),
            None,
        )
        .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let reads = Arc::new(AtomicUsize::new(0));
        let cancellation = cancelled.clone();
        let observed = reads.clone();
        // Cancel at the first hydration boundary, while its metadata and WAL snapshot
        // are already owned. No later body may be opened on this obsolete request.
        db.content.set_history_read_hook(Some(Arc::new(move |_| {
            observed.fetch_add(1, Ordering::Relaxed);
            cancellation.store(true, Ordering::Release);
        })));
        let mut reader = db.read_view().unwrap();
        let result = reader.read_snapshot::<_, RuntimeError>(|catalog| {
            catalog.thread_view_cancellable("thread", "main", 20, None, &|| {
                cancelled.load(Ordering::Acquire)
            })
        });
        assert!(matches!(result, Err(RuntimeError::DispatchCancelled)));
        assert_eq!(reads.load(Ordering::Relaxed), 1);
        assert!(
            reader.db.is_autocommit(),
            "cancelled views must release the WAL read mark"
        );
        db.content.set_history_read_hook(None);
        cancelled.store(false, Ordering::Release);
        let view = reader
            .read_snapshot::<_, RuntimeError>(|catalog| {
                catalog.thread_view_cancellable("thread", "main", 20, None, &|| {
                    cancelled.load(Ordering::Acquire)
                })
            })
            .unwrap();
        assert_eq!(view["history"].as_array().unwrap().len(), 2);
        assert!(matches!(
            reader.thread_view_cancellable("missing", "missing", 20, None, &|| true),
            Err(RuntimeError::DispatchCancelled)
        ));
        assert!(reader.db.is_autocommit());
    }

    #[test]
    fn thread_view_preserves_window_bodies_active_operations_and_delta_boundaries() {
        let f = Fixture::new();
        let mut db = Catalog::open(&f.0).unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"original"}),
                configuration: json!({}),
            })
            .unwrap();
        let mut head = receipt.input_id.clone();
        for n in 0..200 {
            head = db
                .append_history(
                    &receipt.run_id,
                    db.epoch(),
                    Some(&head),
                    HistorySource::User,
                    json!({"text":format!("Retained original {n}"),"extra":[null,42,"中文"]}),
                    None,
                )
                .unwrap()
                .id;
        }
        let operation = db
            .admit_operation(
                "active-tool",
                &receipt.run_id,
                db.epoch(),
                Lifetime::Run,
                json!({"kind":"fixture"}),
            )
            .unwrap();
        let view = db.thread_view("thread", "main", 20, None).unwrap();
        assert_eq!(view["history"].as_array().unwrap().len(), 20);
        assert_eq!(
            view["history"][19]["content"]["extra"],
            json!([null, 42, "中文"])
        );
        assert_eq!(view["historyPage"]["head"], head);
        assert_eq!(view["operations"][0]["id"], operation.id);
        let before = head.clone();
        head = db
            .append_history(
                &receipt.run_id,
                db.epoch(),
                Some(&head),
                HistorySource::Assistant,
                json!({"text":"new response"}),
                None,
            )
            .unwrap()
            .id;
        let delta = db.thread_view("thread", "main", 20, Some(&before)).unwrap();
        assert_eq!(delta["history"].as_array().unwrap().len(), 1);
        assert_eq!(delta["historyPage"]["afterHeadId"], before);
        assert_eq!(delta["historyPage"]["head"], head);
        assert_eq!(delta["operations"][0]["id"], operation.id);
        assert_eq!(
            db.thread_view("thread", "main", 20, Some(&head)).unwrap()["history"],
            json!([])
        );
        let reset = db
            .thread_view("thread", "main", 20, Some("unrelated-cut"))
            .unwrap();
        assert!(reset["historyPage"].get("afterHeadId").is_none());
        assert_eq!(reset["history"].as_array().unwrap().len(), 20);
        db.create_thread("foreign", "other").unwrap();
        assert!(db.thread_view("thread", "other", 20, None).is_err());
    }
    /// Projection rules moved from the Host; exercise durable rows and real history hydration,
    /// rather than reproducing that algorithm in a mocked RPC response.
    #[test]
    fn finite_resource_observers_keep_original_producer_and_branch_identity() {
        for origin in ["model", "policy"] {
            for variant in [
                "original",
                "ordinary-result",
                "other-branch",
                "other-thread",
                "none-effect",
                "spoofed-data",
                "missing",
                "corrupt",
            ] {
                let f = Fixture::new();
                let mut db = Catalog::open(&f.0).unwrap();
                db.create_thread("thread", "main").unwrap();
                let submit = |key: &str, thread: &str, branch: &str| SubmitInput {
                    key: key.into(),
                    thread_id: thread.into(),
                    branch_id: branch.into(),
                    expected_head: None,
                    input: json!({"text":"original"}),
                    configuration: json!({}),
                };
                let receipt = db.submit(&submit("input", "thread", "main")).unwrap();
                let operation_id = if origin == "model" {
                    "request:original:tool:subscribe"
                } else {
                    "action:original:node:subscribe"
                };
                let mut operation = serde_json::to_value(
                    db.admit_operation(
                        operation_id,
                        &receipt.run_id,
                        db.epoch(),
                        Lifetime::Thread,
                        json!({"kind":"fixture"}),
                    )
                    .unwrap(),
                )
                .unwrap();
                operation["phase"] = json!("terminal");
                operation["outcome"] = json!("succeeded");
                operation["effect"] = json!(if variant == "none-effect" {
                    "none"
                } else {
                    "confirmed"
                });
                operation["cancel_requested"] = json!(true);
                operation["mcp_resource_subscription"] = json!({
                    "binding":{"operationId":operation_id,"executionOwner":{"kind":"external","identity":"original","epoch":"original"},
                        "endpoint":{"server":"original","resourceKey":"original","configurationVersion":"original","credentialVersion":"original"},
                        "schemaVersion":"original","uri":"file:///opaque"},
                    "sourceScope":"workspace","acceptanceRef":null,"listenerId":"original", "availability":"closed",
                    "localReleased":true,"mcpHolderReleased":true,"remoteCleanup":"unknown","lastEventCursor":null,"problem":null
                });
                if variant == "ordinary-result" {
                    operation["mcp_resource_subscription"] = Value::Null;
                }
                if variant == "other-branch" || variant == "other-thread" {
                    let thread = if variant == "other-thread" {
                        db.create_thread("foreign", "other").unwrap();
                        "foreign"
                    } else {
                        db.db.execute("INSERT INTO branches(id,thread_id,head) VALUES('other','thread',NULL)", []).unwrap();
                        "thread"
                    };
                    let foreign = db
                        .submit(&submit("foreign-input", thread, "other"))
                        .unwrap();
                    operation["run_id"] = json!(foreign.run_id);
                }
                let output = json!({"data":{"operationId":if variant == "spoofed-data" { "operation:unrelated" } else { operation_id }},"parts":[]});
                let completion = json!({"kind":"result","outcome":"succeeded","effect":"confirmed","content":output});
                operation["call_completion"] = json!({"kind":"result","outcome":"succeeded","effect":"confirmed",
                    "content_ref":db.content.save_output(&serde_json::from_value(output.clone()).unwrap()).unwrap()});
                let history = if origin == "model" {
                    json!({"provenance":{"kind":"tool_data","call_id":"subscribe"},"content":{"kind":"tool_result",
                        "result":{"request_id":"request:original","call_id":"subscribe","completion":completion}}})
                } else {
                    json!({"provenance":{"kind":"policy_tool_data","reference":{"action_id":"action:original","node_id":"subscribe"}},
                        "content":{"kind":"output","output":output}})
                };
                db.append_history(
                    &receipt.run_id,
                    db.epoch(),
                    Some(&receipt.input_id),
                    HistorySource::Tool,
                    history.clone(),
                    None,
                )
                .unwrap();
                // Persist the original terminal record; no continuing observer is in active operations.
                if variant == "corrupt" {
                    operation["revision"] = json!("unreadable");
                }
                db.db
                    .execute(
                        "UPDATE operations SET body=?1 WHERE id=?2",
                        params![operation.to_string(), operation_id],
                    )
                    .unwrap();
                if variant == "missing" {
                    db.db
                        .execute("DELETE FROM operations WHERE id=?1", [operation_id])
                        .unwrap();
                }
                assert!(
                    db.active_thread_operations("thread", Some("main"))
                        .unwrap()
                        .is_empty()
                );
                let result = db.thread_view("thread", "main", 20, None);
                if variant == "corrupt" {
                    assert!(
                        result.is_err(),
                        "{origin}: corruption must not become an absent optional row"
                    );
                    continue;
                }
                let view = result.unwrap();
                assert_eq!(
                    view["history"].as_array().unwrap().last().unwrap()["content"],
                    history
                );
                let expected =
                    variant == "original" || (origin == "model" && variant == "spoofed-data");
                assert_eq!(
                    view["operations"].as_array().unwrap().len(),
                    usize::from(expected),
                    "{origin}/{variant}"
                );
                if expected {
                    assert_eq!(view["operations"][0]["id"], operation_id);
                    assert_eq!(view["operations"][0]["call_completion"], completion);
                    assert_eq!(
                        view["operations"][0]["mcp_resource_subscription"]["availability"],
                        "closed"
                    );
                }
            }
        }
    }
}
