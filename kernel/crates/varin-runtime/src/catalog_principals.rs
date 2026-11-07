//! Authentication identities are supplied only by the trusted Application Host. The Catalog
//! retains attribution; an absent principal is public work and never grants account access.
use super::*;
use serde::{Deserialize, Deserializer};

pub fn optional_principal<'de, D: Deserializer<'de>>(
    value: D,
) -> std::result::Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(value).map(Some)
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrincipalQuery {
    #[serde(default, deserialize_with = "optional_principal")]
    pub principal_id: Option<Option<String>>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventsQuery {
    pub cursor: i64,
    pub limit: i64,
    #[serde(default, deserialize_with = "optional_principal")]
    pub principal_id: Option<Option<String>>,
}
pub(super) fn validate(value: &str) -> Result<()> {
    if value.trim().is_empty() || value != value.trim() {
        return Err(RuntimeError::Invalid(
            "principal identity is empty or malformed".into(),
        ));
    }
    Ok(())
}
pub(super) fn upgrade(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("ALTER TABLE threads ADD COLUMN principal_id TEXT; CREATE INDEX thread_principals ON threads(principal_id,id); CREATE TABLE catalog_principal_owner(id INTEGER PRIMARY KEY CHECK(id=1),owner_principal_id TEXT NOT NULL,claim_legacy INTEGER NOT NULL CHECK(claim_legacy IN(0,1)));")?;
    Ok(())
}
/// Principal attribution was introduced atomically in 87. A lower format marker
/// with any of its schema is not a released legacy layout and must stay untouched.
pub(super) fn check_legacy_format(db: &Connection) -> Result<()> {
    let present: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('threads') WHERE name='principal_id') OR EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('thread_principals','catalog_principal_owner'))",
        [], |row| row.get(0),
    )?;
    if present {
        return Err(RuntimeError::Invalid(
            "Legacy Catalog contains newer principal attribution schema; data was preserved".into(),
        ));
    }
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT principal_id FROM threads")?;
    db.prepare("SELECT owner_principal_id,claim_legacy FROM catalog_principal_owner")?;
    let invalid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE principal_id IS NOT NULL AND (typeof(principal_id)!='text' OR length(trim(principal_id))=0 OR principal_id!=trim(principal_id))) OR EXISTS(SELECT 1 FROM catalog_principal_owner WHERE typeof(owner_principal_id)!='text' OR length(trim(owner_principal_id))=0 OR owner_principal_id!=trim(owner_principal_id) OR claim_legacy NOT IN(0,1))", [], |r|r.get(0))?;
    if invalid {
        return Err(RuntimeError::Invalid(
            "invalid principal attribution; data was preserved".into(),
        ));
    }
    Ok(())
}
pub(super) fn thread(db: &Connection, id: &str) -> Result<Option<String>> {
    db.query_row("SELECT principal_id FROM threads WHERE id=?1", [id], |r| {
        r.get(0)
    })
    .map_err(Into::into)
}
pub(super) fn branch(db: &Connection, id: &str) -> Result<Option<String>> {
    db.query_row(
        "SELECT t.principal_id FROM branches b JOIN threads t ON t.id=b.thread_id WHERE b.id=?1",
        [id],
        |r| r.get(0),
    )
    .map_err(Into::into)
}
pub(super) fn assign_new(tx: &Transaction<'_>, id: &str, principal: Option<&str>) -> Result<()> {
    if let Some(value) = principal {
        validate(value)?;
    }
    tx.execute(
        "UPDATE threads SET principal_id=?2 WHERE id=?1",
        params![id, principal],
    )?;
    Ok(())
}
// Resolve only original Catalog relations, never an ID prefix or fields inside author output.
// Colliding identities in different domains remain ambiguous and are withheld from observers.
const SUBJECTS: &str = "SELECT id AS subject,id AS thread_id FROM threads
 UNION ALL SELECT id,thread_id FROM branches
 UNION ALL SELECT r.id,b.thread_id FROM runs r JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT o.id,b.thread_id FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT i.id,b.thread_id FROM input_queue i JOIN branches b ON b.id=i.branch_id
 UNION ALL SELECT m.id,b.thread_id FROM model_steps m JOIN runs r ON r.id=m.run_id JOIN branches b ON b.id=r.branch_id
 UNION ALL SELECT f.id,f.thread_id FROM followups f
 UNION ALL SELECT o.id,f.thread_id FROM followup_occurrences o JOIN followups f ON f.id=o.followup_id
 UNION ALL SELECT d.id,c.child_thread_id FROM delegated_executions d JOIN child_tasks c ON c.id=d.child_operation_id";
impl Catalog {
    /// Called at Host authentication startup, not from user-selected request parameters.
    /// The first transaction records the migration policy. Later auth changes cannot claim public work.
    pub fn initialize_principals(&mut self, owner: &str, claim_legacy: bool) -> Result<()> {
        validate(owner)?;
        let tx = self.db.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT owner_principal_id FROM catalog_principal_owner WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            if old != owner {
                return Err(RuntimeError::Conflict(
                    "Catalog belongs to another authentication owner".into(),
                ));
            }
            return Ok(());
        }
        tx.execute("INSERT INTO catalog_principal_owner(id,owner_principal_id,claim_legacy) VALUES(1,?1,?2)", params![owner,claim_legacy])?;
        if claim_legacy {
            tx.execute(
                "UPDATE threads SET principal_id=?1 WHERE principal_id IS NULL",
                [owner],
            )?;
            followups::events::claim_legacy(&tx, owner)?;
            external::claim_public_principals(&tx, owner)?;
        }
        tx.execute("UPDATE runs SET body=json_set(body,'$.principal_id',(SELECT t.principal_id FROM branches b JOIN threads t ON t.id=b.thread_id WHERE b.id=runs.branch_id)) WHERE json_type(body,'$.thread_id')='text'", [])?;
        tx.commit()?;
        Ok(())
    }
    /// Existing public work retains the legacy local Host authority. Authenticated members
    /// never inherit it: only the persisted authentication owner may use Host-wide resources.
    pub fn thread_has_host_authority(&self, thread_id: &str) -> Result<bool> {
        let Some(principal) = thread(&self.db, thread_id)? else {
            return Ok(true);
        };
        let owner: Option<String> = self
            .db
            .query_row(
                "SELECT owner_principal_id FROM catalog_principal_owner WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(owner.as_deref() == Some(principal.as_str()))
    }
    pub fn thread_principal(&self, thread_id: &str) -> Result<Option<String>> {
        thread(&self.db, thread_id)
    }
    pub fn events_after_for_principal(
        &self,
        cursor: u64,
        limit: u32,
        principal: Option<&str>,
    ) -> Result<Vec<Event>> {
        if let Some(principal) = principal {
            validate(principal)?;
        }
        let sql = format!(
            "SELECT e.cursor,e.subject,e.revision,e.kind,e.data FROM events e WHERE e.cursor>?1 AND EXISTS(SELECT 1 FROM threads t WHERE (t.principal_id IS NULL OR t.principal_id=?3) AND t.id=(SELECT min(thread_id) FROM ({SUBJECTS}) subjects WHERE subjects.subject=e.subject HAVING count(DISTINCT thread_id)=1)) ORDER BY e.cursor LIMIT ?2"
        );
        let mut query = self.db.prepare(&sql)?;
        let mut result = Vec::new();
        for row in query.query_map(params![sql_number(cursor)?, limit, principal], |r| {
            Ok((
                read_number(r, 0)?,
                r.get::<_, String>(1)?,
                read_number(r, 2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })? {
            let (cursor, subject, revision, kind, data) = row?;
            result.push(Event {
                cursor,
                subject,
                revision,
                kind,
                data: serde_json::from_str(&data)?,
            });
        }
        Ok(result)
    }
    pub fn filter_attention_principal(
        &self,
        snapshot: &mut attention::AttentionSnapshot,
        principal: Option<&str>,
    ) -> Result<()> {
        let allowed: std::collections::HashSet<String> = self
            .db
            .prepare("SELECT id FROM threads WHERE principal_id IS NULL OR principal_id=?1")?
            .query_map([principal], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        snapshot
            .branches
            .retain(|row| allowed.contains(&row.thread_id));
        snapshot
            .items
            .retain(|row| allowed.contains(&row.thread_id));
        snapshot.team_executions.retain(|row| {
            allowed.contains(&row.parent_thread_id) && allowed.contains(&row.child_thread_id)
        });
        snapshot.delegations.retain(|row| {
            allowed.contains(&row.parent_thread_id) && allowed.contains(&row.child_thread_id)
        });
        snapshot
            .follows
            .retain(|row| allowed.contains(&row.thread_id));
        snapshot
            .stopped_executors
            .retain(|row| allowed.contains(&row.thread_id));
        snapshot.delivered_reports.retain(|row| {
            allowed.contains(&row.parent_thread_id) && allowed.contains(&row.child_thread_id)
        });
        snapshot.counts.action_required = snapshot.items.iter().filter(|i| i.actionable).count();
        snapshot.counts.affected_branches = snapshot
            .items
            .iter()
            .filter(|i| i.actionable)
            .map(|i| (&i.thread_id, &i.branch_id))
            .collect::<std::collections::HashSet<_>>()
            .len();
        snapshot.counts.unknown_effects = snapshot
            .items
            .iter()
            .filter(|i| i.kind == "effect_unknown")
            .count();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_submission::InputAdmission;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("varin-principals-{}", id())))
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
    fn submit(catalog: &mut Catalog, thread: &str) -> Receipt {
        catalog
            .submit(&SubmitInput {
                key: format!("input-{thread}"),
                thread_id: thread.into(),
                branch_id: format!("{thread}-main"),
                expected_head: None,
                input: json!({"text":thread}),
                configuration: json!({"provider":"test"}),
            })
            .unwrap()
    }
    fn create(catalog: &mut Catalog, thread: &str, principal: Option<&str>) {
        catalog
            .create_thread_with_principal(thread, &format!("{thread}-main"), principal)
            .unwrap();
    }
    #[test]
    fn principal_visibility_and_original_run_attribution_survive_reopen() {
        let f = Fixture::new();
        let mut c = f.open();
        c.initialize_principals("alice", false).unwrap();
        create(&mut c, "alice-thread", Some("alice"));
        create(&mut c, "bob-thread", Some("bob"));
        create(&mut c, "public", None);
        let a = submit(&mut c, "alice-thread");
        let b = submit(&mut c, "bob-thread");
        let p = submit(&mut c, "public");
        assert_eq!(
            c.run(&a.run_id).unwrap().principal_id.as_deref(),
            Some("alice")
        );
        assert_eq!(
            c.run(&b.run_id).unwrap().principal_id.as_deref(),
            Some("bob")
        );
        assert_eq!(c.run(&p.run_id).unwrap().principal_id, None);
        assert!(c.thread_has_host_authority("alice-thread").unwrap());
        assert!(!c.thread_has_host_authority("bob-thread").unwrap());
        assert!(c
            .create_thread_with_principal("bob-thread", "bob-thread-main", Some("alice"))
            .is_err());
        for (selection, expected) in [
            (json!({}), 3),
            (json!({"principalId":null}), 1),
            (json!({"principalId":"alice"}), 2),
            (json!({"principalId":"bob"}), 2),
        ] {
            let query = serde_json::from_value(selection).unwrap();
            assert_eq!(c.list_thread_catalog(&query).unwrap().len(), expected);
        }
        let events = c.events_after_for_principal(0, 100, Some("alice")).unwrap();
        assert!(events.iter().any(|e| e.subject == a.run_id));
        assert!(events.iter().any(|e| e.subject == p.run_id));
        assert!(!events
            .iter()
            .any(|e| e.subject == b.run_id || e.subject == "bob-thread"));
        let mut attention = c.capture_attention_read().load(&|| false).unwrap();
        c.filter_attention_principal(&mut attention, Some("alice"))
            .unwrap();
        assert!(attention
            .branches
            .iter()
            .all(|branch| branch.thread_id != "bob-thread"));
        drop(c);
        let c = f.open();
        assert_eq!(
            c.run(&b.run_id).unwrap().principal_id.as_deref(),
            Some("bob")
        );
        assert_eq!(
            c.inspect_thread("alice-thread").unwrap()["principal_id"],
            "alice"
        );
    }
    #[test]
    fn migration_claim_policy_is_atomic_persistent_and_never_reclaims_public_work() {
        let f = Fixture::new();
        let mut c = f.open();
        create(&mut c, "legacy", None);
        let receipt = submit(&mut c, "legacy");
        followups::events::restore_pre_arrangement_fixture(&c.db).unwrap();
        c.db.execute_batch("DROP TABLE thread_creations;DROP TABLE calendar_invocations;DROP TABLE calendar_legacy_manual_boundaries;DROP INDEX thread_principals; ALTER TABLE threads DROP COLUMN principal_id; DROP TABLE catalog_principal_owner; UPDATE runs SET body=json_remove(body,'$.principal_id'); PRAGMA user_version=86;").unwrap();
        drop(c);
        let mut c = f.open();
        assert_eq!(
            c.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            FORMAT
        );
        c.initialize_principals("owner", true).unwrap();
        assert_eq!(
            c.thread_principal("legacy").unwrap().as_deref(),
            Some("owner")
        );
        assert_eq!(
            c.run(&receipt.run_id).unwrap().principal_id.as_deref(),
            Some("owner")
        );
        assert_eq!(c.history("legacy-main").unwrap().len(), 1);
        create(&mut c, "new-public", None);
        drop(c);
        let mut c = f.open();
        c.initialize_principals("owner", true).unwrap();
        assert_eq!(c.thread_principal("new-public").unwrap(), None);
        assert!(c.initialize_principals("different", true).is_err());
    }
    #[test]
    fn enabling_auth_later_does_not_claim_original_public_threads() {
        let f = Fixture::new();
        let mut c = f.open();
        create(&mut c, "public", None);
        c.initialize_principals("owner", false).unwrap();
        c.initialize_principals("owner", true).unwrap();
        assert_eq!(c.thread_principal("public").unwrap(), None);
    }
    #[test]
    fn relabeled_current_principal_schema_is_rejected_without_rewriting_assets() {
        let f = Fixture::new();
        let mut c = f.open();
        c.initialize_principals("alice", true).unwrap();
        create(&mut c, "private", Some("alice"));
        let receipt = submit(&mut c, "private");
        c.db.pragma_update(None, "user_version", 86).unwrap();
        let before: String =
            c.db.query_row(
                "SELECT body FROM runs WHERE id=?1",
                [&receipt.run_id],
                |row| row.get(0),
            )
            .unwrap();
        drop(c);
        let error = match Catalog::open(&f.0) {
            Ok(_) => panic!("mislabeled schema was accepted"),
            Err(error) => error,
        };
        assert!(error
            .to_string()
            .contains("newer principal attribution schema"));
        let raw = Connection::open(f.0.join("conversation.sqlite")).unwrap();
        assert_eq!(
            raw.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            86
        );
        assert_eq!(thread(&raw, "private").unwrap().as_deref(), Some("alice"));
        assert_eq!(
            raw.query_row(
                "SELECT body FROM runs WHERE id=?1",
                [&receipt.run_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            before
        );
    }
    #[test]
    fn explicit_null_is_not_internal_unfiltered_authority() {
        let public: EventsQuery =
            serde_json::from_value(json!({"cursor":0,"limit":10,"principalId":null})).unwrap();
        let internal: EventsQuery = serde_json::from_value(json!({"cursor":0,"limit":10})).unwrap();
        assert_eq!(public.principal_id, Some(None));
        assert_eq!(internal.principal_id, None);
        let public: PrincipalQuery = serde_json::from_value(json!({"principalId":null})).unwrap();
        assert_eq!(public.principal_id, Some(None));
    }
}
