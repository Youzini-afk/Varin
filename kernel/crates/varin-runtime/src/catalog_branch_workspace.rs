//! The branch owns only a default, not a live permit. Existing launches and Operations
//! are never updated by this command. Null is an explicit choice; a missing row is not.
use super::*;

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BranchWorkspace {
    pub revision: u64,
    pub source: Option<launches::SourceSelection>,
}
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBranchWorkspace {
    pub thread_id: String,
    pub branch_id: String,
    pub expected_revision: u64,
    // Missing must never silently turn into chat-only.
    #[serde(deserialize_with = "source_or_null")]
    pub source: Option<launches::SourceSelection>,
}
fn source_or_null<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<launches::SourceSelection>, D::Error> {
    serde::Deserialize::deserialize(d)
}
const TABLE: &str = "CREATE TABLE branch_workspaces(branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK(revision>0), head TEXT, source TEXT NOT NULL, PRIMARY KEY(branch_id,revision))";
const HEADS: &str =
    "CREATE INDEX branch_workspace_heads ON branch_workspaces(branch_id,head,revision DESC)";
pub(super) fn check_format(db: &Connection) -> Result<()> {
    for (name, sql) in [
        ("branch_workspaces", TABLE),
        ("branch_workspace_heads", HEADS),
    ] {
        let existing: Option<String> = db
            .query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .optional()?;
        if existing.as_deref() != Some(sql) {
            return Err(RuntimeError::Invalid(
                "unrecognized branch workspace schema; data was preserved".into(),
            ));
        }
    }
    Ok(())
}
pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='branch_workspaces')",
        [],
        |r| r.get(0),
    )?;
    if exists {
        // Some migration fixtures and prerelease databases may already contain the
        // empty current layout. Never relabel an unknown layout or newer choices.
        check_format(tx)?;
        let populated: bool =
            tx.query_row("SELECT EXISTS(SELECT 1 FROM branch_workspaces)", [], |r| {
                r.get(0)
            })?;
        if populated {
            return Err(RuntimeError::Invalid(
                "older Catalog contains newer workspace choices; data was preserved".into(),
            ));
        }
    } else {
        tx.execute_batch(TABLE)?;
        tx.execute_batch(HEADS)?;
    }
    Ok(())
}
pub(super) fn read(db: &Connection, branch: &str) -> Result<Option<BranchWorkspace>> {
    let row = db.query_row("SELECT revision,source FROM branch_workspaces WHERE branch_id=?1 ORDER BY revision DESC LIMIT 1", [branch],
        |r| Ok((read_number(r, 0)?, r.get::<_, String>(1)?))).optional()?;
    row.map(|(revision, source)| {
        Ok(BranchWorkspace {
            revision,
            source: serde_json::from_str(&source)?,
        })
    })
    .transpose()
}
fn write(
    tx: &Transaction<'_>,
    branch: &str,
    revision: u64,
    head: Option<&str>,
    source: &Option<launches::SourceSelection>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO branch_workspaces(branch_id,revision,source,head) VALUES(?1,?2,?3,?4)",
        params![branch, sql_number(revision)?, encode(source)?, head],
    )?;
    event(
        tx,
        branch,
        revision,
        "branch.workspace_changed",
        Value::Null,
    )?;
    Ok(())
}
pub(super) fn requires_preparation(db: &Connection, run: &Run) -> Result<bool> {
    let Some(default) = read(db, &run.branch_id)? else {
        return Ok(false);
    };
    let launch: Option<launch_content::LaunchMetadata> =
        optional_record(db, "run_launches", &run.id)?;
    Ok(launch.is_none_or(|l| l.selection.source != default.source))
}
// A switch can occur after a Run, without appending a synthetic message. A fork at
// that exact head inherits the confirmed choice; an older history item keeps its Run's
// admitted source. No tool receipts or grants travel into the target branch.
pub(super) fn inherit_at(
    tx: &Transaction<'_>,
    from: &str,
    target: &str,
    head: Option<&str>,
) -> Result<()> {
    if read(tx, from)?.is_none() {
        return Ok(());
    }
    let saved: Option<String> = tx.query_row(
        "SELECT source FROM branch_workspaces WHERE branch_id=?1 AND head IS ?2 ORDER BY revision DESC LIMIT 1",
        params![from,head], |r| r.get(0)).optional()?;
    let source = if let Some(saved) = saved {
        serde_json::from_str(&saved)?
    } else {
        // Before the first message, preserve the branch's actual initial source, if
        // known, rather than resolving today's service default on another device.
        let raw: Option<String> = if let Some(head) = head {
            tx.query_row(
                "SELECT l.body FROM history h JOIN run_launches l ON l.id=h.run_id WHERE h.id=?1",
                [head],
                |r| r.get(0),
            )
            .optional()?
        } else {
            tx.query_row("SELECT l.body FROM runs r JOIN run_launches l ON l.id=r.id WHERE r.branch_id=?1 ORDER BY r.rowid LIMIT 1", [from], |r| r.get(0)).optional()?
        };
        let launch: launch_content::LaunchMetadata =
            serde_json::from_str(&raw.ok_or_else(|| {
                RuntimeError::Conflict("historical workspace could not be established".into())
            })?)?;
        if launch
            .selection
            .source
            .as_ref()
            .is_some_and(|s| s.mode != SourceMode::LiveRoot)
        {
            return Err(RuntimeError::Conflict(
                "historical isolated workspace requires its original execution owner".into(),
            ));
        }
        launch.selection.source
    };
    let revision = read(tx, target)?
        .map_or(0, |v| v.revision)
        .checked_add(1)
        .ok_or_else(|| RuntimeError::Invalid("branch workspace revision exhausted".into()))?;
    write(tx, target, revision, head, &source)
}
impl Catalog {
    pub fn set_branch_workspace(&mut self, command: SetBranchWorkspace) -> Result<BranchWorkspace> {
        if !self.thread_has_host_authority(&command.thread_id)?
            || self.child_task_for_thread(&command.thread_id)?.is_some()
        {
            return Err(RuntimeError::Invalid(
                "only an owner-controlled native root can switch workspaces".into(),
            ));
        }
        if let Some(source) = &command.source {
            source.validate()?;
            // Non-live views require retained mounts/pins. Never turn a live target into an
            // isolated copy (or vice versa) through a mere preference write.
            if source.mode != SourceMode::LiveRoot {
                return Err(RuntimeError::Invalid(
                    "only live roots or chat-only are supported for branch workspace changes"
                        .into(),
                ));
            }
        }
        let tx = self.db.transaction()?;
        threads::require_product_caller(&tx, &command.thread_id)?;
        threads::require_branch_available(&tx, &command.branch_id)?;
        // Until the executor can re-prepare capabilities within a Run, reject an active
        // switch rather than acknowledge an unsafe or ineffective mid-request retarget.
        let head = navigation::idle(&tx, &command.thread_id, &command.branch_id)?;
        let latest_mode: Option<String> = tx.query_row("SELECT json_extract(l.body,'$.selection.source.mode') FROM history h JOIN run_launches l ON l.id=h.run_id WHERE h.id=?1",
            [head.as_deref()], |r| r.get(0)).optional()?.flatten();
        if latest_mode
            .as_deref()
            .is_some_and(|mode| mode != "live_root")
        {
            return Err(RuntimeError::Conflict(
                "keep the original isolated execution workspace".into(),
            ));
        }
        let current = read(&tx, &command.branch_id)?;
        if current.as_ref().map_or(0, |v| v.revision) != command.expected_revision {
            return Err(RuntimeError::Conflict(
                "branch workspace revision changed".into(),
            ));
        }
        let revision = command
            .expected_revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Invalid("branch workspace revision exhausted".into()))?;
        write(
            &tx,
            &command.branch_id,
            revision,
            head.as_deref(),
            &command.source,
        )?;
        tx.commit()?;
        Ok(BranchWorkspace {
            revision,
            source: command.source,
        })
    }
}
