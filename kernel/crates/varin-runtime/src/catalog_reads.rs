//! Independent WAL readers share immutable content and live registries, never writer ownership.
use super::*;

impl Catalog {
    /// Opening a reader does not acquire or retain `runtime.owner`, run recovery, or install
    /// write hooks. SQLite READ_ONLY is the final guard even for legacy `&self` methods.
    pub fn read_view(&self) -> Result<Self> {
        let db = Connection::open_with_flags(
            &self.database_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        threads::install_functions(&db)?;
        db.pragma_update(None, "query_only", true)?;
        db.pragma_update(None, "foreign_keys", true)?;
        Ok(Self {
            db,
            content: self.content.clone(),
            resource_admission: self.resource_admission.clone(),
            nested_tools: self.nested_tools.clone(),
            context_compositions: self.context_compositions.clone(),
            _owner: None,
            database_path: self.database_path.clone(),
            epoch: self.epoch,
            plan_cursor_key: self.plan_cursor_key,
            continuation_stopping: self.continuation_stopping.clone(),
            event_observers: self.event_observers.clone(),
            attention_cache: Default::default(),
            context_inspections: self.context_inspections.clone(),
        })
    }

    /// A composed view sees one committed generation. The closure performs local reads only;
    /// it cannot await a model, executor, Host callback, or mutable Catalog acquisition.
    pub fn read_snapshot<T, E>(
        &mut self,
        read: impl FnOnce(&mut Self) -> std::result::Result<T, E>,
    ) -> std::result::Result<T, E>
    where
        E: From<RuntimeError>,
    {
        // Register before SQLite fixes its WAL cut: the current writer may retire
        // these body references while this reader still owns the older snapshot.
        let _publication = self.content.begin_publication();
        self.db
            .execute_batch("BEGIN DEFERRED")
            .map_err(RuntimeError::from)?;
        let result = self
            .assert_read_epoch()
            .map_err(E::from)
            .and_then(|_| read(self));
        // Read transactions have nothing to commit; rollback also releases the WAL read mark
        // on an application error. No snapshot remains leased to the pooled connection.
        let release = self
            .db
            .execute_batch("ROLLBACK")
            .map_err(RuntimeError::from);
        match result {
            Ok(value) => {
                release?;
                self.assert_read_epoch()?;
                Ok(value)
            }
            Err(error) => {
                let _ = release;
                Err(error)
            }
        }
    }

    fn assert_read_epoch(&self) -> Result<()> {
        let epoch = self
            .db
            .query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| {
                read_number(row, 0)
            })?;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "Catalog reader belongs to a previous owner epoch".into(),
            ));
        }
        Ok(())
    }

    /// Missing identities are omitted, including transitive ownership. Callers fail closed
    /// when a requested mapping is absent; public ownership is represented explicitly by null.
    pub fn resolve_ownership(
        &self,
        threads: &[String],
        runs: &[String],
        operations: &[String],
        inputs: &[String],
    ) -> Result<Value> {
        let ids = |values: &[String]| -> Result<String> { Ok(serde_json::to_string(values)?) };
        let operation_rows = self
            .db
            .prepare_cached(
                "SELECT id,run_id FROM operations WHERE id IN (SELECT value FROM json_each(?1))",
            )?
            .query_map([ids(operations)?], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let input_rows = self.db.prepare_cached("SELECT q.id,b.thread_id FROM input_queue q JOIN branches b ON b.id=q.branch_id WHERE q.id IN (SELECT value FROM json_each(?1))")?
            .query_map([ids(inputs)?], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?)))?
            .collect::<std::result::Result<Vec<_>,_>>()?;
        let run_ids: Vec<_> = runs
            .iter()
            .cloned()
            .chain(operation_rows.iter().map(|(_, id)| id.clone()))
            .collect();
        let run_rows = self.db.prepare_cached("SELECT r.id,b.thread_id FROM runs r JOIN branches b ON b.id=r.branch_id WHERE r.id IN (SELECT value FROM json_each(?1))")?
            .query_map([ids(&run_ids)?], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?)))?
            .collect::<std::result::Result<Vec<_>,_>>()?;
        let thread_ids: Vec<_> = threads
            .iter()
            .cloned()
            .chain(
                run_rows
                    .iter()
                    .chain(input_rows.iter())
                    .map(|(_, id)| id.clone()),
            )
            .collect();
        let thread_rows = self
            .db
            .prepare_cached(
                "SELECT id,principal_id FROM threads WHERE id IN (SELECT value FROM json_each(?1))",
            )?
            .query_map([ids(&thread_ids)?], |r| {
                Ok(json!({"id":r.get::<_,String>(0)?,"principalId":r.get::<_,Option<String>>(1)?}))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(
            json!({"threads":thread_rows,"runs":run_rows.into_iter().map(|(id,thread)|json!({"id":id,"threadId":thread})).collect::<Vec<_>>(),
            "operations":operation_rows.into_iter().map(|(id,run)|json!({"id":id,"runId":run})).collect::<Vec<_>>(),
            "inputs":input_rows.into_iter().map(|(id,thread)|json!({"id":id,"threadId":thread})).collect::<Vec<_>>() }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readers_see_committed_writes_without_writer_lock_and_reject_writes() {
        let root = std::env::temp_dir().join(format!("varin-reader-{}", uuid::Uuid::new_v4()));
        let mut writer = Catalog::open(&root).unwrap();
        let mut reader = writer.read_view().unwrap();
        writer.create_thread("thread", "branch").unwrap();
        assert_eq!(
            reader.inspect_thread("thread").unwrap()["thread_id"],
            "thread"
        );
        assert!(matches!(
            reader.create_thread("forbidden", "forbidden-branch"),
            Err(RuntimeError::Sql(_))
        ));
        assert!(!writer.content.publication_active());
        reader
            .read_snapshot::<_, RuntimeError>(|catalog| {
                assert!(writer.content.publication_active(), "snapshot pins content before any read");
                assert_eq!(catalog.inspect_thread("thread")?["title"], "New thread");
                writer
                    .db
                    .execute("UPDATE threads SET title='committed' WHERE id='thread'", [])?;
                assert_eq!(catalog.inspect_thread("thread")?["title"], "New thread");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            reader.inspect_thread("thread").unwrap()["title"],
            "committed"
        );
        assert!(!writer.content.publication_active(), "read lease ends with the snapshot");
        drop(writer);
        // A retained reader cannot keep the writer's OS lease alive.
        let reopened = Catalog::open(&root).unwrap();
        drop(reopened);
        drop(reader);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ownership_batches_include_transitive_links_and_explicit_public_ownership() {
        use crate::test_submission::InputAdmission;
        let root = std::env::temp_dir().join(format!("varin-owner-read-{}", id()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread_with_principal("private", "main", Some("alice"))
            .unwrap();
        db.create_thread("public", "public-main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "private".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"original"}),
                configuration: json!({}),
            })
            .unwrap();
        db.admit_operation(
            "operation",
            &receipt.run_id,
            db.epoch(),
            Lifetime::Run,
            json!({"kind":"fixture"}),
        )
        .unwrap();
        let reader = db.read_view().unwrap();
        let result = reader
            .resolve_ownership(
                &["public".into(), "missing".into()],
                &[],
                &["operation".into(), "not-found".into()],
                &[],
            )
            .unwrap();
        assert_eq!(
            result["operations"],
            json!([{"id":"operation","runId":receipt.run_id}])
        );
        assert_eq!(
            result["runs"],
            json!([{"id":receipt.run_id,"threadId":"private"}])
        );
        assert_eq!(
            result["threads"],
            json!([{"id":"private","principalId":"alice"},{"id":"public","principalId":null}])
        );
        assert_eq!(result["inputs"], json!([]));
        drop(reader);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
