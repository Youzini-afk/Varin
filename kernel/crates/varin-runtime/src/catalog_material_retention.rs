//! Material ownership follows the original task family and frozen dispatch background.
//! Bodies are read outside the Catalog lock; Storage remains the material record owner.
use super::*;
use std::collections::BTreeSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialThreadRetention {
    pub thread_id: String,
    pub root_thread_id: String,
    pub release: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialInheritance {
    pub parent_thread_id: String,
    pub child_thread_id: String,
    pub root_thread_id: String,
    pub snapshot_ids: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRetention {
    pub threads: Vec<MaterialThreadRetention>,
    pub inheritances: Vec<MaterialInheritance>,
    pub sources: Vec<source_retention::SourceRetirement>,
}
pub struct MaterialRetentionRead {
    threads: Vec<MaterialThreadRetention>,
    sources: Vec<source_retention::SourceRetirement>,
    children: Vec<(delegated::ChildRelation, String)>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl MaterialRetentionRead {
    pub fn load(self) -> Result<MaterialRetention> {
        let mut inheritances = Vec::new();
        // These identify references, not grants. The material owner must still verify
        // the parent's read authority before retaining anything for the child.
        let reference = regex::Regex::new(r#""(?:snapshotId|sourceSnapshotId)"\s*:\s*"([^"\\]+)""#).expect("material reference pattern");
        fn collect(value: &Value, reference: &regex::Regex, ids: &mut BTreeSet<String>) {
            match value {
                Value::Object(fields) => for (key, value) in fields {
                    if matches!(key.as_str(), "snapshotId" | "sourceSnapshotId") {
                        if let Some(id) = value.as_str() { ids.insert(id.to_owned()); }
                    }
                    collect(value, reference, ids);
                },
                Value::Array(values) => for value in values { collect(value, reference, ids); },
                Value::String(text) => for capture in reference.captures_iter(text) { ids.insert(capture[1].to_owned()); },
                _ => (),
            }
        }
        for (child, root_thread_id) in self.children {
            let Some(context) = child.inherited_context else { continue; };
            let history = self.content.load_items(&context.items, &|| false)?;
            let mut ids = BTreeSet::new();
            collect(&serde_json::to_value(history)?, &reference, &mut ids);
            if !ids.is_empty() {
                inheritances.push(MaterialInheritance { parent_thread_id: child.parent_thread_id,
                    child_thread_id: child.child_thread_id, root_thread_id, snapshot_ids: ids.into_iter().collect() });
            }
        }
        Ok(MaterialRetention { threads: self.threads, inheritances, sources: self.sources })
    }
}
impl Catalog {
    pub fn capture_material_retention(&self, child_id: Option<&str>, drained_threads: &[String]) -> Result<MaterialRetentionRead> {
        let publication = self.content.begin_publication();
        let mut threads = Vec::new();
        if child_id.is_none() {
            for row in self.db.prepare("SELECT id FROM threads")?.query_map([], |row| row.get::<_, String>(0))? {
                let id = row?;
                threads.push(MaterialThreadRetention { root_thread_id: scheduling::thread_family(&self.db, &id)?,
                    release: drained_threads.contains(&id), thread_id: id });
            }
        }
        let mut children = Vec::new();
        for row in self.db.prepare("SELECT c.body FROM child_tasks c JOIN threads t ON t.id=c.child_thread_id WHERE t.deleted_at_ms IS NULL AND (?1 IS NULL OR c.child_thread_id=?1)")?
            .query_map([child_id], |row| row.get::<_, String>(0))? {
            let child: delegated::ChildRelation = serde_json::from_str(&row?)?;
            if child.inherited_context.is_some() {
                let root = scheduling::thread_family(&self.db, &child.child_thread_id)?;
                children.push((child, root));
            }
        }
        let sources=if child_id.is_none(){self.capture_source_retirements(drained_threads)?}else{Vec::new()};
        Ok(MaterialRetentionRead { threads, sources, children, content: self.content.clone(), _publication: publication })
    }
}
