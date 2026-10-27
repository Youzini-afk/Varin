//! Compare retained immutable trees on a read worker. Equal path/index hashes
//! are skipped as whole subtrees, including unchanged siblings after AVL edits.
use super::*;

pub(super) struct Difference {
    pub paths: BTreeMap<String, (Option<PathState>, Option<PathState>)>,
    #[cfg(test)]
    pub nodes_read: usize,
}
struct Reader<'a> {
    db: Connection,
    cancel: &'a AtomicBool,
    #[cfg(test)]
    nodes_read: usize,
}
impl Reader<'_> {
    fn check(&self) -> Result<(), KernelError> {
        if self.cancel.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    }
    fn node(&mut self, hash: &str) -> Result<TrieNode, KernelError> {
        self.check()?;
        #[cfg(test)]
        {
            self.nodes_read += 1;
        }
        let encoded: String = self.db.query_row(
            "SELECT children_json FROM trie_nodes WHERE hash=?1",
            [hash],
            |row| row.get(0),
        )?;
        let node = serde_json::from_str(&encoded)?;
        if node_hash(&node) != hash {
            return Err(KernelError::Storage(format!(
                "Corrupt immutable tree node {hash}"
            )));
        }
        Ok(node)
    }
    fn path(
        &mut self,
        hash: Option<&str>,
    ) -> Result<(Option<PathState>, Option<String>), KernelError> {
        match hash.map(|hash| self.node(hash)).transpose()? {
            None => Ok((None, None)),
            Some(TrieNode::Path { state, children }) => Ok((state, children)),
            _ => Err(KernelError::Storage(
                "Immutable path points to an index".into(),
            )),
        }
    }
}
#[derive(Clone)]
struct Index {
    key: String,
    child: String,
    left: Option<String>,
    right: Option<String>,
    height: u16,
}
#[derive(Clone)]
enum Step {
    Tree(String, Option<Index>),
    Item(String, String),
}
struct Cursor(Vec<Step>);
impl Cursor {
    fn new(root: Option<String>) -> Self {
        Self(
            root.into_iter()
                .map(|root| Step::Tree(root, None))
                .collect(),
        )
    }
    fn height(&mut self, reader: &mut Reader<'_>) -> Result<u16, KernelError> {
        let Some(Step::Tree(hash, loaded)) = self.0.last_mut() else {
            return Ok(0);
        };
        if loaded.is_none() {
            let TrieNode::Index {
                key,
                child,
                left,
                right,
                height,
            } = reader.node(hash)?
            else {
                return Err(KernelError::Storage(
                    "Immutable directory index points to a path".into(),
                ));
            };
            // Every key is one actual path component, never an encoded path.
            let checked = Storage::validate_path(&key)?;
            if checked.len() != 1 || checked[0] != key {
                return Err(KernelError::Storage(
                    "Invalid immutable directory key".into(),
                ));
            }
            *loaded = Some(Index {
                key,
                child,
                left,
                right,
                height,
            });
        }
        Ok(loaded.as_ref().unwrap().height)
    }
    fn expand(&mut self, reader: &mut Reader<'_>) -> Result<(), KernelError> {
        self.height(reader)?;
        let Some(Step::Tree(_, Some(index))) = self.0.pop() else {
            unreachable!("tree cursor expansion");
        };
        if let Some(right) = index.right {
            self.0.push(Step::Tree(right, None));
        }
        self.0.push(Step::Item(index.key, index.child));
        if let Some(left) = index.left {
            self.0.push(Step::Tree(left, None));
        }
        Ok(())
    }
}
pub(super) fn compare(
    database: &Path,
    base: &str,
    current: &str,
    cancel: &AtomicBool,
) -> Result<Difference, KernelError> {
    compare_trees(database,base,current,cancel,false)
}
pub(super) fn compare_metadata(database:&Path,base:&str,current:&str,cancel:&AtomicBool)->Result<Difference,KernelError>{
    compare_trees(database,base,current,cancel,true)
}
fn compare_trees(database:&Path,base:&str,current:&str,cancel:&AtomicBool,structural:bool)->Result<Difference,KernelError>{
    let mut reader = Reader {
        db: Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?,
        cancel,
        #[cfg(test)]
        nodes_read: 0,
    };
    let mut pending = vec![(
        String::new(),
        Some(base.to_owned()),
        Some(current.to_owned()),
    )];
    let mut paths = BTreeMap::new();
    while let Some((path, before, after)) = pending.pop() {
        reader.check()?;
        if before == after {
            continue;
        }
        let (old_state, old_children) = reader.path(before.as_deref())?;
        let (new_state, new_children) = reader.path(after.as_deref())?;
        if old_state != new_state || structural && before.is_none()!=after.is_none() {
            paths.insert(path.clone(), (old_state, new_state));
        }
        let (mut left, mut right) = (Cursor::new(old_children), Cursor::new(new_children));
        loop {
            reader.check()?;
            let (a, b) = (left.0.last().cloned(), right.0.last().cloned());
            let pair = match (a, b) {
                (None, None) => break,
                (Some(Step::Tree(a, _)), Some(Step::Tree(b, _))) if a == b => {
                    left.0.pop();
                    right.0.pop();
                    continue;
                }
                (Some(Step::Tree(..)), Some(Step::Tree(..))) => {
                    let (a, b) = (left.height(&mut reader)?, right.height(&mut reader)?);
                    if a >= b {
                        left.expand(&mut reader)?;
                    }
                    if b >= a {
                        right.expand(&mut reader)?;
                    }
                    continue;
                }
                (Some(Step::Tree(..)), _) => {
                    left.expand(&mut reader)?;
                    continue;
                }
                (_, Some(Step::Tree(..))) => {
                    right.expand(&mut reader)?;
                    continue;
                }
                (Some(Step::Item(a, old)), Some(Step::Item(b, new))) => match a.cmp(&b) {
                    std::cmp::Ordering::Equal => {
                        left.0.pop();
                        right.0.pop();
                        (a, Some(old), Some(new))
                    }
                    std::cmp::Ordering::Less => {
                        left.0.pop();
                        (a, Some(old), None)
                    }
                    std::cmp::Ordering::Greater => {
                        right.0.pop();
                        (b, None, Some(new))
                    }
                },
                (Some(Step::Item(key, old)), None) => {
                    left.0.pop();
                    (key, Some(old), None)
                }
                (None, Some(Step::Item(key, new))) => {
                    right.0.pop();
                    (key, None, Some(new))
                }
            };
            let name = if path.is_empty() {
                pair.0
            } else {
                format!("{path}/{}", pair.0)
            };
            pending.push((name, pair.1, pair.2));
        }
    }
    Ok(Difference {
        paths,
        #[cfg(test)]
        nodes_read: reader.nodes_read,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_tree_difference_skips_shared_siblings_and_matches_namespace_changes() {
        let root = std::env::temp_dir().join(format!("workspace-tree-diff-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&root, "host").unwrap();
        let entries = (0..4096)
            .map(|n| {
                (
                    vec![format!("item-{n:05}")],
                    PathState::Directory { mode: Some(0o755) },
                )
            })
            .collect::<Vec<_>>();
        let base = storage
            .filesystem_transaction(|s| s.build_root(&entries))
            .unwrap();
        let changed = storage
            .root_apply(
                &base,
                &[(
                    vec!["item-02048".into()],
                    PathState::Directory { mode: Some(0o700) },
                )],
            )
            .unwrap();
        let difference = compare(
            &root.join("catalog.sqlite"),
            &base,
            &changed,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(difference.paths.len(), 1);
        assert!(difference.paths.contains_key("item-02048"));
        assert!(
            difference.nodes_read < 100,
            "a one-path edit traversed {} nodes in a 4096-entry directory",
            difference.nodes_read
        );
        let changed = storage
            .root_apply(
                &changed,
                &[
                    (vec!["item-00000".into()], PathState::Missing),
                    (
                        vec!["item-04096".into()],
                        PathState::Directory { mode: None },
                    ),
                    (
                        vec!["nested".into(), "new".into()],
                        PathState::Directory { mode: Some(0o750) },
                    ),
                ],
            )
            .unwrap();
        let difference = compare(
            &root.join("catalog.sqlite"),
            &base,
            &changed,
            &AtomicBool::new(false),
        )
        .unwrap();
        let before = storage
            .root_entries(&base)
            .unwrap()
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        let after = storage
            .root_entries(&changed)
            .unwrap()
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        let expected = before
            .keys()
            .chain(after.keys())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|path| before.get(path) != after.get(path))
            .map(|path| {
                let values = (before.get(&path).cloned(), after.get(&path).cloned());
                (path, values)
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(difference.paths, expected);
        assert!(compare(
            &root.join("catalog.sqlite"),
            &base,
            &changed,
            &AtomicBool::new(true)
        )
        .is_err());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
