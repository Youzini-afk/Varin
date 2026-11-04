//! Read-only conversation topology. Bodies are fetched separately for visible turns.
use super::*;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeRoute {
    pub branch_id: String,
    pub head_id: Option<String>,
    pub node_id: Option<String>,
    pub source_branch_id: Option<String>,
    pub fork_head_id: Option<String>,
    pub preserved: bool,
    pub active_run_id: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub run_id: String,
    pub first_item_id: String,
    pub last_item_id: String,
    pub branch_id: String,
    pub item_count: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeChild {
    pub node_id: Option<String>,
    pub run_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub name: String,
    pub avatar: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTree {
    pub thread_id: String,
    pub main_branch_id: String,
    pub routes: Vec<TreeRoute>,
    pub nodes: Vec<TreeNode>,
    pub children: Vec<TreeChild>,
}
pub struct ConversationTreeRead {
    database: std::path::PathBuf,
    epoch: u64,
    thread: String,
    branch: String,
    _publication: crate::content::ContentPublication,
}
impl Catalog {
    pub fn capture_conversation_tree(
        &self,
        thread: &str,
        branch: &str,
    ) -> Result<ConversationTreeRead> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Invalid(
                "conversation tree branch belongs to another Thread".into(),
            ));
        }
        threads::require_public(&self.db, thread)?;
        Ok(ConversationTreeRead {
            database: self.database_path.clone(),
            epoch: self.epoch,
            thread: thread.into(),
            branch: branch.into(),
            _publication: self.content.begin_publication(),
        })
    }
}
impl ConversationTreeRead {
    pub fn load(self, cancelled: &dyn Fn() -> bool) -> Result<ConversationTree> {
        let mut db = history_views::current_history_owner(&self.database, self.epoch)?;
        let tx = db.transaction()?;
        threads::require_available(&tx, &self.thread)?;
        let main_branch_id = threads::branch(&tx, &self.thread)?;
        let mut routes = Vec::new();
        {
            let mut statement = tx.prepare("SELECT b.id,b.head,b.active_run,
                (SELECT data FROM events WHERE subject=b.id AND kind='branch.created' ORDER BY cursor LIMIT 1)
                FROM branches b WHERE b.thread_id=?1 ORDER BY b.rowid")?;
            let rows = statement.query_map([&self.thread], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?;
            for row in rows {
                let (branch_id, head_id, active_run_id, creation) = row?;
                let creation: Value = creation
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?
                    .unwrap_or(Value::Null);
                routes.push(TreeRoute {
                    branch_id,
                    head_id,
                    node_id: None,
                    active_run_id,
                    source_branch_id: creation["source"].as_str().map(str::to_owned),
                    fork_head_id: creation["head"].as_str().map(str::to_owned),
                    preserved: creation["reason"] == "navigation",
                });
            }
        }
        if !routes.iter().any(|route| route.branch_id == self.branch) {
            return Err(RuntimeError::NotFound(self.branch));
        }
        let check = || {
            if cancelled() {
                Err(RuntimeError::Invalid(
                    "conversation tree read cancelled".into(),
                ))
            } else {
                Ok(())
            }
        };
        check()?;
        // UNION visits a shared ancestor once. No content objects or tool output
        // are opened, and this scan runs outside the Catalog command mutex.
        let mut statement = tx.prepare("WITH RECURSIVE reachable(id) AS (
            SELECT head FROM branches WHERE thread_id=?1 AND head IS NOT NULL
            UNION SELECT h.parent FROM history h JOIN reachable r ON h.id=r.id WHERE h.parent IS NOT NULL
        ) SELECT h.id,h.parent,h.run_id,json_extract(h.body,'$.source') FROM history h
          JOIN reachable r ON r.id=h.id WHERE h.thread_id=?1 ORDER BY h.rowid")?;
        let items = statement
            .query_map([&self.thread], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut child_counts: HashMap<&str, usize> = HashMap::new();
        for (_, parent, _, _) in &items {
            if let Some(parent) = parent {
                *child_counts.entry(parent).or_default() += 1;
            }
        }
        let endpoints: HashSet<&str> = routes
            .iter()
            .flat_map(|route| {
                [route.head_id.as_deref(), route.fork_head_id.as_deref()]
                    .into_iter()
                    .flatten()
            })
            .collect();
        let mut item_nodes: HashMap<&str, usize> = HashMap::new();
        let mut nodes: Vec<TreeNode> = Vec::new();
        for (id, parent, run, source) in &items {
            check()?;
            let parent_node = parent.as_deref().and_then(|id| item_nodes.get(id)).copied();
            let extend = parent_node.filter(|index| {
                nodes[*index].run_id == *run
                    && source != "user"
                    && parent.as_deref().is_some_and(|parent| {
                        !endpoints.contains(parent)
                            && child_counts.get(parent).copied().unwrap_or(0) == 1
                    })
            });
            let index = if let Some(index) = extend {
                nodes[index].last_item_id = id.clone();
                nodes[index].item_count += 1;
                index
            } else {
                let index = nodes.len();
                nodes.push(TreeNode {
                    id: id.clone(),
                    parent_id: parent_node.map(|i| nodes[i].id.clone()),
                    run_id: run.clone(),
                    first_item_id: id.clone(),
                    last_item_id: id.clone(),
                    branch_id: String::new(),
                    item_count: 1,
                });
                index
            };
            item_nodes.insert(id, index);
        }
        // Prefer the selected route as the navigation witness for shared turns.
        let mut order: Vec<usize> = (0..routes.len()).collect();
        order.sort_by_key(|index| routes[*index].branch_id != self.branch);
        let positions: HashMap<String, usize> = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.clone(), i))
            .collect();
        for index in order {
            let route = &mut routes[index];
            let mut position = route
                .head_id
                .as_deref()
                .and_then(|id| item_nodes.get(id))
                .copied();
            route.node_id = position.map(|index| nodes[index].id.clone());
            while let Some(index) = position {
                if !nodes[index].branch_id.is_empty() {
                    break;
                }
                nodes[index].branch_id = route.branch_id.clone();
                position = nodes[index]
                    .parent_id
                    .as_ref()
                    .and_then(|id| positions.get(id))
                    .copied();
            }
        }
        let mut children = Vec::new();
        let mut child_query = tx.prepare("SELECT json_extract(c.body,'$.parent_run_id'),c.child_thread_id,
            json_extract(c.body,'$.child_branch_id'),t.title,json_extract(c.body,'$.avatar'),
            (SELECT h.id FROM events e JOIN history h ON h.id=json_extract(e.data,'$.id')
             WHERE e.subject=json_extract(c.body,'$.parent_branch_id') AND e.kind='history.appended'
             AND e.cursor<=json_extract(c.body,'$.cursor') AND h.run_id=json_extract(c.body,'$.parent_run_id')
             ORDER BY e.cursor DESC LIMIT 1)
            FROM child_tasks c JOIN threads t ON t.id=c.child_thread_id JOIN operations o ON o.id=c.id
            WHERE json_extract(c.body,'$.parent_thread_id')=?1 AND t.deleted_at_ms IS NULL
            AND json_extract(o.body,'$.executor')!='code_retrieval' ORDER BY c.rowid")?;
        for child in child_query.query_map([&self.thread], |row| {
            Ok(TreeChild {
                run_id: row.get(0)?,
                thread_id: row.get(1)?,
                branch_id: row.get(2)?,
                name: row.get(3)?,
                avatar: row.get(4)?,
                node_id: row
                    .get::<_, Option<String>>(5)?
                    .as_deref()
                    .and_then(|id| item_nodes.get(id))
                    .map(|index| nodes[*index].id.clone()),
            })
        })? {
            children.push(child?);
        }
        check()?;
        Ok(ConversationTree {
            thread_id: self.thread,
            main_branch_id,
            routes,
            nodes,
            children,
        })
    }
}
