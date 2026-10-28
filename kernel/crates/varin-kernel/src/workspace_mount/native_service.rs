//! FSKit's private executor. All file state remains in the original Session;
//! this protocol carries small metadata and separate binary bodies, not assets
//! or a second Storage database. The resource is scoped to one mount lifetime.
use super::*;
use crate::storage::workspace_metadata::Timestamp;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

struct Item {
    node: Arc<Node>,
    resident: bool,
    opens: usize,
    content: Option<Arc<PrivateFile>>,
}
pub(super) struct Service {
    session: Arc<Session>,
    items: Mutex<HashMap<u64, Item>>,
}
impl Service {
    pub(super) fn new(session: Arc<Session>) -> Result<Self, KernelError> {
        let root = session.lookup("")?;
        Ok(Self {
            session,
            items: Mutex::new(HashMap::from([(
                root.id,
                Item {
                    node: root,
                    resident: true,
                    opens: 0,
                    content: None,
                },
            )])),
        })
    }
    fn node(&self, id: u64) -> Result<Arc<Node>, KernelError> {
        self.session.check_open()?;
        self.items
            .lock()
            .map_err(|_| unsupported("FSKit item registry failed"))?
            .get(&id)
            .map(|item| item.node.clone())
            .ok_or_else(|| KernelError::NotFound("FSKit item".into()))
    }
    fn remember(&self, node: Arc<Node>) -> Result<Value, KernelError> {
        let result = self.attributes(&node)?;
        let mut items = self
            .items
            .lock()
            .map_err(|_| unsupported("FSKit item registry failed"))?;
        items
            .entry(node.id)
            .and_modify(|item| item.resident = true)
            .or_insert(Item {
                node,
                resident: true,
                opens: 0,
                content: None,
            });
        Ok(result)
    }
    fn retire(&self, id: u64) -> Result<(), KernelError> {
        let node = {
            let mut items = self
                .items
                .lock()
                .map_err(|_| unsupported("FSKit item registry failed"))?;
            if id == 1
                || items
                    .get(&id)
                    .is_none_or(|item| item.resident || item.opens != 0)
            {
                return Ok(());
            }
            items.remove(&id).map(|item| item.node)
        };
        if let Some(node) = node {
            self.session.forget_cached(&node)?;
        }
        self.session.notify_native_idle();
        Ok(())
    }
    fn path(&self, parent: u64, name: &str) -> Result<String, KernelError> {
        let name = component(std::ffi::OsStr::new(name))?;
        let parent = self
            .node(parent)?
            .path()?
            .ok_or_else(|| KernelError::NotFound("unlinked directory".into()))?;
        Ok(if parent.is_empty() {
            name.into()
        } else {
            format!("{parent}/{name}")
        })
    }
    fn attributes(&self, node: &Node) -> Result<Value, KernelError> {
        let (kind, size) = match node.state()? {
            PathState::RegularFile { byte_length, .. } => ("file", byte_length),
            PathState::Directory { .. } => ("directory", 0),
            PathState::Symlink { symlink_target, .. } => ("symlink", symlink_target.len() as u64),
            _ => return Err(unsupported("Unsupported FSKit item type")),
        };
        let a = node.attributes()?;
        let parent = match node.path()? {
            Some(path) if !path.is_empty() => {
                self.session
                    .lookup(
                        path.rsplit_once('/')
                            .map(|(parent, _)| parent)
                            .unwrap_or(""),
                    )?
                    .id
            }
            _ => 1,
        };
        Ok(
            json!({"id":node.id,"parent":parent,"kind":kind,"size":size,"links":node.link_count()?,
            "mode":a.mode,"uid":a.uid,"gid":a.gid,"flags":a.bsd_flags,
            "accessed":a.accessed,"modified":a.modified,"changed":a.changed,"created":a.created,"backup":a.backup}),
        )
    }
    fn changes(&self, node: &Arc<Node>, value: &Value) -> Result<(), KernelError> {
        if let Some(size) = value.get("size") {
            self.session.truncate(node, number(size)?)?;
        }
        let mut times = Vec::new();
        for key in ["accessed", "modified", "changed", "created", "backup"] {
            if let Some(value) = value.get(key) {
                let time: Timestamp = serde_json::from_value(value.clone())?;
                time.time()?;
                times.push((key, time));
            }
        }
        let integers = ["mode", "uid", "gid", "flags"]
            .into_iter()
            .map(|key| {
                value
                    .get(key)
                    .map(|v| {
                        u32::try_from(number(v)?)
                            .map(|v| (key, v))
                            .map_err(|_| unsupported("FSKit attribute exceeds u32"))
                    })
                    .transpose()
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.session.set_attributes(node, move |a| {
            for (key, value) in integers.into_iter().flatten() {
                match key {
                    "mode" => a.mode = value & 0o7777,
                    "uid" => a.uid = value,
                    "gid" => a.gid = value,
                    _ => a.bsd_flags = value,
                }
            }
            for (key, time) in times {
                match key {
                    "accessed" => a.accessed = time,
                    "modified" => a.modified = time,
                    "changed" => a.changed = time,
                    "created" => {
                        a.created = time;
                        a.creation_exported = true;
                    }
                    _ => a.backup = Some(time),
                }
            }
            Ok(())
        })
    }
    pub(super) fn dispatch(&self, q: &Value, body: &[u8]) -> Result<(Value, Vec<u8>), KernelError> {
        let op = text(q, "op")?;
        let empty = |value| Ok((value, Vec::new()));
        if op == "sync" {
            self.session.flush_all()?;
            return empty(Value::Null);
        }
        if op == "statfs" {
            let (total, free) = self.session.capacity()?;
            return empty(json!({"total":total,"free":free}));
        }
        if op == "root" {
            return empty(self.remember(self.node(1)?)?);
        }
        if op == "lookup" {
            return empty(
                self.remember(
                    self.session
                        .lookup(&self.path(number(&q["parent"])?, text(q, "name")?)?)?,
                )?,
            );
        }
        if op == "create" {
            let path = self.path(number(&q["parent"])?, text(q, "name")?)?;
            let mode = q["attributes"]["mode"]
                .as_u64()
                .unwrap_or(if q["kind"] == "directory" {
                    0o755
                } else {
                    0o644
                }) as u32;
            let node = match text(q, "kind")? {
                "file" => self.session.create_file(&path, mode)?,
                "directory" => self
                    .session
                    .create(&path, PathState::Directory { mode: Some(mode) })?,
                "symlink" => self.session.create(
                    &path,
                    PathState::Symlink {
                        symlink_target: text(q, "target")?.into(),
                        mode: Some(mode),
                    },
                )?,
                _ => return Err(unsupported("Unsupported FSKit creation type")),
            };
            self.changes(&node, &q["attributes"])?;
            return empty(self.remember(node)?);
        }
        let id = number(&q["id"])?;
        let node = self.node(id)?;
        match op {
            "getattr" => empty(self.attributes(&node)?),
            "setattr" => {
                self.changes(&node, &q["attributes"])?;
                empty(self.attributes(&node)?)
            }
            "open" => {
                let content = matches!(node.state()?, PathState::RegularFile { .. })
                    .then(|| self.session.open_file(&node))
                    .transpose()?;
                let mut items = self
                    .items
                    .lock()
                    .map_err(|_| unsupported("FSKit item registry failed"))?;
                let item = items
                    .get_mut(&id)
                    .ok_or_else(|| KernelError::NotFound("FSKit open item".into()))?;
                // FSKit reports the aggregate mode, not one callback per fd.
                // A read→write upgrade must not invent another lifetime ref.
                item.opens = 1;
                if content.is_some() {
                    item.content = content;
                }
                empty(Value::Null)
            }
            "close" => {
                self.session.flush(&node)?;
                {
                    let mut items = self
                        .items
                        .lock()
                        .map_err(|_| unsupported("FSKit item registry failed"))?;
                    if let Some(item) = items.get_mut(&id) {
                        item.opens = usize::from(q["keepOpen"].as_bool().unwrap_or(false));
                        if item.opens == 0 {
                            item.content.take();
                        }
                    }
                }
                self.retire(id)?;
                empty(Value::Null)
            }
            "reclaim" => {
                if let Some(item) = self
                    .items
                    .lock()
                    .map_err(|_| unsupported("FSKit item registry failed"))?
                    .get_mut(&id)
                {
                    item.resident = false;
                }
                self.retire(id)?;
                empty(Value::Null)
            }
            "read" => {
                let count = usize::try_from(number(&q["length"])?)
                    .map_err(|_| unsupported("Read size exceeds address space"))?;
                if count > crate::protocol::MAX_FRAME_BYTES {
                    return Err(unsupported(
                        "Read exceeds the native content frame; continue in chunks",
                    ));
                }
                let mut data = vec![0; count];
                let count = self.session.read(&node, number(&q["offset"])?, &mut data)?;
                data.truncate(count);
                Ok((Value::Null, data))
            }
            "write" => {
                let (_, count) = self
                    .session
                    .write(&node, Some(number(&q["offset"])?), body)?;
                empty(json!(count))
            }
            "readlink" => match node.state()? {
                PathState::Symlink { symlink_target, .. } => empty(json!(symlink_target)),
                _ => Err(unsupported("Item is not a symbolic link")),
            },
            "link" => {
                let path = self.path(number(&q["parent"])?, text(q, "name")?)?;
                self.session.link(&node, &path)?;
                empty(Value::Null)
            }
            "remove" => {
                let path = self.path(number(&q["parent"])?, text(q, "name")?)?;
                self.session
                    .remove(&path, matches!(node.state()?, PathState::Directory { .. }))?;
                empty(Value::Null)
            }
            "rename" => {
                let from = self.path(number(&q["parent"])?, text(q, "name")?)?;
                let to = self.path(number(&q["toParent"])?, text(q, "toName")?)?;
                self.session
                    .rename(&from, &to, q["replace"].as_bool().unwrap_or(false))?;
                empty(Value::Null)
            }
            "directory" => {
                let path = node
                    .path()?
                    .ok_or_else(|| KernelError::NotFound("unlinked directory".into()))?;
                let page = self.session.directory_after(
                    &path,
                    q["after"].as_str().map(str::to_owned),
                    128,
                )?;
                let mut entries = Vec::new();
                for entry in page.entries {
                    let child = self.session.lookup(&if path.is_empty() {
                        entry.name.clone()
                    } else {
                        format!("{path}/{}", entry.name)
                    })?;
                    entries.push(json!({"name":entry.name,"attributes":self.attributes(&child)?}));
                    self.session.forget_cached(&child)?;
                }
                empty(json!({"revision":page.node,"entries":entries,"next":page.next}))
            }
            "getxattr" => {
                let name = URL_SAFE_NO_PAD.encode(text(q, "name")?.as_bytes());
                let value = node
                    .attributes()?
                    .xattrs
                    .get(&name)
                    .cloned()
                    .ok_or_else(|| {
                        KernelError::Execution(varin_runtime::execution::ExecutionError::new(
                            "namespace_xattr_missing",
                            "Extended attribute does not exist",
                        ))
                    })?;
                Ok((Value::Null, value))
            }
            "listxattrs" => {
                let names = node
                    .attributes()?
                    .xattrs
                    .keys()
                    .map(|key| {
                        URL_SAFE_NO_PAD
                            .decode(key)
                            .map_err(|_| unsupported("Invalid stored xattr name"))
                            .and_then(|v| {
                                String::from_utf8(v).map_err(|_| {
                                    unsupported("Xattr name is not representable by FSKit")
                                })
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                empty(json!(names))
            }
            "setxattr" => {
                let name = URL_SAFE_NO_PAD.encode(text(q, "name")?.as_bytes());
                let present = node.attributes()?.xattrs.contains_key(&name);
                let policy = text(q, "policy")?;
                if (policy == "create" && present)
                    || ((policy == "replace" || policy == "remove") && !present)
                {
                    return Err(KernelError::Execution(
                        varin_runtime::execution::ExecutionError::new(
                            if present {
                                "namespace_xattr_exists"
                            } else {
                                "namespace_xattr_missing"
                            },
                            "Extended attribute policy conflict",
                        ),
                    ));
                }
                let data = body.to_vec();
                let remove = policy == "remove";
                self.session.set_attributes(&node, move |a| {
                    if remove {
                        a.xattrs.remove(&name);
                    } else {
                        a.xattrs.insert(name, data);
                    }
                    Ok(())
                })?;
                empty(Value::Null)
            }
            _ => Err(unsupported("Unknown native filesystem operation")),
        }
    }
}
fn number(value: &Value) -> Result<u64, KernelError> {
    value
        .as_u64()
        .ok_or_else(|| unsupported("Native request requires an unsigned integer"))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, KernelError> {
    value[key]
        .as_str()
        .ok_or_else(|| unsupported("Native request requires a string"))
}

#[cfg(target_os = "macos")]
mod transport;
#[cfg(target_os = "macos")]
pub(super) use transport::Server;
