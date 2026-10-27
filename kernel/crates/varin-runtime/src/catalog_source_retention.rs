//! Original Source retirement belongs to conversation deletion. A short Catalog
//! claim fences new saved references while Storage drains the actual mount. The
//! claim is removed after that original cleanup, not kept as a second ledger.
use super::*;
use launches::SourceSelection;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRetirement {
    pub cleanup_id: String,
    pub source: SourceSelection,
}
fn key(source: &SourceSelection) -> Option<String> {
    source.resource_owner.is_local().then_some(())?;
    let branch = source.branch_id.as_deref()?;
    // These namespaces are created by source preparation. User project heads,
    // Git refs and arbitrary API-created branches have their own lifetimes.
    if ![
        "source:",
        "child-source:",
        "native-snapshot:",
        "code-snapshot:",
    ]
    .iter()
    .any(|prefix| branch.starts_with(prefix))
    {
        return None;
    }
    Some(format!(
        "source-retention:{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(source.workspace_id.as_str(), branch)).ok()?
        ))
    ))
}
fn record_sources(table: &str, value: &Value) -> Result<Vec<SourceSelection>> {
    let mut found = Vec::new();
    let mut add = |value: Option<&Value>| -> Result<()> {
        if let Some(value) = value.filter(|value| !value.is_null()) {
            found.push(serde_json::from_value(value.clone())?);
        }
        Ok(())
    };
    match table {
        "run_launches" => add(value.pointer("/selection/source"))?,
        "delegated_executions" => {
            for pointer in [
                "/launch/source",
                "/source_basis/source",
                "/source_basis/incoming/source",
                "/source/selection",
                "/source/pin/source",
                "/source/handoff/source",
                "/source/handoff/refresh/source",
                "/source/handoff/retention_pin/source",
                "/source/handoff/root/pin/source",
            ] {
                add(value.pointer(pointer))?;
            }
        }
        "external_conversations" => add(value.get("nativeWorkspace"))?,
        "external_children" => {
            for pointer in [
                "/source/nativeSource",
                "/handoff/source",
                "/handoff/refresh/source",
                "/handoff/retention_pin/source",
                "/handoff/root/pin/source",
            ] {
                add(value.pointer(pointer))?;
            }
        }
        _ => (),
    }
    Ok(found)
}
pub(super) fn assert_record_available(db: &Connection, table: &str, value: &Value) -> Result<()> {
    for source in record_sources(table, value)? {
        if let Some(id) = key(&source) {
            let claimed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM commands WHERE id=?1 AND json_extract(receipt,'$.state')='claimed')",[id],|row|row.get(0))?;
            if claimed {
                return Err(RuntimeError::Conflict(
                    "source_retiring: the deleted conversation's workspace is being released"
                        .into(),
                ));
            }
        }
    }
    Ok(())
}
impl Catalog {
    fn source_references(&self) -> Result<BTreeMap<String, (SourceSelection, BTreeSet<String>)>> {
        let mut references = BTreeMap::new();
        let queries = [
            (
                "run_launches",
                "SELECT l.body,b.thread_id FROM run_launches l JOIN runs r ON r.id=l.id JOIN branches b ON b.id=r.branch_id",
            ),
            (
                "delegated_executions",
                "SELECT d.body,b.thread_id FROM delegated_executions d JOIN operations o ON o.id=d.child_operation_id JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id",
            ),
            (
                "external_conversations",
                "SELECT body,'' FROM external_conversations WHERE coalesce(json_extract(body,'$.deleted'),0)=0 OR coalesce(json_extract(body,'$.cleanupPending'),0)=1",
            ),
            (
                "external_children",
                "SELECT x.body,'' FROM external_children x JOIN external_conversations c ON c.id=json_extract(x.body,'$.conversation_id') WHERE coalesce(json_extract(c.body,'$.deleted'),0)=0 OR coalesce(json_extract(c.body,'$.cleanupPending'),0)=1",
            ),
        ];
        for (table, query) in queries {
            for row in self.db.prepare(query)?.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (body, thread) = row?;
                for source in record_sources(table, &serde_json::from_str(&body)?)? {
                    if let Some(id) = key(&source) {
                        let entry = references
                            .entry(id)
                            .or_insert_with(|| (source.clone(), BTreeSet::new()));
                        if source.mode == crate::SourceMode::NativeWorkspace {
                            entry.0 = source;
                        }
                        entry.1.insert(thread.clone());
                    }
                }
            }
        }
        for row in self.db.prepare("SELECT intent FROM commands WHERE json_extract(intent,'$.kind')='source.preparation'")?.query_map([],|row|row.get::<_,String>(0))? {
            let value:Value=serde_json::from_str(&row?)?;
            let source:SourceSelection=serde_json::from_value(value["source"].clone())?;
            if let Some(id)=key(&source){references.entry(id).or_insert_with(||(source,BTreeSet::new())).1.insert(value["threadId"].as_str().ok_or_else(||RuntimeError::Invalid("Source preparation Thread is missing".into()))?.into());}
        }
        Ok(references)
    }
    fn source_retirement_threads(&self, drained: &[String]) -> Result<BTreeSet<String>> {
        let mut ready: BTreeSet<String> = drained.iter().cloned().collect();
        // Retained child identities and shared history still use the original
        // source for continuation/navigation, even after hiding its Thread.
        for query in [
            "SELECT json_extract(c.body,'$.parent_thread_id') FROM child_tasks c JOIN threads t ON t.id=c.child_thread_id WHERE t.deleted_at_ms IS NULL",
            "WITH RECURSIVE retained(id) AS (SELECT b.head FROM branches b JOIN threads t ON t.id=b.thread_id WHERE t.deleted_at_ms IS NULL AND b.head IS NOT NULL UNION SELECT h.parent FROM history h JOIN retained r ON r.id=h.id WHERE h.parent IS NOT NULL) SELECT DISTINCT h.thread_id FROM history h JOIN retained r ON r.id=h.id",
        ] {
            for thread in self
                .db
                .prepare(query)?
                .query_map([], |row| row.get::<_, String>(0))?
            {
                ready.remove(&thread?);
            }
        }
        Ok(ready)
    }
    pub(super) fn capture_source_retirements(
        &self,
        drained: &[String],
    ) -> Result<Vec<SourceRetirement>> {
        let ready = self.source_retirement_threads(drained)?;
        let references = self.source_references()?;
        for (id, (source, threads)) in &references {
            if !threads.is_empty() && threads.iter().all(|thread| ready.contains(thread)) {
                self.db.execute(
                    "INSERT OR IGNORE INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
                    params![
                        id,
                        json!({"kind":"source.retention","source":source}).to_string(),
                        json!({"state":"pending"}).to_string()
                    ],
                )?;
            }
        }
        let mut retired = Vec::new();
        for row in self.db.prepare("SELECT id,intent FROM commands WHERE json_extract(intent,'$.kind')='source.retention'")?.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))? {
            let (id,intent)=row?;
            if references.get(&id).is_some_and(|(_,threads)|threads.iter().any(|thread|!ready.contains(thread))) {continue;}
            let source:SourceSelection=serde_json::from_value(serde_json::from_str::<Value>(&intent)?["source"].clone())?;
            retired.push(SourceRetirement{cleanup_id:id,source});
        }
        Ok(retired)
    }
    pub fn source_retirement(&mut self, cleanup_id: &str, complete: bool) -> Result<Value> {
        self.source_retirement_action(cleanup_id, complete, false)
    }
    pub fn source_retirement_action(
        &mut self,
        cleanup_id: &str,
        complete: bool,
        defer: bool,
    ) -> Result<Value> {
        let row:Option<(String,String)>=self.db.query_row("SELECT intent,receipt FROM commands WHERE id=?1 AND json_extract(intent,'$.kind')='source.retention'",[cleanup_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        let Some((intent, receipt)) = row else {
            return Ok(json!({"claimed":false}));
        };
        if defer {
            self.db.execute(
                "UPDATE commands SET receipt=?2 WHERE id=?1",
                params![cleanup_id, json!({"state":"pending"}).to_string()],
            )?;
            return Ok(json!({"claimed":false}));
        }
        if complete {
            if serde_json::from_str::<Value>(&receipt)?["state"] != "claimed" {
                return Err(RuntimeError::Conflict(
                    "Source cleanup was not claimed".into(),
                ));
            }
            self.db
                .execute("DELETE FROM commands WHERE id=?1", [cleanup_id])?;
            self.db.execute(
                "DELETE FROM commands WHERE id=?1",
                [format!("source-preparation:{cleanup_id}")],
            )?;
            return Ok(json!({"claimed":false,"completed":true}));
        }
        let (candidates, _) = self.deleted_thread_retirement_candidates()?;
        let ready = self.source_retirement_threads(
            &candidates
                .into_iter()
                .map(|(thread, _)| thread)
                .collect::<Vec<_>>(),
        )?;
        if self
            .source_references()?
            .get(cleanup_id)
            .is_some_and(|(_, threads)| threads.iter().any(|thread| !ready.contains(thread)))
        {
            return Ok(json!({"claimed":false}));
        }
        self.db.execute(
            "UPDATE commands SET receipt=?2 WHERE id=?1",
            params![cleanup_id, json!({"state":"claimed"}).to_string()],
        )?;
        Ok(json!({"claimed":true,"source":serde_json::from_str::<Value>(&intent)?["source"]}))
    }
    pub fn source_preparation(
        &mut self,
        thread_id: &str,
        source: &SourceSelection,
        release: bool,
    ) -> Result<Value> {
        source.validate()?;
        let id = key(source).ok_or_else(|| {
            RuntimeError::Invalid("Source preparation requires its owned local branch".into())
        })?;
        let preparation = format!("source-preparation:{id}");
        if release {
            self.db.execute(
                "DELETE FROM commands WHERE id=?1 AND json_extract(intent,'$.threadId')=?2",
                params![preparation, thread_id],
            )?;
            return Ok(json!({"retained":false}));
        }
        let deleted: Option<i64> = self.db.query_row(
            "SELECT deleted_at_ms FROM threads WHERE id=?1",
            [thread_id],
            |row| row.get(0),
        )?;
        if deleted.is_some() {
            return Err(RuntimeError::Conflict(
                "Source preparation Thread was deleted".into(),
            ));
        }
        assert_record_available(
            &self.db,
            "run_launches",
            &json!({"selection":{"source":source}}),
        )?;
        let intent =
            json!({"kind":"source.preparation","threadId":thread_id,"source":source}).to_string();
        if let Some(original) = self
            .db
            .query_row(
                "SELECT intent FROM commands WHERE id=?1",
                [&preparation],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            if serde_json::from_str::<Value>(&original)? != serde_json::from_str::<Value>(&intent)?
            {
                return Err(RuntimeError::Conflict(
                    "Source preparation identity changed".into(),
                ));
            }
        } else {
            self.db.execute(
                "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
                params![preparation, intent, json!({"retained":true}).to_string()],
            )?;
        }
        Ok(json!({"retained":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> SourceSelection {
        serde_json::from_value(json!({"resource_owner":{"kind":"local"},"mode":"native_workspace","workspace_id":"project","execution_workspace_id":"child","branch_id":"source:owned","revision":null,"live_root":null})).unwrap()
    }
    fn delete(db: &mut Catalog) {
        let revision = db.inspect_thread("owner").unwrap()["revision"]
            .as_u64()
            .unwrap();
        db.delete_thread(&threads::ThreadDelete {
            thread_id: "owner".into(),
            key: "delete-owner".into(),
            expected_revision: revision,
        })
        .unwrap();
    }
    #[test]
    fn original_preparation_retires_after_deletion_fences_new_references_and_recovers_its_claim() {
        let root = std::env::temp_dir().join(format!("varin-source-retention-{}", Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("owner", "owner-main").unwrap();
        let selected = source();
        db.source_preparation("owner", &selected, false).unwrap();
        assert!(db.capture_source_retirements(&[]).unwrap().is_empty());
        delete(&mut db);
        let pending = db.capture_source_retirements(&["owner".into()]).unwrap();
        assert_eq!(pending.len(), 1);
        let id = &pending[0].cleanup_id;
        assert_eq!(db.source_retirement(id, false).unwrap()["claimed"], true);
        assert!(
            assert_record_available(
                &db.db,
                "run_launches",
                &json!({"selection":{"source":selected}})
            )
            .is_err()
        );
        drop(db);
        let mut db = Catalog::open(&root).unwrap();
        assert_eq!(
            db.capture_source_retirements(&["owner".into()]).unwrap()[0].cleanup_id,
            *id
        );
        db.source_retirement(id, true).unwrap();
        assert!(
            db.capture_source_retirements(&["owner".into()])
                .unwrap()
                .is_empty()
        );
        assert_eq!(db.db.query_row("SELECT count(*) FROM commands WHERE json_extract(intent,'$.kind') IN ('source.preparation','source.retention')",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn surviving_external_source_protects_a_deleted_threads_files_and_deferred_cleanup_survives_retirement()
     {
        let root = std::env::temp_dir().join(format!("varin-source-retention-{}", Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("owner", "owner-main").unwrap();
        let selected = source();
        db.source_preparation("owner", &selected, false).unwrap();
        db.db
            .execute(
                "INSERT INTO external_conversations(id,body) VALUES('external',?1)",
                [json!({"nativeWorkspace":selected,"deleted":false}).to_string()],
            )
            .unwrap();
        delete(&mut db);
        assert!(
            db.capture_source_retirements(&["owner".into()])
                .unwrap()
                .is_empty()
        );
        db.db
            .execute(
                "UPDATE external_conversations SET body=?1 WHERE id='external'",
                [json!({"deleted":true}).to_string()],
            )
            .unwrap();
        let pending = db.capture_source_retirements(&["owner".into()]).unwrap();
        assert_eq!(pending.len(), 1);
        db.retire_deleted_threads(&[]).unwrap();
        assert_eq!(
            db.capture_source_retirements(&["owner".into()])
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.source_retirement(&pending[0].cleanup_id, false).unwrap()["claimed"],
            true
        );
        db.source_retirement(&pending[0].cleanup_id, true).unwrap();
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
}
