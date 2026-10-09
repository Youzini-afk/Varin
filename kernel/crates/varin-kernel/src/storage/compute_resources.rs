//! One admitted native query owns one independent root reader reference.
//! Cancellation/revocation cannot free that reference while a worker is reading.
use super::*;
use super::file_resources::parse_file_params;
use crate::compute::{ObjectSource,Source,Task};
use crate::protocol_generated::{KernelComputeGrammarParams,KernelComputeStartParams,KernelComputeReadParams,KernelComputeHandleParams};
fn failure(message:impl Into<String>)->KernelError{KernelError::Operation(message.into())}
fn relative(value:&str)->Result<String,KernelError>{
    let path=value.replace('\\',"/");
    if path.contains('\0')||path.starts_with('/')||path.contains(':')||path.split('/').any(|s|s==".."){return Err(KernelError::Authorization("Computation path escaped its view".into()));}
    Ok(path.split('/').filter(|s|!s.is_empty()&&*s!=".").collect::<Vec<_>>().join("/"))
}
impl Storage {
    pub(crate) fn watch_compute(&self, id: &str, workspace_id: &str, grant: &Grant) -> Result<crate::compute::ComputeWatch, KernelError> {
        let job = self.computations.jobs.get(id).ok_or_else(|| failure("Computation handle is not available in this epoch"))?;
        if job.grant_id != grant.grant_id || job.workspace_id != workspace_id || job.epoch != grant.kernel_epoch {
            return Err(KernelError::Authorization("Computation handle belongs to another actor/workspace/epoch".into()));
        }
        Ok(job.watch())
    }
    pub(crate) fn sweep_compute_readers(&mut self)->Result<(),KernelError>{
        let done=self.computations.jobs.iter().filter(|(_,job)|job.done()).map(|(id,job)|(id.clone(),job.pin_id.clone(),job.revoked)).collect::<Vec<_>>();
        for(id,pin,revoked)in done{
            if let Some(pin)=pin{self.conn.execute("DELETE FROM pins WHERE pin_id=?1",params![pin])?;if let Some(job)=self.computations.jobs.get_mut(&id){job.pin_id=None;}}
            if revoked{self.computations.jobs.remove(&id);}
        }Ok(())
    }
    pub(crate) fn shutdown_computations(&mut self)->Result<(),KernelError>{self.computations.shutdown();self.sweep_compute_readers()}
    fn admit_compute(&mut self,value:&Value,grant:&Grant)->Result<Value,KernelError>{
        self.check_cancelled()?;
        let mut params:KernelComputeStartParams=parse_file_params(value)?;
        if params.job_id.is_empty()||params.job_id.len()>200{return Err(failure("Invalid computation identity"));}
        if !matches!(params.lane.as_str(),"foreground"|"background"){return Err(failure("Unknown computation scheduling lane"));}
        if !matches!(params.operation.as_str(),"read"|"bytes"|"list"|"inventory"|"search"|"structure"|"chunks"|"grammar"){return Err(failure("Unknown native computation operation"));}
        for(number,zero_allowed)in [(params.max_results,false),(params.before,true),(params.after,true),(params.start_line,false),(params.end_line,false),
            (params.byte_offset,true),(params.byte_length,true),(params.parse_budget_ms,true),(params.chunk_lines,false)]{
            if number.is_some_and(|n|n<if zero_allowed{0}else{1}||n>9_007_199_254_740_991){return Err(failure("Computation limits must be safe integers in their valid range"));}
        }
        if params.start_line.zip(params.end_line).is_some_and(|(a,b)|a>b){return Err(failure("Invalid line range"));}
        let hash=hash_json(value)?;
        if let Some(job)=self.computations.jobs.get(&params.job_id){
            if job.grant_id!=grant.grant_id||job.workspace_id!=params.workspace_id{return Err(KernelError::Authorization("Computation belongs to another actor/workspace".into()));}
            if job.params_hash!=hash{return Err(failure("Computation identity was reused with different parameters"));}
            return self.computations.read(&params.job_id,0,65536).map_err(failure);
        }
        let roots=params.paths.clone().unwrap_or_else(||vec![String::new()]).iter().map(|p|relative(p)).collect::<Result<Vec<_>,_>>()?;
        let scopes=grant.path_scopes.iter().map(|s|relative(s)).collect::<Result<Vec<_>,_>>()?;
        params.paths=Some(roots);
        if let Some(files)=params.files.as_mut(){for file in files{file.path=relative(&file.path)?;if !path_allowed(grant,&file.path){return Err(KernelError::Authorization("Requested file is outside grant scope".into()));}}}
        for paths in [&mut params.exclude_paths]{if let Some(paths)=paths{for path in paths{*path=relative(path)?;}}}
        let mut overlays=Vec::new();let mut seen=BTreeSet::new();
        for object in params.objects.as_deref().unwrap_or_default(){
            let path=relative(&object.path)?;
            if !seen.insert(path.clone()){return Err(failure("Duplicate fixed-view overlay path"));}
            if !path_allowed(grant,&path){return Err(KernelError::Authorization("Overlay path is outside grant scope".into()));}
            if object.missing==Some(true){
                if object.object_hash.is_some()||object.owner_id.is_some(){return Err(failure("A missing overlay must not include content"));}
                overlays.push(ObjectSource{path,revision:object.revision.clone(),hash:None,file:None});continue;
            }
            let owner=object.owner_id.as_deref().ok_or_else(||failure("An explicit object owner is required for fixed text"))?;
            let object_hash=object.object_hash.as_deref().ok_or_else(||failure("A content hash is required for fixed text"))?;
            let exists:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM object_owners WHERE owner_id=?1 AND blob_hash=?2 AND grant_id=?3 AND workspace_id=?4)",
                params![owner,object_hash,grant.grant_id,params.workspace_id],|row|row.get(0))?;
            if !exists{return Err(KernelError::Authorization("Fixed text object belongs to another owner, actor or workspace".into()));}
            // Open before handing the task over. Even explicit owner release
            // cannot invalidate this admitted reader; Windows GC may retry unlink.
            let file=File::open(object_path(&self.root,object_hash)?)?;
            overlays.push(ObjectSource{path,revision:object.revision.clone(),hash:Some(object_hash.into()),file:Some(file)});
        }
        if [params.pin_id.is_some(), params.root_id.is_some(), params.branch_id.is_some()].into_iter().filter(|present| *present).count() > 1 {
            return Err(failure("A query cannot merge multiple source authorities"));
        }
        if params.branch_id.is_some() != params.revision.is_some() || params.revision.is_some_and(|revision| revision < 0) {
            return Err(failure("A branch computation requires a fixed non-negative revision"));
        }
        let mut pin_id=None;let mut root=None;
        let source=if let Some(branch)=&params.branch_id {
            let observed=self.branch_read(&json!({"branchId":branch,"revision":params.revision,"includeEntries":false}))?;
            if observed["workspaceId"].as_str()!=Some(params.workspace_id.as_str()) {
                return Err(KernelError::Authorization("Branch workspace does not match computation".into()));
            }
            let hash=observed["root"].as_str().ok_or_else(||failure("Branch root identity is unavailable"))?.to_string();
            let reader_pin=format!("compute-reader:{}",Uuid::new_v4());
            self.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,?4,?4,?5,?6,1,?7)",
                params![reader_pin,branch,params.workspace_id,params.revision,hash,format!("native-reader:{}",grant.kernel_epoch),now_ms()])?;
            pin_id=Some(reader_pin);root=Some(hash.clone());
            Source::Tree{catalog:self.root.join("catalog.sqlite"),objects:self.root.clone(),root:hash}
        }else if let Some(pin)=&params.pin_id{
            let observed=self.pin_read(&json!({"pinId":pin,"includeEntries":false,"__pathScopes":scopes}),&grant.grant_id)?;
            if observed["workspaceId"].as_str()!=Some(params.workspace_id.as_str()){return Err(KernelError::Authorization("Pin workspace does not match computation".into()));}
            let hash=observed["root"].as_str().ok_or_else(||failure("Pin root identity is unavailable"))?.to_string();
            let reader_pin=format!("compute-reader:{}",Uuid::new_v4());
            self.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) SELECT ?1,branch_id,workspace_id,revision,write_revision,root_hash,?2,1,?3 FROM pins WHERE pin_id=?4",
                params![reader_pin,format!("native-reader:{}",grant.kernel_epoch),now_ms(),pin])?;
            pin_id=Some(reader_pin);root=Some(hash.clone());
            Source::Tree{catalog:self.root.join("catalog.sqlite"),objects:self.root.clone(),root:hash}
        }else if let Some(root_id)=&params.root_id{
            let admitted=self.registered_file_root(root_id,grant)?;
            if admitted.owning_workspace_id!=params.workspace_id{return Err(KernelError::Authorization("Root workspace does not match computation".into()));}
            Source::Disk{root:admitted.canonical_root}
        }else if params.objects.is_some(){Source::Objects}else{return Err(failure("Computation requires an admitted pin, root, or fixed text source"));};
        let selected=params.files.as_deref().unwrap_or_default().iter().filter_map(|f|f.recipe_id.as_ref()).collect::<BTreeSet<_>>();
        let mut recipes=HashMap::new();
        for id in selected{if let Some(recipe)=self.computations.recipes.get(id){recipes.insert(id.clone(),recipe.clone());}}
        let id=params.job_id.clone();
        let task=Task{params,source,overlays,scopes,recipes};
        if let Err(error)=self.computations.start(id.clone(),task,grant.grant_id.clone(),grant.kernel_epoch.clone(),pin_id.clone(),root,hash){
            if let Some(pin)=pin_id{self.conn.execute("DELETE FROM pins WHERE pin_id=?1",params![pin])?;}
            return Err(failure(error));
        }
        self.computations.read(&id,0,65536).map_err(failure)
    }
    fn register_compute_grammar(&mut self,value:&Value)->Result<Value,KernelError>{
        let mut recipe:KernelComputeGrammarParams=parse_file_params(value)?;
        if !matches!(recipe.style.as_str(),"code"|"json"|"tags"){return Err(failure("Unknown native grammar recipe style"));}
        let path=Path::new(&recipe.grammar_path);
        if !path.is_absolute(){return Err(KernelError::Authorization("Grammar requires a Host-admitted absolute path".into()));}
        recipe.grammar_path=fs::canonicalize(path)?.to_string_lossy().into();
        let bytes=fs::read(&recipe.grammar_path)?;
        // Preserve the existing installer/runtime ABI; inspect the actual wasm
        // exports rather than guessing a language from a file extension.
        let mut exports=Vec::new();
        for payload in wasmparser::Parser::new(0).parse_all(&bytes){
            if let wasmparser::Payload::ExportSection(section)=payload.map_err(|e|failure(e.to_string()))?{
                for export in section{let export=export.map_err(|e|failure(e.to_string()))?;
                    if export.kind==wasmparser::ExternalKind::Func&&export.name.starts_with("tree_sitter_")&&!export.name.contains("_external_scanner_"){
                        exports.push(export.name.trim_start_matches("tree_sitter_").to_string());
                    }
                }
            }
        }
        if recipe.grammar_name.is_empty(){if exports.len()!=1{return Err(failure("Grammar has no unambiguous language export"));}recipe.grammar_name=exports.remove(0);}
        if recipe.grammar_name.contains('\0')||!recipe.grammar_name.chars().all(|c|c.is_ascii_alphanumeric()||c=='_'){return Err(failure("Invalid native grammar export name"));}
        recipe.grammar_hash=Some(format!("sha256-{}",hex::encode(Sha256::digest(&bytes))));
        let identity=json!(["native-tree-sitter-0.25.10-r5",recipe.grammar_hash,recipe.grammar_name,recipe.style,recipe.definition_query,
            recipe.import_query,recipe.literal_call_query,recipe.max_depth,recipe.max_symbols]);
        let id=hash_json(&identity)?;recipe.recipe_id=id.clone();
        self.computations.recipes.insert(id.clone(),recipe);
        Ok(json!({"recipeId":id,"minAbi":tree_sitter::MIN_COMPATIBLE_LANGUAGE_VERSION,"maxAbi":tree_sitter::LANGUAGE_VERSION}))
    }
    pub(crate) fn dispatch_compute(&mut self,method:&str,value:&Value,grant:&Grant)->Result<Value,KernelError>{
        if method=="compute.grammar.register"{return self.register_compute_grammar(value);}
        if method=="compute.start"{return self.admit_compute(value,grant);}
        let (workspace,id)=if method=="compute.read"{let p:KernelComputeReadParams=parse_file_params(value)?;(p.workspace_id,p.job_id)}
            else{let p:KernelComputeHandleParams=parse_file_params(value)?;(p.workspace_id,p.job_id)};
        let job=self.computations.jobs.get(&id).ok_or_else(||failure("Computation handle is not available in this epoch"))?;
        if job.grant_id!=grant.grant_id||job.workspace_id!=workspace||job.epoch!=grant.kernel_epoch{return Err(KernelError::Authorization("Computation handle belongs to another actor/workspace/epoch".into()));}
        match method{
            "compute.read"=>{
                let p:KernelComputeReadParams=parse_file_params(value)?;
                if p.cursor<0||p.cursor>9_007_199_254_740_991||p.max_bytes.is_some_and(|n|n<=0||n>8*1024*1024){return Err(failure("Invalid computation cursor or read bound"));}
                self.computations.read(&id,p.cursor as u64,p.max_bytes.unwrap_or(65536) as usize).map_err(failure)
            },
            "compute.cancel"=>{self.computations.cancel(&id);Ok(json!({"requested":true,"stopped":self.computations.jobs.get(&id).is_some_and(|j|j.done())}))},
            "compute.release"=>{
                if !job.done(){return Err(failure("Native computation is still active; reader references are retained"));}
                if let Some(pin)=&job.pin_id{self.conn.execute("DELETE FROM pins WHERE pin_id=?1",params![pin])?;}
                self.computations.jobs.remove(&id);Ok(json!({"released":true}))
            },_=>Err(failure("Unknown computation method"))
        }
    }
}
