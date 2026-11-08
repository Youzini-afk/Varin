//! Small title ownership and one resumable naming cut per branch. Conversation bodies
//! and auxiliary inference receipts remain with their original owners.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TitleMode {
    Automatic,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TitleJob {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub head_id: String,
    pub checkpoint_id: Option<String>,
    pub active_run_id: Option<String>,
    pub rounds: u64,
    pub generation: u64,
    pub title: String,
    pub initial: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TitlePrepare {
    pub thread_id: String,
    pub branch_id: String,
    pub interval: u64,
    #[serde(default)]
    pub initial: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TitleFinish {
    pub job: TitleJob,
    pub title: Option<String>,
}

pub(super) fn check_format(db: &Connection) -> Result<()> {
    let version: Option<u64> = db
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='thread_titles'",
            [],
            |row| read_number(row, 0),
        )
        .optional()?;
    if version.is_none() {
        let partial: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('thread_title_state','thread_title_progress'))", [], |row| row.get(0))?;
        return if partial {
            Err(RuntimeError::Invalid(
                "incomplete title metadata; data was preserved".into(),
            ))
        } else {
            Ok(())
        };
    }
    if version != Some(1) {
        return Err(RuntimeError::Invalid(
            "unsupported title metadata; data was preserved".into(),
        ));
    }
    db.prepare("SELECT thread_id,mode,generation FROM thread_title_state")?;
    db.prepare("SELECT branch_id,checked_rounds,pending FROM thread_title_progress")?;
    Ok(())
}

pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM runtime_domains WHERE name='thread_titles')",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        return check_format(tx);
    }
    tx.execute_batch("CREATE TABLE thread_title_state(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,mode TEXT NOT NULL CHECK(mode IN ('automatic','manual')),generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0));
        CREATE TABLE thread_title_progress(branch_id TEXT PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,checked_rounds INTEGER NOT NULL CHECK(checked_rounds>=0),pending TEXT);
        CREATE INDEX title_completed_runs ON runs(branch_id,id) WHERE json_extract(body,'$.state')='completed';
        CREATE INDEX title_user_history ON history(run_id) WHERE json_extract(body,'$.source')='user';")?;
    // Import ownership once from original metadata receipts, including manual
    // renames whose text happens to equal a previously generated title.
    let mut statement = tx.prepare("SELECT json_extract(intent,'$.command.threadId'),id FROM commands WHERE json_extract(intent,'$.kind')='thread.update' AND json_extract(intent,'$.command.title') IS NOT NULL ORDER BY rowid")?;
    let updates = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    tx.execute(
        "INSERT INTO thread_title_state(thread_id,mode) SELECT id,'automatic' FROM threads",
        [],
    )?;
    for (thread, key) in updates {
        tx.execute(
            "UPDATE thread_title_state SET mode=?2 WHERE thread_id=?1",
            params![
                thread,
                if key.starts_with("thread-title:") {
                    "automatic"
                } else {
                    "manual"
                }
            ],
        )?;
    }
    tx.execute("UPDATE thread_title_state SET mode='manual' WHERE thread_id IN (SELECT child_thread_id FROM child_tasks)", [])?;
    // Existing conversations start their new interval here; upgrading does not
    // dispatch a backlog of title requests for retained historical rounds.
    tx.execute("INSERT INTO thread_title_progress(branch_id,checked_rounds) SELECT b.id,(SELECT count(*) FROM runs r WHERE r.branch_id=b.id AND json_extract(r.body,'$.state')='completed' AND EXISTS(SELECT 1 FROM history h WHERE h.run_id=r.id AND json_extract(h.body,'$.source')='user')) FROM branches b", [])?;
    tx.execute(
        "INSERT INTO runtime_domains(name,version) VALUES('thread_titles',1)",
        [],
    )?;
    Ok(())
}

pub(super) fn mode(db: &Connection, thread: &str) -> Result<TitleMode> {
    let value: Option<String> = db
        .prepare_cached("SELECT mode FROM thread_title_state WHERE thread_id=?1")?
        .query_row([thread],
            |row| row.get(0),
        )
        .optional()?;
    Ok(if value.as_deref() == Some("manual") {
        TitleMode::Manual
    } else {
        TitleMode::Automatic
    })
}
pub(super) fn set_mode(tx: &Transaction<'_>, thread: &str, mode: TitleMode) -> Result<()> {
    let value = if mode == TitleMode::Automatic {
        "automatic"
    } else {
        "manual"
    };
    tx.execute("INSERT INTO thread_title_state(thread_id,mode,generation) VALUES(?1,?2,1) ON CONFLICT(thread_id) DO UPDATE SET mode=excluded.mode,generation=generation+1", params![thread,value])?;
    tx.execute("DELETE FROM thread_title_progress WHERE branch_id IN (SELECT id FROM branches WHERE thread_id=?1)", [thread])?;
    Ok(())
}

impl Catalog {
    pub fn prepare_thread_title(&mut self, input: &TitlePrepare) -> Result<Option<TitleJob>> {
        let tx = self.db.transaction()?;
        threads::require_available(&tx, &input.thread_id)?;
        let (thread, head, active_run_id): (String, Option<String>, Option<String>) = tx
            .query_row(
                "SELECT thread_id,head,active_run FROM branches WHERE id=?1",
                [&input.branch_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        if thread != input.thread_id {
            return Err(RuntimeError::Conflict(
                "title branch belongs to another Thread".into(),
            ));
        }
        if mode(&tx, &thread)? != TitleMode::Automatic {
            return Ok(None);
        }
        let Some(head) = head else {
            return Ok(None);
        };
        let previous: Option<(u64, Option<String>)> = tx
            .query_row(
                "SELECT checked_rounds,pending FROM thread_title_progress WHERE branch_id=?1",
                [&input.branch_id],
                |row| Ok((read_number(row, 0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((_, Some(pending))) = &previous {
            return Ok(Some(serde_json::from_str(pending)?));
        }
        let rounds: u64 = tx.query_row("SELECT count(*) FROM runs r WHERE r.branch_id=?1 AND json_extract(r.body,'$.state')='completed' AND EXISTS(SELECT 1 FROM history h WHERE h.run_id=r.id AND json_extract(h.body,'$.source')='user')", [&input.branch_id], |row| read_number(row,0))?;
        let first = input.initial && previous.is_none();
        if !first
            && (input.interval == 0
                || rounds == 0
                || rounds.saturating_sub(previous.as_ref().map_or(0, |value| value.0))
                    < input.interval)
        {
            return Ok(None);
        }
        let title: String =
            tx.query_row("SELECT title FROM threads WHERE id=?1", [&thread], |row| {
                row.get(0)
            })?;
        let generation = tx
            .query_row(
                "SELECT generation FROM thread_title_state WHERE thread_id=?1",
                [&thread],
                |row| read_number(row, 0),
            )
            .optional()?
            .unwrap_or(0);
        let checkpoint_id = tx
            .query_row(
                "SELECT checkpoint_id FROM active_contexts WHERE branch_id=?1",
                [&input.branch_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let job = TitleJob {
            key: format!(
                "thread-title:v2:{}:{}:{generation}:{rounds}:{head}",
                thread, input.branch_id
            ),
            thread_id: thread,
            branch_id: input.branch_id.clone(),
            head_id: head,
            checkpoint_id,
            active_run_id,
            rounds,
            generation,
            title,
            initial: rounds == 0,
        };
        tx.execute("INSERT INTO thread_title_progress(branch_id,checked_rounds,pending) VALUES(?1,0,?2) ON CONFLICT(branch_id) DO UPDATE SET pending=excluded.pending",params![input.branch_id,serde_json::to_string(&job)?])?;
        tx.commit()?;
        Ok(Some(job))
    }

    pub fn finish_thread_title(&mut self, input: &TitleFinish) -> Result<bool> {
        let job = &input.job;
        let tx = self.db.transaction()?;
        let pending: Option<String> = tx
            .query_row(
                "SELECT pending FROM thread_title_progress WHERE branch_id=?1",
                [&job.branch_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        if pending
            .as_deref()
            .map(serde_json::from_str::<TitleJob>)
            .transpose()?
            .as_ref()
            != Some(job)
        {
            return Ok(false);
        }
        let generation = tx
            .query_row(
                "SELECT generation FROM thread_title_state WHERE thread_id=?1",
                [&job.thread_id],
                |row| read_number(row, 0),
            )
            .optional()?
            .unwrap_or(0);
        if mode(&tx, &job.thread_id)? != TitleMode::Automatic || generation != job.generation {
            return Ok(false);
        }
        tx.execute("UPDATE thread_title_progress SET checked_rounds=max(checked_rounds,?2),pending=NULL WHERE branch_id=?1", params![job.branch_id,sql_number(job.rounds)?])?;
        let changed = if let Some(title) = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            tx.execute("UPDATE threads SET title=?2,title_initialized=1,revision=revision+1,updated_at_ms=max(updated_at_ms,?3) WHERE id=?1 AND deleted_at_ms IS NULL AND title=?4 AND title!=?2", params![job.thread_id,title,sql_number(threads::now_ms()?)?,job.title])?
        } else {
            0
        };
        if changed > 0 {
            let revision = tx.query_row(
                "SELECT revision FROM threads WHERE id=?1",
                [&job.thread_id],
                |row| read_number(row, 0),
            )?;
            event(
                &tx,
                &job.thread_id,
                revision,
                "thread.updated",
                json!({"title":input.title}),
            )?;
        }
        tx.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_submission::InputAdmission;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("varin-titles-{}", id())))
        }
        fn open(&self) -> Catalog {
            Catalog::open(&self.0).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn complete(db: &mut Catalog, key: &str) {
        let receipt = db
            .submit(&SubmitInput {
                key: key.into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: db.head("main").unwrap(),
                input: json!({"text":key}),
                configuration: json!({"provider":"fixture"}),
            })
            .unwrap();
        db.db
            .execute(
                "UPDATE runs SET body=json_set(body,'$.state','completed') WHERE id=?1",
                [receipt.run_id],
            )
            .unwrap();
        db.db
            .execute("UPDATE branches SET active_run=NULL WHERE id='main'", [])
            .unwrap();
    }
    fn prepare(db: &mut Catalog, interval: u64, initial: bool) -> Option<TitleJob> {
        db.prepare_thread_title(&TitlePrepare {
            thread_id: "thread".into(),
            branch_id: "main".into(),
            interval,
            initial,
        })
        .unwrap()
    }
    fn update(db: &mut Catalog, title: Option<&str>, mode: Option<TitleMode>, key: &str) {
        let revision = db.inspect_thread("thread").unwrap()["revision"]
            .as_u64()
            .unwrap();
        db.update_thread(&threads::ThreadUpdate {
            thread_id: "thread".into(),
            key: key.into(),
            expected_revision: revision,
            title: title.map(Into::into),
            title_mode: mode,
            pinned: None,
            archived: None,
        })
        .unwrap();
    }
    #[test]
    fn title_cadence_counts_completed_user_runs_and_unchanged_results_once() {
        let f = Fixture::new();
        let mut db = f.open();
        db.create_thread("thread", "main").unwrap();
        for number in 1..=4 {
            complete(&mut db, &format!("message-{number}"));
        }
        assert!(prepare(&mut db, 5, false).is_none());
        complete(&mut db, "message-5");
        let job = prepare(&mut db, 5, false).unwrap();
        assert_eq!(job.rounds, 5);
        drop(db);
        let mut db = f.open();
        assert_eq!(prepare(&mut db, 50, false), Some(job.clone()));
        assert!(db
            .finish_thread_title(&TitleFinish {
                job: job.clone(),
                title: Some(job.title.clone())
            })
            .unwrap());
        assert!(!db
            .finish_thread_title(&TitleFinish {
                job,
                title: Some("late duplicate".into())
            })
            .unwrap());
        assert!(prepare(&mut db, 5, false).is_none());
        for number in 6..=10 {
            complete(&mut db, &format!("message-{number}"));
        }
        assert_eq!(prepare(&mut db, 5, false).unwrap().rounds, 10);
    }
    #[test]
    fn manual_identity_wins_even_when_the_text_is_unchanged_and_can_be_resumed() {
        let f = Fixture::new();
        let mut db = f.open();
        db.create_thread("thread", "main").unwrap();
        complete(&mut db, "first request");
        let job = prepare(&mut db, 5, true).unwrap();
        update(&mut db, Some(&job.title), None, "manual-same-title");
        assert_eq!(db.inspect_thread("thread").unwrap()["title_mode"], "manual");
        assert!(!db
            .finish_thread_title(&TitleFinish {
                job,
                title: Some("must not overwrite".into())
            })
            .unwrap());
        assert!(prepare(&mut db, 1, true).is_none());
        update(&mut db, None, Some(TitleMode::Automatic), "resume");
        let job = prepare(&mut db, 0, true).unwrap();
        assert!(db
            .finish_thread_title(&TitleFinish {
                job,
                title: Some("new automatic title".into())
            })
            .unwrap());
        assert_eq!(
            db.inspect_thread("thread").unwrap()["title"],
            "new automatic title"
        );
        assert!(prepare(&mut db, 0, false).is_none());
    }
    #[test]
    fn new_title_domain_is_installed_once_without_replaying_old_rounds_or_manual_names() {
        let f = Fixture::new();
        let mut db = f.open();
        db.create_thread("thread", "main").unwrap();
        complete(&mut db, "old input");
        update(&mut db, Some("user title"), None, "manual-original");
        db.db.execute_batch("DROP TABLE thread_title_progress; DROP TABLE thread_title_state; DROP INDEX title_completed_runs; DROP INDEX title_user_history; DELETE FROM runtime_domains WHERE name='thread_titles';").unwrap();
        drop(db);
        let mut db = f.open();
        assert_eq!(db.inspect_thread("thread").unwrap()["title_mode"], "manual");
        assert_eq!(db.inspect_thread("thread").unwrap()["title"], "user title");
        assert!(prepare(&mut db, 1, false).is_none());
    }
}
