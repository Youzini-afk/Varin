//! Retire deleted conversations and branches through their original Catalog before content tracing.
//! Live executors and surviving relational references remain roots. Thread tombstones keep
//! deletion replay and agent identity stable without retaining every historical request body.
use super::*;
use std::collections::BTreeMap;

type RetirementCandidates = (Vec<(String, Vec<String>)>, usize);

fn quoted(value: &str) -> String { format!("\"{}\"", value.replace('"', "\"\"")) }

fn seed(tx: &Transaction<'_>, table: &str, condition: &str) -> Result<()> {
    tx.execute(&format!("INSERT OR IGNORE INTO thread_gc_rows SELECT ?1,rowid FROM {} WHERE {condition}", quoted(table)), [table])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::threads::{BranchDelete, ThreadDelete};
    use crate::test_submission::InputAdmission;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self { Self(std::env::temp_dir().join(format!("varin-thread-retention-{}", Uuid::new_v4()))) }
        fn open(&self) -> Catalog { Catalog::open(&self.0).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn submit(db: &mut Catalog, thread: &str, text: &str) -> Receipt {
        db.create_thread(thread, &format!("{thread}-main")).unwrap();
        db.submit(&SubmitInput { key: format!("{thread}-input"), thread_id: thread.into(), branch_id: format!("{thread}-main"), expected_head: None, input: json!({"text":text}), configuration: json!({}) }).unwrap()
    }
    fn finish(db: &mut Catalog, run: &str) {
        let current = db.run(run).unwrap();
        let next = db.transition_run(run, db.epoch(), current.revision, RunState::Runnable).unwrap();
        db.transition_run(run, db.epoch(), next.revision, RunState::Completed).unwrap();
    }
    fn delete(db: &mut Catalog, thread: &str) -> ThreadDelete {
        let command = ThreadDelete { thread_id: thread.into(), key: format!("{thread}-delete"), expected_revision: db.inspect_thread(thread).unwrap()["revision"].as_u64().unwrap() };
        db.delete_thread(&command).unwrap(); command
    }
    fn retire(db: &mut Catalog) -> Result<(usize, usize)> {
        let runs = db.deleted_thread_retirement_candidates()?.0.into_iter()
            .chain(db.deleted_branch_retirement_candidates()?.0).flat_map(|(_, runs)| runs).collect::<Vec<_>>();
        db.retire_deleted_threads(&runs)
    }

    #[test]
    fn branch_deletion_preserves_descendants_and_retires_unshared_history() {
        let root = Fixture::new();
        let mut db = root.open();
        let main = submit(&mut db, "chat", "Main conversation");
        finish(&mut db, &main.run_id);
        let fork = db.prepare_branch_fork("chat-main", "fork", Some(&main.input_id), None).unwrap().load().unwrap();
        db.admit_branch_fork(fork).unwrap();
        let leaf = db.submit(&SubmitInput {
            key: "fork-input".into(), thread_id: "chat".into(), branch_id: "fork".into(),
            expected_head: Some(main.input_id.clone()), input: json!({"text":"Branch work"}), configuration: json!({}),
        }).unwrap();
        let command = BranchDelete { thread_id: "chat".into(), branch_id: "fork".into(), key: "delete-fork".into() };
        assert!(db.delete_branch(&command).is_err());
        finish(&mut db, &leaf.run_id);
        let descendant = db.prepare_branch_fork("fork", "descendant", Some(&leaf.input_id), None).unwrap().load().unwrap();
        db.admit_branch_fork(descendant).unwrap();
        let receipt = db.delete_branch(&command).unwrap();
        assert_eq!(receipt["branches"].as_array().unwrap().len(), 2);
        assert_eq!(db.delete_branch(&command).unwrap(), receipt);
        assert!(db.prepare_branch_fork("fork", "new", Some(&leaf.input_id), None).is_err());
        let tree = db.capture_conversation_tree("chat", "chat-main").unwrap().load(&|| false).unwrap();
        assert!(tree.routes.iter().all(|route| route.branch_id != "fork"));
        assert_eq!(retire(&mut db).unwrap().1, 0);
        assert!(db.history("fork").unwrap().is_empty());
        assert_eq!(db.history("descendant").unwrap().len(), 2);

        db.delete_branch(&BranchDelete { branch_id: "descendant".into(), key: "delete-descendant".into(), ..command.clone() }).unwrap();
        assert!(retire(&mut db).unwrap().0 > 0);
        assert!(matches!(db.run(&leaf.run_id), Err(RuntimeError::NotFound(_))));
        assert_eq!(db.history("chat-main").unwrap().len(), 1);
        drop(db);
        let mut db = root.open();
        assert_eq!(db.delete_branch(&command).unwrap(), receipt);
        assert_eq!(db.inspect_thread("chat").unwrap()["branches"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn deletion_releases_finished_history_and_keeps_shared_content_readable() {
        let root = Fixture::new(); let mut db = root.open();
        let text = "shared conversation material ".repeat(3000);
        let removed = submit(&mut db, "removed", &text);
        let survivor = submit(&mut db, "survivor", &text);
        finish(&mut db, &removed.run_id); finish(&mut db, &survivor.run_id);
        let before = db.history("survivor-main").unwrap();
        let reference = db.history_page("removed-main", None, None, 1).unwrap().items.remove(0);
        let command = delete(&mut db, "removed");
        // A tombstone hides discovery, but leaves the original holder readable until retirement.
        assert!(db.history_body_reader(&reference.id).unwrap().chunk(0).is_ok());
        let receipt = db.delete_thread(&command).unwrap();
        let (retired, pending) = retire(&mut db).unwrap();
        assert!(retired > 0); assert_eq!(pending, 0);
        assert!(db.history("removed-main").unwrap().is_empty());
        let retired_page = db.history_page("removed-main", None, None, 1).unwrap();
        assert!(retired_page.head.is_none() && retired_page.items.is_empty() && retired_page.previous.is_none());
        // A page reference is not a lease across RPCs. The same stale body lookup that
        // can race retirement must reject, even while shared bytes survive for another Thread.
        assert!(matches!(db.history_body_reader(&reference.id), Err(RuntimeError::NotFound(_))));
        assert!(matches!(db.run(&removed.run_id), Err(RuntimeError::NotFound(_))));
        let collected = db.prepare_content_collection(Default::default()).run();
        assert_eq!(collected.status, ContentCollectionStatus::Completed, "{collected:?}");
        assert!(collected.removed_objects > 0);
        assert_eq!(db.history("survivor-main").unwrap(), before);
        assert_eq!(db.delete_thread(&command).unwrap(), receipt);
        assert_eq!(retire(&mut db).unwrap(), (0, 0));
        drop(db);
        let db = root.open();
        assert_eq!(db.history("survivor-main").unwrap(), before);
        assert_eq!(db.inspect_thread("removed").unwrap()["deleted_at_ms"], receipt["deleted_at_ms"]);
    }

    #[test]
    fn ui_retention_follows_surviving_content_not_thread_visibility() {
        let root = Fixture::new(); let mut db = root.open();
        let removed = submit(&mut db, "removed-ui", "```ui\n{\"ref\":\"ui:shared@2\"}\n``` ui-selection:original");
        finish(&mut db, &removed.run_id);
        assert!(db.capture_material_retention(None, &[], false).unwrap().load().unwrap().ui_references.is_none());
        assert!(db.capture_material_retention(Some("removed-ui"), &[], true).unwrap().load().unwrap().ui_references.is_none());
        db.create_thread("surviving-ui", "surviving-ui-main").unwrap();
        db.db.execute("UPDATE branches SET head=?1 WHERE id='surviving-ui-main'", [&removed.input_id]).unwrap();
        let refs = |db: &Catalog| db.capture_material_retention(None, &[], true).unwrap().load().unwrap().ui_references.unwrap();
        assert!(refs(&db).contains(&"ui:shared@2".into()));
        delete(&mut db, "removed-ui");
        retire(&mut db).unwrap();
        assert!(refs(&db).contains(&"ui:shared@2".into()));
        assert!(refs(&db).contains(&"ui-selection:original".into()));
        delete(&mut db, "surviving-ui");
        retire(&mut db).unwrap();
        assert!(refs(&db).is_empty());
    }

    #[test]
    fn ui_retention_keeps_pending_deleted_run_until_native_drain() {
        let root = Fixture::new(); let mut db = root.open();
        let running = submit(&mut db, "running-ui", "ui-snapshot:active ui-view:open");
        delete(&mut db, "running-ui");
        assert_eq!(retire(&mut db).unwrap(), (0, 1));
        let refs = db.capture_material_retention(None, &[], true).unwrap().load().unwrap().ui_references.unwrap();
        assert!(refs.contains(&"ui-snapshot:active".into()));
        assert!(refs.contains(&"ui-view:open".into()));
        finish(&mut db, &running.run_id);
        retire(&mut db).unwrap();
        assert!(db.capture_material_retention(None, &[], true).unwrap().load().unwrap().ui_references.unwrap().is_empty());
    }

    #[test]
    fn ui_retention_includes_queue_of_an_archived_live_thread() {
        let root = Fixture::new(); let mut db = root.open();
        submit(&mut db, "queued-ui", "initial");
        db.enqueue_input(&inputs::EnqueueInput {
            key: "queued-ui-message".into(), thread_id: "queued-ui".into(), branch_id: "queued-ui-main".into(),
            mode: InputMode::Boundary, input: json!({"text":"Inspect ui-selection:queued ui:queued@1"}), configuration: None,
        }).unwrap();
        db.update_thread(&threads::ThreadUpdate { thread_id:"queued-ui".into(), key:"archive-ui".into(),
            expected_revision:db.inspect_thread("queued-ui").unwrap()["revision"].as_u64().unwrap(),
            title:None,pinned:None,archived:Some(true),title_mode:None }).unwrap();
        let refs = db.capture_material_retention(None, &[], true).unwrap().load().unwrap().ui_references.unwrap();
        assert!(refs.contains(&"ui-selection:queued".into()));
        assert!(refs.contains(&"ui:queued@1".into()));
    }

    #[test]
    fn deleted_conversation_usage_survives_retirement_and_loses_only_its_title() {
        use crate::catalog::usage_ledger::fixture::{completed_conversation, summary};
        let root = Fixture::new(); let mut db = root.open();
        let removed = submit(&mut db, "removed", "paid question");
        let kept = submit(&mut db, "kept", "another paid question");
        completed_conversation(&mut db, &removed.run_id, "removed-request");
        completed_conversation(&mut db, &kept.run_id, "kept-request");
        let before = summary(&db);
        delete(&mut db, "removed");
        let (retired, pending) = retire(&mut db).unwrap();
        assert!(retired > 0); assert_eq!(pending, 0);
        assert!(matches!(db.run(&removed.run_id), Err(RuntimeError::NotFound(_))));
        let after = summary(&db);
        assert_eq!(after.rows, before.rows, "the request and its estimated cost remain");
        let threads: Vec<_> = after.threads.iter().map(|thread| (thread.thread_id.as_str(), thread.title.is_some(), thread.deleted, thread.requests)).collect();
        assert_eq!(threads, [("kept", true, false, 1), ("removed", false, true, 1)]);
        assert_eq!(before.threads.iter().filter(|thread| thread.title.is_some() && !thread.deleted).count(), 2);
        drop(db);
        assert_eq!(summary(&root.open()).rows, before.rows);
    }

    #[test]
    fn deletion_waits_for_the_original_run_to_finish() {
        let root = Fixture::new(); let mut db = root.open();
        let receipt = submit(&mut db, "running", "accepted work");
        delete(&mut db, "running");
        assert_eq!(retire(&mut db).unwrap(), (0, 1));
        assert!(!db.history("running-main").unwrap().is_empty());
        finish(&mut db, &receipt.run_id);
        assert_eq!(db.retire_deleted_threads(&[]).unwrap(), (0, 1));
        let (removed, pending) = retire(&mut db).unwrap();
        assert!(removed > 0); assert_eq!(pending, 0);
        assert!(db.history("running-main").unwrap().is_empty());
    }

    #[test]
    fn surviving_branch_keeps_shared_history_until_its_own_deletion() {
        let root = Fixture::new(); let mut db = root.open();
        let receipt = submit(&mut db, "source", "shared fork input");
        finish(&mut db, &receipt.run_id);
        db.create_thread("fork", "fork-main").unwrap();
        db.db.execute("UPDATE branches SET head=?1 WHERE id='fork-main'", [&receipt.input_id]).unwrap();
        let before = db.history("fork-main").unwrap();
        delete(&mut db, "source");
        retire(&mut db).unwrap();
        assert_eq!(db.history("fork-main").unwrap(), before);
        assert!(db.run(&receipt.run_id).is_ok());
        assert_eq!(db.prepare_content_collection(Default::default()).run().status, ContentCollectionStatus::Completed);
        assert_eq!(db.history("fork-main").unwrap(), before);
        delete(&mut db, "fork");
        retire(&mut db).unwrap();
        assert!(db.history("fork-main").unwrap().is_empty());
        assert!(db.run(&receipt.run_id).is_err());
    }
}

fn owned(tx: &Transaction<'_>, table: &str, query: &str) -> Result<()> {
    tx.execute(&format!("INSERT OR IGNORE INTO thread_gc_owners SELECT ?1,row_id,run_id FROM ({query}) WHERE run_id IN (SELECT id FROM thread_gc_runs)"), [table])?;
    tx.execute("INSERT OR IGNORE INTO thread_gc_rows SELECT table_name,row_id FROM thread_gc_owners WHERE table_name=?1", [table])?;
    Ok(())
}

impl Catalog {
    pub(crate) fn deleted_thread_retirement_candidates(&self) -> Result<RetirementCandidates> {
        // Summary Threads are private jobs owned by the branch being deleted.
        self.db.execute("UPDATE threads SET deleted_at_ms=(SELECT parent.deleted_at_ms FROM child_tasks c JOIN operations o ON o.id=c.id JOIN threads parent ON parent.id=json_extract(c.body,'$.parent_thread_id') WHERE c.child_thread_id=threads.id AND json_extract(o.body,'$.executor')='code_retrieval' AND parent.deleted_at_ms IS NOT NULL),revision=revision+1 WHERE deleted_at_ms IS NULL AND id IN (SELECT c.child_thread_id FROM child_tasks c JOIN operations o ON o.id=c.id JOIN threads parent ON parent.id=json_extract(c.body,'$.parent_thread_id') WHERE json_extract(o.body,'$.executor')='code_retrieval' AND parent.deleted_at_ms IS NOT NULL)", [])?;
        self.db.execute("UPDATE threads SET deleted_at_ms=(SELECT min(parent.deleted_at_ms) FROM context_jobs j JOIN branches source ON source.id=j.branch_id JOIN threads parent ON parent.id=source.thread_id JOIN runs r ON r.id=j.run_id JOIN branches child ON child.id=r.branch_id WHERE child.thread_id=threads.id AND parent.deleted_at_ms IS NOT NULL),revision=revision+1 WHERE deleted_at_ms IS NULL AND id IN (SELECT child.thread_id FROM context_jobs j JOIN branches source ON source.id=j.branch_id JOIN threads parent ON parent.id=source.thread_id JOIN runs r ON r.id=j.run_id JOIN branches child ON child.id=r.branch_id WHERE parent.deleted_at_ms IS NOT NULL)", [])?;
        self.retirement_candidates("SELECT id FROM threads WHERE deleted_at_ms IS NOT NULL",
            "SELECT r.body FROM runs r JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1")
    }

    pub(crate) fn deleted_branch_retirement_candidates(&self) -> Result<RetirementCandidates> {
        self.retirement_candidates(
            "SELECT b.id FROM events e JOIN branches b ON b.id=e.subject JOIN threads t ON t.id=b.thread_id
             WHERE e.kind='branch.deleted' AND t.deleted_at_ms IS NULL",
            "SELECT body FROM runs WHERE branch_id=?1",
        )
    }

    fn retirement_candidates(&self, targets: &str, runs: &str) -> Result<RetirementCandidates> {
        let targets: Vec<String> = self.db.prepare(targets)?.query_map([], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let mut query = self.db.prepare(runs)?;
        let mut ready = Vec::new();
        let mut pending = 0;
        for id in targets {
            let runs: Vec<Run> = query.query_map([&id], |row| row.get::<_, String>(0))?
                .map(|row| Ok(serde_json::from_str(&row?)?)).collect::<Result<_>>()?;
            let mut drained = true;
            for run in &runs {
                let pending: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.phase')!='terminal') OR EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched'))", [&run.id], |row| row.get(0))?;
                let (stops, _, models) = self.bot_run_barriers(&run.id)?;
                let child_resources:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM delegated_executions d JOIN operations o ON o.id=d.child_operation_id WHERE o.run_id=?1 AND json_extract(d.body,'$.resources_released')=0)",[&run.id],|row|row.get(0))?;
                if !run.state.terminal() || pending || child_resources || !stops.is_empty() || !models.is_empty() { drained = false; break; }
            }
            if drained { ready.push((id, runs.into_iter().map(|run| run.id).collect())); } else { pending += 1; }
        }
        Ok((ready, pending))
    }

    pub(crate) fn retire_deleted_threads(&mut self, drained_runs: &[String]) -> Result<(usize, usize)> {
        let (candidates, mut pending) = self.deleted_thread_retirement_candidates()?;
        let (branches, branch_pending) = self.deleted_branch_retirement_candidates()?;
        pending += branch_pending;
        let mut ready = Vec::new();
        for ((id, runs), table) in candidates.into_iter().map(|target| (target, "thread_gc_threads"))
            .chain(branches.into_iter().map(|target| (target, "thread_gc_branches"))) {
            if runs.iter().all(|run| drained_runs.contains(run)) { ready.push((id, table)); }
            else { pending += 1; }
        }
        if ready.is_empty() { return Ok((0, pending)); }
        let tx = self.db.transaction()?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS thread_gc_threads(id TEXT PRIMARY KEY);
            CREATE TEMP TABLE IF NOT EXISTS thread_gc_branches(id TEXT PRIMARY KEY);
            CREATE TEMP TABLE IF NOT EXISTS thread_gc_runs(id TEXT PRIMARY KEY);
            CREATE TEMP TABLE IF NOT EXISTS thread_gc_rows(table_name TEXT NOT NULL,row_id INTEGER NOT NULL,PRIMARY KEY(table_name,row_id));
            CREATE TEMP TABLE IF NOT EXISTS thread_gc_owners(table_name TEXT NOT NULL,row_id INTEGER NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(table_name,row_id));
            DELETE FROM thread_gc_threads; DELETE FROM thread_gc_branches; DELETE FROM thread_gc_runs; DELETE FROM thread_gc_rows; DELETE FROM thread_gc_owners;")?;
        for (id, table) in ready {
            tx.execute(&format!("INSERT INTO {table} VALUES(?1)"), [id])?;
        }
        tx.execute("INSERT INTO thread_gc_branches SELECT id FROM branches WHERE thread_id IN (SELECT id FROM thread_gc_threads)", [])?;
        tx.execute("INSERT INTO thread_gc_runs SELECT r.id FROM runs r JOIN thread_gc_branches b ON b.id=r.branch_id", [])?;
        for table in ["history", "goals", "calendar_occurrences"] {
            seed(&tx, table, "thread_id IN (SELECT id FROM thread_gc_threads)")?;
        }
        for table in ["input_queue", "context_checkpoints", "memory_states", "active_contexts", "goals", "thread_title_progress"] {
            seed(&tx, table, "branch_id IN (SELECT id FROM thread_gc_branches)")?;
        }
        seed(&tx, "followups", "json_extract(body,'$.owner.kind')='work' AND (thread_id IN (SELECT id FROM thread_gc_threads) OR json_extract(body,'$.branch_id') IN (SELECT id FROM thread_gc_branches))")?;
        seed(&tx, "calendar_occurrences", "input_id IN (SELECT id FROM input_queue WHERE branch_id IN (SELECT id FROM thread_gc_branches))")?;
        seed(&tx, "runs", "id IN (SELECT id FROM thread_gc_runs)")?;
        for table in ["run_drivers", "driver_checkpoints", "driver_calls", "operations", "model_steps", "model_selections", "policy_checkpoints", "policy_selections", "waits", "bot_run_holds", "context_jobs", "context_job_nodes", "context_job_steps", "resumptions"] {
            owned(&tx, table, &format!("SELECT rowid AS row_id,run_id FROM {table}"))?;
        }
        owned(&tx, "context_observation_captures", "SELECT rowid AS row_id,source_run_id AS run_id FROM context_observation_captures")?;
        owned(&tx, "context_observation_imports", "SELECT rowid AS row_id,id AS run_id FROM context_observation_imports")?;
        owned(&tx, "history", "SELECT rowid AS row_id,run_id FROM history")?;
        owned(&tx, "run_launches", "SELECT rowid AS row_id,id AS run_id FROM run_launches")?;
        owned(&tx, "computer_requests", "SELECT rowid AS row_id,requester_run_id AS run_id FROM computer_requests")?;
        for table in ["model_outputs", "tool_calls"] {
            owned(&tx, table, &format!("SELECT x.rowid AS row_id,m.run_id FROM {table} x JOIN model_steps m ON m.id=x.request_id"))?;
        }
        for (table, column) in [("policy_graph_nodes", "action_id"), ("policy_graph_dependencies", "action_id"), ("resource_occupancy", "operation_id"), ("mcp_interactions", "operation_id"), ("code_exchange_peers", "operation_id"), ("child_tasks", "id")] {
            owned(&tx, table, &format!("SELECT x.rowid AS row_id,o.run_id FROM {table} x JOIN operations o ON o.id=x.{column}"))?;
        }
        owned(&tx, "delegated_executions", "SELECT x.rowid AS row_id,o.run_id FROM delegated_executions x JOIN operations o ON o.id=x.child_operation_id")?;
        owned(&tx, "child_result_files", "SELECT x.rowid AS row_id,o.run_id FROM child_result_files x JOIN delegated_executions d ON d.id=x.execution_id JOIN operations o ON o.id=d.child_operation_id")?;
        // A surviving child still needs its original dispatch/parent identity, even when
        // the parent conversation is hidden. Relational protection retains that Run too.
        tx.execute("DELETE FROM thread_gc_rows WHERE table_name='child_tasks' AND row_id IN (SELECT rowid FROM child_tasks WHERE child_thread_id NOT IN (SELECT id FROM thread_gc_threads))", [])?;
        seed(&tx, "input_history_content", "input_id IN (SELECT id FROM input_queue WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='input_queue'))")?;
        seed(&tx, "followup_event_routes", "followup_id IN (SELECT id FROM followups WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='followups'))")?;
        seed(&tx, "followup_event_matches", "followup_id IN (SELECT id FROM followups WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='followups'))")?;
        seed(&tx, "followup_occurrences", "followup_id IN (SELECT id FROM followups WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='followups'))")?;
        // Bot definitions outlive the conversation, not the conversation's settled
        // input/history graph. Matching watermarks and compact source dedup remain.
        seed(&tx, "followup_occurrences", "input_id IN (SELECT id FROM input_queue WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='input_queue'))")?;
        seed(&tx, "followup_event_matches", "occurrence_id IN (SELECT id FROM followup_occurrences WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='followup_occurrences'))")?;

        for table in ["goal_children", "goal_runs"] { seed(&tx, table, "goal_id IN (SELECT id FROM goals WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='goals'))")?; }
        seed(&tx, "goal_usage", "id IN (SELECT id FROM goals WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='goals'))")?;

        // These are typed receipt identity fields, never a scan of arbitrary user text for IDs.
        seed(&tx, "commands", "coalesce(json_extract(intent,'$.kind'),'') NOT IN ('thread.delete','branch.delete') AND (
            json_extract(receipt,'$.thread_id') IN (SELECT id FROM thread_gc_threads)
            OR json_extract(receipt,'$.threadId') IN (SELECT id FROM thread_gc_threads)
            OR json_extract(receipt,'$.run_id') IN (SELECT id FROM thread_gc_runs)
            OR json_extract(receipt,'$.runId') IN (SELECT id FROM thread_gc_runs)
            OR json_extract(receipt,'$.branch_id') IN (SELECT id FROM thread_gc_branches)
            OR json_extract(receipt,'$.branchId') IN (SELECT id FROM thread_gc_branches)
            OR json_extract(receipt,'$.input_id') IN (SELECT id FROM input_queue WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='input_queue'))
            OR json_extract(receipt,'$.id') IN (SELECT id FROM operations WHERE run_id IN (SELECT id FROM thread_gc_runs)))")?;
        seed(&tx, "events", "kind NOT IN ('thread.deleted','branch.deleted','branch.created') AND (subject IN (SELECT id FROM thread_gc_threads)
            OR subject IN (SELECT id FROM thread_gc_branches)
            OR subject IN (SELECT id FROM thread_gc_runs)
            OR subject IN (SELECT id FROM operations WHERE run_id IN (SELECT id FROM thread_gc_runs))
            OR subject IN (SELECT id FROM driver_calls WHERE run_id IN (SELECT id FROM thread_gc_runs))
            OR subject IN (SELECT id FROM model_steps WHERE run_id IN (SELECT id FROM thread_gc_runs))
            OR subject IN (SELECT id FROM input_queue WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name='input_queue')))")?;
        seed(&tx, "deliveries", "state='\"committed\"' AND fact_cursor IN (SELECT row_id FROM thread_gc_rows WHERE table_name='events')")?;
        // Shared history also keeps the original command and event receipts for its Run.
        owned(&tx, "commands", "SELECT rowid AS row_id,coalesce(json_extract(receipt,'$.run_id'),json_extract(receipt,'$.runId')) AS run_id FROM commands")?;
        owned(&tx, "events", "SELECT e.rowid AS row_id,r.id AS run_id FROM events e JOIN runs r ON r.id=e.subject UNION SELECT e.rowid AS row_id,o.run_id FROM events e JOIN operations o ON o.id=e.subject UNION SELECT e.rowid AS row_id,m.run_id FROM events e JOIN model_steps m ON m.id=e.subject UNION SELECT e.rowid AS row_id,d.run_id FROM events e JOIN driver_calls d ON d.id=e.subject")?;

        // A branch can share an older Thread's head before it has appended any history of its own.
        tx.execute_batch("WITH RECURSIVE retained(id) AS (
            SELECT head FROM branches WHERE id NOT IN (SELECT id FROM thread_gc_branches) AND head IS NOT NULL
            UNION SELECT h.parent FROM history h JOIN retained r ON r.id=h.id WHERE h.parent IS NOT NULL)
            DELETE FROM thread_gc_rows WHERE table_name='history' AND row_id IN (SELECT rowid FROM history WHERE id IN retained);")?;

        let tables: Vec<String> = tx.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")?
            .query_map([], |row| row.get(0))?.collect::<std::result::Result<_, _>>()?;
        let mut constraints = Vec::new();
        for table in &tables {
            let mut keys: BTreeMap<i64, (String, Vec<(String, String)>)> = BTreeMap::new();
            let mut query = tx.prepare(&format!("PRAGMA foreign_key_list({})", quoted(table)))?;
            for key in query.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)))? {
                let (id, parent, from, to) = key?;
                keys.entry(id).or_insert_with(|| (parent, Vec::new())).1.push((from, to));
            }
            for (_, (parent, columns)) in keys {
                let equality = columns.iter().map(|(from, to)| format!("c.{}=p.{}", quoted(from), quoted(to))).collect::<Vec<_>>().join(" AND ");
                constraints.push((parent.clone(), table.clone(), format!("SELECT p.rowid FROM {} p JOIN {} c ON {equality} WHERE NOT EXISTS(SELECT 1 FROM thread_gc_rows g WHERE g.table_name=?2 AND g.row_id=c.rowid)", quoted(&parent), quoted(table))));
            }
        }
        // Preserve surviving FK consumers, including composite keys. A shared historical Run
        // keeps its source, requests and receipts so file navigation and inspection still work.
        loop {
            let mut protected = 0;
            for (parent, child, query) in &constraints {
                protected += tx.execute(&format!("DELETE FROM thread_gc_rows WHERE table_name=?1 AND row_id IN ({query})"), params![parent, child])?;
            }
            protected += tx.execute("DELETE FROM thread_gc_rows WHERE EXISTS(SELECT 1 FROM thread_gc_owners o JOIN runs r ON r.id=o.run_id WHERE o.table_name=thread_gc_rows.table_name AND o.row_id=thread_gc_rows.row_id AND NOT EXISTS(SELECT 1 FROM thread_gc_rows g WHERE g.table_name='runs' AND g.row_id=r.rowid))", [])?;
            if protected == 0 { break; }
        }
        tx.execute_batch("PRAGMA defer_foreign_keys=ON;")?;
        let mut removed = 0;
        for table in &tables {
            removed += tx.execute(&format!("DELETE FROM {} WHERE rowid IN (SELECT row_id FROM thread_gc_rows WHERE table_name=?1)", quoted(table)), [table])?;
        }
        attachments::retire(&tx)?;
        // Heads are not SQL foreign keys. Only retired branches can have lost their final head.
        tx.execute("UPDATE branches SET head=NULL,active_run=NULL WHERE thread_id IN (SELECT id FROM thread_gc_threads) AND head IS NOT NULL AND NOT EXISTS(SELECT 1 FROM history WHERE id=branches.head)", [])?;
        tx.execute("UPDATE branches SET head=NULL WHERE id IN (SELECT id FROM thread_gc_branches) AND head IS NOT NULL AND EXISTS(SELECT 1 FROM events WHERE subject=branches.id AND kind='branch.deleted')", [])?;
        tx.execute_batch("DELETE FROM thread_gc_threads; DELETE FROM thread_gc_branches; DELETE FROM thread_gc_runs; DELETE FROM thread_gc_rows; DELETE FROM thread_gc_owners;")?;
        tx.commit()?;
        Ok((removed, pending))
    }
}
