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
    pub cancellation: Arc<AtomicBool>,
}
impl Task {
    fn authorize(&self, s: &Storage) -> Result<Grant, KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let grant = s.load_grant(&self.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != self.grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Root registration's original grant is no longer active".into(),
            ));
        }
        require_capability(&grant, "file.root.register")?;
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
            cancellation,
        };
        task.authorize(self)?;
        Ok(task)
    }
    fn register_file_root_metadata(
        &mut self,
        params: &Value,
        canonical: PathBuf,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params = self.validate_file_root_registration(params, grant)?;
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
            });
        Ok(
            json!({"rootId":id,"canonicalRoot":canonical,"executionWorkspaceId":params.execution_workspace_id}),
        )
    }
}
