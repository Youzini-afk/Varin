//! Single-file execution views. Bytes and retention stay with Storage's original
//! objects and records; the worker never exposes a writable CAS inode or a tree.
use super::file_effects::Control;
use super::materialization::{directory_identity, DirectoryIdentity};
use super::*;
use serde::{Deserialize, Serialize};

const RECORD_TYPE: &str = "file.object-view";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    workspace_id: String,
    execution_workspace_id: String,
    record_id: String,
    slot: String,
    view_id: String,
    filename: String,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    external_conversation_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Release { workspace_id: String, view_id: String }
#[derive(Clone)]
pub(crate) struct Task {
    key: String,
    record: Value,
    grant: Grant,
    storage_root: PathBuf,
    cancelled: Arc<AtomicBool>,
    _retention: blob_reads::BlobReadRetention,
    release: bool,
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, KernelError> {
    value[name].as_str().ok_or_else(|| KernelError::Storage(format!("Object view omitted {name}")))
}
fn fail(message: &str) -> KernelError { KernelError::Operation(message.into()) }
fn filename(name: &str) -> Result<(), KernelError> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0', ':']) {
        return Err(fail("Object view filename must be one portable filename"));
    }
    Ok(())
}
fn remove_staging(path: &Path) -> Result<(), KernelError> {
    let metadata=match fs::symlink_metadata(path) {Ok(metadata)=>metadata,Err(error) if error.kind()==io::ErrorKind::NotFound=>return Ok(()),Err(error)=>return Err(error.into())};
    if !metadata.is_file() || metadata.file_type().is_symlink() {return Err(fail("Object view staging path changed; it was preserved"));}
    let mut permissions=metadata.permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(path,permissions)?;fs::remove_file(path)?;Ok(())
}
impl Task {
    #[cfg(test)]
    pub(crate) fn run_fixture(&self, storage:&mut Storage)->Result<Value,KernelError> {
        self.run_with(&mut super::file_effects::Local(storage))
    }
    pub(crate) fn run(&self, mut port: workspace_session::StoragePort) -> Result<Value, KernelError> {
        self.run_with(&mut port)
    }
    fn control<T: Send + 'static>(&self, port: &mut impl Control,
        f: impl FnOnce(&Task, &mut Storage) -> Result<T, KernelError> + Send + 'static) -> Result<T, KernelError> {
        let task = self.clone(); port.call(move |storage| f(&task, storage))
    }
    fn check(&self) -> Result<(), KernelError> {
        if self.cancelled.load(Ordering::Acquire) { Err(KernelError::Cancelled) } else { Ok(()) }
    }
    fn run_with(&self, port: &mut impl Control) -> Result<Value, KernelError> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||self.io(port)))
            .unwrap_or_else(|_|Err(KernelError::Storage("Attachment path worker panicked".into())));
        // The actual worker, including cancellation, relinquishes its reservation.
        let completed = result.is_ok();
        self.control(port, move |task, storage| {
            storage.object_view_tasks.remove(&task.key);
            if completed && task.release {
                storage.conn.execute("DELETE FROM domain_records WHERE workspace_id=?1 AND record_id=?2 AND record_type=?3",
                    params![task.record["workspaceId"].as_str(), task.key, RECORD_TYPE])?;
            }
            Ok(())
        })?;
        result
    }
    fn io(&self, port: &mut impl Control) -> Result<Value, KernelError> {
        self.check()?;
        let directory = self.storage_root.join(field(&self.record, "path")?);
        let target = directory.join(field(&self.record, "filename")?);
        // Keep internal staging outside the user-controlled filename namespace.
        // A perfectly valid attachment may itself be named `.attachment.partial`.
        let staging = directory.with_extension("partial");
        let expected: Option<DirectoryIdentity> = self.record.get("directoryIdentity").cloned().map(serde_json::from_value).transpose()?;
        if self.release {
            if let Some(actual) = directory_identity(&directory)? {
                if expected.as_ref() != Some(&actual) { return Err(fail("Object view directory was replaced; unrelated files were preserved")); }
                // No deletion until all original process consumers have confirmed exit.
                self.control(port, |task, storage| storage.require_object_view_idle(&task.record))?;
                if target.try_exists()? {
                    let metadata = fs::symlink_metadata(&target)?;
                    if !metadata.is_file() || metadata.file_type().is_symlink()
                        || !file_content::matches_file(&self.storage_root,field(&self.record,"objectHash")?,self.record["byteLength"].as_u64().ok_or_else(||fail("Object view length missing"))?,&target,&self.cancelled)? {
                        return Err(fail("Object view file was modified or replaced; it was preserved"));
                    }
                    let mut permissions = metadata.permissions();
                    #[allow(clippy::permissions_set_readonly_false)]
                    permissions.set_readonly(false);
                    fs::set_permissions(&target, permissions)?;
                    fs::remove_file(&target)?;
                }
                remove_staging(&staging)?;
                // remove_dir deliberately refuses unexpected files, rather than recursively deleting them.
                fs::remove_dir(&directory)?;
                sync_directory(directory.parent().expect("view parent"))?;
            }
            return Ok(json!({"viewId":self.record["viewId"],"released":true}));
        }
        let identity = match directory_identity(&directory)? {
            Some(actual) => {
                if expected.is_none() && fs::read_dir(&directory)?.next().is_none() {
                    // A crash may happen after creating the private empty directory
                    // but before publishing its identity. No file has been exposed yet.
                    let recorded=actual.clone();
                    self.control(port,move |task,storage| {let mut record=task.record.clone();record["directoryIdentity"]=json!(recorded);storage.save_object_view(&task.key,&record)})?;
                } else if expected.as_ref() != Some(&actual) { return Err(fail("Object view directory identity is unavailable or changed")); }
                actual
            }
            None => {
                fs::create_dir_all(directory.parent().expect("view parent"))?;
                fs::create_dir(&directory)?;
                sync_directory(directory.parent().expect("view parent"))?;
                let identity = directory_identity(&directory)?.ok_or_else(|| fail("Object view directory disappeared"))?;
                let recorded = identity.clone();
                self.control(port, move |task, storage| {
                    let mut record = task.record.clone(); record["directoryIdentity"] = json!(recorded);
                    storage.save_object_view(&task.key, &record)
                })?;
                identity
            }
        };
        self.check()?;
        let hash = field(&self.record, "objectHash")?;
        let length = self.record["byteLength"].as_u64().ok_or_else(|| fail("Object view length missing"))?;
        if target.try_exists()? {
            let meta = fs::symlink_metadata(&target)?;
            if !meta.is_file() || meta.file_type().is_symlink() || !meta.permissions().readonly()
                || !file_content::matches_file(&self.storage_root, hash, length, &target, &self.cancelled)? {
                return Err(fail("Fixed attachment path was modified; choose a new execution view"));
            }
        } else {
            // The durable view owns this one staging pathname. Resume a stopped
            // copy without creating untracked temporary copies after a restart.
            remove_staging(&staging)?;
            let copied = (|| {
                let mut output = OpenOptions::new().write(true).create_new(true).open(&staging)?;
                file_content::copy_to(&self.storage_root, hash, length, &mut output, &self.cancelled)?;
                output.sync_all()?;
                let mut permissions = output.metadata()?.permissions(); permissions.set_readonly(true);
                output.set_permissions(permissions)?;
                drop(output);
                self.check()?;
                if directory_identity(&directory)?.as_ref() != Some(&identity) { return Err(fail("Object view directory changed during preparation")); }
                durable_rename(&staging, &target)?;
                sync_directory(&directory)?;
                Ok(())
            })();
            let _ = remove_staging(&staging);
            copied?;
        }
        self.check()?;
        let saved_identity = identity.clone();
        self.control(port, move |task, storage| {
            let current = storage.load_grant(&task.grant.grant_id)?;
            if current.state != crate::model::GrantState::Active || current.kernel_epoch != task.grant.kernel_epoch {
                return Err(KernelError::Authorization("Object view consumer authority changed".into()));
            }
            let source = storage.domain_record_get(&json!({"workspaceId":task.record["workspaceId"],"recordId":task.record["sourceRecordId"]}), &current.grant_id)?;
            if !source["references"].as_array().is_some_and(|refs| refs.iter().any(|r| r["slot"] == task.record["slot"] && r["objectHash"] == task.record["objectHash"])) {
                return Err(KernelError::Authorization("Attachment retention changed during path preparation".into()));
            }
            let mut record = task.record.clone(); record["directoryIdentity"] = json!(saved_identity); record["state"] = json!("ready");
            storage.save_object_view(&task.key, &record)
        })?;
        Ok(json!({"viewId":self.record["viewId"],"path":target,"kernelEpoch":self.record["kernelEpoch"],"readOnly":true}))
    }
}
impl Storage {
    pub(crate) fn abandon_object_view(&mut self, task:&Task) {self.object_view_tasks.remove(&task.key);}
    fn save_object_view(&self, key: &str, record: &Value) -> Result<(), KernelError> {
        let transaction=self.conn.unchecked_transaction()?;
        transaction.execute("INSERT INTO domain_records(workspace_id,record_id,record_type,state,thread_id,run_id,record_revision,payload_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,1,?7,?8,?8) ON CONFLICT(workspace_id,record_id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json,record_revision=domain_records.record_revision+1,updated_at=excluded.updated_at",
            params![record["workspaceId"].as_str(),key,RECORD_TYPE,record["state"].as_str(),record["threadId"].as_str(),record["runId"].as_str(),serde_json::to_string(record)?,now_ms()])?;
        transaction.execute("INSERT OR REPLACE INTO domain_record_refs(workspace_id,record_id,slot,object_hash) VALUES(?1,?2,'content',?3)",params![record["workspaceId"].as_str(),key,record["objectHash"].as_str()])?;
        transaction.commit()?;
        Ok(())
    }
    pub(crate) fn prepare_object_view(&mut self, value: &Value, grant: &Grant, cancelled: Arc<AtomicBool>) -> Result<Task, KernelError> {
        let params: Prepare = super::file_resources::parse_file_params(value)?;
        filename(&params.filename)?;
        if params.view_id.is_empty() || params.run_id.is_some() == params.external_conversation_id.is_some()
            || params.run_id.as_deref().is_some_and(str::is_empty) || params.external_conversation_id.as_deref().is_some_and(str::is_empty)
            || grant.run_id.as_ref().is_some_and(|run| Some(run) != params.run_id.as_ref()) {
            return Err(KernelError::Authorization("Object view requires its actual native Run or external conversation".into()));
        }
        if let Some(conversation) = params.external_conversation_id.as_deref() {
            if grant.thread_id.as_deref() != Some(conversation) || grant.run_id.is_some()
                || grant.external_transport_id.is_none() || grant.operation_id != grant.external_transport_id {
                return Err(KernelError::Authorization("External object view requires its actual conversation and transport".into()));
            }
        } else if grant.external_transport_id.is_some() {
            return Err(KernelError::Authorization("External grant cannot create a native Run object view".into()));
        }
        let source = self.domain_record_get(&json!({"workspaceId":params.workspace_id,"recordId":params.record_id}), &grant.grant_id)?;
        let hash = source["references"].as_array().and_then(|refs| refs.iter().find(|r| r["slot"] == params.slot))
            .and_then(|r| r["objectHash"].as_str()).ok_or_else(|| KernelError::Authorization("Attachment record has no readable selected object".into()))?.to_owned();
        let length: i64 = self.conn.query_row("SELECT byte_length FROM blobs WHERE hash=?1", [&hash], |row|row.get(0))?;
        let key_hash = hex::encode(Sha256::digest(serde_json::to_vec(&json!([params.workspace_id, params.view_id, grant.kernel_epoch]))?));
        let key = format!("object-view:{key_hash}");
        if self.object_view_tasks.contains(&key) { return Err(fail("Object view preparation is already active; observe the original request")); }
        let mut record = json!({"workspaceId":params.workspace_id,"viewId":params.view_id,"sourceRecordId":params.record_id,"slot":params.slot,
            "executionWorkspaceId":params.execution_workspace_id,"filename":params.filename,"runId":params.run_id,"externalConversationId":params.external_conversation_id,
            "externalTransportId":grant.external_transport_id,
            "threadId":source["threadId"],"objectHash":hash,"byteLength":length,"ownerGrantId":grant.grant_id,"kernelEpoch":grant.kernel_epoch,
            "path":format!("managed/object-views/{key_hash}"),"state":"preparing"});
        if let Some(old) = self.domain_record_value(&params.workspace_id, &key)? {
            let prior: Value = serde_json::from_str(old["payloadJson"].as_str().ok_or_else(||fail("Object view record missing"))?)?;
            for field in ["sourceRecordId","slot","objectHash","filename","executionWorkspaceId","runId","externalConversationId"] {
                if prior[field] != record[field] { return Err(KernelError::Authorization("Object view identity was reused for a different attachment or consumer".into())); }
            }
            if let Some(transport) = prior["externalTransportId"].as_str() {
                if Some(transport) != grant.external_transport_id.as_deref() {
                    return Err(KernelError::Authorization("Object view belongs to another external transport".into()));
                }
            } else if prior["externalConversationId"].is_string() {
                // Preserve the historical receipt verbatim. Its original grant
                // proves the consumer; absent transport retains every live
                // process of that conversation rather than inventing a binding.
                let original = self.load_grant(field(&prior, "ownerGrantId")?)?;
                if original.thread_id.as_deref() != prior["externalConversationId"].as_str()
                    || original.thread_id != grant.thread_id || original.run_id.is_some() {
                    return Err(KernelError::Authorization("Original external object view consumer is unavailable or changed".into()));
                }
            }
            record = prior;
        }
        self.save_object_view(&key, &record)?;
        self.object_view_tasks.insert(key.clone());
        Ok(Task { key, record, grant: grant.clone(), storage_root:self.root.clone(), cancelled,
            _retention:self.blob_read_roots.retain(&hash), release:false })
    }
    fn require_object_view_idle(&mut self, record: &Value) -> Result<(), KernelError> {
        self.refresh_process_records()?;
        if let Some(run) = record["runId"].as_str() {
            let active: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM process_records p JOIN grants g ON g.grant_id=p.grant_id WHERE json_extract(g.grant_json,'$.run_id')=?1 AND COALESCE(json_extract(p.status_json,'$.writerActive'),1)!=0)", [run], |row|row.get(0))?;
            if active { return Err(fail("Attachment path is still retained by an executing process")); }
        }
        if let Some(conversation) = record["externalConversationId"].as_str() {
            // The immutable attachment is outside the process cwd. Retain it by
            // its original typed consumer, not by a filesystem-prefix guess.
            let active: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM process_records p JOIN grants g ON g.grant_id=p.grant_id WHERE json_extract(g.grant_json,'$.thread_id')=?1 AND (?2 IS NULL OR json_extract(g.grant_json,'$.external_transport_id')=?2) AND COALESCE(json_extract(p.status_json,'$.writerActive'),1)!=0)",
                params![conversation, record["externalTransportId"].as_str()], |row| row.get(0))?;
            if active { return Err(fail("Attachment path is still retained by its external process")); }
        }
        self.assert_process_directory_idle(&self.root.join(field(record,"path")?))
    }
    pub(crate) fn prepare_object_view_release(&mut self, value: &Value, grant: &Grant) -> Result<Vec<Task>, KernelError> {
        let all_generations = grant.capabilities.contains("storage.maintenance") || grant.capabilities.contains("storage.admin");
        self.prepare_object_view_release_generations(value, grant, all_generations)
    }
    pub(crate) fn prepare_obsolete_object_view_release(&mut self, value: &Value, grant: &Grant) -> Result<Vec<Task>, KernelError> {
        // Background collection only owns the obsolete generation it observed.
        self.prepare_object_view_release_generations(value, grant, false)
    }
    fn prepare_object_view_release_generations(&mut self, value: &Value, grant: &Grant, all_generations: bool) -> Result<Vec<Task>, KernelError> {
        let params: Release = super::file_resources::parse_file_params(value)?;
        if grant.owning_workspace.as_deref() != Some(&params.workspace_id) && !grant.capabilities.contains("storage.admin") {
            return Err(KernelError::Authorization("Object view release belongs to another workspace".into()));
        }
        let rows = self.conn.prepare("SELECT record_id,payload_json FROM domain_records WHERE workspace_id=?1 AND record_type=?2 AND json_extract(payload_json,'$.viewId')=?3 AND (?5 OR json_extract(payload_json,'$.kernelEpoch')=?4)")?
            .query_map(params![params.workspace_id,RECORD_TYPE,params.view_id,grant.kernel_epoch,all_generations], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        let mut tasks = Vec::new();
        for (key,raw) in rows {
            if self.object_view_tasks.contains(&key) { return Err(fail("Object view is still preparing or releasing")); }
            let mut record:Value=serde_json::from_str(&raw)?;
            if record["ownerGrantId"] != grant.grant_id && record["kernelEpoch"] == grant.kernel_epoch && !grant.capabilities.contains("storage.maintenance") && !grant.capabilities.contains("storage.admin") {
                return Err(KernelError::Authorization("Object view release belongs to its original consumer".into()));
            }
            record["releaseRequested"]=json!(true);self.save_object_view(&key,&record)?;
            self.require_object_view_idle(&record)?;
            let hash=field(&record,"objectHash")?.to_owned();
            tasks.push(Task {key,record,grant:grant.clone(),storage_root:self.root.clone(),cancelled:Arc::new(AtomicBool::new(false)),_retention:self.blob_read_roots.retain(&hash),release:true});
        }
        // Admission is atomic across generations: a later live consumer must
        // not leave earlier generations with reservations nobody can finish.
        for task in &tasks { self.object_view_tasks.insert(task.key.clone()); }
        Ok(tasks)
    }
    pub(crate) fn obsolete_object_views(&self, epoch:&str) -> Result<Vec<(Value,Grant)>,KernelError> {
        let rows=self.conn.prepare("SELECT payload_json FROM domain_records WHERE record_type=?1")?.query_map([RECORD_TYPE],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        let mut result=Vec::new();
        for raw in rows {
            let record:Value=serde_json::from_str(&raw)?;
            let source_exists:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM domain_records WHERE workspace_id=?1 AND record_id=?2)",params![record["workspaceId"].as_str(),record["sourceRecordId"].as_str()],|r|r.get(0))?;
            // External execution owns its stop receipt. A Host epoch change is not proof it stopped.
            if record["releaseRequested"]==true || (record["externalConversationId"].is_null() && (record["kernelEpoch"]!=epoch || !source_exists)) {
                let mut grant=self.load_grant(field(&record,"ownerGrantId")?)?; grant.kernel_epoch=field(&record,"kernelEpoch")?.into();
                result.push((json!({"workspaceId":record["workspaceId"],"viewId":record["viewId"]}),grant));
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::file_effects::Local;
    fn invoke(storage:&mut Storage,grant:&Grant,method:&str,value:Value)->Value {
        let (grant,value)=storage.authorize(Some(&grant.grant_id),&grant.kernel_epoch,"host","generation",method,&value).unwrap();
        storage.dispatch(method,&value,Some(&grant.grant_id),&grant).unwrap()
    }
    fn fixture()->(Storage,Grant,PathBuf,Value,Vec<u8>) {
        let root=std::env::temp_dir().join(format!("varin-object-view-{}",Uuid::new_v4()));
        let mut storage=Storage::open(&root,"host").unwrap();
        storage.issue_grant(&json!({"grantId":"owner","hostGeneration":"generation","owningWorkspace":"materials","executionWorkspace":"materials","threadId":"thread","capabilities":["storage.read","storage.write","storage.maintenance","storage.gc"],"pathScopes":[""]}),"host","generation",root.to_str().unwrap(),"epoch").unwrap();
        let grant=storage.load_grant("owner").unwrap();
        let bytes=b"original\0binary\xffbytes".to_vec();
        invoke(&mut storage,&grant,"storage.putBlob.begin",json!({"workspaceId":"materials","operationId":"upload","streamId":"upload","byteLength":bytes.len()}));
        invoke(&mut storage,&grant,"storage.putBlob.chunk",json!({"streamId":"upload","sequence":0,"bytesBase64":BASE64.encode(&bytes)}));
        let blob=invoke(&mut storage,&grant,"storage.putBlob.finish",json!({"workspaceId":"materials","operationId":"upload","streamId":"upload"}));
        invoke(&mut storage,&grant,"storage.record.put",json!({"operationId":"file","workspaceId":"materials","recordId":"attachment:file","recordType":"attachment.file","threadId":"thread","state":"temporary","payloadJson":json!({"attachment":{"ref":"attachment:file","filename":"binary.dat","mimeType":"application/octet-stream","byteLength":bytes.len()},"contentHash":blob["hash"]}).to_string(),"ownerIds":[blob["ownerId"]],"references":[{"slot":"source","objectHash":blob["hash"]}]}));
        let params=json!({"workspaceId":"materials","executionWorkspaceId":"execution","recordId":"attachment:file","slot":"source","viewId":"consumer","filename":"binary.dat","runId":"run"});
        (storage,grant,root,params,bytes)
    }
    #[test]
    fn fixed_single_file_path_survives_reopen_and_source_release_until_collection() {
        let (mut storage,grant,root,params,bytes)=fixture();
        let task=storage.prepare_object_view(&params,&grant,Arc::new(AtomicBool::new(false))).unwrap();
        let view=task.run_with(&mut Local(&mut storage)).unwrap();
        let path=PathBuf::from(view["path"].as_str().unwrap());
        assert_eq!(fs::read(&path).unwrap(),bytes);assert!(fs::metadata(&path).unwrap().permissions().readonly());
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(),1,"only the selected file is materialized");
        drop(task);drop(storage);
        let mut storage=Storage::open(&root,"host").unwrap();
        let task=storage.prepare_object_view(&params,&grant,Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(task.run_with(&mut Local(&mut storage)).unwrap(),view);
        invoke(&mut storage,&grant,"storage.record.release",json!({"operationId":"release-file","workspaceId":"materials","recordId":"attachment:file"}));
        assert_eq!(fs::read(&path).unwrap(),bytes,"releasing a descriptor does not delete an active path");
        let obsolete=storage.obsolete_object_views("epoch").unwrap();assert_eq!(obsolete.len(),1);
        for (params,owner) in obsolete {for cleanup in storage.prepare_obsolete_object_view_release(&params,&owner).unwrap() {cleanup.run_with(&mut Local(&mut storage)).unwrap();}}
        assert!(!path.exists());drop(storage);let _=fs::remove_dir_all(root);
    }
    #[test]
    #[cfg(unix)]
    fn source_release_waits_for_original_process_stop_even_outside_view_directory() {
        let (mut storage,grant,root,params,bytes)=fixture();
        let task=storage.prepare_object_view(&params,&grant,Arc::new(AtomicBool::new(false))).unwrap();
        let view=task.run_with(&mut Local(&mut storage)).unwrap();
        let path=PathBuf::from(view["path"].as_str().unwrap());
        drop(task);
        storage.issue_grant(&json!({"grantId":"process-owner","hostGeneration":"generation","owningWorkspace":"materials","executionWorkspace":"execution","threadId":"thread","runId":"run","capabilities":["storage.read"],"pathScopes":[]}),"host","generation",root.to_str().unwrap(),"epoch").unwrap();
        // The process may read the absolute attachment path while its cwd remains
        // its ordinary project. Run attribution, not cwd containment, owns the use.
        let process=json!({"processId":"consumer","kernelEpoch":"epoch","workspaceId":"execution","cwd":root,"status":"unknown","writerActive":true,"outputAvailable":false});
        storage.conn.execute("INSERT INTO process_records(process_id,workspace_id,execution_workspace_id,grant_id,kernel_epoch,cwd,job_name,params_hash,status_json) VALUES('consumer','materials','execution','process-owner','epoch',?1,'job','params',?2)",params![root.to_string_lossy(),process.to_string()]).unwrap();
        invoke(&mut storage,&grant,"storage.record.release",json!({"operationId":"release-file","workspaceId":"materials","recordId":"attachment:file"}));
        let obsolete=storage.obsolete_object_views("epoch").unwrap();
        assert_eq!(obsolete.len(),1);
        assert!(storage.prepare_obsolete_object_view_release(&obsolete[0].0,&obsolete[0].1).is_err());
        storage.gc().unwrap();storage.drain_gc_files().unwrap();
        assert_eq!(fs::read(&path).unwrap(),bytes);
        // Reconcile the original guardian's durable exit receipt, rather than
        // treating cancellation, grant retirement or observer closure as exit.
        let receipt=crate::process::receipt_path(&root,"consumer");
        fs::create_dir_all(receipt.parent().unwrap()).unwrap();
        fs::write(receipt,json!({"processId":"consumer","kernelEpoch":"epoch","status":"exited","treeConfirmed":true,"exitCode":0}).to_string()).unwrap();
        for cleanup in storage.prepare_obsolete_object_view_release(&obsolete[0].0,&obsolete[0].1).unwrap() {
            cleanup.run_with(&mut Local(&mut storage)).unwrap();
        }
        assert!(!path.exists());
        assert!(storage.obsolete_object_views("epoch").unwrap().is_empty());
        drop(storage);let _=fs::remove_dir_all(root);
    }
    #[test]
    fn attachment_named_like_internal_staging_remains_readable_after_reopen() {
        let (mut storage,grant,root,mut params,bytes)=fixture();
        params["filename"]=json!(".attachment.partial");
        let task=storage.prepare_object_view(&params,&grant,Arc::new(AtomicBool::new(false))).unwrap();
        let view=task.run_with(&mut Local(&mut storage)).unwrap();
        let path=PathBuf::from(view["path"].as_str().unwrap());
        assert_eq!(fs::read(&path).unwrap(),bytes);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(),1);
        drop(task);drop(storage);
        let mut storage=Storage::open(&root,"host").unwrap();
        let task=storage.prepare_object_view(&params,&grant,Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(task.run_with(&mut Local(&mut storage)).unwrap(),view);
        assert_eq!(fs::read(&path).unwrap(),bytes);
        for cleanup in storage.prepare_object_view_release(&json!({"workspaceId":"materials","viewId":"consumer"}),&grant).unwrap() {
            cleanup.run_with(&mut Local(&mut storage)).unwrap();
        }
        assert!(!path.exists());
        assert_eq!(fs::read_dir(root.join("managed/object-views")).unwrap().count(),0);
        drop(task);drop(storage);let _=fs::remove_dir_all(root);
    }
    #[test]
    #[cfg(unix)]
    fn maintenance_release_covers_old_generations_but_obsolete_collection_does_not() {
        let (mut storage, old, root, mut params, bytes) = fixture();
        params["runId"] = json!("old-run");
        let old_view = storage.prepare_object_view(&params, &old, Arc::new(AtomicBool::new(false))).unwrap()
            .run_with(&mut Local(&mut storage)).unwrap();
        storage.issue_grant(&json!({"grantId":"fresh-owner","hostGeneration":"generation","owningWorkspace":"materials","executionWorkspace":"execution","threadId":"thread","capabilities":["storage.read","storage.write","storage.maintenance"],"pathScopes":[]}),"host","generation",root.to_str().unwrap(),"fresh-epoch").unwrap();
        let fresh = storage.load_grant("fresh-owner").unwrap();
        params["runId"] = json!("fresh-run");
        let fresh_view = storage.prepare_object_view(&params, &fresh, Arc::new(AtomicBool::new(false))).unwrap()
            .run_with(&mut Local(&mut storage)).unwrap();
        let old_path = PathBuf::from(old_view["path"].as_str().unwrap());
        let fresh_path = PathBuf::from(fresh_view["path"].as_str().unwrap());
        assert_ne!(old_path, fresh_path);
        for (process, run, epoch) in [("old-process", "old-run", "epoch"), ("fresh-process", "fresh-run", "fresh-epoch")] {
            storage.issue_grant(&json!({"grantId":process,"hostGeneration":"generation","owningWorkspace":"materials","executionWorkspace":"execution","threadId":"thread","runId":run,"capabilities":["storage.read"],"pathScopes":[]}),"host","generation",root.to_str().unwrap(),epoch).unwrap();
            let status = json!({"processId":process,"kernelEpoch":epoch,"workspaceId":"execution","cwd":root,"status":"unknown","writerActive":true,"outputAvailable":false});
            storage.conn.execute("INSERT INTO process_records(process_id,workspace_id,execution_workspace_id,grant_id,kernel_epoch,cwd,job_name,params_hash,status_json) VALUES(?1,'materials','execution',?1,?2,?3,'job','params',?4)", params![process, epoch, root.to_string_lossy(), status.to_string()]).unwrap();
        }
        let release = json!({"workspaceId":"materials","viewId":"consumer"});
        assert!(storage.prepare_object_view_release(&release, &fresh).is_err());
        assert!(storage.object_view_tasks.is_empty(), "failed admission must not strand a generation reservation");
        assert_eq!(fs::read(&old_path).unwrap(), bytes);
        let stopped = |process: &str, epoch: &str| {
            let receipt = crate::process::receipt_path(&root, process);
            fs::create_dir_all(receipt.parent().unwrap()).unwrap();
            fs::write(receipt, json!({"processId":process,"kernelEpoch":epoch,"status":"exited","treeConfirmed":true,"exitCode":0}).to_string()).unwrap();
        };
        stopped("old-process", "epoch");
        // The original collector does not touch a newer still-executing view,
        // even though both generations intentionally share the stable view ID.
        for task in storage.prepare_obsolete_object_view_release(&release, &old).unwrap() {
            task.run_with(&mut Local(&mut storage)).unwrap();
        }
        assert!(!old_path.exists());
        assert_eq!(fs::read(&fresh_path).unwrap(), bytes);
        assert!(storage.prepare_object_view_release(&release, &fresh).is_err());
        assert!(storage.object_view_tasks.is_empty());
        stopped("fresh-process", "fresh-epoch");
        params["runId"] = json!("old-run");
        storage.prepare_object_view(&params, &old, Arc::new(AtomicBool::new(false))).unwrap()
            .run_with(&mut Local(&mut storage)).unwrap();
        let tasks = storage.prepare_object_view_release(&release, &fresh).unwrap();
        assert_eq!(tasks.len(), 2, "explicit maintenance release covers every retained generation");
        for task in tasks { task.run_with(&mut Local(&mut storage)).unwrap(); }
        assert!(!old_path.exists()); assert!(!fresh_path.exists());
        assert!(storage.object_view_tasks.is_empty());
        drop(storage); let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn object_path_rejects_identity_reuse_and_cancellation_keeps_original_record() {
        let (mut storage,grant,root,params,_)=fixture();
        let cancelled=Arc::new(AtomicBool::new(true));
        let task=storage.prepare_object_view(&params,&grant,cancelled).unwrap();
        assert!(matches!(task.run_with(&mut Local(&mut storage)),Err(KernelError::Cancelled)));
        assert!(storage.object_view_tasks.is_empty());
        let mut changed=params.clone();changed["filename"]=json!("different.dat");
        assert!(storage.prepare_object_view(&changed,&grant,Arc::new(AtomicBool::new(false))).is_err());
        let mut forged=params.clone();forged["recordId"]=json!("not-authorized");forged["viewId"]=json!("forged");
        assert!(storage.prepare_object_view(&forged,&grant,Arc::new(AtomicBool::new(false))).is_err());
        let task=storage.prepare_object_view(&params,&grant,Arc::new(AtomicBool::new(false))).unwrap();
        assert!(task.run_with(&mut Local(&mut storage)).is_ok());
        drop(task);drop(storage);let _=fs::remove_dir_all(root);
    }
}
