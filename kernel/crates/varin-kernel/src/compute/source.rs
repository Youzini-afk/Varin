//! Incremental immutable-tree and admitted-directory readers. The cursor lives
//! in the worker: requesting another output page never rescans the whole tree.
use super::{ObjectSource, Result, Shared, Source, Task};
use crate::{model::{PathState, TrieNode}, protocol::{node_hash, object_path}};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest,Sha256};
use std::{collections::{HashMap,HashSet}, fs::{self,File}, io::Read, path::{Path,PathBuf}};

pub(crate) struct SourceMetadata {pub byte_length:u64,pub modified_time_ns:Option<String>}
pub(crate) struct Document {pub path:String,pub revision:String,pub state:PathState,pub bytes:Option<Vec<u8>>,pub metadata:Option<SourceMetadata>}
pub(crate) fn within(path:&str,root:&str)->bool {root.is_empty()||path==root||path.starts_with(&(root.to_string()+"/"))}
pub(crate) fn normalize(value:&str)->Result<String>{
    let value=value.replace('\\',"/");
    if value.contains('\0')||value.starts_with('/')||value.contains(':')||value.split('/').any(|s|s==".."){return Err("Computation path is outside its admitted view".into());}
    Ok(value.split('/').filter(|s|!s.is_empty()&&*s!=".").collect::<Vec<_>>().join("/"))
}
struct CapturedFile {
    bytes: Vec<u8>,
    metadata: SourceMetadata,
    object_hash: String,
    revision: String,
}
fn revision_from_object_hash(hash:&str)->Result<String>{
    let hex=hash.strip_prefix("sha256-").ok_or("Invalid immutable object identity")?;
    let bytes=hex::decode(hex).map_err(|_|"Invalid immutable object identity")?;
    if bytes.len()!=32{return Err("Invalid immutable object identity".into());}
    Ok(format!("d1_{}",URL_SAFE_NO_PAD.encode(bytes)))
}
fn read_capture(mut file:File,expected:Option<&str>,shared:&Shared)->Result<CapturedFile>{
    let before=file.metadata().map_err(|e|e.to_string())?;
    let mut result=Vec::new();let mut buffer=[0u8;65536];let mut digest=Sha256::new();
    loop {shared.check()?;let n=file.read(&mut buffer).map_err(|e|e.to_string())?;if n==0{break;}digest.update(&buffer[..n]);result.extend_from_slice(&buffer[..n]);}
    let after=file.metadata().map_err(|e|e.to_string())?;
    if before.len()!=after.len()||before.modified().ok()!=after.modified().ok()||after.len()!=result.len() as u64{return Err("File changed during native capture; retry the source".into());}
    // One digest of the bytes actually captured supplies both identities. Live
    // files, immutable objects and structure consumers must not rehash the body.
    let digest=digest.finalize();
    let object_hash=format!("sha256-{}",hex::encode(digest));
    if expected.is_some_and(|expected|expected!=object_hash){return Err("Immutable content object hash mismatch".into());}
    let revision=format!("d1_{}",URL_SAFE_NO_PAD.encode(digest));
    let metadata=SourceMetadata{byte_length:after.len(),modified_time_ns:after.modified().ok()
        .and_then(|time|time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time|time.as_nanos().to_string())};
    Ok(CapturedFile{bytes:result,metadata,object_hash,revision})
}
struct TreeReader {conn:Connection}
impl TreeReader {
    fn open(path:&Path)->Result<Self>{Ok(Self{conn:Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e|e.to_string())?})}
    fn node(&self,hash:&str)->Result<TrieNode>{
        let encoded:String=self.conn.query_row("SELECT children_json FROM trie_nodes WHERE hash=?1",[hash],|row|row.get(0)).map_err(|e|e.to_string())?;
        let node:TrieNode=serde_json::from_str(&encoded).map_err(|e|e.to_string())?;
        if node_hash(&node)!=hash{return Err("Immutable tree node hash mismatch".into());}Ok(node)
    }
    fn child(&self,mut hash:String,key:&str)->Result<Option<String>>{
        loop {let TrieNode::Index{key:current,child,left,right,..}=self.node(&hash)? else{return Err("Invalid tree index".into());};
            if current==key{return Ok(Some(child));}let next=if key<current.as_str(){left}else{right};
            match next{Some(next)=>hash=next,None=>return Ok(None)}
        }
    }
    fn path(&self,root:&str,path:&str)->Result<Option<String>>{
        let mut hash=root.to_string();
        for part in path.split('/').filter(|s|!s.is_empty()){
            let TrieNode::Path{state,children}=self.node(&hash)? else{return Err("Invalid tree path node".into());};
            if matches!(state,Some(PathState::Missing|PathState::RegularFile{..}|PathState::Symlink{..}|PathState::Unsupported)){return Ok(None);}
            let Some(children)=children else{return Ok(None);};
            let Some(child)=self.child(children,part)? else{return Ok(None);};hash=child;
        }Ok(Some(hash))
    }
}
fn load_object(source:ObjectSource,content:bool,shared:&Shared)->Result<Document>{
    if let Some(file)=source.file{
        let (bytes,object_hash,length)=if content{
            let captured=read_capture(file,source.hash.as_deref(),shared)?;
            let length=captured.bytes.len() as u64;
            (Some(captured.bytes),captured.object_hash,length)
        }else{(None,source.hash.unwrap_or_default(),0)};
        // Registry drafts retain their supplied revision; their content identity
        // still comes from the verified object bytes, not that opaque revision.
        Ok(Document{path:source.path,revision:source.revision,state:PathState::RegularFile{object_hash,byte_length:length,mode:0o644},bytes,metadata:None})
    }else{Ok(Document{path:source.path,revision:source.revision,state:PathState::Missing,bytes:None,metadata:None})}
}
fn safe_disk_path(root:&Path,path:&Path,scopes:&[String])->Result<PathBuf>{
    let canonical=fs::canonicalize(path).map_err(|e|e.to_string())?;
    let relative=canonical.strip_prefix(root).map_err(|_|"File identity escaped its admitted root")?.to_string_lossy().replace('\\',"/");
    if !scopes.iter().any(|scope|within(&relative,scope)){return Err("File target is outside the granted scope".into());}
    Ok(canonical)
}

/// Baseline inventory is exhaustive, unlike search: ignore files do not filter
/// it, explicit scopes can name hidden state, and unreadable paths fail capture.
/// The traversal stays on a compute worker and streams one inventory across pages.
pub(crate) fn inventory(task: &Task, shared: &Shared) -> Result<bool> {
    let Source::Disk { root } = &task.source else {
        return Err("Workspace inventory requires an admitted directory".into());
    };
    let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if canonical != *root { return Err("Admitted root identity changed before inventory".into()); }
    let mut pending = task.params.paths.clone().unwrap_or_else(|| vec![String::new()]);
    let mut visited = HashSet::new();
    while let Some(path) = pending.pop() {
        shared.check()?;
        let path = normalize(&path)?;
        if !visited.insert(path.clone()) { continue; }
        let allowed = task.scopes.iter().any(|scope| within(&path, scope));
        if !allowed && !task.scopes.iter().any(|scope| within(scope, &path)) { continue; }
        let absolute = root.join(&path);
        let resolved = if path.is_empty() { absolute.clone() } else {
            // Resolve ancestors, preserving a leaf symlink as an inventory entry.
            let parent = match fs::canonicalize(absolute.parent().ok_or("Inventory path has no parent")?) {
                Ok(parent) => parent,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            parent.join(absolute.file_name().ok_or("Inventory path has no filename")?)
        };
        let resolved_path = resolved.strip_prefix(root).map_err(|_| "Inventory path escaped its admitted root")?
            .to_str().ok_or("Filesystem inventory contains a non-UTF-8 path")?.replace('\\', "/");
        if allowed && !task.scopes.iter().any(|scope| within(&resolved_path, scope)) {
            return Err("Inventory path is outside the granted scope".into());
        }
        let metadata = match fs::symlink_metadata(&resolved) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        if allowed && !path.is_empty() {
            shared.emit("entry", &path, "", serde_json::json!({}))?;
        }
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            for entry in fs::read_dir(&resolved).map_err(|e| e.to_string())? {
                shared.check()?;
                let name = entry.map_err(|e| e.to_string())?.file_name().into_string()
                    .map_err(|_| "Filesystem inventory contains a non-UTF-8 path")?;
                if name == ".git" || name == ".varin" { continue; }
                pending.push(if path.is_empty() { name } else { format!("{path}/{name}") });
            }
        }
    }
    Ok(false)
}

/// callback=false is an explicit caller result budget, not a failed enumeration.
pub(crate) fn visit(task:&mut Task,shared:&Shared,mut callback:impl FnMut(Document)->Result<bool>)->Result<bool>{
    let content=task.params.operation!="list"||task.params.include_revisions.unwrap_or(false);
    let roots=task.params.paths.clone().unwrap_or_else(||vec![String::new()]);
    let explicit=task.params.files.as_deref().unwrap_or_default().iter().map(|f|f.path.clone()).collect::<HashSet<_>>();
    let roots=roots.iter().map(|p|normalize(p)).collect::<Result<Vec<_>>>()?;
    let excluded=task.params.exclude_paths.clone().unwrap_or_default().into_iter().map(|p|normalize(&p)).collect::<Result<HashSet<_>>>()?;
    let dirs:HashSet<String>=task.params.exclude_directories.clone().unwrap_or_default().into_iter().collect();
    let scopes=task.scopes.clone();
    let include_hidden=task.params.include_hidden.unwrap_or(false);
    let mut glob_builder=ignore::overrides::OverrideBuilder::new("");
    for glob in task.params.globs.as_deref().unwrap_or_default(){glob_builder.add(glob).map_err(|e|e.to_string())?;}
    let glob=glob_builder.build().map_err(|e|e.to_string())?;
    let eligible=|path:&str,directory:bool|->bool{
        if excluded.iter().any(|p|within(path,p))||(!explicit.is_empty()&&!explicit.contains(path))||!scopes.iter().any(|scope|within(path,scope))||!roots.iter().any(|root|within(path,root)){return false;}
        if path.split('/').any(|s|dirs.contains(s)||(!include_hidden&&s.starts_with('.'))){return false;}
        !glob.matched(path,directory).is_ignore()
    };
    let descend=|path:&str|->bool{
        (explicit.is_empty()||explicit.iter().any(|f|within(f,path)||f==path))&&scopes.iter().any(|s|within(path,s)||within(s,path))&&roots.iter().any(|s|within(path,s)||within(s,path))
            &&!path.split('/').any(|s|dirs.contains(s)||(!include_hidden&&s.starts_with('.')))
    };
    let mut overlays=std::mem::take(&mut task.overlays).into_iter().map(|o|(o.path.clone(),o)).collect::<HashMap<_,_>>();
    let shadowed=overlays.keys().cloned().collect::<HashSet<_>>();
    // Fixed overlays participate before any source candidate budget. Tombstones
    // hide entire subtrees, including children that still exist on parent disk.
    let mut overlay_paths=overlays.keys().cloned().collect::<Vec<_>>();overlay_paths.sort();
    for path in overlay_paths {
        shared.check()?; if !eligible(&path,false) {continue;}
        if shadowed.iter().any(|ancestor|ancestor!=&path&&within(&path,ancestor)){continue;}
        let document=load_object(overlays.remove(&path).unwrap(),content,shared)?;
        if !matches!(document.state,PathState::Missing)&&!callback(document)? {return Ok(false);}
    }
    let mut partial=false;
    match &task.source {
        Source::Objects=>{},
        Source::Tree{catalog,objects,root}=>{
            let reader=TreeReader::open(catalog)?;
            enum Visit {Path(String,String),Index(String,String)}
            let mut stack=Vec::new();let mut seeded=Vec::<String>::new();
            for requested in &roots {
                for scope in &scopes {
                    let prefix=if within(requested,scope){requested}else if within(scope,requested){scope}else{continue;};
                    if seeded.iter().any(|p|within(prefix,p)){continue;}seeded.push(prefix.clone());
                    if let Some(hash)=reader.path(root,prefix)?{stack.push(Visit::Path(hash,prefix.clone()));}
                }
            }
            let mut seen=HashSet::new();
            while let Some(next)=stack.pop(){shared.check()?;match next{
                Visit::Index(hash,prefix)=>{
                    let TrieNode::Index{key,child,left,right,..}=reader.node(&hash)? else{return Err("Invalid immutable index".into());};
                    if let Some(right)=right{stack.push(Visit::Index(right,prefix.clone()));}
                    let path=if prefix.is_empty(){key}else{format!("{prefix}/{key}")};
                    if descend(&path){stack.push(Visit::Path(child,path));}
                    if let Some(left)=left{stack.push(Visit::Index(left,prefix));}
                },
                Visit::Path(hash,path)=>{
                    if !seen.insert(path.clone()){continue;}
                    let TrieNode::Path{state,children}=reader.node(&hash)? else{return Err("Invalid immutable path".into());};
                    let state=state.unwrap_or(PathState::Directory{mode:None});
                    if matches!(state,PathState::Missing){continue;}
                    let directory=state.is_directory();
                    if directory&&descend(&path){if let Some(children)=children{
                        let depth_allowed=!task.params.immediate.unwrap_or(false)||roots.iter().any(|r|path==*r||within(r,&path));
                        if depth_allowed{stack.push(Visit::Index(children,path.clone()));}
                    }}
                    if shadowed.iter().any(|p|within(&path,p))||!eligible(&path,directory){continue;}
                    let (bytes,revision)=match &state{PathState::RegularFile{object_hash,..} if content=>{
                        let file=File::open(object_path(objects,object_hash).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                        let captured=read_capture(file,Some(object_hash),shared)?;
                        (Some(captured.bytes),captured.revision)
                    },_=>{let revision=if let Some(hash)=state.object_hash(){revision_from_object_hash(hash)?}else{root.clone()};(None,revision)}};
                    if !callback(Document{path,revision,state,bytes,metadata:None})?{return Ok(partial);}
                }
            }}
        },
        Source::Disk{root}=>{
            let canonical=fs::canonicalize(root).map_err(|e|e.to_string())?;
            if canonical!=*root {return Err("Admitted root identity changed before native capture".into());}
            let root=canonical;
            // Traverse selected directories independently. A non-Git parent
            // keeps ignore rules active and hands nested repositories to their
            // own Git inventory (including tracked files ignored by patterns).
            let mut selected = HashSet::new();
            let mut walk_starts = Vec::new();
            for prefix in &roots {
                let target = root.join(prefix);
                let directory_prefix = if fs::symlink_metadata(&target).is_ok_and(|m|m.is_dir()) {
                    prefix.clone()
                } else { prefix.rsplit_once('/').map(|(parent,_)|parent.to_string()).unwrap_or_default() };
                if selected.insert(directory_prefix.clone()) { walk_starts.push(directory_prefix); }
            }
            let initial = selected.clone();
            let mut visited = HashSet::new();
            while let Some(prefix) = walk_starts.pop() {
                if !visited.insert(prefix.clone()) { continue; }
                shared.check()?;
                let directory = fs::canonicalize(root.join(&prefix)).map_err(|e|e.to_string())?;
                if !directory.starts_with(&root) { continue; }
                let git_visible = task.params.include_tracked.unwrap_or(false) && task.params.respect_gitignore.unwrap_or(true);
                let exact = if explicit.is_empty() { None } else {
                    Some(explicit.iter().filter(|p|within(p,&prefix)).map(|p| {
                        if prefix.is_empty() { p.clone() } else { p.strip_prefix(&prefix).unwrap_or("").trim_start_matches('/').to_string() }
                    }).collect::<Vec<_>>())
                };
                let inventory = if git_visible { super::inventory::git_inventory(&directory,shared,exact.as_deref())? } else { None };
                if task.params.operation == "list" && task.params.include_tracked.unwrap_or(false) && initial.contains(&prefix) {
                    shared.emit("inventory", &prefix, "", match &inventory {
                        Some(inventory) => serde_json::json!({"strategy":"git-visible","gitRoot":inventory.git_root,
                            "selectedRootIgnored":inventory.selected_root_ignored}),
                        None => serde_json::json!({"strategy":"directory","gitRoot":null}),
                    })?;
                }
                let respect = task.params.respect_gitignore.unwrap_or(true) && inventory.is_none();
                let discover_repositories = git_visible && inventory.is_none();
                let nested = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
                let queued = nested.clone();
                let walk_scopes=scopes.clone();let walk_roots=roots.clone();let walk_dirs=dirs.clone();let walk_root=root.clone();
                let walk_prefix=prefix.clone();
                let mut builder=ignore::WalkBuilder::new(&directory);
                builder.hidden(!include_hidden).follow_links(false).git_ignore(respect).git_global(respect).git_exclude(respect).ignore(respect)
                    .filter_entry(move|entry|{
                        let Ok(path)=entry.path().strip_prefix(&walk_root)else{return false;};let path=path.to_string_lossy().replace('\\',"/");
                        let is_directory=entry.file_type().is_some_and(|t|t.is_dir());
                        if !walk_scopes.iter().any(|s|within(&path,s)||within(s,&path))
                            || !walk_roots.iter().any(|s|within(&path,s)||within(s,&path))
                            || path.split('/').any(|s|walk_dirs.contains(s)) { return false; }
                        let relative = if walk_prefix.is_empty() { path.as_str() } else { path.strip_prefix(&walk_prefix).unwrap_or("").trim_start_matches('/') };
                        if inventory.as_ref().is_some_and(|inventory|!inventory.allows(relative,is_directory)) { return false; }
                        if discover_repositories && is_directory && path != walk_prefix && entry.path().join(".git").exists() {
                            queued.lock().unwrap().push(path);
                            return false;
                        }
                        true
                    });
            for entry in builder.build(){shared.check()?;
                let entry=match entry{Ok(entry)=>entry,Err(_)=>{partial=true;continue;}};
                if entry.error().is_some(){partial=true;}
                let path=entry.path().strip_prefix(&root).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/");
                let Some(kind)=entry.file_type()else{partial=true;continue;};
                if shadowed.iter().any(|p|within(&path,p))||!eligible(&path,kind.is_dir()){continue;}
                if task.params.immediate.unwrap_or(false)&&!roots.iter().any(|r|path==*r||path.rsplit_once('/').map(|(p,_)|p==r).unwrap_or(r.is_empty())){continue;}
                let mut bytes=None;let mut object_hash=String::new();let mut revision=String::new();
                let mut metadata=if task.params.operation=="list"&&kind.is_file(){
                    match fs::symlink_metadata(entry.path()){
                        Ok(metadata) if metadata.is_file()=>Some(SourceMetadata{
                            byte_length:metadata.len(),
                            modified_time_ns:metadata.modified().ok()
                                .and_then(|time|time.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|modified|modified.as_nanos().to_string()),
                        }),
                        Ok(_)=>{partial=true;continue;},
                        Err(error)=>{partial=true;shared.emit("error",&path,"",serde_json::json!({"message":error.to_string()}))?;continue;}
                    }
                }else{None};
                let state=if kind.is_dir(){PathState::Directory{mode:None}}else if kind.is_symlink(){PathState::Symlink{symlink_target:fs::read_link(entry.path()).map_err(|e|e.to_string())?.to_string_lossy().into(),mode:None}}
                else if kind.is_file(){
                    if content {
                        let result: Result<CapturedFile>=(||{let canonical=safe_disk_path(&root,entry.path(),&scopes)?;let b=read_capture(File::open(&canonical).map_err(|e|e.to_string())?,None,shared)?;
                            if fs::canonicalize(entry.path()).map_err(|e|e.to_string())?!=canonical{return Err("File identity changed during native capture".into());}Ok(b)})();
                        match result{Ok(captured)=>{bytes=Some(captured.bytes);metadata=Some(captured.metadata);object_hash=captured.object_hash;revision=captured.revision;},Err(e)=>{shared.check()?;partial=true;shared.emit("error",&path,"",serde_json::json!({"message":e}))?;continue;}}
                    }
                    PathState::RegularFile{object_hash,byte_length:bytes.as_ref().map(|b|b.len() as u64).or_else(||metadata.as_ref().map(|value|value.byte_length)).unwrap_or(0),mode:0o644}
                }else{PathState::Unsupported};
                if !callback(Document{path,revision,state,bytes,metadata})?{return Ok(partial);}
            }
                walk_starts.extend(std::mem::take(&mut *nested.lock().unwrap()));
            }
        }
    }
    Ok(partial)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestFile(PathBuf);
    impl Drop for TestFile {
        fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
    }

    #[test]
    fn capture_keeps_one_verified_identity_for_exact_bytes() {
        let fixture = TestFile(std::env::temp_dir().join(format!("varin-capture-{}", uuid::Uuid::new_v4())));
        fs::write(&fixture.0, b"abc").unwrap();
        let hash = "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let captured = read_capture(File::open(&fixture.0).unwrap(), None, &Shared::new()).unwrap();
        assert_eq!(captured.bytes, b"abc");
        assert_eq!(captured.metadata.byte_length, 3);
        assert_eq!(captured.object_hash, hash);
        assert_eq!(captured.revision, "d1_ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
        assert_eq!(captured.revision, revision_from_object_hash(hash).unwrap());
        let verified = read_capture(File::open(&fixture.0).unwrap(), Some(hash), &Shared::new()).unwrap();
        assert_eq!(verified.object_hash, captured.object_hash);
        assert_eq!(verified.revision, captured.revision);

        fs::write(&fixture.0, b"abd").unwrap();
        let error = read_capture(File::open(&fixture.0).unwrap(), Some(hash), &Shared::new())
            .err().expect("corrupt immutable bytes must remain rejected");
        assert!(error.contains("hash mismatch"), "{error}");
        let cancelled = Shared::new();
        cancelled.cancel();
        assert_eq!(read_capture(File::open(&fixture.0).unwrap(), None, &cancelled).err().unwrap(), "cancelled");
    }
}
