//! Immutable ancestry summaries are cached by branch head; mutable usage receipts are not.
use super::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Summary {
    counts: [u64; 4],
    latest: Option<String>,
    context: Option<String>,
}
#[derive(Default)]
struct BranchCache {
    head: Option<String>,
    summary: Summary,
    composition: Option<(String, Value)>,
}
#[derive(Clone, Default)]
pub(super) struct InspectionCache(Arc<Mutex<HashMap<String, BranchCache>>>);

impl Catalog {
    pub fn context_inspection(&self, branch_id: &str, head_id: Option<&str>) -> Result<Value> {
        let _publication = self.content.begin_publication();
        let _transaction = self
            .db
            .is_autocommit()
            .then(|| self.db.unchecked_transaction())
            .transpose()?;
        let current_head = self.head(branch_id)?;
        // A cached cut is not authority over another branch. Validate the selected head against
        // today's immutable ancestry; the usual current-head case is constant time.
        let mut selected = current_head;
        if let Some(head) = head_id {
            while selected.as_deref() != Some(head) {
                let id = selected.ok_or_else(|| {
                    RuntimeError::Conflict("history anchor is no longer on this branch".into())
                })?;
                selected =
                    self.db
                        .query_row("SELECT parent FROM history WHERE id=?1", [&id], |r| {
                            r.get(0)
                        })?;
            }
        }
        let checkpoint_id: Option<String> = self
            .db
            .query_row(
                "SELECT checkpoint_id FROM active_contexts WHERE branch_id=?1",
                [branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if head_id.is_none() {
            return Ok(
                json!({"head":null,"counts":{"total":0,"user":0,"assistant":0,"tool":0},
                "latestRequest":null,"contextRequest":null,"checkpointId":checkpoint_id}),
            );
        }
        let (known_head, known_summary, composition) = {
            let cache = self
                .context_inspections
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache
                .get(branch_id)
                .map(|entry| {
                    (
                        entry.head.clone(),
                        entry.summary.clone(),
                        entry.composition.clone(),
                    )
                })
                .unwrap_or_default()
        };
        let mut cursor = head_id.map(str::to_owned);
        let mut pending = Vec::new();
        let mut summary = Summary::default();
        while let Some(id) = cursor {
            if known_head.as_deref() == Some(&id) {
                summary = known_summary;
                break;
            }
            let item: HistoryItem = record(&self.db, "history", &id)?;
            cursor = item.parent.clone();
            pending.push((item.id, item.source));
        }
        for (id, source) in pending.into_iter().rev() {
            summary.counts[0] += 1;
            match source {
                HistorySource::User => summary.counts[1] += 1,
                HistorySource::Assistant => {
                    summary.counts[2] += 1;
                    summary.latest = Some(id.clone());
                    summary.context = Some(id);
                }
                HistorySource::Tool => summary.counts[3] += 1,
                HistorySource::Compaction => summary.context = None,
                _ => {}
            }
        }
        let latest_item = summary
            .latest
            .as_ref()
            .map(|id| {
                record::<HistoryItem>(&self.db, "history", id)
                    .and_then(|item| self.content.hydrate_history(item))
            })
            .transpose()?;
        let request_id = latest_item
            .as_ref()
            .and_then(super::thread_view::model_request_id);
        let known_composition = composition.filter(|(id, _)| Some(id) == request_id.as_ref());
        let mut presentation = request_id
            .as_ref()
            .map(|id| {
                self.capture_model_presentations(&[id.clone()], known_composition.is_none())?
                    .load(&|| false)
                    .map(|views| views.into_iter().next())
            })
            .transpose()?
            .flatten()
            .map(serde_json::to_value)
            .transpose()?;
        if let (Some(value), Some((_, context))) = (&mut presentation, &known_composition) {
            value["context"] = context.clone();
        }
        let composition = request_id.zip(
            presentation
                .as_ref()
                .and_then(|value| value.get("context"))
                .cloned(),
        );
        {
            let mut cache = self
                .context_inspections
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(
                branch_id.into(),
                BranchCache {
                    head: head_id.map(str::to_owned),
                    summary: summary.clone(),
                    composition,
                },
            );
        }
        let mut context = (summary.context == summary.latest)
            .then(|| presentation.clone())
            .flatten();
        if let Some(request_checkpoint) = context
            .as_ref()
            .and_then(|value| value.get("context"))
            .and_then(|value| value.get("checkpointId"))
        {
            if request_checkpoint != &json!(checkpoint_id) {
                context = None;
            }
        }
        Ok(
            json!({"head":head_id,"counts":{"total":summary.counts[0],"user":summary.counts[1],"assistant":summary.counts[2],"tool":summary.counts[3]},
            "latestRequest":presentation,"contextRequest":context,"checkpointId":checkpoint_id}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_submission::InputAdmission;
    #[test]
    fn incremental_heads_counts_and_navigation_keep_original_boundaries() {
        let root = std::env::temp_dir().join(format!("varin-context-read-{}", id()));
        let mut db = Catalog::open(&root).unwrap();
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
        let mut reader = db.read_view().unwrap();
        let first = reader
            .read_snapshot::<_, RuntimeError>(|view| {
                view.context_inspection("main", Some(&receipt.input_id))
            })
            .unwrap();
        assert_eq!(
            first["counts"],
            json!({"total":1,"user":1,"assistant":0,"tool":0})
        );
        let second = db
            .append_history(
                &receipt.run_id,
                db.epoch(),
                Some(&receipt.input_id),
                HistorySource::Environment,
                json!({"text":"observation"}),
                None,
            )
            .unwrap();
        let head = db.head("main").unwrap().unwrap();
        assert_eq!(head, second.id);
        let next = reader
            .read_snapshot::<_, RuntimeError>(|view| view.context_inspection("main", Some(&head)))
            .unwrap();
        assert_eq!(
            next["counts"],
            json!({"total":2,"user":1,"assistant":0,"tool":0})
        );
        assert_eq!(
            reader
                .context_inspection("main", Some(&receipt.input_id))
                .unwrap()["counts"],
            first["counts"]
        );
        db.create_thread("other", "elsewhere").unwrap();
        assert!(reader.context_inspection("elsewhere", Some(&head)).is_err());
        drop(reader);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn distant_assistant_composition_late_usage_compaction_and_real_rewind() {
        use super::super::navigation::NavigationCommand;
        use crate::execution::{UsageMeasurement, UsageReceipt};
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root = Fixture(std::env::temp_dir().join(format!("varin-context-contract-{}", id())));
        let mut db = Catalog::open(&root.0).unwrap();
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
        let request_id = "request";
        db.prepare_model_step(request_id, &receipt.run_id, db.epoch(), json!({
            "view": { "origin": {"kind":"driver","driver_id":"fixture","operation_id":"fixture","input_identity":"original"},
                "binding": {"provider_family":"openai-completions","model":"fixture-model","resource_checkpoint_id":null}, "history":[] },
            "serialized": {"messages":[{"role":"user","content":"original"}]}
        })).unwrap();
        let assistant_content = serde_json::to_value(crate::execution::model_history_item(
            request_id,
            &crate::execution::ProviderItem {
                id: "answer".into(),
                content: crate::execution::Content::Text {
                    text: "answer".into(),
                },
                opaque: None,
            },
        ))
        .unwrap();
        let assistant = db
            .append_history(
                &receipt.run_id,
                db.epoch(),
                Some(&receipt.input_id),
                HistorySource::Assistant,
                assistant_content.clone(),
                None,
            )
            .unwrap();
        let mut head = assistant.id.clone();
        // The assistant lies well before the 256-item presentation window. The Catalog owner
        // traverses immutable metadata without hydrating hundreds of unrelated tool bodies.
        for index in 0..448 {
            head = db
                .append_history(
                    &receipt.run_id,
                    db.epoch(),
                    Some(&head),
                    HistorySource::Tool,
                    json!({"index":index,"text":"tool receipt"}),
                    None,
                )
                .unwrap()
                .id;
        }
        let mut reader = db.read_view().unwrap();
        let first = reader
            .read_snapshot::<_, RuntimeError>(|view| view.context_inspection("main", Some(&head)))
            .unwrap();
        assert_eq!(
            first["counts"],
            json!({"total":450,"user":1,"assistant":1,"tool":448})
        );
        assert_eq!(first["latestRequest"]["requestId"], request_id);
        assert!(first["contextRequest"]["contextTokens"].is_null());
        let composition = first["latestRequest"]["context"].clone();
        assert!(composition["totalTokens"].as_u64().unwrap() > 0);
        {
            let cache = reader.context_inspections.0.lock().unwrap();
            let branch = &cache["main"];
            assert_eq!(branch.head.as_deref(), Some(head.as_str()));
            assert_eq!(
                branch.composition.as_ref().unwrap(),
                &(request_id.into(), composition.clone())
            );
        }
        // No new history head: a provider receipt arrives after the initial inspection.
        db.settle_model_step(
            request_id,
            db.epoch(),
            ModelStepState::Completed,
            Vec::new(),
            Some(
                serde_json::to_value(UsageReceipt {
                    measurement: UsageMeasurement::Actual,
                    input_tokens: Some(40000),
                    output_tokens: Some(1000),
                    cached_input_tokens: Some(35000),
                    ..Default::default()
                })
                .unwrap(),
            ),
        )
        .unwrap();
        let late = reader
            .read_snapshot::<_, RuntimeError>(|view| view.context_inspection("main", Some(&head)))
            .unwrap();
        assert_eq!(late["contextRequest"]["contextTokens"], 41000);
        assert_eq!(late["latestRequest"]["context"], composition);
        assert_eq!(late["latestRequest"]["usage"]["measurement"], "actual");
        head = db
            .append_history(
                &receipt.run_id,
                db.epoch(),
                Some(&head),
                HistorySource::Compaction,
                json!({"text":"compacted"}),
                None,
            )
            .unwrap()
            .id;
        let compacted = reader.context_inspection("main", Some(&head)).unwrap();
        assert!(compacted["contextRequest"].is_null());
        assert_eq!(compacted["latestRequest"]["contextTokens"], 41000);
        assert_eq!(compacted["counts"]["total"], 451);
        head = db
            .append_history(
                &receipt.run_id,
                db.epoch(),
                Some(&head),
                HistorySource::Assistant,
                assistant_content,
                None,
            )
            .unwrap()
            .id;
        assert_eq!(
            reader.context_inspection("main", Some(&head)).unwrap()["contextRequest"]["contextTokens"],
            41000
        );
        let run = db.run(&receipt.run_id).unwrap();
        let run = db
            .transition_run(&run.id, db.epoch(), run.revision, RunState::Runnable)
            .unwrap();
        db.transition_run(&run.id, db.epoch(), run.revision, RunState::Completed)
            .unwrap();
        let navigation = db
            .prepare_navigation(NavigationCommand {
                key: "rewind".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head_id: Some(head.clone()),
                target_head_id: Some(assistant.id.clone()),
                undo_of: None,
                preserved_plan: None,
            })
            .unwrap()
            .load()
            .unwrap();
        db.commit_navigation(navigation).unwrap();
        let rewound = reader
            .context_inspection("main", Some(&assistant.id))
            .unwrap();
        assert_eq!(
            rewound["counts"],
            json!({"total":2,"user":1,"assistant":1,"tool":0})
        );
        assert_eq!(rewound["contextRequest"]["contextTokens"], 41000);
        assert!(
            reader
                .context_inspection("main", Some(&receipt.input_id))
                .unwrap()["contextRequest"]
                .is_null()
        );
        assert!(matches!(
            reader.context_inspection("main", Some(&head)),
            Err(RuntimeError::Conflict(_))
        ));
        db.create_thread("other", "other-main").unwrap();
        assert!(matches!(
            reader.context_inspection("other-main", Some(&assistant.id)),
            Err(RuntimeError::Conflict(_))
        ));
    }
}
