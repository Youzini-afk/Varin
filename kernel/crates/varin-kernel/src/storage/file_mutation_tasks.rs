//! Text mutation orchestration runs beside the filesystem, with metadata stages
//! returning to the sole Storage owner. Its read and apply borrow one lease.
use super::file_effects::Control;
#[cfg(test)]
use super::file_effects::Local;
use super::file_mutations::{
    edit_preserving_line_endings, fixed_read_namespace, read_version, FileWriteMode, TextMutation,
};
use super::file_resource_leases::{canonical_lease_path, FileLeaseRequest, RetainedFileLease};
use super::file_resources::{
    normalized_relative_path, parse_file_params, resolve_admitted_resource, FileState,
};
use super::*;
use crate::model::CanonicalFileLeaseResource;
use varin_runtime::catalog::journal::JournalAnchor;

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, KernelError> {
    value[field].as_str().ok_or_else(|| {
        KernelError::Storage(format!("Text mutation content upload omitted {field}"))
    })
}

#[derive(Clone)]
pub(crate) struct Task {
    workspace: String,
    root: FileRoot,
    operation: String,
    mutation: Arc<TextMutation>,
    grant: Grant,
    journal: Option<JournalAnchor>,
    source_mode: varin_runtime::SourceMode,
    baseline: Option<crate::tools::FixedFileSource>,
    lease: String,
    pub cancellation: Arc<AtomicBool>,
    expected_key: Option<String>,
    live_root: Option<varin_runtime::catalog::launches::LiveRoot>,
}
impl Task {
    pub(crate) fn with_source(
        mut self,
        key: Option<String>,
        root: Option<varin_runtime::catalog::launches::LiveRoot>,
    ) -> Self {
        self.expected_key = key;
        self.live_root = root;
        self
    }
    fn check(&self) -> Result<(), KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    }
    fn control<T: Send + 'static>(
        &self,
        owner: &mut impl Control,
        work: impl FnOnce(&Task, &mut Storage) -> Result<T, KernelError> + Send + 'static,
    ) -> Result<T, KernelError> {
        let task = self.clone();
        owner.call(move |s| work(&task, s))
    }
    fn authorize(&self, s: &Storage) -> Result<Grant, KernelError> {
        self.check()?;
        let grant = s.load_grant(&self.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != self.grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Original text mutation grant is no longer active".into(),
            ));
        }
        require_capability(&grant, "file.apply")?;
        let root = s.admitted_file_root(&self.root.root_id, &grant)?;
        if root.canonical_root != self.root.canonical_root
            || root.owning_workspace_id != self.workspace
            || root.execution_workspace_id != self.root.execution_workspace_id
            || !path_allowed(&grant, self.mutation.path())
        {
            return Err(KernelError::Authorization(
                "Original text mutation source changed".into(),
            ));
        }
        Ok(grant)
    }
    pub(crate) fn run(
        &self,
        mut port: workspace_session::StoragePort,
    ) -> Result<Value, crate::tools::ResourceFailure> {
        let mut dispatched = false;
        self.run_with(&mut port, &mut dispatched)
            .map_err(|error| crate::tools::ResourceFailure { error, dispatched })
    }
    #[cfg(test)]
    pub(crate) fn run_local(
        &self,
        s: &mut Storage,
        dispatched: &mut bool,
    ) -> Result<Value, KernelError> {
        self.run_with(&mut Local(s), dispatched)
    }
    fn upload(
        &self,
        owner: &mut impl Control,
        text: &str,
        label: &str,
    ) -> Result<Value, KernelError> {
        let stream = format!("text-{}", Uuid::new_v4());
        let upload = json!({"workspaceId":self.workspace,"operationId":format!("{label}:{}",self.operation),"streamId":stream,"byteLength":text.len()});
        let begin = upload.clone();
        self.control(owner, move |t, s| {
            t.authorize(s)?;
            s.begin_blob_stream(&begin, &t.grant.grant_id)
        })?;
        let outcome = (|| {
            for (sequence, bytes) in text.as_bytes().chunks(65536).enumerate() {
                self.check()?;
                let (stream, bytes) = (stream.clone(), bytes.to_vec());
                self.control(owner, move |t, s| {
                    t.authorize(s)?;
                    s.stream_blob_bytes(&stream, sequence as u64, &bytes, &t.grant.grant_id)
                })?;
            }
            let finish = upload.clone();
            self.control(owner, move |t, s| {
                t.authorize(s)?;
                s.finish_blob_stream(&finish, &t.grant.grant_id)
            })
        })();
        if outcome.is_err() {
            let _ = self.control(owner, move |t, s| {
                s.abort_blob_stream(&upload, &t.grant.grant_id)
            });
        }
        outcome
    }
    fn run_with(
        &self,
        owner: &mut impl Control,
        dispatched: &mut bool,
    ) -> Result<Value, KernelError> {
        let mut retained = false;
        let mut provisional = Vec::<String>::new();
        let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
            self.check()?;
            let resource=resolve_admitted_resource(&self.root,self.mutation.path(),&self.grant,false)?;
            let canonical=CanonicalFileLeaseResource{absolute:canonical_lease_path(resource.absolute.clone())?,subtree:false};
            if let Some(root)=&self.live_root {
                if fs::canonicalize(&root.canonical_root)?!=self.root.canonical_root || root.root_id!=self.root.root_id || root.host_id!=self.grant.host_id {
                    return Err(KernelError::Authorization("Text mutation live source differs from admitted root".into()));
                }
            }
            let key=serde_json::to_string(&["file",self.grant.host_id.as_str(),canonical.absolute.to_str().ok_or_else(||KernelError::Authorization("File resource is not UTF-8".into()))?])?;
            if self.expected_key.as_ref().is_some_and(|expected|expected!=&key){
                return Err(KernelError::Authorization("Canonical file resource changed after admission".into()));
            }
            let proof=canonical.clone();
            self.control(owner,move |t,s|{
                let grant=t.authorize(s)?;
                let paths=vec![FileLeaseResource{path:t.mutation.path().into(),subtree:false}];
                let params=parse_file_params(&json!({"workspaceId":t.workspace,"rootId":t.root.root_id,"leaseId":t.lease,
                    "resources":[{"path":t.mutation.path(),"scope":"exact"}]}))?;
                let result=s.acquire_file_lease_for(FileLeaseRequest{params,resources:paths,canonical_resources:vec![proof]},&grant,None)?;
                if result["status"]!="acquired"{return Err(KernelError::Operation("file resource is busy".into()));}
                s.retained_file_leases.insert(t.lease.clone(),RetainedFileLease{release_requested:true});
                Ok(())
            })?;
            retained=true;
            let request_hash=hash_json(&json!(["text-mutation-v1",self.grant.grant_id,self.workspace,self.root.root_id,self.operation,&*self.mutation]))?;
            let prior=self.control(owner,|t,s|{t.authorize(s)?;s.operation_get(&json!({"operationId":t.operation}))})?;
            if !prior.is_null(){
                let receipt=&prior["result"];
                let stored=receipt["__nativeRequestHash"].as_str().or_else(||receipt["intent"]["__nativeRequestHash"].as_str());
                if prior["kind"]!="file.apply" || stored!=Some(request_hash.as_str()){
                    return Err(KernelError::Operation("mutation operation identity was reused with different arguments".into()));
                }
                if prior["state"]=="committed"{
                    let receipt=receipt.clone();
                    return self.control(owner,move |t,s|s.mutation_receipt(receipt,&t.root.root_id,t.mutation.path()));
                }
                if prior["state"]!="started"{return Err(KernelError::Operation("mutation journal state cannot be replayed".into()));}
                let mut intent=receipt["intent"].clone();intent["leaseId"]=json!(self.lease);
                *dispatched=true;
                let effect=self.control(owner,move |t,s|s.prepare_file_effect("file.apply",&intent,&t.authorize(s)?,t.cancellation.clone()))?;
                let receipt=effect.run_borrowed(owner)?;
                return self.control(owner,move |t,s|s.mutation_receipt(receipt,&t.root.root_id,t.mutation.path()));
            }
            if self.mutation.read_version().is_empty() {
                match fs::symlink_metadata(&resource.absolute) {
                    Ok(_) => return Ok(json!({"path":self.mutation.path(),"status":"conflict",
                        "reason":if matches!(&*self.mutation,TextMutation::Write(args)if args.mode==Some(FileWriteMode::Create)){"create_target_exists"}else{"read_version_required"}})),
                    Err(error) if error.kind()==io::ErrorKind::NotFound => {},
                    Err(error) => return Err(error.into()),
                }
            }
            let reader=self.control(owner,|t,s|{
                let grant=t.authorize(s)?;
                s.prepare_retained_mutation_read(&json!({"rootId":t.root.root_id,"path":t.mutation.path(),"offset":0,"leaseId":t.lease}),&grant,t.cancellation.clone())
            })?;
            let prepared=reader.run()?;
            let expected=prepared.state.clone();
            let observed=self.control(owner,move |t,s|s.finish_file_read(&reader,Ok(prepared),&t.authorize(s)?))?;
            let current_version=read_version(&self.root.root_id,self.mutation.path(),&expected)?;
            if let TextMutation::Write(args)=&*self.mutation {
                let missing=matches!(expected,FileState::Missing);
                if (args.mode==Some(FileWriteMode::Create)&&!missing)||(args.mode==Some(FileWriteMode::Replace)&&missing){
                    return Ok(json!({"path":self.mutation.path(),"status":"conflict","readVersion":current_version,
                        "reason":if missing{"replace_target_missing"}else{"create_target_exists"}}));
                }
            }
            let mut version_matches=if self.mutation.read_version().is_empty(){matches!(expected,FileState::Missing)}else{self.mutation.read_version()==current_version};
            if !version_matches && !self.mutation.read_version().is_empty(){
                if let Some(baseline)=&self.baseline {
                    let original=self.control(owner,|t,s|{
                        t.authorize(s)?;let base=t.baseline.as_ref().expect("fixed mutation baseline");
                        s.branch_read(&json!({"branchId":base.branch_id,"revision":base.revision,"paths":[t.mutation.path()]}))
                    })?;
                    let state=original["entries"].as_array().and_then(|entries|entries.first()).and_then(|entry|entry.get("state")).cloned().unwrap_or_else(||json!({"kind":"missing"}));
                    let mut state:FileState=serde_json::from_value(state)?;
                    if read_version(&fixed_read_namespace(&self.workspace,baseline),self.mutation.path(),&state)?==self.mutation.read_version(){
                        #[cfg(windows)]
                        if let FileState::RegularFile{mode:Some(mode),..}=&mut state{*mode=if *mode&0o222==0{0o444}else{0o666};}
                        version_matches=Storage::file_state_matches(&expected,&state);
                    }
                }
            }
            if !version_matches {
                return Ok(json!({"path":self.mutation.path(),"status":"conflict","readVersion":current_version,
                    "reason":if self.mutation.read_version().is_empty(){"read_version_required"}else{"read_version_changed"}}));
            }
            let mode=match &expected{
                FileState::Missing=>None,FileState::RegularFile{mode,..}=>*mode,
                _=>return Err(KernelError::Operation("text mutation requires a regular file or a missing write target".into()))
            };
            let previous=if matches!(expected,FileState::RegularFile{..}){
                let text=observed["content"]["text"].as_str().ok_or_else(||KernelError::Operation("text mutation requires UTF-8 content".into()))?;
                if text.contains('\0'){return Err(KernelError::Operation("text mutation cannot overwrite binary content".into()));}
                Some(text.to_owned())
            }else{None};
            let content=match &*self.mutation{
                TextMutation::Write(args)=>if previous.as_ref().is_some_and(|text|text.starts_with('\u{feff}'))&&!args.content.starts_with('\u{feff}'){
                    format!("\u{feff}{}",args.content)
                }else{args.content.clone()},
                TextMutation::Edit(args)=>edit_preserving_line_endings(previous.as_deref().ok_or_else(||KernelError::Operation("cannot edit a missing file".into()))?,&args.edits)?
            };
            if content.contains('\0'){return Err(KernelError::Operation("text mutation content must not contain NUL bytes".into()));}
            let stored=self.upload(owner,&content,"text-content")?;
            let content_owner=string(&stored,"ownerId")?.to_owned();provisional.push(content_owner.clone());
            let target=FileState::RegularFile{object_hash:string(&stored,"hash")?.into(),byte_length:content.len() as u64,mode};
            let turn=self.control(owner,|t,s|{
                let grant=t.authorize(s)?;
                t.journal.as_ref().map(|anchor|s.prepare_journal_turn(&t.workspace,&t.root.root_id,anchor,t.source_mode,&grant)).transpose()
            })?;
            let mut before_owner=None;
            if turn.is_some(){
                if let Some(text)=&previous{
                    let stored=self.upload(owner,text,"journal-before")?;
                    let id=string(&stored,"ownerId")?.to_owned();provisional.push(id.clone());before_owner=Some(id);
                    if serde_json::to_value(&expected)?["objectHash"]!=stored["hash"]{
                        return Err(KernelError::Storage("captured journal before-image differs".into()));
                    }
                }
            }
            let mut params=json!({"workspaceId":self.workspace,"operationId":self.operation,"rootId":self.root.root_id,"path":self.mutation.path(),
                "leaseId":self.lease,"targetJson":serde_json::to_string(&target)?,"expectedJson":serde_json::to_string(&expected)?,
                "ownerId":content_owner,"__nativeRequestHash":request_hash,"__nativeGrantId":self.grant.grant_id,"__nativeEpoch":self.grant.kernel_epoch});
            if let Some(turn)=turn{
                params["__recoveryTurn"]=turn;params["__recoveryBeforeOwner"]=json!(before_owner);
                params["__recoveryTool"]=json!(match &*self.mutation{TextMutation::Write(_)=>"file_write",TextMutation::Edit(_)=>"file_edit"});
            }
            self.check()?;
            let effect=self.control(owner,move |t,s|s.prepare_file_effect("file.apply",&params,&t.authorize(s)?,t.cancellation.clone()))?;
            *dispatched=true;
            let receipt=effect.run_borrowed(owner)?;
            self.control(owner,move |t,s|s.mutation_receipt(receipt,&t.root.root_id,t.mutation.path()))
        })).unwrap_or_else(|_|Err(KernelError::Storage("Text mutation worker panicked; inspect its original operation receipt".into())));
        let cleanup = self.control(owner, move |t, s| {
            // An accepted intent owns its exact target and before-image. Anything
            // staged before that intent remains this worker's cleanup obligation.
            let original = s.operation_get(&json!({"operationId":t.operation}));
            // Lease drainage is unconditional even when reading the receipt fails.
            if retained {
                s.finish_retained_file_lease(&t.lease);
            }
            let original = original?;
            for id in provisional {
                let intent = &original["result"]["intent"];
                if original["state"] == "started"
                    && (intent["ownerId"] == id || intent["__recoveryBeforeOwner"] == id)
                {
                    continue;
                }
                let _ = s.release_object_owner(
                    &json!({"ownerId":id}),
                    Some(&t.workspace),
                    &t.grant.grant_id,
                );
            }
            Ok(())
        });
        if outcome.is_ok() {
            cleanup?;
        }
        outcome
    }
}
impl Storage {
    pub(crate) fn prepare_text_mutation(
        &self,
        workspace: &str,
        root: &str,
        operation: &str,
        mutation: &TextMutation,
        grant: &Grant,
        journal: Option<&JournalAnchor>,
        source_mode: varin_runtime::SourceMode,
        baseline: Option<&crate::tools::FixedFileSource>,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Task, KernelError> {
        let admitted = self.admitted_file_root(root, grant)?;
        if admitted.owning_workspace_id != workspace {
            return Err(KernelError::Authorization(
                "Text mutation workspace differs from admitted root".into(),
            ));
        }
        let normalized = normalized_relative_path(mutation.path(), false)?.0;
        if mutation.read_version().is_empty()
            && (matches!(mutation, TextMutation::Edit(_))
                || matches!(mutation,TextMutation::Write(args)if args.mode==Some(FileWriteMode::Replace)))
        {
            return Err(KernelError::Operation("readVersion is required".into()));
        }
        let mut mutation = mutation.clone();
        match &mut mutation {
            TextMutation::Write(args) => args.path = normalized,
            TextMutation::Edit(args) => args.path = normalized,
        }
        let task = Task {
            workspace: workspace.into(),
            root: admitted,
            operation: operation.into(),
            mutation: Arc::new(mutation),
            grant: grant.clone(),
            journal: journal.cloned(),
            source_mode,
            baseline: baseline.cloned(),
            lease: format!("write:{}", Uuid::new_v4()),
            cancellation,
            expected_key: None,
            live_root: None,
        };
        task.authorize(self)?;
        Ok(task)
    }
}
