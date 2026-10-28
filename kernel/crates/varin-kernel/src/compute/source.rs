//! Incremental immutable-tree and admitted-directory readers. The cursor lives
//! in the worker: requesting another output page never rescans the whole tree.
use super::{ObjectSource, Result, Shared, Source, Task};
use crate::{model::{PathState, TrieNode}, protocol::{node_hash, object_path}};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest,Sha256};
use std::{collections::{HashMap,HashSet,VecDeque}, fs::{self,File}, io::{Read,Seek,SeekFrom}, path::{Path,PathBuf}};

enum TreeVisit {Path(String,String),Index(String,String)}
#[derive(Default)]
struct TreeTraversal {
    initialized: bool,
    roots: VecDeque<Vec<TreeVisit>>,
}
struct DiskWalk {
    walk: ignore::Walk,
    nested: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}
#[derive(Default)]
struct DiskTraversal {
    initialized: bool,
    pending: Vec<String>,
    initial: HashSet<String>,
    visited: HashSet<String>,
    walks: VecDeque<DiskWalk>,
    ignore_errors: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
/// Listings retain their actual iterators across output pages. Each selected root
/// gets a turn before a busy sibling contributes another entry. The compute job
/// still owns one record cursor, one reader pin and the original cancellation.
#[derive(Default)]
pub(crate) struct Traversal {
    tree: TreeTraversal,
    disk: DiskTraversal,
    overlays: VecDeque<ObjectSource>,
    shadowed: HashSet<String>,
    partial: bool,
}

pub(crate) struct SourceMetadata {pub byte_length:u64,pub modified_time_ns:Option<String>}
pub(crate) struct Document {pub path:String,pub revision:String,pub state:PathState,pub bytes:Option<Vec<u8>>,pub metadata:Option<SourceMetadata>}
pub(crate) fn within(path:&str,root:&str)->bool {root.is_empty()||path.strip_prefix(root).is_some_and(|tail|tail.is_empty()||tail.starts_with('/'))}
fn relative_to<'a>(path:&'a str,root:&str)->&'a str {
    if root.is_empty(){path}else{path.strip_prefix(root).unwrap_or(path).trim_start_matches('/')}
}
fn selection_relative<'a>(path:&'a str,selections:&[String])->&'a str {
    let selected=selections.iter().filter(|root|within(path,root)).max_by_key(|root|root.len());
    selected.map_or(path,|root|relative_to(path,root))
}
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
    let hash=hash.strip_prefix("ranges-").unwrap_or(hash);
    let hex=hash.strip_prefix("sha256-").ok_or("Invalid immutable object identity")?;
    let bytes=hex::decode(hex).map_err(|_|"Invalid immutable object identity")?;
    if bytes.len()!=32{return Err("Invalid immutable object identity".into());}
    Ok(format!("d1_{}",URL_SAFE_NO_PAD.encode(bytes)))
}
fn read_capture(mut file:File,expected:Option<&str>,shared:&Shared)->Result<CapturedFile>{
    let before=file.metadata().map_err(|e|e.to_string())?;
    let mut result=Vec::new();let mut buffer=[0u8;65536];let mut digest=Sha256::new();
    shared.check()?;
    // Capture needs the exact bytes, but allocation failure must fail this read,
    // not abort the process that also owns conversations and tool execution.
    let length=usize::try_from(before.len()).map_err(|_|"File length exceeds addressable memory")?;
    reserve_capture(&mut result,length)?;
    loop {shared.check()?;let n=file.read(&mut buffer).map_err(|e|e.to_string())?;if n==0{break;}
        reserve_capture(&mut result,n)?;digest.update(&buffer[..n]);result.extend_from_slice(&buffer[..n]);}
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
fn reserve_capture(bytes:&mut Vec<u8>,additional:usize)->Result<()> {
    bytes.try_reserve_exact(additional).map_err(|_|"Insufficient memory to capture the file; retry when memory is available".to_string())
}
fn search_capture(mut file:File,shared:&Shared)->Result<Option<CapturedFile>> {
    shared.check()?;
    let mut prefix=[0u8;8192];
    let count=file.read(&mut prefix).map_err(|e|e.to_string())?;
    let prefix=&prefix[..count];
    if prefix.contains(&0) || std::str::from_utf8(prefix).is_err_and(|error|error.error_len().is_some()) {return Ok(None);}
    file.seek(SeekFrom::Start(0)).map_err(|e|e.to_string())?;
    read_capture(file,None,shared).map(Some)
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
    if let Some((root,length,_retention))=source.range {
        let object_hash=source.hash.ok_or("Immutable file version identity is missing")?;
        let bytes=if content{Some(crate::storage::file_content::read_all(&root,&object_hash,length,&shared.cancelled).map_err(|error|error.to_string())?)}else{None};
        return Ok(Document{path:source.path,revision:source.revision,state:PathState::RegularFile{object_hash,byte_length:length,mode:0o644},bytes,metadata:None});
    }
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
    let immediate=task.params.immediate.unwrap_or(false);
    let roots=task.params.paths.clone().unwrap_or_else(||vec![String::new()]);
    let explicit=task.params.files.as_deref().unwrap_or_default().iter().map(|f|f.path.clone()).collect::<HashSet<_>>();
    let mut roots=roots.iter().map(|p|normalize(p)).collect::<Result<Vec<_>>>()?;
    roots.sort_by(|a,b|a.split('/').cmp(b.split('/')));
    roots.dedup();
    let selections=roots.clone();
    let mut minimal_roots=Vec::<String>::new();
    for path in roots { if !minimal_roots.iter().any(|parent|within(&path,parent)){minimal_roots.push(path);} }
    let roots=minimal_roots.into_iter().rev().collect::<Vec<_>>();
    let excluded=task.params.exclude_paths.clone().unwrap_or_default().into_iter().map(|p|normalize(&p)).collect::<Result<HashSet<_>>>()?;
    let dirs:HashSet<String>=task.params.exclude_directories.clone().unwrap_or_default().into_iter().collect();
    let scopes=task.scopes.clone();
    let include_hidden=task.params.include_hidden.unwrap_or(false);
    let mut glob_builder=ignore::overrides::OverrideBuilder::new("");
    for glob in task.params.globs.as_deref().unwrap_or_default(){glob_builder.add(glob).map_err(|e|e.to_string())?;}
    let glob=glob_builder.build().map_err(|e|e.to_string())?;
    let eligible=|path:&str,directory:bool|->bool{
        if task.params.start_after_path.as_deref().is_some_and(|after| {
            let order = path.split('/').cmp(after.split('/'));
            order == std::cmp::Ordering::Less || (order == std::cmp::Ordering::Equal && task.params.start_after_line.is_none())
        }) { return false; }
        if excluded.iter().any(|p|within(path,p))||(!explicit.is_empty()&&!explicit.contains(path))||!scopes.iter().any(|scope|within(path,scope))||!roots.iter().any(|root|within(path,root)){return false;}
        if immediate&&!selections.iter().any(|root|path==root||path.rsplit_once('/').map(|(parent,_)|parent==root).unwrap_or(root.is_empty())){return false;}
        if selection_relative(path,&selections).split('/').any(|s|dirs.contains(s)||(!include_hidden&&s.starts_with('.'))){return false;}
        let matched = glob.matched(path,directory);
        // ignore's directory exemption keeps walkers descending. Traversal is
        // already separate here; records must actually match a positive glob.
        !matched.is_ignore() && (!directory || glob.num_whitelists() == 0 || matched.is_whitelist())
    };
    let descend=|path:&str|->bool{
        if task.params.start_after_path.as_deref().is_some_and(|after|path.split('/').cmp(after.split('/'))==std::cmp::Ordering::Less && !within(after,path)) {return false;}
        (explicit.is_empty()||explicit.iter().any(|f|within(f,path)||f==path))&&scopes.iter().any(|s|within(path,s)||within(s,path))&&roots.iter().any(|s|within(path,s)||within(s,path))
            &&(selections.iter().any(|root|within(root,path))||!selection_relative(path,&selections).split('/').any(|s|dirs.contains(s)||(!include_hidden&&s.starts_with('.'))))
    };
    let listing=task.params.operation=="list";
    let mut traversal=task.traversal.take().unwrap_or_else(|| {
        let mut overlays=std::mem::take(&mut task.overlays).into_iter().map(|o|(o.path.clone(),o)).collect::<HashMap<_,_>>();
        let mut paths=overlays.keys().cloned().collect::<Vec<_>>();paths.sort();
        Traversal {shadowed:paths.iter().cloned().collect(),overlays:paths.into_iter().map(|path|overlays.remove(&path).unwrap()).collect(),..Default::default()}
    });
    let shadowed=traversal.shadowed.clone();
    let result=(|| {
    // Fixed overlays participate before any source candidate budget. Tombstones
    // hide entire subtrees, including children that still exist on parent disk.
    while let Some(overlay)=traversal.overlays.pop_front() {
        let path=overlay.path.clone();
        shared.check()?; if !eligible(&path,false) {continue;}
        if shadowed.iter().any(|ancestor|ancestor!=&path&&within(&path,ancestor)){continue;}
        let document=load_object(overlay,content,shared)?;
        if !matches!(document.state,PathState::Missing)&&!callback(document)? {return Ok(false);}
    }
    let mut partial=traversal.partial;
    match &task.source {
        Source::Objects=>{},
        Source::Tree{catalog,objects,root}=>{
            let reader=TreeReader::open(catalog)?;
            let tree=&mut traversal.tree;
            if !tree.initialized {
                let mut prefixes=roots.iter().flat_map(|requested|scopes.iter().filter_map(|scope| {
                    if within(requested,scope){Some(requested.clone())}else if within(scope,requested){Some(scope.clone())}else{None}
                })).collect::<Vec<_>>();
                prefixes.sort_by(|a,b|a.split('/').cmp(b.split('/')));
                let mut seeded=Vec::<String>::new();
                for prefix in &prefixes {
                    // Disjoint roots avoid retaining a set of every emitted path
                    // for the entire paginated listing, including long listings.
                    if seeded.iter().any(|parent|within(prefix,parent)){continue;}seeded.push(prefix.clone());
                    if let Some(hash)=reader.path(root,prefix)?{tree.roots.push_back(vec![TreeVisit::Path(hash,prefix.clone())]);}
                    else if !shadowed.iter().any(|p|within(p,prefix)||within(prefix,p)) {
                        if !matches!(task.params.operation.as_str(),"list"|"search") || selections.len()==1 {return Err(format!("Discovery path does not exist: {prefix}"));}
                        partial=true;shared.emit("error",prefix,"",serde_json::json!({"status":"missing","message":"Discovery path does not exist"}))?;
                    }
                }
                tree.initialized=true;
                traversal.partial=partial;
            }
            while !tree.roots.is_empty(){shared.check()?;if shared.page_full(){return Ok(partial);}
                let stack=tree.roots.front_mut().unwrap();
                let Some(next)=stack.pop() else {tree.roots.pop_front();continue;};
                match next{
                TreeVisit::Index(hash,prefix)=>{
                    let TrieNode::Index{key,child,left,right,..}=reader.node(&hash)? else{return Err("Invalid immutable index".into());};
                    if let Some(right)=right{stack.push(TreeVisit::Index(right,prefix.clone()));}
                    let path=if prefix.is_empty(){key}else{format!("{prefix}/{key}")};
                    if descend(&path){stack.push(TreeVisit::Path(child,path));}
                    if let Some(left)=left{stack.push(TreeVisit::Index(left,prefix));}
                },
                TreeVisit::Path(hash,path)=>{
                    let TrieNode::Path{state,children}=reader.node(&hash)? else{return Err("Invalid immutable path".into());};
                    let state=state.unwrap_or(PathState::Directory{mode:None});
                    if matches!(state,PathState::Missing){continue;}
                    let directory=state.is_directory();
                    if directory&&descend(&path){if let Some(children)=children{
                        let depth_allowed=!immediate||selections.iter().any(|r|path==*r||within(r,&path));
                        if depth_allowed{stack.push(TreeVisit::Index(children,path.clone()));}
                    }}
                    if listing {tree.roots.rotate_left(1);}
                    if shadowed.iter().any(|p|within(&path,p))||!eligible(&path,directory){continue;}
                    let (bytes,revision)=match &state{PathState::RegularFile{object_hash,byte_length,..} if content=>{
                        if crate::storage::file_content::is_range(object_hash) {
                            let bytes=crate::storage::file_content::read_all(objects,object_hash,*byte_length,&shared.cancelled).map_err(|e|e.to_string())?;
                            (Some(bytes),revision_from_object_hash(object_hash)?)
                        } else {
                            let file=File::open(object_path(objects,object_hash).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                            let captured=read_capture(file,Some(object_hash),shared)?;
                            (Some(captured.bytes),captured.revision)
                        }
                    },_=>{let revision=if let Some(hash)=state.object_hash(){revision_from_object_hash(hash)?}else{root.clone()};(None,revision)}};
                    let more=callback(Document{path,revision,state,bytes,metadata:None})?;
                    if !more{return Ok(partial);}
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
            let disk=&mut traversal.disk;
            if !disk.initialized {
            let mut selected = HashSet::new();
            for prefix in &roots {
                let target = root.join(prefix);
                let metadata = match fs::symlink_metadata(&target) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        if shadowed.iter().any(|p|within(p,prefix)||within(prefix,p)) { continue; }
                        if !matches!(task.params.operation.as_str(),"list"|"search") || selections.len()==1 {return Err(format!("Discovery path does not exist: {prefix}"));}
                        partial=true;shared.emit("error",prefix,"",serde_json::json!({"status":"missing","message":"Discovery path does not exist"}))?;continue;
                    },
                    Err(error) => {
                        if !matches!(task.params.operation.as_str(),"list"|"search") || selections.len()==1 {return Err(format!("Cannot inspect discovery path {prefix}: {error}"));}
                        partial=true;shared.emit("error",prefix,"",serde_json::json!({"status":"unreadable","message":error.to_string()}))?;continue;
                    },
                };
                let directory_prefix = if metadata.is_dir()||(!task.params.include_tracked.unwrap_or(false)&&!metadata.file_type().is_symlink()) {
                    prefix.clone()
                } else { prefix.rsplit_once('/').map(|(parent,_)|parent.to_string()).unwrap_or_default() };
                if selected.insert(directory_prefix.clone()) { disk.pending.push(directory_prefix); }
            }
            disk.initial=selected;
            disk.initialized=true;
            traversal.partial=partial;
            }
            let mut ignore_matchers=None;
            let ignore_errors=disk.ignore_errors.clone();
            while !disk.pending.is_empty() || !disk.walks.is_empty() {
                // Build one iterator per selected root for listings. Other source
                // consumers retain their depth-first order and line checkpoints.
                while disk.walks.is_empty() || listing {
                let Some(prefix)=disk.pending.pop() else {break;};
                if !disk.visited.insert(prefix.clone()) { continue; }
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
                if task.params.operation == "list" && task.params.include_tracked.unwrap_or(false) && disk.initial.contains(&prefix) {
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
                let walk_selections=selections.clone();
                let walk_prefix=prefix.clone();
                let walk_after=task.params.start_after_path.clone();
                let walk_ignore_errors=ignore_errors.clone();
                // Explicit paths are search roots, including ignored directories. Compile
                // ignore rules once per selected root; the traversal reuses these matchers.
                if respect&&ignore_matchers.is_none() {
                    let mut probe=ignore::WalkBuilder::new(&root).hidden(false).build_matchers().remove(0);
                    let mut matchers=Vec::new();
                    for selected in &selections {
                        let target=root.join(selected);
                        let ignored=if selected.is_empty(){false}else{
                            let (matched,error)=probe.matched_with_errors(selected,true);
                            partial|=error.is_some();matched.is_ignore()
                        };
                        if !ignored {continue;}
                        let mut rules=ignore::WalkBuilder::new(&target);
                        rules.hidden(false).parents(false).git_global(false).git_exclude(false).require_git(false);
                        matchers.push((selected.clone(),rules.build_matchers().remove(0)));
                    }
                    matchers.push((String::new(),probe));
                    matchers.sort_by_key(|(selected,_)|std::cmp::Reverse(selected.len()));
                    ignore_matchers=Some(std::sync::Arc::new(std::sync::Mutex::new(matchers)));
                }
                let matchers=if respect{ignore_matchers.clone()}else{None};
                let mut builder=ignore::WalkBuilder::new(&directory);
                if immediate&&selections.len()==roots.len() { builder.max_depth(Some(1)); }
                builder.sort_by_file_name(|a,b|a.cmp(b)).standard_filters(false).follow_links(false)
                    .filter_entry(move|entry|{
                        let Ok(path)=entry.path().strip_prefix(&walk_root)else{return false;};let path=path.to_string_lossy().replace('\\',"/");
                        let is_directory=entry.file_type().is_some_and(|t|t.is_dir());
                        if is_directory && walk_after.as_deref().is_some_and(|after|path.split('/').cmp(after.split('/'))==std::cmp::Ordering::Less && !within(after,&path)) {return false;}
                        if !walk_scopes.iter().any(|s|within(&path,s)||within(s,&path))
                            || !walk_roots.iter().any(|s|within(&path,s)||within(s,&path)) { return false; }
                        let leads_to_selection=walk_selections.iter().any(|selected|within(selected,&path));
                        let selected_relative=selection_relative(&path,&walk_selections);
                        if !leads_to_selection {
                            if selected_relative.split('/').any(|s|walk_dirs.contains(s)||(!include_hidden&&s.starts_with('.')))
                                || (immediate&&selected_relative.contains('/')) {return false;}
                            if let Some(matchers)=&matchers {
                                let mut matchers=matchers.lock().unwrap();
                                if let Some((selected,matcher))=matchers.iter_mut().find(|(selected,_)|within(&path,selected)) {
                                    let (matched,error)=matcher.matched_with_errors(relative_to(&path,selected),is_directory);
                                    if error.is_some(){walk_ignore_errors.store(true,std::sync::atomic::Ordering::Relaxed);}
                                    if matched.is_ignore(){return false;}
                                }
                            }
                        }
                        let relative = if walk_prefix.is_empty() { path.as_str() } else { path.strip_prefix(&walk_prefix).unwrap_or("").trim_start_matches('/') };
                        if inventory.as_ref().is_some_and(|inventory|!inventory.allows(relative,is_directory)) { return false; }
                        if discover_repositories && is_directory && path != walk_prefix && entry.path().join(".git").exists() {
                            queued.lock().unwrap().push(path);
                            return false;
                        }
                        true
                    });
                disk.walks.push_back(DiskWalk{walk:builder.build(),nested});
                }
                shared.check()?;if shared.page_full(){return Ok(partial||ignore_errors.load(std::sync::atomic::Ordering::Relaxed));}
                let Some(walk)=disk.walks.front_mut() else {continue;};
                let Some(entry)=walk.walk.next() else {
                    let finished=disk.walks.pop_front().unwrap();
                    disk.pending.extend(std::mem::take(&mut *finished.nested.lock().unwrap()));
                    continue;
                };
                if listing {disk.walks.rotate_left(1);}
                let entry=match entry{Ok(entry)=>entry,Err(_)=>{partial=true;continue;}};
                if entry.error().is_some(){partial=true;}
                let path=entry.path().strip_prefix(&root).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/");
                let Some(kind)=entry.file_type()else{partial=true;continue;};
                if shadowed.iter().any(|p|within(&path,p))||!eligible(&path,kind.is_dir()){continue;}
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
                        let result: Result<Option<CapturedFile>>=(||{let canonical=safe_disk_path(&root,entry.path(),&scopes)?;let file=File::open(&canonical).map_err(|e|e.to_string())?;
                            let b=if task.params.operation=="search"{search_capture(file,shared)?}else{Some(read_capture(file,None,shared)?)};
                            if fs::canonicalize(entry.path()).map_err(|e|e.to_string())?!=canonical{return Err("File identity changed during native capture".into());}Ok(b)})();
                        match result{Ok(Some(captured))=>{bytes=Some(captured.bytes);metadata=Some(captured.metadata);object_hash=captured.object_hash;revision=captured.revision;},Ok(None)=>continue,Err(e)=>{shared.check()?;partial=true;shared.emit("error",&path,"",serde_json::json!({"message":e}))?;continue;}}
                    }
                    PathState::RegularFile{object_hash,byte_length:bytes.as_ref().map(|b|b.len() as u64).or_else(||metadata.as_ref().map(|value|value.byte_length)).unwrap_or(0),mode:0o644}
                }else{PathState::Unsupported};
                if !callback(Document{path,revision,state,bytes,metadata})?{return Ok(partial||ignore_errors.load(std::sync::atomic::Ordering::Relaxed));}
            }
            partial|=ignore_errors.load(std::sync::atomic::Ordering::Relaxed);
        }
    }
    Ok(partial)
    })();
    if listing {task.traversal=Some(traversal);}
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestFile(PathBuf);
    impl Drop for TestFile {
        fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
    }

    #[test]
    fn search_skips_binary_before_allocating_the_file_length() {
        let fixture=TestFile(std::env::temp_dir().join(format!("varin-search-binary-{}",uuid::Uuid::new_v4())));
        let file=File::create(&fixture.0).unwrap(); file.set_len(32*1024*1024).unwrap(); drop(file);
        assert!(search_capture(File::open(&fixture.0).unwrap(),&Shared::new(false)).unwrap().is_none());
        fs::write(&fixture.0,"中文🙂 needle").unwrap();
        assert_eq!(search_capture(File::open(&fixture.0).unwrap(),&Shared::new(false)).unwrap().unwrap().bytes,"中文🙂 needle".as_bytes());
    }
    #[test]
    fn capture_allocation_failure_preserves_existing_bytes() {
        let mut bytes=vec![1,2,3];
        assert!(reserve_capture(&mut bytes,usize::MAX).unwrap_err().contains("Insufficient memory"));
        assert_eq!(bytes,[1,2,3]);
    }

    #[test]
    fn capture_keeps_one_verified_identity_for_exact_bytes() {
        let fixture = TestFile(std::env::temp_dir().join(format!("varin-capture-{}", uuid::Uuid::new_v4())));
        fs::write(&fixture.0, b"abc").unwrap();
        let hash = "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let captured = read_capture(File::open(&fixture.0).unwrap(), None, &Shared::new(false)).unwrap();
        assert_eq!(captured.bytes, b"abc");
        assert_eq!(captured.metadata.byte_length, 3);
        assert_eq!(captured.object_hash, hash);
        assert_eq!(captured.revision, "d1_ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
        assert_eq!(captured.revision, revision_from_object_hash(hash).unwrap());
        let verified = read_capture(File::open(&fixture.0).unwrap(), Some(hash), &Shared::new(false)).unwrap();
        assert_eq!(verified.object_hash, captured.object_hash);
        assert_eq!(verified.revision, captured.revision);

        fs::write(&fixture.0, b"abd").unwrap();
        let error = read_capture(File::open(&fixture.0).unwrap(), Some(hash), &Shared::new(false))
            .err().expect("corrupt immutable bytes must remain rejected");
        assert!(error.contains("hash mismatch"), "{error}");
        let cancelled = Shared::new(false);
        cancelled.cancel();
        assert_eq!(read_capture(File::open(&fixture.0).unwrap(), None, &cancelled).err().unwrap(), "cancelled");
    }
}
