//! Content-free creation evidence outlives execution/history retirement. The Thread
//! remains the sole principal owner; these receipts never authorize new execution.
use super::*;

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE thread_creations(
        thread_id TEXT PRIMARY KEY REFERENCES threads(id),
        initial_branch_id TEXT,
        domain TEXT CHECK(domain IN ('public','summary','child','memory','calendar')),
        bot_id TEXT,
        identity_known INTEGER NOT NULL CHECK(identity_known IN (0,1)),
        CHECK(identity_known=0 OR (initial_branch_id IS NOT NULL AND domain IS NOT NULL)),
        CHECK(bot_id IS NULL OR domain='public' OR identity_known=0)
    );",
    )?;
    Ok(())
}

pub(super) fn record(
    tx: &Transaction<'_>,
    thread: &str,
    branch: &str,
    domain: &str,
    bot: Option<&str>,
) -> Result<()> {
    tx.execute("INSERT INTO thread_creations(thread_id,initial_branch_id,domain,bot_id,identity_known) VALUES(?1,?2,?3,?4,1)", params![thread,branch,domain,bot])?;
    Ok(())
}

pub(super) fn check_legacy_format(db: &Connection) -> Result<()> {
    let present: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('thread_creations','calendar_invocations','calendar_legacy_manual_boundaries'))", [], |r| r.get(0))?;
    if present {
        return Err(RuntimeError::Invalid(
            "Legacy Catalog contains newer creation receipts; data was preserved".into(),
        ));
    }
    Ok(())
}

pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare(
        "SELECT thread_id,initial_branch_id,domain,bot_id,identity_known FROM thread_creations",
    )?;
    let invalid: bool = db.query_row("SELECT
        EXISTS(SELECT 1 FROM threads t LEFT JOIN thread_creations c ON c.thread_id=t.id WHERE c.thread_id IS NULL)
        OR EXISTS(SELECT 1 FROM thread_creations c LEFT JOIN threads t ON t.id=c.thread_id
            LEFT JOIN branches b ON b.id=c.initial_branch_id LEFT JOIN bot_thread_bindings bot ON bot.thread_id=c.thread_id
            WHERE t.id IS NULL OR c.identity_known NOT IN (0,1)
            OR (c.initial_branch_id IS NOT NULL AND (b.id IS NULL OR b.thread_id!=c.thread_id))
            OR (c.identity_known=1 AND (c.initial_branch_id IS NULL OR c.domain IS NULL OR c.domain NOT IN ('public','summary','child','memory','calendar') OR c.bot_id IS NOT bot.bot_id))
            OR (c.bot_id IS NOT NULL AND c.bot_id IS NOT bot.bot_id))", [], |r| r.get(0))?;
    if invalid {
        return Err(RuntimeError::Invalid(
            "Thread creation identity is inconsistent; data was preserved".into(),
        ));
    }
    Ok(())
}

/// Only original durable facts may be converted. In particular an absent binding on
/// an old tombstone is unknown, not proof that this was an ordinary conversation.
pub(super) fn upgrade(tx: &Transaction<'_>) -> Result<()> {
    initialize(tx)?;
    let rows = tx.prepare("SELECT t.id,t.deleted_at_ms,b.bot_id FROM threads t LEFT JOIN bot_thread_bindings b ON b.thread_id=t.id ORDER BY t.rowid")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<i64>>(1)?,r.get::<_,Option<String>>(2)?)))?
        .collect::<std::result::Result<Vec<_>,_>>()?;
    for (thread, deleted, bot) in rows {
        let events = tx.prepare("SELECT data FROM events WHERE subject=?1 AND kind='thread.created' ORDER BY cursor")?
            .query_map([&thread], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut initial = None;
        let mut domain = None;
        for raw in events {
            let value: Value = serde_json::from_str(&raw)?;
            let branch = value
                .get("branch_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    RuntimeError::Invalid("Thread creation branch is malformed".into())
                })?;
            if initial
                .as_deref()
                .is_some_and(|previous| previous != branch)
            {
                return Err(RuntimeError::Invalid(
                    "Thread creation receipts disagree".into(),
                ));
            }
            initial = Some(branch.to_owned());
            domain = Some(if value.get("calendar_occurrence_id").is_some() {
                "calendar"
            } else {
                "public"
            });
        }
        // Typed helper admissions take precedence: legacy summaries emitted the
        // same thread.created shape as ordinary public conversations.
        let helper: Option<(String,String)> = tx.query_row(
            "SELECT 'child',json_extract(c.body,'$.child_branch_id') FROM child_tasks c WHERE c.child_thread_id=?1
             UNION ALL SELECT 'summary',r.branch_id FROM context_jobs j JOIN runs r ON r.id=j.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1
             UNION ALL SELECT 'memory',r.branch_id FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND json_extract(o.body,'$.intent.kind')='memory_work_v1' LIMIT 1",
            [&thread], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((kind, branch)) = &helper {
            if initial.as_deref().is_some_and(|initial| initial != branch) {
                return Err(RuntimeError::Invalid(
                    "Thread helper creation receipts disagree".into(),
                ));
            }
            initial = Some(branch.clone());
            domain = match kind.as_str() {
                "child" => Some("child"),
                "summary" => Some("summary"),
                "memory" => Some("memory"),
                _ => unreachable!(),
            };
        }
        if let Some(branch) = &initial {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT thread_id FROM branches WHERE id=?1",
                    [branch],
                    |r| r.get(0),
                )
                .optional()?;
            if owner.as_deref() != Some(thread.as_str()) {
                return Err(RuntimeError::Invalid(
                    "Thread creation branch has another owner".into(),
                ));
            }
        }
        // No need to reconstruct unknown helper or retired facts just to open the store.
        let known = initial.is_some() && (deleted.is_none() || bot.is_some());
        tx.execute("INSERT INTO thread_creations(thread_id,initial_branch_id,domain,bot_id,identity_known) VALUES(?1,?2,?3,?4,?5)", params![thread,initial,domain,bot,known])?;
    }
    check_format(tx)
}

/// Validate even historical replay against the current sole principal owner and the
/// original direct Bot/branch/domain. Returning a receipt does not un-delete a Thread.
pub(super) fn validate_public(
    db: &Connection,
    thread: &str,
    branch: &str,
    bot: Option<&str>,
    principal: Option<&str>,
) -> Result<()> {
    if principals::thread(db, thread)?.as_deref() != principal {
        return Err(RuntimeError::Conflict("Thread principal changed".into()));
    }
    let (initial, domain, bound, known): (Option<String>,Option<String>,Option<String>,bool) = db.query_row(
        "SELECT initial_branch_id,domain,bot_id,identity_known FROM thread_creations WHERE thread_id=?1", [thread], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    if bound.as_deref().is_some_and(|bound| Some(bound) != bot) {
        return Err(RuntimeError::Conflict("Thread Bot binding changed".into()));
    }
    if initial.as_deref().is_some_and(|initial| initial != branch) {
        return Err(RuntimeError::Conflict(
            "thread was created with another initial branch".into(),
        ));
    }
    let direct: Option<String> = db
        .query_row(
            "SELECT bot_id FROM bot_thread_bindings WHERE thread_id=?1",
            [thread],
            |r| r.get(0),
        )
        .optional()?;
    if direct != bound {
        return Err(RuntimeError::Conflict(
            "Thread creation and Bot binding disagree".into(),
        ));
    }
    let branch_owner: Option<String> = db
        .query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [branch],
            |r| r.get(0),
        )
        .optional()?;
    if branch_owner.as_deref() != Some(thread) {
        return Err(RuntimeError::Conflict(
            "Thread initial branch has another owner".into(),
        ));
    }
    if !known {
        return Err(RuntimeError::IdentityUnavailable(thread.into()));
    }
    if domain.as_deref() != Some("public") || bound.as_deref() != bot {
        return Err(RuntimeError::Conflict(
            "Thread creation domain or Bot binding changed".into(),
        ));
    }
    Ok(())
}

pub(super) fn create_public(
    tx: &Transaction<'_>,
    thread: &str,
    branch: &str,
    bot: Option<&str>,
    principal: Option<&str>,
    epoch: u64,
) -> Result<()> {
    if let Some(principal) = principal {
        principals::validate(principal)?;
    }
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
        [thread],
        |r| r.get(0),
    )?;
    if exists {
        return validate_public(tx, thread, branch, bot, principal);
    }
    if let Some(bot) = bot {
        if !bot::permitted(tx, bot, epoch)? {
            return Err(RuntimeError::RequestActivationHeld);
        }
    }
    threads::insert(tx, thread, branch, "public", bot)?;
    principals::assign_new(tx, thread, principal)?;
    if let Some(bot) = bot {
        tx.execute(
            "INSERT INTO bot_thread_bindings(thread_id,bot_id) VALUES(?1,?2)",
            params![thread, bot],
        )?;
    }
    tx.execute(
        "INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,NULL)",
        params![branch, thread],
    )?;
    event(tx, thread, 1, "thread.created", json!({"branch_id":branch}))?;
    Ok(())
}

#[cfg(test)]
#[path = "catalog_identity_tests.rs"]
mod tests;
