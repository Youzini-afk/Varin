//! One physical overlap boundary across all admitted workspace/root identities.
//! Grant/root ownership authorizes access; it must not partition disk exclusion.
use super::file_resources::{normalized_relative_path, parse_file_params};
use super::*;
use crate::model::CanonicalFileLeaseResource;
use crate::protocol_generated::{KernelFileLeaseAcquireParams, KernelFileLeaseReleaseParams};

pub(super) fn covers(
    held: &CanonicalFileLeaseResource,
    requested: &CanonicalFileLeaseResource,
) -> bool {
    if held.absolute == requested.absolute {
        return held.subtree || !requested.subtree;
    }
    held.subtree && requested.absolute.starts_with(&held.absolute)
}

pub(super) fn overlaps(
    left: &CanonicalFileLeaseResource,
    right: &CanonicalFileLeaseResource,
) -> bool {
    left.absolute == right.absolute
        || (left.subtree && right.absolute.starts_with(&left.absolute))
        || (right.subtree && left.absolute.starts_with(&right.absolute))
}

/// Parent components have already passed the shared path resolver. Preserve a symlink leaf:
/// file replacement changes the link itself, rather than its target.
pub(super) fn canonical_lease_path(resolved: PathBuf) -> Result<PathBuf, KernelError> {
    // Parent components are canonicalized by resolve_file_resource.
    // Preserve a symlink leaf: mutations replace the link, not its target.
    let absolute = match fs::symlink_metadata(&resolved) {
        Ok(metadata) if !metadata.file_type().is_symlink() => fs::canonicalize(&resolved)?,
        Ok(_) => resolved,
        // A file ancestor has no descendants, but their admitted physical path
        // still needs a lease for capture and a planned file/directory change.
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            resolved
        }
        Err(error) => return Err(error.into()),
    };
    #[cfg(windows)]
    let absolute = PathBuf::from(
        absolute
            .to_str()
            .ok_or_else(|| KernelError::Authorization("file lease path is not UTF-8".to_string()))?
            .to_lowercase(),
    );
    Ok(absolute)
}

pub(super) struct RetainedFileLease {
    pub release_requested: bool,
}

pub(super) struct FileLeaseWaiter {
    pub(super) request_id: String,
    pub(super) params: Value,
    pub(super) grant_id: String,
    pub(super) lease_id: String,
    pub(super) canonical_resources: Vec<CanonicalFileLeaseResource>,
    pub(super) cancellation: Arc<AtomicBool>,
    pub(super) resolving: bool,
}

pub(super) struct FileLeaseRequest {
    pub(super) params: KernelFileLeaseAcquireParams,
    pub(super) resources: Vec<FileLeaseResource>,
    pub(super) canonical_resources: Vec<CanonicalFileLeaseResource>,
}

impl Storage {
    pub(crate) fn set_file_lease_notify(&mut self, notify: impl Fn() + Send + Sync + 'static) {
        self.file_lease_notify = Some(Arc::new(notify));
    }

    pub(super) fn notify_file_lease_waiters(&self) {
        if !self.file_lease_waiters.is_empty() {
            if let Some(notify) = &self.file_lease_notify {
                notify();
            }
        }
    }

    /// Direct owner fixtures drive the same worker stages synchronously.
    #[cfg(test)]
    pub(crate) fn wait_file_lease(
        &mut self,
        request_id: &str,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Option<Value>, KernelError> {
        let task = self.prepare_file_lease_task("file.lease.wait", params, grant, cancellation)?;
        let result = task.run();
        self.finish_file_lease_task(request_id, &task, result, grant)
    }
    #[cfg(test)]
    pub(crate) fn settle_file_lease_waiters(
        &mut self,
        epoch: &str,
        host: &str,
        generation: &str,
    ) -> Vec<(String, Result<Value, KernelError>)> {
        let (mut completed, tasks) = self.prepare_file_lease_waiters(epoch, host, generation);
        for continuation in tasks {
            let result = continuation.task.run();
            let grant = self.load_grant(&continuation.grant_id);
            let result = grant.and_then(|grant| {
                self.finish_file_lease_task(
                    &continuation.request_id,
                    &continuation.task,
                    result,
                    &grant,
                )
            });
            match result {
                Ok(Some(value)) => completed.push((continuation.request_id, Ok(value))),
                Ok(None) => {}
                Err(error) => {
                    self.finish_file_lease_waiter(&continuation.request_id);
                    completed.push((continuation.request_id, Err(error)));
                }
            }
        }
        completed
    }

    pub(crate) fn cancel_file_lease_waiters(&mut self) -> Vec<String> {
        let pending = std::mem::take(&mut self.file_lease_waiters);
        let mut cancelled = Vec::new();
        for waiter in pending {
            waiter.cancellation.store(true, Ordering::Release);
            if waiter.resolving {
                self.file_lease_waiters.push_back(waiter);
            } else {
                cancelled.push(waiter.request_id);
            }
        }
        cancelled
    }

    pub(crate) fn finish_retained_file_lease(&mut self, lease_id: &str) {
        if self
            .retained_file_leases
            .remove(lease_id)
            .is_some_and(|lease| lease.release_requested)
        {
            if let Some(lease) = self.file_leases.remove(lease_id) {
                self.hint_file_root(&lease.root_id);
                self.notify_file_lease_waiters();
            }
        }
    }

    /// Same canonical file identity as actual leases, independent of alias roots and Run IDs.
    pub(crate) fn file_resource_key(
        &self,
        root_id: &str,
        path: &str,
        grant: &Grant,
    ) -> Result<String, KernelError> {
        let resolved = self.canonical_lease_resources(
            root_id,
            &[FileLeaseResource {
                path: path.into(),
                subtree: false,
            }],
            grant,
        )?;
        let absolute = resolved[0]
            .absolute
            .to_str()
            .ok_or_else(|| KernelError::Authorization("file resource path is not UTF-8".into()))?;
        Ok(serde_json::to_string(&[
            "file",
            grant.host_id.as_str(),
            absolute,
        ])?)
    }
    pub(super) fn canonical_lease_resources(
        &self,
        root_id: &str,
        resources: &[FileLeaseResource],
        grant: &Grant,
    ) -> Result<Vec<CanonicalFileLeaseResource>, KernelError> {
        resources
            .iter()
            .map(|resource| {
                let resolved = self.resolve_file_resource(root_id, &resource.path, grant, true)?;
                let absolute = canonical_lease_path(resolved.absolute)?;
                Ok(CanonicalFileLeaseResource {
                    absolute,
                    subtree: resource.subtree,
                })
            })
            .collect()
    }

    /// Observer reads share the original physical lease namespace. Only another
    /// known read worker is compatible; ordinary mutations still see every lease.
    pub(super) fn assert_file_observation_lease(
        &self,
        grant: &Grant,
        root_id: &str,
        paths: &[FileLeaseResource],
    ) -> Result<(), KernelError> {
        let requested = self.canonical_lease_resources(root_id, paths, grant)?;
        self.assert_file_observation_resources(&requested)
    }
    pub(super) fn assert_file_observation_resources(&self,requested:&[CanonicalFileLeaseResource])->Result<(),KernelError>{
        for lease in self.file_leases.values() {
            if self.is_file_observation_read_lease(&lease.lease_id) {
                continue;
            }
            if requested.iter().any(|resource| {
                lease
                    .canonical_resources
                    .iter()
                    .any(|held| overlaps(held, resource))
            }) {
                return Err(KernelError::FileObservationBusy);
            }
        }
        Ok(())
    }
    /// Original caller/root identity and sole active-worker check, without filesystem work.
    pub(super) fn active_file_worker_lease(
        &self,
        grant: &Grant,
        root_id: &str,
        lease_id: &str,
    ) -> Result<&FileLease, KernelError> {
        if self.retained_file_leases.contains_key(lease_id) {
            return Err(KernelError::Operation(
                "file lease is retained by an active file worker".into(),
            ));
        }
        let lease = self.file_leases.get(lease_id).ok_or_else(|| {
            KernelError::Operation("file resource lease is no longer active".to_string())
        })?;
        if lease.grant_id != grant.grant_id || lease.root_id != root_id {
            return Err(KernelError::Authorization(
                "file resource lease belongs to another grant or root".to_string(),
            ));
        }
        Ok(lease)
    }

    pub(super) fn assert_file_lease(
        &self,
        grant: &Grant,
        root_id: &str,
        paths: &[FileLeaseResource],
        lease_id: Option<&str>,
    ) -> Result<(), KernelError> {
        let requested = self.canonical_lease_resources(root_id, paths, grant)?;
        self.assert_canonical_file_lease(grant, root_id, &requested, lease_id)
    }

    /// Admission and retention use one resolved physical identity. A second path
    /// resolution between overlap checking and insertion could switch aliases.
    pub(super) fn assert_canonical_file_lease(
        &self,
        grant: &Grant,
        root_id: &str,
        requested: &[CanonicalFileLeaseResource],
        lease_id: Option<&str>,
    ) -> Result<(), KernelError> {
        self.check_canonical_file_lease(grant, root_id, requested, lease_id, false)
    }
    /// An inner read/apply borrows the enclosing executor's original lease. It
    /// cannot acquire another retention or release that executor's ownership.
    pub(super) fn assert_retained_canonical_file_lease(
        &self, grant: &Grant, root_id: &str, requested: &[CanonicalFileLeaseResource], lease_id: &str,
    ) -> Result<(), KernelError> {
        if !self.retained_file_leases.contains_key(lease_id) {
            return Err(KernelError::Storage("Original file worker retention is missing".into()));
        }
        self.check_canonical_file_lease(grant, root_id, requested, Some(lease_id), true)
    }
    fn check_canonical_file_lease(
        &self, grant: &Grant, root_id: &str, requested: &[CanonicalFileLeaseResource],
        lease_id: Option<&str>, retained: bool,
    ) -> Result<(), KernelError> {
        if let Some(lease_id) = lease_id {
            let lease = if retained {
                let lease = self.file_leases.get(lease_id).ok_or_else(||KernelError::Storage("Original worker lease is missing".into()))?;
                if lease.grant_id != grant.grant_id || lease.root_id != root_id {
                    return Err(KernelError::Authorization("Original worker lease changed owner".into()));
                }
                lease
            } else { self.active_file_worker_lease(grant, root_id, lease_id)? };
            if requested.iter().any(|resource| {
                !lease
                    .canonical_resources
                    .iter()
                    .any(|held| covers(held, resource))
            }) {
                return Err(KernelError::Authorization(
                    "file resource is outside the held lease".to_string(),
                ));
            }
        }
        for lease in self.file_leases.values() {
            if lease_id == Some(lease.lease_id.as_str()) {
                continue;
            }
            if requested.iter().any(|resource| {
                lease
                    .canonical_resources
                    .iter()
                    .any(|held| overlaps(held, resource))
            }) {
                return Err(KernelError::Operation(format!(
                    "file resource is busy under lease {}",
                    lease.lease_id
                )));
            }
        }
        Ok(())
    }

    pub(super) fn parse_lease_resources(
        params: &KernelFileLeaseAcquireParams,
    ) -> Result<Vec<FileLeaseResource>, KernelError> {
        let mut resources = params
            .resources
            .iter()
            .map(|resource| {
                let (path, _) = normalized_relative_path(&resource.path, true)?;
                let subtree = match resource.scope.as_str() {
                    "exact" => false,
                    "subtree" => true,
                    _ => {
                        return Err(KernelError::Protocol(
                            "file lease scope must be exact or subtree".to_string(),
                        ))
                    }
                };
                Ok(FileLeaseResource { path, subtree })
            })
            .collect::<Result<Vec<_>, KernelError>>()?;
        resources.sort_by(|a, b| a.path.cmp(&b.path).then(a.subtree.cmp(&b.subtree)));
        resources.dedup();
        if resources.is_empty() {
            return Err(KernelError::Operation(
                "file lease requires at least one resource".to_string(),
            ));
        }
        Ok(resources)
    }

    pub(super) fn file_lease_check(
        &self,
        value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileLeaseAcquireParams = parse_file_params(value)?;
        let resources = Self::parse_lease_resources(&params)?;
        self.assert_file_lease(grant, &params.root_id, &resources, Some(&params.lease_id))?;
        Ok(json!({"leaseId": params.lease_id, "checked": true}))
    }

    pub(super) fn file_lease_acquire(
        &mut self,
        value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let prepared = self.prepare_file_lease(value, grant)?;
        self.acquire_file_lease(prepared, grant)
    }

    fn prepare_file_lease(
        &self,
        value: &Value,
        grant: &Grant,
    ) -> Result<FileLeaseRequest, KernelError> {
        let params: KernelFileLeaseAcquireParams = parse_file_params(value)?;
        self.registered_file_root(&params.root_id, grant)?;
        let resources = Self::parse_lease_resources(&params)?;
        let canonical_resources =
            self.canonical_lease_resources(&params.root_id, &resources, grant)?;
        Ok(FileLeaseRequest {
            params,
            resources,
            canonical_resources,
        })
    }

    fn acquire_file_lease(
        &mut self,
        prepared: FileLeaseRequest,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        self.acquire_file_lease_for(prepared, grant, None)
    }
    pub(super) fn acquire_file_lease_for(
        &mut self,
        prepared: FileLeaseRequest,
        grant: &Grant,
        request_id: Option<&str>,
    ) -> Result<Value, KernelError> {
        let FileLeaseRequest {
            params,
            resources,
            canonical_resources,
        } = prepared;
        if let Some(existing) = self.file_leases.get(&params.lease_id) {
            if existing.grant_id != grant.grant_id
                || existing.root_id != params.root_id
                || existing.workspace_id != params.workspace_id
            {
                return Err(KernelError::Authorization(
                    "file lease id belongs to another resource owner".to_string(),
                ));
            }
            if existing.resources != resources
                || existing.canonical_resources != canonical_resources
            {
                return Err(KernelError::Operation(
                    "file lease id was reused with different resources or path identity"
                        .to_string(),
                ));
            }
            return Ok(json!({"leaseId": params.lease_id, "status": "acquired", "reused": true}));
        }
        for existing in self.file_leases.values() {
            if canonical_resources.iter().any(|resource| {
                existing
                    .canonical_resources
                    .iter()
                    .any(|held| overlaps(resource, held))
            }) {
                return Ok(
                    json!({"leaseId": params.lease_id, "status": "busy", "blockingLeaseId": existing.lease_id}),
                );
            }
        }
        for earlier in &self.file_lease_waiters {
            if request_id == Some(earlier.request_id.as_str()) {
                break;
            }
            if canonical_resources.iter().any(|resource| {
                earlier
                    .canonical_resources
                    .iter()
                    .any(|held| overlaps(resource, held))
            }) {
                return Ok(
                    json!({"leaseId":params.lease_id,"status":"busy","blockingLeaseId":earlier.lease_id}),
                );
            }
        }
        self.file_leases.insert(
            params.lease_id.clone(),
            FileLease {
                lease_id: params.lease_id.clone(),
                root_id: params.root_id,
                workspace_id: params.workspace_id,
                grant_id: grant.grant_id.clone(),
                resources,
                canonical_resources,
            },
        );
        Ok(json!({"leaseId": params.lease_id, "status": "acquired", "reused": false}))
    }

    pub(super) fn file_lease_release(
        &mut self,
        value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileLeaseReleaseParams = parse_file_params(value)?;
        let Some(existing) = self.file_leases.get(&params.lease_id) else {
            return Ok(json!({"leaseId": params.lease_id, "released": false}));
        };
        if existing.grant_id != grant.grant_id
            || existing.root_id != params.root_id
            || existing.workspace_id != params.workspace_id
        {
            return Err(KernelError::Authorization(
                "file lease belongs to another resource owner".to_string(),
            ));
        }
        if let Some(retained) = self.retained_file_leases.get_mut(&params.lease_id) {
            retained.release_requested = true;
            return Ok(json!({"leaseId": params.lease_id, "released": true, "deferred": true}));
        }
        self.file_leases.remove(&params.lease_id);
        self.hint_file_root(&params.root_id);
        self.notify_file_lease_waiters();
        Ok(json!({"leaseId": params.lease_id, "released": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn resource(path: &str, subtree: bool) -> CanonicalFileLeaseResource {
        CanonicalFileLeaseResource {
            absolute: PathBuf::from(path),
            subtree,
        }
    }
    #[test]
    fn overlap_is_symmetric_but_coverage_is_directional() {
        let parent = resource("root", true);
        let child = resource("root/child", true);
        assert!(overlaps(&parent, &child) && overlaps(&child, &parent));
        assert!(covers(&parent, &child));
        assert!(!covers(&child, &parent));
        assert!(!covers(&resource("root", false), &parent));
        assert!(!overlaps(&parent, &resource("root-other", true)));
    }
}
