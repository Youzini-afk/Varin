//! Cwd resolution and guardian startup never enter a mounted path on Storage's
//! control thread. The original process intent owns admission and final handles.
use super::file_effects::{Control, Local};
use super::file_resources::{
    file_params_value, normalized_relative_path, resolve_admitted_resource,
};
use super::*;

pub(super) enum Admission {
    Complete(Value),
    Launch(crate::process::launch::Launch),
}
#[derive(Clone)]
pub(crate) struct Task {
    params: Arc<Value>,
    root: FileRoot,
    grant: Grant,
    storage_root: PathBuf,
    pub cancellation: Arc<AtomicBool>,
    live_root: Option<varin_runtime::catalog::launches::LiveRoot>,
}
impl Task {
    pub(crate) fn with_live_root(
        mut self,
        root: Option<varin_runtime::catalog::launches::LiveRoot>,
    ) -> Self {
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
    fn authorize(&self, s: &Storage) -> Result<Grant, KernelError> {
        self.check()?;
        let grant = s.load_grant(&self.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != self.grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Original process grant is no longer active".into(),
            ));
        }
        require_capability(&grant, "process.spawn")?;
        let root = s.admitted_file_root(&self.root.root_id, &grant)?;
        if root.canonical_root != self.root.canonical_root
            || root.execution_workspace_id != self.root.execution_workspace_id
            || root.owning_workspace_id != self.root.owning_workspace_id
        {
            return Err(KernelError::Authorization(
                "Original process source changed".into(),
            ));
        }
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
    #[cfg(test)]
    pub(crate) fn run_local_resource(
        &self,
        s: &mut Storage,
    ) -> Result<Value, crate::tools::ResourceFailure> {
        self.run_local(s)
            .map_err(|error| crate::tools::ResourceFailure {
                error,
                dispatched: !s
                    .process_spawn_not_dispatched(self.params["processId"].as_str().unwrap())
                    .unwrap_or(false),
            })
    }
    pub(crate) fn run_resource(
        &self,
        mut port: workspace_session::StoragePort,
    ) -> Result<Value, crate::tools::ResourceFailure> {
        let result = self.run_with(&mut port);
        result.map_err(|error| {
            let not_dispatched = self
                .control(&mut port, |t, s| {
                    s.process_spawn_not_dispatched(
                        t.params["processId"].as_str().expect("admitted process ID"),
                    )
                })
                .unwrap_or(false);
            crate::tools::ResourceFailure {
                error,
                dispatched: !not_dispatched,
            }
        })
    }
    fn run_with(&self, owner: &mut impl Control) -> Result<Value, KernelError> {
        self.check()?;
        if let Some(root) = &self.live_root {
            if root.host_id != self.grant.host_id
                || root.root_id != self.root.root_id
                || fs::canonicalize(&root.canonical_root)? != self.root.canonical_root
            {
                return Err(KernelError::Authorization(
                    "Original process live source changed".into(),
                ));
            }
        }
        let resource = resolve_admitted_resource(
            &self.root,
            self.params["cwd"].as_str().expect("admitted cwd"),
            &self.grant,
            true,
        )?;
        let cwd = fs::canonicalize(&resource.absolute).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                KernelError::NotFound(format!(
                    "process working directory {:?} under the selected source root",
                    self.params["cwd"]
                ))
            } else {
                error.into()
            }
        })?;
        if !cwd.is_dir() {
            return Err(KernelError::Authorization(
                "process cwd escaped the registered directory".into(),
            ));
        }
        let relative = cwd
            .strip_prefix(&self.root.canonical_root)
            .map_err(|_| {
                KernelError::Authorization("process cwd escaped the registered directory".into())
            })?
            .to_str()
            .ok_or_else(|| KernelError::Authorization("process cwd is not UTF-8".into()))?
            .replace('\\', "/");
        if !path_allowed(&self.grant, &relative) {
            return Err(KernelError::Authorization(
                "process cwd is outside grant scope".into(),
            ));
        }
        let canonical = super::file_resource_leases::canonical_lease_path(cwd.clone())?;
        let launch = self.control(owner, move |t, s| {
            let grant = t.authorize(s)?;
            if !path_allowed(&grant, &relative) {
                return Err(KernelError::Authorization(
                    "Process cwd scope changed during admission".into(),
                ));
            }
            s.begin_process_launch(&t.params, &t.root, &cwd, &relative, &canonical, &grant)
        })?;
        let Admission::Launch(launch) = launch else {
            let Admission::Complete(value) = launch else {
                unreachable!()
            };
            return Ok(value);
        };
        let id = launch.id.clone();
        let configuration_possible = launch.configuration_possible.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.check()?;
            let path = crate::process::receipt_path(&self.storage_root, &id);
            fs::create_dir_all(path.parent().ok_or_else(|| {
                KernelError::Storage("process receipt directory is unavailable".into())
            })?)?;
            sync_directory(&self.storage_root)?;
            self.control(owner, |t, s| t.authorize(s).map(|_| ()))?;
            launch.run()
        }));
        let result = match result {
            Ok(result) => result,
            Err(_) if !configuration_possible.load(Ordering::Acquire) => Err(KernelError::Storage(
                "Guardian startup worker panicked before dispatch".into(),
            )),
            Err(_) => return self.control(owner, move |_, s| s.fail_uncertain_process_launch(&id)),
        };
        // Once startup is admitted, even failure returns through the original
        // receipt owner. Revocation cannot discard a guardian that already exists.
        self.control(owner, move |t, s| {
            let value = s.finish_process_launch(&id, result)?;
            if t.cancellation.load(Ordering::Acquire) {
                let _ = s.processes.kill(&id, true);
            }
            Ok(value)
        })
    }
}
impl Storage {
    pub(crate) fn prepare_process_spawn(
        &self,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Task, KernelError> {
        let params = file_params_value(params);
        let id = params["processId"]
            .as_str()
            .ok_or_else(|| KernelError::Operation("process processId is required".into()))?;
        if id.is_empty() || id.len() > 200 {
            return Err(KernelError::Operation("invalid process identity".into()));
        }
        let root = self.admitted_file_root(
            params["rootId"]
                .as_str()
                .ok_or_else(|| KernelError::Authorization("process root is missing".into()))?,
            grant,
        )?;
        if params["workspaceId"].as_str() != Some(root.owning_workspace_id.as_str()) {
            return Err(KernelError::Authorization(
                "process root workspace mismatch".into(),
            ));
        }
        normalized_relative_path(
            params["cwd"]
                .as_str()
                .ok_or_else(|| KernelError::Operation("process cwd is required".into()))?,
            true,
        )?;
        let task = Task {
            params: Arc::new(params),
            root,
            grant: grant.clone(),
            storage_root: self.root.clone(),
            cancellation,
            live_root: None,
        };
        task.authorize(self)?;
        Ok(task)
    }
}
