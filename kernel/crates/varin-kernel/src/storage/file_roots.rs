//! Root registration proves the path on a worker. The same Storage owner admits
//! the identity and reconciles original journals through worker observations.
use super::file_effects::{Control, Local};
use super::file_resources::{file_params_value, file_root_identity, parse_file_params};
use super::*;
use crate::protocol_generated::KernelFileRootRegisterParams;

#[derive(Clone)]
pub(crate) struct Task {
    params: Value,
    grant: Grant,
    selected_execution: Option<String>,
    pub cancellation: Arc<AtomicBool>,
}
impl Task {
    fn authorize(&self, s: &Storage) -> Result<Grant, KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let mut grant = s.load_grant(&self.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != self.grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Root registration's original grant is no longer active".into(),
            ));
        }
        require_capability(&grant, "file.root.register")?;
        if let Some(execution)=&self.selected_execution {grant.execution_workspace=Some(execution.clone());}
        s.validate_file_root_registration(&self.params, &grant)?;
        Ok(grant)
    }
    fn control<T: Send + 'static>(
        &self,
        owner: &mut impl Control,
        work: impl FnOnce(&Task, &mut Storage) -> Result<T, KernelError> + Send + 'static,
    ) -> Result<T, KernelError> {
        let task = self.clone();
        owner.call(move |s| work(&task, s))
    }
    pub(crate) fn run(
        &self,
        mut port: workspace_session::StoragePort,
    ) -> Result<Value, KernelError> {
        self.run_with(&mut port)
    }
    pub(super) fn run_local(&self, s: &mut Storage) -> Result<Value, KernelError> {
        self.run_with(&mut Local(s))
    }
    fn run_with(&self, owner: &mut impl Control) -> Result<Value, KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let requested = self.params["canonicalRoot"]
            .as_str()
            .expect("validated root");
        let canonical = fs::canonicalize(requested)?;
        if !fs::metadata(&canonical)?.is_dir() {
            return Err(KernelError::Operation(
                "file root is not a directory".into(),
            ));
        }
        let proof = canonical.clone();
        let mut result = self.control(owner, move |t, s| {
            let grant = t.authorize(s)?;
            s.register_file_root_metadata(&t.params, proof, &grant)
        })?;
        if self.selected_execution.is_some(){
            if fs::canonicalize(requested)?!=canonical{return Err(KernelError::Authorization("Selected source root changed during registration".into()));}
            self.control(owner,|t,s|t.authorize(s).map(|_|()))?;
            // Original journal reconciliation remains with that source's owner;
            // selecting its directory does not re-admit its old write authority.
            result["reconciledOperations"]=json!(0);result["pendingOperations"]=json!(0);
            return Ok(result);
        }
        let selection = json!({"workspaceId":self.params["workspaceId"],"rootId":result["rootId"]});
        let inspection = self.control(owner, move |t, s| {
            s.prepare_file_inspection(
                "file.root.register",
                &selection,
                &t.authorize(s)?,
                t.cancellation.clone(),
            )
        })?;
        let counts = inspection.run_with(owner)?;
        if fs::canonicalize(requested)? != canonical || !fs::metadata(&canonical)?.is_dir() {
            return Err(KernelError::Authorization(
                "File root changed during registration".into(),
            ));
        }
        self.control(owner, |t, s| t.authorize(s).map(|_| ()))?;
        result["reconciledOperations"] = counts["reconciledOperations"].clone();
        result["pendingOperations"] = counts["pendingOperations"].clone();
        Ok(result)
    }
}
impl Storage {
    fn validate_file_root_registration(
        &self,
        params: &Value,
        grant: &Grant,
    ) -> Result<KernelFileRootRegisterParams, KernelError> {
        let params: KernelFileRootRegisterParams = parse_file_params(params)?;
        let owning = grant.owning_workspace.as_deref();
        let execution = grant.execution_workspace.as_deref().or(owning);
        if (owning != Some(params.workspace_id.as_str())
            || execution != Some(params.execution_workspace_id.as_str()))
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "grant workspace identity does not match file root registration".into(),
            ));
        }
        if !Path::new(&params.canonical_root).is_absolute() {
            return Err(KernelError::Authorization(
                "file root must be absolute".into(),
            ));
        }
        Ok(params)
    }
    pub(crate) fn prepare_file_root_registration(
        &self,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Task, KernelError> {
        self.validate_file_root_registration(params, grant)?;
        let task = Task {
            params: file_params_value(params),
            grant: grant.clone(),
            selected_execution: None,
            cancellation,
        };
        task.authorize(self)?;
        Ok(task)
    }
    pub(super) fn selected_file_root_register(&mut self, params:&Value, original:&Grant, execution:&str)->Result<Value,KernelError>{
        let mut selected=original.clone();selected.execution_workspace=Some(execution.into());
        self.validate_file_root_registration(params,&selected)?;
        let task=Task{params:file_params_value(params),grant:original.clone(),selected_execution:Some(execution.into()),cancellation:self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false)))};
        task.authorize(self)?;task.run_local(self)
    }
    // Cleanup owns an existing execution-view receipt and no longer has an
    // active Run grant. Register only Storage's own root, never an arbitrary
    // caller path, so the original exclusion can drain after revocation.
    pub(super) fn storage_cleanup_file_root(&mut self, grant:&Grant)->Result<Value,KernelError>{
        let workspace=grant.owning_workspace.as_deref().ok_or_else(||KernelError::Authorization("Cleanup workspace missing".into()))?;
        let execution=grant.execution_workspace.as_deref().unwrap_or(workspace);
        let canonical=fs::canonicalize(&self.root)?;
        self.register_file_root_metadata(&json!({"workspaceId":workspace,"executionWorkspaceId":execution,"canonicalRoot":canonical}),canonical.clone(),grant)
    }
    fn register_file_root_metadata(
        &mut self,
        params: &Value,
        canonical: PathBuf,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params = self.validate_file_root_registration(params, grant)?;
        if let Some(root)=self.file_roots.values().find(|root|root.canonical_root==canonical
            && self.native_file_roots.contains_key(&root.root_id)).cloned(){
            let (branch,generation,scope)=self.native_file_roots[&root.root_id].clone();
            if self.native_closing_roots.contains(&(branch.clone(),generation.clone())){
                return Err(KernelError::Authorization("Native workspace is closing".into()));
            }
            let session=self.workspace_sessions.get(&branch).and_then(std::sync::Weak::upgrade)
                .ok_or_else(||KernelError::Authorization("Native workspace is no longer mounted".into()))?;
            session.check_open()?;
            if session.identity().to_string()!=generation{return Err(KernelError::Authorization("Native workspace mount generation changed".into()));}
            let id=super::native_sources::root_id(&params.workspace_id,&params.execution_workspace_id,&branch,&scope);
            self.file_roots.insert(id.clone(),FileRoot{root_id:id.clone(),owning_workspace_id:params.workspace_id,
                execution_workspace_id:params.execution_workspace_id.clone(),canonical_root:canonical.clone(),native:root.native.clone()});
            self.native_file_roots.insert(id.clone(),(branch,generation,scope));
            return Ok(json!({"rootId":id,"canonicalRoot":canonical,"executionWorkspaceId":params.execution_workspace_id}));
        }
        if canonical.starts_with(self.root.join("managed").join("workspaces")){
            return Err(KernelError::Authorization("Native mount directories require their original workspace binding".into()));
        }
        let id = file_root_identity(
            &params.workspace_id,
            &params.execution_workspace_id,
            &canonical,
        );
        self.file_roots
            .entry(id.clone())
            .or_insert_with(|| FileRoot {
                root_id: id.clone(),
                owning_workspace_id: params.workspace_id,
                execution_workspace_id: params.execution_workspace_id.clone(),
                canonical_root: canonical.clone(),
                native: None,
            });
        Ok(
            json!({"rootId":id,"canonicalRoot":canonical,"executionWorkspaceId":params.execution_workspace_id}),
        )
    }
}
