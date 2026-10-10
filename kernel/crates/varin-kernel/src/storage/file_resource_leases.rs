//! One physical overlap boundary across all admitted workspace/root identities.
//! Grant/root ownership authorizes access; it must not partition disk exclusion.
use super::file_resources::{normalized_relative_path, parse_file_params};
use super::*;
use crate::model::CanonicalFileLeaseResource;
use crate::protocol_generated::{KernelFileLeaseAcquireParams, KernelFileLeaseReleaseParams};

fn covers(held: &CanonicalFileLeaseResource, requested: &CanonicalFileLeaseResource) -> bool {
    if held.absolute == requested.absolute {
        return held.subtree || !requested.subtree;
    }
    held.subtree && requested.absolute.starts_with(&held.absolute)
}

fn overlaps(left: &CanonicalFileLeaseResource, right: &CanonicalFileLeaseResource) -> bool {
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
        Ok(metadata) if !metadata.file_type().is_symlink() => {
            fs::canonicalize(&resolved)?
        }
        Ok(_) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound => resolved,
        Err(error) => return Err(error.into()),
    };
    #[cfg(windows)]
    let absolute = PathBuf::from(
        absolute
            .to_str()
            .ok_or_else(|| {
                KernelError::Authorization("file lease path is not UTF-8".to_string())
            })?
            .to_lowercase(),
    );
    Ok(absolute)
}

pub(super) struct RetainedFileLease {
    pub release_requested: bool,
}

impl Storage {
    pub(crate) fn finish_retained_file_lease(&mut self, lease_id: &str) {
        if self
            .retained_file_leases
            .remove(lease_id)
            .is_some_and(|lease| lease.release_requested)
        {
            self.file_leases.remove(lease_id);
        }
    }

    /// Same canonical file identity as actual leases, independent of alias roots and Run IDs.
    pub(crate) fn file_resource_key(&self, root_id: &str, path: &str, grant: &Grant) -> Result<String, KernelError> {
        let resolved = self.canonical_lease_resources(root_id, &[FileLeaseResource { path: path.into(), subtree: false }], grant)?;
        let absolute = resolved[0].absolute.to_str().ok_or_else(|| KernelError::Authorization("file resource path is not UTF-8".into()))?;
        Ok(serde_json::to_string(&["file", absolute])?)
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

    pub(super) fn assert_file_lease(
        &self,
        grant: &Grant,
        root_id: &str,
        paths: &[FileLeaseResource],
        lease_id: Option<&str>,
    ) -> Result<(), KernelError> {
        let requested = self.canonical_lease_resources(root_id, paths, grant)?;
        if let Some(lease_id) = lease_id {
            if self.retained_file_leases.contains_key(lease_id) {
                return Err(KernelError::Operation("file lease is retained by an active file worker".into()));
            }
            let lease = self.file_leases.get(lease_id).ok_or_else(|| {
                KernelError::Operation("file resource lease is no longer active".to_string())
            })?;
            if lease.grant_id != grant.grant_id || lease.root_id != root_id {
                return Err(KernelError::Authorization(
                    "file resource lease belongs to another grant or root".to_string(),
                ));
            }
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

    fn parse_lease_resources(
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
        let params: KernelFileLeaseAcquireParams = parse_file_params(value)?;
        self.registered_file_root(&params.root_id, grant)?;
        let resources = Self::parse_lease_resources(&params)?;
        let canonical_resources =
            self.canonical_lease_resources(&params.root_id, &resources, grant)?;
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
