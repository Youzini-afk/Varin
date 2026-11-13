//! Resolve event ownership once, at publication. Readers only join the retained scope.
use super::*;

#[derive(Default)]
pub(super) struct Scope {
    pub thread: Option<String>,
    pub branch: Option<String>,
}

// These domains intentionally have Host/project/source scope rather than a native conversation.
// They are not implicitly public: principal-filtered replay admits only its organization space.
pub const GLOBAL_KINDS: &[&str] = &[
    "catalog.upgraded",
    "organization.changed",
    "external.created",
    "external.changed",
    "external.settings",
    "calendar.definition_changed",
    "calendar.definition_deleted",
    "calendar.project_synchronized",
    "calendar.calculated",
    "calendar.calculation_requested",
    "calendar.preparation_requested",
    "calendar.preparation_failed",
    "bot.scope_deleted",
    "bot.execution_gate_published",
    "bot.matter.updated",
    "bot.work_pending",
    "followup.event_received",
    "followup.source_route_created",
    "followup.source_route_changed",
    "followup.source_route_removed",
    "usage.updated",
    "recovery.unavailable",
];

// Standalone text and knowledge inference share operation/receipt events with native
// conversations, but deliberately do not create synthetic conversation branches.
#[cfg(test)]
const UTILITY_GLOBAL_KINDS: &[&str] = &[
    "model_text.admitted",
    "model_text.cancel_requested",
    "model_text.settled",
    "model_text.recovered",
    "knowledge_inference.admitted",
    "knowledge_inference.finished",
    "knowledge_inference.recovered",
    "inference.admitted",
    "inference.dispatched",
    "inference.receipt_pending",
    "inference.settled",
    "inference.recovered",
    "operation.cancel_requested",
    "operation.kernel_executor_stopped",
    "operation.settled",
];
#[cfg(test)]
pub(super) fn is_global(db: &Connection, subject: &str, kind: &str) -> Result<bool> {
    if GLOBAL_KINDS.contains(&kind) {
        return Ok(true);
    }
    if !UTILITY_GLOBAL_KINDS.contains(&kind) {
        return Ok(false);
    }
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM runs r WHERE json_extract(r.body,'$.kind') IN (?2,?3) AND (r.id=?1 OR r.id=(SELECT run_id FROM operations WHERE id=?1) OR r.id=(SELECT run_id FROM model_steps WHERE id=?1) OR r.id=(SELECT run_id FROM waits WHERE id=?1)))",
        params![subject, model_text::KIND, knowledge_inference::KIND], |row| row.get(0))?)
}

// Index lookups at one writer, rather than this UNION for every event for every observer.
// A subject colliding between different owners remains ambiguous and is not exposed.
const SUBJECTS: &str = "
 SELECT id AS subject,id AS thread_id,NULL AS branch_id FROM threads
 UNION ALL SELECT id,thread_id,id FROM branches
 UNION ALL SELECT r.id,b.thread_id,b.id FROM runs r JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT o.id,b.thread_id,b.id FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT i.id,b.thread_id,i.branch_id FROM input_queue i JOIN branches b ON b.id=i.branch_id
 UNION ALL SELECT m.id,b.thread_id,b.id FROM model_steps m JOIN runs r ON r.id=m.run_id JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT w.id,b.thread_id,b.id FROM waits w JOIN runs r ON r.id=w.run_id JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT d.id,b.thread_id,b.id FROM driver_calls d JOIN runs r ON r.id=d.run_id JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT f.id,f.thread_id,json_extract(f.body,'$.branch_id') FROM followups f
 UNION ALL SELECT o.id,f.thread_id,json_extract(f.body,'$.branch_id') FROM followup_occurrences o JOIN followups f ON f.id=o.followup_id
 UNION ALL SELECT g.id,g.thread_id,g.branch_id FROM goals g
 UNION ALL SELECT c.id,c.root_thread_id,c.root_branch_id FROM computer_requests c
 UNION ALL SELECT m.id,b.thread_id,b.id FROM mcp_interactions m JOIN operations o ON o.id=m.operation_id JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT o.id,o.thread_id,json_extract(o.body,'$.branch_id') FROM calendar_occurrences o
 UNION ALL SELECT u.id,coalesce(u.owner_thread_id,u.thread_id),u.branch_id FROM usage_records u
";

/// A message has two interested conversation views. Its authorization scope remains
/// the recipient (or the operation owner for wait events); sender facts only drive
/// invalidation after principal filtering. Read indexed ingress columns, not content.
pub(super) fn message_participants(
    db: &Connection,
    subject: &str,
    kind: &str,
    data: &mut Value,
) -> Result<()> {
    if !kind.starts_with("message.") || kind == "message.accepted" {
        return Ok(());
    }
    let input = data["input_id"]
        .as_str()
        .or_else(|| data["message_id"].as_str())
        .unwrap_or(subject);
    let participants: Option<(String, String, String, String)> = db.prepare_cached(
        "SELECT i.sender_thread_id,i.sender_branch_id,b.thread_id,i.branch_id FROM input_queue i JOIN branches b ON b.id=i.branch_id WHERE i.id=?1 AND i.origin='message'"
    )?.query_row([input], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
    if let (Some((sender, sender_branch, target, target_branch)), Some(data)) =
        (participants, data.as_object_mut())
    {
        data.insert("senderThreadId".into(), json!(sender));
        data.insert("senderBranchId".into(), json!(sender_branch));
        data.insert("targetThreadId".into(), json!(target));
        data.insert("targetBranchId".into(), json!(target_branch));
    }
    Ok(())
}

pub(super) fn resolve(db: &Connection, subject: &str, kind: &str, data: &Value) -> Result<Scope> {
    if matches!(kind, "catalog.upgraded" | "organization.changed") {
        return Ok(Scope::default());
    }
    // The first delegated execution deliberately shares its ID with the parent's
    // operation. Select its domain from the authored event kind, not a UNION collision.
    if matches!(
        kind,
        "child.execution_accepted"
            | "child.preparation_progress"
            | "child.prepared"
            | "child.report_ready"
            | "child.resources_released"
            | "child.cancel_requested"
            | "child.source_ready"
            | "bot.report_pending"
            | "child.report_delivered"
            | "child.model_selected"
            | "child.settling"
            | "child.source_unchanged"
            | "child.result_candidate"
            | "child.result_ready"
    ) {
        let scope = db.prepare_cached("SELECT c.child_thread_id,json_extract(c.body,'$.child_branch_id') FROM delegated_executions d JOIN child_tasks c ON c.id=d.child_operation_id WHERE d.id=?1")?
            .query_row([subject], |row| Ok(Scope { thread: row.get(0)?, branch: row.get(1)? })).optional()?;
        if let Some(scope) = scope {
            return Ok(scope);
        }
        if let Some(id) = data["child_operation_id"].as_str() {
            let scope = db.prepare_cached("SELECT child_thread_id,json_extract(body,'$.child_branch_id') FROM child_tasks WHERE id=?1")?
                .query_row([id], |row| Ok(Scope { thread: row.get(0)?, branch: row.get(1)? })).optional()?;
            if let Some(scope) = scope {
                return Ok(scope);
            }
        }
    }
    let (threads, thread, branches, branch): (i64, Option<String>, i64, Option<String>) = db.prepare_cached(
        &format!("SELECT count(DISTINCT thread_id),min(thread_id),count(DISTINCT branch_id),min(branch_id) FROM ({SUBJECTS}) WHERE subject=?1")
    )?.query_row([subject], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
    if threads > 1 {
        return Ok(Scope::default());
    }
    if threads == 1 {
        return Ok(Scope {
            thread,
            branch: (branches == 1).then_some(branch).flatten(),
        });
    }
    if matches!(kind, "policy.delivered" | "policy.paused") {
        if let Some(run) = data["run_id"].as_str() {
            if let Some(scope) = db.prepare_cached("SELECT b.thread_id,b.id FROM runs r JOIN branches b ON b.id=r.branch_id WHERE r.id=?1")?
                .query_row([run], |row| Ok(Scope { thread: row.get(0)?, branch: row.get(1)? })).optional()? { return Ok(scope); }
        }
    }
    // These facts precede their row insert. The fields below are authored by these specific
    // Catalog writers, never inferred recursively from tool/model/user content.
    let direct = match kind {
        "context.observed" | "context.capture.accepted" => {
            Some((data["threadId"].as_str(), data["branchId"].as_str()))
        }
        "memory.fact" => Some((data["thread_id"].as_str(), None)),
        "message.accepted" => Some((
            data["targetThreadId"].as_str(),
            data["targetBranchId"].as_str(),
        )),
        "followup.registration_pending" | "followup.registration_cancelled" => {
            Some((data["thread_id"].as_str(), data["branch_id"].as_str()))
        }
        "computer.handback_cancelled"
        | "computer.handback_stop_received"
        | "computer.control_received" => Some((
            data["execution"]["threadId"].as_str(),
            data["execution"]["branchId"].as_str(),
        )),
        "branch.deleted" => Some((data["threadId"].as_str(), None)),
        _ => None,
    };
    if let Some((Some(thread), branch)) = direct {
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
            [thread],
            |row| row.get(0),
        )?;
        if exists {
            return Ok(Scope {
                thread: Some(thread.into()),
                branch: branch.map(str::to_owned),
            });
        }
    }
    if matches!(
        kind,
        "child.execution_accepted" | "child.preparation_progress"
    ) {
        if let Some(id) = data["child_operation_id"].as_str() {
            return Ok(db.query_row("SELECT child_thread_id,json_extract(body,'$.child_branch_id') FROM child_tasks WHERE id=?1",
                [id], |row| Ok(Scope { thread: row.get(0)?, branch: row.get(1)? })).optional()?.unwrap_or_default());
        }
    }
    if GLOBAL_KINDS.contains(&kind) {
        return Ok(Scope::default());
    }
    // Legacy events can outlive their subject rows. Unknown historical ownership stays
    // private, never implicitly public; writer tests require an explicit domain classification.
    Ok(Scope::default())
}

pub(super) fn upgrade(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("ALTER TABLE events ADD COLUMN thread_id TEXT; ALTER TABLE events ADD COLUMN branch_id TEXT; CREATE INDEX events_thread_cursor ON events(thread_id,cursor);")?;
    let events = tx
        .prepare("SELECT cursor,subject,kind,data FROM events")?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (cursor, subject, kind, data) in events {
        let mut data: Value = serde_json::from_str(&data)?;
        message_participants(tx, &subject, &kind, &mut data)?;
        let scope = resolve(tx, &subject, &kind, &data)?;
        tx.execute(
            "UPDATE events SET thread_id=?2,branch_id=?3,data=?4 WHERE cursor=?1",
            params![cursor, scope.thread, scope.branch, encode(&data)?],
        )?;
    }
    Ok(())
}

pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT thread_id,branch_id FROM events")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_submission::InputAdmission;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("varin-event-scope-{}", id())))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn scoped_events_preserve_unread_and_principal_visibility_after_upgrade() {
        let fixture = Fixture::new();
        let mut db = Catalog::open(&fixture.0).unwrap();
        db.create_thread("alice-thread", "alice-main").unwrap();
        db.create_thread("bob-thread", "bob-main").unwrap();
        db.db
            .execute(
                "UPDATE threads SET principal_id='alice' WHERE id='alice-thread'",
                [],
            )
            .unwrap();
        db.db
            .execute(
                "UPDATE threads SET principal_id='bob' WHERE id='bob-thread'",
                [],
            )
            .unwrap();
        let accepted = db
            .submit(&SubmitInput {
                key: "alice-input".into(),
                thread_id: "alice-thread".into(),
                branch_id: "alice-main".into(),
                expected_head: None,
                input: json!({"text":"hello"}),
                configuration: json!({}),
            })
            .unwrap();
        db.admit_operation(
            "alice-op",
            &accepted.run_id,
            db.epoch(),
            Lifetime::Run,
            json!({"kind":"fixture"}),
        )
        .unwrap();
        let before = db
            .events_after_for_principal(0, 256, Some("alice"))
            .unwrap();
        assert!(!before.is_empty());
        assert!(before
            .iter()
            .all(|event| event.thread_id.as_deref() == Some("alice-thread")));
        assert!(before
            .iter()
            .filter(|event| event.subject != "alice-thread")
            .all(|event| event.branch_id.as_deref() == Some("alice-main")));
        assert!(
            db.inspect_thread("alice-thread").unwrap()["activity_cursor"]
                .as_u64()
                .unwrap()
                > 0
        );
        for event in db.events_after(0, 256).unwrap() {
            assert!(
                event.thread_id.is_some() || GLOBAL_KINDS.contains(&event.kind.as_str()),
                "unscoped {}",
                event.kind
            );
        }
        drop(db);
        let raw = Connection::open(fixture.0.join("conversation.sqlite")).unwrap();
        raw.execute_batch("DROP INDEX events_thread_cursor; ALTER TABLE events DROP COLUMN thread_id; ALTER TABLE events DROP COLUMN branch_id; PRAGMA user_version=98;").unwrap();
        drop(raw);
        let db = Catalog::open(&fixture.0).unwrap();
        let after = db
            .events_after_for_principal(0, 256, Some("alice"))
            .unwrap();
        for event in before {
            assert!(after.iter().any(|next| next == &event));
        }
        assert!(after
            .iter()
            .all(|event| event.thread_id.as_deref() == Some("alice-thread")));
    }
}
