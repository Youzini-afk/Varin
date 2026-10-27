//! Physical identity resolution never runs on the Storage owner. The existing
//! lease table and waiter queue remain the only exclusion/fairness authority.
use super::file_resource_leases::{
    canonical_lease_path, overlaps, FileLeaseRequest, FileLeaseWaiter,
};
use super::file_resources::{parse_file_params, resolve_admitted_resource};
use super::*;
use crate::model::CanonicalFileLeaseResource;
use crate::protocol_generated::KernelFileLeaseAcquireParams;

pub(crate) struct Task {
    pub params: Value,
    pub cancellation: Arc<AtomicBool>,
    method: &'static str,
    root: FileRoot,
    grant: Grant,
    resources: Vec<FileLeaseResource>,
    expected: Option<Vec<CanonicalFileLeaseResource>>,
}
pub(crate) struct Resolved(FileLeaseRequest);
pub(crate) struct Continuation {
    pub request_id: String,
    pub grant_id: String,
    pub task: Task,
}
impl Task {
    pub(crate) fn method(&self) -> &'static str {
        self.method
    }
    fn check(&self) -> Result<(), KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    }
    pub(crate) fn run(&self) -> Result<Resolved, KernelError> {
        self.check()?;
        let resolve = || -> Result<Vec<CanonicalFileLeaseResource>, KernelError> {
            self.resources
                .iter()
                .map(|resource| {
                    self.check()?;
                    let resolved =
                        resolve_admitted_resource(&self.root, &resource.path, &self.grant, true)?;
                    Ok(CanonicalFileLeaseResource {
                        absolute: canonical_lease_path(resolved.absolute)?,
                        subtree: resource.subtree,
                    })
                })
                .collect()
        };
        let canonical = resolve()?;
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| expected != &canonical)
            || resolve()? != canonical
        {
            return Err(KernelError::Authorization(
                "queued file resource identity changed".into(),
            ));
        }
        self.check()?;
        Ok(Resolved(FileLeaseRequest {
            params: parse_file_params(&self.params)?,
            resources: self.resources.clone(),
            canonical_resources: canonical,
        }))
    }
}
impl Storage {
    pub(crate) fn prepare_file_lease_task(
        &self,
        method: &str,
        value: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Task, KernelError> {
        let method = match method {
            "file.lease.acquire" => "file.lease.acquire",
            "file.lease.check" => "file.lease.check",
            "file.lease.wait" => "file.lease.wait",
            _ => return Err(KernelError::Protocol("Unknown file lease action".into())),
        };
        let params: KernelFileLeaseAcquireParams = parse_file_params(value)?;
        let root = self.admitted_file_root(&params.root_id, grant)?;
        if root.owning_workspace_id != params.workspace_id {
            return Err(KernelError::Authorization(
                "File lease workspace differs from its original root".into(),
            ));
        }
        let resources = Self::parse_lease_resources(&params)?;
        if resources
            .iter()
            .any(|resource| !path_allowed(grant, &resource.path))
        {
            return Err(KernelError::Authorization(
                "File lease is outside its original path scope".into(),
            ));
        }
        let task = Task {
            params: super::file_resources::file_params_value(value),
            cancellation,
            method,
            root,
            grant: grant.clone(),
            resources,
            expected: None,
        };
        task.check()?;
        Ok(task)
    }
    pub(crate) fn finish_file_lease_task(
        &mut self,
        request: &str,
        task: &Task,
        result: Result<Resolved, KernelError>,
        grant: &Grant,
    ) -> Result<Option<Value>, KernelError> {
        let outcome = (|| {
            task.check()?;
            let root = self.admitted_file_root(&task.root.root_id, grant)?;
            if grant.grant_id != task.grant.grant_id
                || root.canonical_root != task.root.canonical_root
                || root.owning_workspace_id != task.root.owning_workspace_id
                || root.execution_workspace_id != task.root.execution_workspace_id
            {
                return Err(KernelError::Authorization(
                    "File lease authority changed during resolution".into(),
                ));
            }
            let prepared = result?.0;
            if task.method == "file.lease.check" {
                self.assert_canonical_file_lease(
                    grant,
                    &root.root_id,
                    &prepared.canonical_resources,
                    Some(&prepared.params.lease_id),
                )?;
                return Ok(Some(
                    json!({"leaseId":prepared.params.lease_id,"checked":true}),
                ));
            }
            let canonical = prepared.canonical_resources.clone();
            let lease_id = prepared.params.lease_id.clone();
            let value = self.acquire_file_lease_for(
                prepared,
                grant,
                (task.method == "file.lease.wait").then_some(request),
            )?;
            if task.method != "file.lease.wait" || value["status"] == "acquired" {
                return Ok(Some(value));
            }
            if self.file_lease_waiters.iter().any(|waiter| {
                waiter.lease_id == lease_id
                    && (waiter.grant_id != grant.grant_id || waiter.params != task.params)
            }) {
                return Err(KernelError::Authorization(
                    "queued file lease belongs to a different request".into(),
                ));
            }
            if let Some(waiter) = self
                .file_lease_waiters
                .iter_mut()
                .find(|waiter| waiter.request_id == request)
            {
                waiter.resolving = false;
            } else {
                self.file_lease_waiters.push_back(FileLeaseWaiter {
                    request_id: request.into(),
                    params: task.params.clone(),
                    grant_id: grant.grant_id.clone(),
                    lease_id,
                    canonical_resources: canonical,
                    cancellation: task.cancellation.clone(),
                    resolving: false,
                });
            }
            Ok(None)
        })();
        if !matches!(outcome, Ok(None)) {
            self.finish_file_lease_waiter(request);
        }
        outcome
    }
    pub(crate) fn finish_file_lease_waiter(&mut self, request: &str) {
        let before = self.file_lease_waiters.len();
        self.file_lease_waiters
            .retain(|waiter| waiter.request_id != request);
        if before != self.file_lease_waiters.len() {
            self.notify_file_lease_waiters();
        }
    }
    pub(crate) fn prepare_file_lease_waiters(
        &mut self,
        epoch: &str,
        host: &str,
        generation: &str,
    ) -> (Vec<(String, Result<Value, KernelError>)>, Vec<Continuation>) {
        let pending = std::mem::take(&mut self.file_lease_waiters);
        let (mut completed, mut tasks) = (Vec::new(), Vec::new());
        for mut waiter in pending {
            if waiter.resolving {
                self.file_lease_waiters.push_back(waiter);
                continue;
            }
            let blocked = self.file_leases.values().any(|lease| {
                waiter.canonical_resources.iter().any(|resource| {
                    lease
                        .canonical_resources
                        .iter()
                        .any(|held| overlaps(resource, held))
                })
            }) || self.file_lease_waiters.iter().any(|earlier| {
                waiter.canonical_resources.iter().any(|resource| {
                    earlier
                        .canonical_resources
                        .iter()
                        .any(|held| overlaps(resource, held))
                })
            });
            // Recheck revoked/cancelled owners even while their physical scope
            // remains blocked. A failed earlier owner must not reserve the queue.
            let prepared = if waiter.cancellation.load(Ordering::Acquire) {
                Err(KernelError::Cancelled)
            } else {
                self.authorize(
                    Some(&waiter.grant_id),
                    epoch,
                    host,
                    generation,
                    "file.lease.wait",
                    &waiter.params,
                )
                .and_then(|(grant, params)| {
                    self.prepare_file_lease_task(
                        "file.lease.wait",
                        &params,
                        &grant,
                        waiter.cancellation.clone(),
                    )
                })
            };
            match prepared {
                Err(error) => completed.push((waiter.request_id, Err(error))),
                Ok(_) if blocked => self.file_lease_waiters.push_back(waiter),
                Ok(mut task) => {
                    task.expected = Some(waiter.canonical_resources.clone());
                    waiter.resolving = true;
                    tasks.push(Continuation {
                        request_id: waiter.request_id.clone(),
                        grant_id: waiter.grant_id.clone(),
                        task,
                    });
                    self.file_lease_waiters.push_back(waiter);
                }
            }
        }
        (completed, tasks)
    }
}
