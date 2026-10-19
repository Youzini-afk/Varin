//! Tokenizer cache roots, captured by the Catalog owner and read off its control lock.
use super::*;
use crate::token_count::TokenizerBinding;
use std::collections::BTreeSet;

pub struct TokenizerReferencesRead {
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl Catalog {
    pub fn capture_tokenizer_references(&self) -> TokenizerReferencesRead {
        TokenizerReferencesRead {
            database: self.database_path.clone(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
}
impl TokenizerReferencesRead {
    pub fn load(self) -> Result<Vec<TokenizerBinding>> {
        let db = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // Queued input already has a Run. Idle continuations inherit the latest branch Run,
        // including its desired model and frozen child directory. Older terminal Runs are history.
        let mut statement = db.prepare("WITH internal_branches AS (
            SELECT r.branch_id FROM context_jobs j JOIN runs r ON r.id=j.run_id
            UNION SELECT r.branch_id FROM operations o JOIN runs r ON r.id=o.run_id WHERE json_extract(o.body,'$.intent.kind')='memory_work_v1'
        ), retained AS (
            SELECT id FROM runs WHERE json_extract(body,'$.state') NOT IN ('completed','failed','cancelled')
            UNION SELECT id FROM runs r WHERE rowid IN (SELECT MAX(rowid) FROM runs GROUP BY branch_id)
                AND branch_id NOT IN internal_branches
        )
        SELECT json_extract(body,'$.configuration') FROM runs WHERE id IN retained
        UNION ALL SELECT body FROM run_launches WHERE id IN retained
        UNION ALL SELECT body FROM model_selections s WHERE run_id IN retained AND
            (active=1 OR status IN ('preparing','ready') OR revision=(SELECT MAX(revision) FROM model_selections WHERE run_id=s.run_id))
        UNION ALL SELECT json_extract(body,'$.models') FROM policy_selections WHERE run_id IN retained AND status IN ('preparing','ready','active')
        UNION ALL SELECT recipe FROM context_jobs WHERE run_id IN (SELECT id FROM runs WHERE json_extract(body,'$.state') NOT IN ('completed','failed','cancelled'))
        UNION ALL SELECT body FROM delegated_executions WHERE json_extract(body,'$.report') IS NULL
        UNION ALL SELECT json_extract(c.body,'$.dispatch_context_ref') FROM child_tasks c
            WHERE id IN (SELECT child_operation_id FROM delegated_executions WHERE json_extract(body,'$.report') IS NULL)
        UNION ALL SELECT json_extract(body,'$.request') FROM model_steps WHERE state IN ('prepared','dispatched')")?;
        let values = statement
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .filter_map(|row| row.transpose())
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        drop(db);
        let mut bindings = BTreeSet::new();
        let mut visited = BTreeSet::new();
        for value in values {
            self.scan(&serde_json::from_str(&value)?, &mut visited, &mut bindings)?;
        }
        Ok(bindings.into_iter().collect())
    }
    fn scan(
        &self,
        value: &Value,
        visited: &mut BTreeSet<String>,
        bindings: &mut BTreeSet<TokenizerBinding>,
    ) -> Result<()> {
        match value {
            Value::Object(object) => {
                if let Some(reference) = object.get("content_object").and_then(Value::as_str) {
                    if visited.insert(reference.into()) {
                        self.scan(&self.content.load(value)?, visited, bindings)?;
                    }
                    return Ok(());
                }
                for (key, value) in object {
                    match key.as_str() {
                        "tokenizer" => {
                            if !value.is_null() {
                                bindings.insert(serde_json::from_value(value.clone())?);
                            }
                        }
                        "continuation_tokenizer" => {
                            bindings.insert(serde_json::from_value(value["name"].clone())?);
                        }
                        // Follow only executable model metadata. History/tool bodies are irrelevant.
                        "configuration_ref"
                        | "catalog_ref"
                        | "child_dispatch_ref"
                        | "dispatch_context_ref"
                        | "configuration"
                        | "selection"
                        | "launch"
                        | "parent_model"
                        | "model"
                        | "inherit_base"
                        | "presets"
                        | "view"
                        | "binding"
                        | "policy_models"
                        | "body"
                        | "child_dispatch" => self.scan(value, visited, bindings)?,
                        _ => (),
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.scan(value, visited, bindings)?;
                }
            }
            _ => (),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_submission::InputAdmission;

    #[test]
    fn active_and_latest_branch_bindings_survive_recovery_while_old_terminal_versions_retire() {
        let root = std::env::temp_dir().join(format!("varin-tokenizer-roots-{}", id()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "main").unwrap();
        let binding = |name: &str| TokenizerBinding::File {
            path: format!("/{name}.json.gz"),
            sha256: name.into(),
        };
        let submit = |key: &str, expected_head: Option<String>| SubmitInput {
            key: key.into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head,
            input: json!({"text":key}),
            configuration: json!({"tokenizer":binding(key)}),
        };
        let first = catalog.submit(&submit("old", None)).unwrap();
        assert_eq!(
            catalog.capture_tokenizer_references().load().unwrap(),
            vec![binding("old")]
        );
        let run = catalog.run(&first.run_id).unwrap();
        catalog
            .transition_run(&run.id, run.epoch, run.revision, RunState::Cancelled)
            .unwrap();
        // The last completed Run still supplies an idle branch's continuation configuration.
        assert_eq!(
            catalog.capture_tokenizer_references().load().unwrap(),
            vec![binding("old")]
        );
        catalog
            .submit(&submit("new", Some(first.input_id)))
            .unwrap();
        drop(catalog);
        let catalog = Catalog::open(&root).unwrap();
        assert_eq!(
            catalog.capture_tokenizer_references().load().unwrap(),
            vec![binding("new")]
        );
        // Child catalogs and retained compaction counters are content references, not model names.
        let frozen = catalog
            .content
            .save(&json!({"presets":[{"model":{"configuration":{"tokenizer":binding("child")}}}]}))
            .unwrap();
        let read = catalog.capture_tokenizer_references();
        let mut bindings = BTreeSet::new();
        read.scan(&json!({"catalog_ref":frozen,"continuation_tokenizer":{"name":binding("conversation"),"matched":true},
            "tools":[{"input_schema":{"properties":{"tokenizer":{"type":"string"}}}}]}), &mut BTreeSet::new(), &mut bindings).unwrap();
        assert_eq!(
            bindings,
            [binding("child"), binding("conversation")]
                .into_iter()
                .collect()
        );
        drop(read);
        drop(catalog);
        std::fs::remove_dir_all(root).unwrap();
    }
}
