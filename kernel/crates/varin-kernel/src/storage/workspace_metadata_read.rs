//! Read immutable filesystem versions beside Storage, using the same encoded
//! namespace/inode graph. This reader never admits writes or selects a live head.
use super::*;

pub(super) fn read_at(
    head: &Head,
    path: &str,
    state: &PathState,
    mut value: impl FnMut(&[String]) -> Result<Option<Value>, KernelError>,
) -> Result<Metadata, KernelError> {
    let parts = if path.is_empty() || path == "." {
        vec![]
    } else {
        Storage::validate_path(path)?
    };
    let mut origin = Origin {
        namespace: head.namespace,
        prefix: String::new(),
    };
    let (mut origin_depth, mut binding) = (0, None);
    for depth in 0..=parts.len() {
        let mut slot = key(&parts[..depth].join("/"))?;
        slot.push("info".into());
        if let Some(selected) = value(&slot)?
            .map(serde_json::from_value::<Binding>)
            .transpose()?
        {
            if let Some(next) = &selected.origin {
                origin = next.clone();
                origin_depth = depth;
            }
            if depth == parts.len() {
                binding = Some(selected);
            }
        }
    }
    let suffix = parts[origin_depth..].join("/");
    let original = if origin.prefix.is_empty() {
        suffix
    } else if suffix.is_empty() {
        origin.prefix.clone()
    } else {
        format!("{}/{suffix}", origin.prefix)
    };
    let binding = binding.unwrap_or_else(|| Binding {
        file_id: identity(origin.namespace, &original),
        attributes_revision: None,
        origin: state.is_directory().then_some(Origin {
            namespace: origin.namespace,
            prefix: original,
        }),
    });
    let attributes = value(&["inodes".into(), binding.file_id.to_string()])?
        .map(serde_json::from_value::<Attributes>)
        .transpose()?
        .unwrap_or_else(|| defaults(binding.file_id, state, head.created));
    attributes.validate()?;
    if attributes.file_id != binding.file_id {
        return Err(KernelError::Storage(
            "Filesystem inode metadata identity differs from namespace".into(),
        ));
    }
    Ok(Metadata {
        binding,
        attributes,
    })
}

pub(in crate::storage) struct Reader<'a> {
    pub connection: &'a Connection,
    pub cancel: &'a AtomicBool,
}
impl Reader<'_> {
    fn node(&self, hash: &str) -> Result<TrieNode, KernelError> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let encoded: String = self.connection.query_row(
            "SELECT children_json FROM trie_nodes WHERE hash=?1",
            [hash],
            |row| row.get(0),
        )?;
        let node: TrieNode = serde_json::from_str(&encoded)?;
        if node_hash(&node) != hash {
            return Err(KernelError::Storage(
                "Corrupt immutable filesystem node".into(),
            ));
        }
        Ok(node)
    }
    fn path_node(&self, root: &str, path: &[String]) -> Result<Option<TrieNode>, KernelError> {
        let mut node = self.node(root)?;
        for name in path {
            let TrieNode::Path { children, .. } = node else {
                return Err(KernelError::Storage(
                    "Filesystem path points to an index".into(),
                ));
            };
            let mut index = children;
            let mut selected = None;
            while let Some(hash) = index {
                let TrieNode::Index {
                    key,
                    child,
                    left,
                    right,
                    ..
                } = self.node(&hash)?
                else {
                    return Err(KernelError::Storage(
                        "Filesystem index points to a path".into(),
                    ));
                };
                match name.cmp(&key) {
                    std::cmp::Ordering::Equal => {
                        selected = Some(child);
                        break;
                    }
                    std::cmp::Ordering::Less => index = left,
                    std::cmp::Ordering::Greater => index = right,
                }
            }
            let Some(hash) = selected else {
                return Ok(None);
            };
            node = self.node(&hash)?;
        }
        Ok(Some(node))
    }
    pub fn state(&self, root: &str, path: &str) -> Result<PathState, KernelError> {
        let parts = if path.is_empty() || path == "." {
            vec![]
        } else {
            Storage::validate_path(path)?
        };
        match self.path_node(root, &parts)? {
            None => Ok(PathState::Missing),
            Some(TrieNode::Path { state, .. }) => {
                Ok(state.unwrap_or_else(|| PathState::Directory { mode: None }))
            }
            _ => Err(KernelError::Storage(
                "Filesystem path points to an index".into(),
            )),
        }
    }
    fn value<T: serde::de::DeserializeOwned>(
        &self,
        root: &str,
        path: &[String],
    ) -> Result<Option<T>, KernelError> {
        let Some(node) = self.path_node(root, path)? else {
            return Ok(None);
        };
        let TrieNode::Path {
            state: Some(PathState::Directory { .. }),
            children: Some(index),
        } = node
        else {
            return Err(KernelError::Storage(
                "Invalid filesystem metadata leaf".into(),
            ));
        };
        let TrieNode::Index {
            key,
            left: None,
            right: None,
            ..
        } = self.node(&index)?
        else {
            return Err(KernelError::Storage(
                "Filesystem metadata leaf has ambiguous payload".into(),
            ));
        };
        let bytes = URL_SAFE_NO_PAD
            .decode(key.strip_prefix("v1-").ok_or_else(|| {
                KernelError::Storage("Unsupported filesystem metadata encoding".into())
            })?)
            .map_err(|_| KernelError::Storage("Invalid filesystem metadata payload".into()))?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
    pub fn metadata(
        &self,
        head: &Head,
        root: &str,
        path: &str,
        state: &PathState,
    ) -> Result<Metadata, KernelError> {
        read_at(head, path, state, |slot| self.value(root, slot))
    }
    pub fn links(
        &self,
        head: &Head,
        root: &str,
        id: Uuid,
        fallback: &str,
    ) -> Result<Vec<String>, KernelError> {
        let Some(group) = self.value::<LinkSet>(root, &["links".into(), id.to_string()])? else {
            return Ok(vec![fallback.into()]);
        };
        let mut paths = Vec::new();
        for entry in group.entries {
            let (mut directory, mut parts, mut seen) =
                (entry.directory, Vec::new(), BTreeSet::new());
            loop {
                if directory == head.namespace {
                    parts.reverse();
                    parts.push(entry.name);
                    paths.push(parts.join("/"));
                    break;
                }
                if head.outside_namespaces.contains(&directory) {
                    break;
                }
                if !seen.insert(directory) {
                    return Err(KernelError::Storage(
                        "Filesystem directory identity cycle".into(),
                    ));
                }
                let name = self
                    .value::<DirectoryName>(root, &["directories".into(), directory.to_string()])?
                    .ok_or_else(|| {
                        KernelError::Storage("Filesystem directory identity is missing".into())
                    })?;
                parts.push(name.name);
                directory = name.parent;
            }
        }
        Ok(paths)
    }
}

/// Diff path leaves carry an inode attribute digest. Metadata payload keys and
/// internal inode/link identities never become product paths or exported data.
pub(in crate::storage) fn changed_paths(
    difference: &super::super::tree_diff::Difference,
) -> BTreeSet<String> {
    difference
        .paths
        .keys()
        .filter_map(|value| {
            let parts = value.split('/').collect::<Vec<_>>();
            if parts.first() != Some(&"namespace") {
                return None;
            }
            let mut path = Vec::new();
            let mut i = 1;
            while parts.get(i) == Some(&"children") {
                path.push(*parts.get(i + 1)?);
                i += 2;
            }
            (parts.get(i) == Some(&"info")).then(|| path.join("/"))
        })
        .collect()
}
