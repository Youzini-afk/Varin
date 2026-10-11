//! Metadata inventory is a finite read, not a durable job or filesystem snapshot.
//! Storage owns root/grant admission; the worker retains those facts through actual
//! drainage and does all filesystem work, ordering, hashing and page construction.
//! Ordinary reads do not require a file lease. An existing capture caller may
//! retain its original lease until its inventory worker has actually stopped.
use super::file_resource_leases::{canonical_lease_path, covers, RetainedFileLease};
use super::file_resources::{
    normalized_relative_path, parse_file_params, resolve_admitted_resource, ResolvedFileResource,
};
use super::*;
use crate::protocol_generated::{KernelFileMeasureParams, KernelFileScanParams};

enum Query {
    Scan(KernelFileScanParams),
    Measure(KernelFileMeasureParams),
}

pub(crate) struct InventoryTask {
    query: Query,
    root: FileRoot,
    grant: Grant,
    lease: Option<FileLease>,
    cancellation: Arc<AtomicBool>,
    #[cfg(test)]
    traversal_hold: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

pub(crate) struct InventoryResult {
    value: Value,
}

impl InventoryTask {
    fn check_cancelled(&self) -> Result<(), KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn path(&self) -> &str {
        match &self.query {
            Query::Scan(params) => &params.path,
            Query::Measure(params) => &params.path,
        }
    }

    pub(crate) fn lease_id(&self) -> Option<&str> {
        self.lease.as_ref().map(|lease| lease.lease_id.as_str())
    }

    fn check_lease_resource(
        &self,
        resource: &ResolvedFileResource,
        subtree: bool,
    ) -> Result<(), KernelError> {
        let Some(lease) = &self.lease else {
            return Ok(());
        };
        let requested = crate::model::CanonicalFileLeaseResource {
            absolute: canonical_lease_path(resource.absolute.clone())?,
            subtree,
        };
        if !lease
            .canonical_resources
            .iter()
            .any(|held| covers(held, &requested))
        {
            return Err(KernelError::Authorization(
                "file resource is outside the held lease".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn run(&self) -> Result<InventoryResult, KernelError> {
        self.check_cancelled()?;
        let base = resolve_admitted_resource(&self.root, self.path(), &self.grant, true)?;
        let value = match &self.query {
            Query::Scan(params) => self.scan(params, &base)?,
            Query::Measure(_) => self.measure(&base)?,
        };
        self.check_cancelled()?;
        // Recheck the original admitted pathname after observation. This is still
        // a live metadata read, not an atomic snapshot or exclusion of OS writers.
        let after = resolve_admitted_resource(&self.root, self.path(), &self.grant, true)?;
        if after.absolute != base.absolute {
            return Err(KernelError::Authorization(
                "inventory source changed during observation".into(),
            ));
        }
        self.check_cancelled()?;
        Ok(InventoryResult { value })
    }

    fn directory_entries(&self, directory: &Path) -> Result<Vec<fs::DirEntry>, KernelError> {
        self.check_cancelled()?;
        let entries = fs::read_dir(directory)?;
        #[cfg(test)]
        if let Some(hold) = self.traversal_hold.lock().unwrap().take() {
            hold();
        }
        let mut result = Vec::new();
        for entry in entries {
            self.check_cancelled()?;
            result.push(entry?);
        }
        self.check_cancelled()?;
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn hold_traversal(&mut self, hold: Box<dyn FnOnce() + Send>) {
        *self.traversal_hold.get_mut().unwrap() = Some(hold);
    }

    fn fingerprint(&self, paths: &[String]) -> Result<String, KernelError> {
        struct DigestWriter<'a> {
            task: &'a InventoryTask,
            digest: Sha256,
        }
        impl Write for DigestWriter<'_> {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.task.cancellation.load(Ordering::Acquire) {
                    return Err(io::Error::other("inventory cancelled"));
                }
                self.digest.update(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        self.check_cancelled()?;
        let mut writer = DigestWriter {
            task: self,
            digest: Sha256::new(),
        };
        // Encode the same JSON path array as the original fingerprint without
        // cloning the complete inventory into another Value and byte buffer.
        let encoded = serde_json::to_writer(&mut writer, paths);
        self.check_cancelled()?;
        encoded?;
        Ok(format!("sha256-{}", hex::encode(writer.digest.finalize())))
    }

    fn scan_directory_paths(
        &self,
        base_path: &str,
        directory: &Path,
        prefix: &str,
        output: &mut Vec<String>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let mut entries = self.directory_entries(directory)?;
        entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
        for entry in entries {
            self.check_cancelled()?;
            let name = entry.file_name().into_string().map_err(|_| {
                KernelError::Operation("filesystem inventory contains a non-UTF-8 path".to_string())
            })?;
            if name == ".git" || name == ".varin" {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let full = if base_path.is_empty() {
                relative.clone()
            } else {
                format!("{base_path}/{relative}")
            };
            let allowed = path_allowed(&self.grant, &full);
            let may_contain_allowed = self.grant.path_scopes.iter().any(|scope| {
                scope.is_empty() || scope == &full || scope.starts_with(&(full.clone() + "/"))
            });
            if !allowed && !may_contain_allowed {
                continue;
            }
            let resource = resolve_admitted_resource(&self.root, &full, &self.grant, false)?;
            self.check_lease_resource(&resource, false)?;
            let metadata = match fs::symlink_metadata(&resource.absolute) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if allowed {
                output.push(relative.clone());
            }
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                self.scan_directory_paths(base_path, &resource.absolute, &relative, output)?;
            }
        }
        Ok(())
    }

    fn scan_paths(
        &self,
        base: &ResolvedFileResource,
        scopes: Option<&[String]>,
    ) -> Result<Vec<String>, KernelError> {
        let mut output = Vec::new();
        let effective_scopes = scopes
            .filter(|values| !values.is_empty())
            .map(|values| values.to_vec())
            .unwrap_or_else(|| vec![String::new()]);
        for raw_scope in effective_scopes {
            self.check_cancelled()?;
            let (scope, _) = normalized_relative_path(&raw_scope, true)?;
            if scope.is_empty() {
                self.check_lease_resource(base, true)?;
                self.scan_directory_paths(&base.path, &base.absolute, "", &mut output)?;
                continue;
            }
            let full = if base.path.is_empty() {
                scope.clone()
            } else {
                format!("{}/{}", base.path, scope)
            };
            if !path_allowed(&self.grant, &full) {
                return Err(KernelError::Authorization(format!(
                    "scan scope is outside grant scope: {full}"
                )));
            }
            let resource = resolve_admitted_resource(&self.root, &full, &self.grant, false)?;
            self.check_lease_resource(&resource, false)?;
            let metadata = match fs::symlink_metadata(&resource.absolute) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            output.push(scope.clone());
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                self.check_lease_resource(&resource, true)?;
                self.scan_directory_paths(&base.path, &resource.absolute, &scope, &mut output)?;
            }
        }
        self.check_cancelled()?;
        output.sort();
        self.check_cancelled()?;
        output.dedup();
        Ok(output)
    }

    fn measure_directory(
        &self,
        directory: &Path,
        logical: &mut u64,
        allocated: &mut u64,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let entries = self.directory_entries(directory)?;
        for entry in entries {
            self.check_cancelled()?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                self.measure_directory(&path, logical, allocated)?;
                continue;
            }
            *logical = logical.checked_add(metadata.len()).ok_or_else(|| {
                KernelError::Storage("materialized logical size overflow".to_string())
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                *allocated = allocated
                    .checked_add(metadata.blocks().saturating_mul(512))
                    .ok_or_else(|| {
                        KernelError::Storage("materialized allocated size overflow".to_string())
                    })?;
            }
            #[cfg(not(unix))]
            {
                let _ = allocated;
            }
        }
        Ok(())
    }

    fn scan(
        &self,
        params: &KernelFileScanParams,
        base: &ResolvedFileResource,
    ) -> Result<Value, KernelError> {
        let paths = self.scan_paths(base, params.scopes.as_deref())?;
        let fingerprint = self.fingerprint(&paths)?;
        let cursor = params.cursor.unwrap_or(0) as usize;
        if (cursor > 0 && params.expected_fingerprint.is_none())
            || params
                .expected_fingerprint
                .as_ref()
                .is_some_and(|expected| expected != &fingerprint)
        {
            return Err(KernelError::Operation(
                "file scan inventory changed or continuation fingerprint is missing".to_string(),
            ));
        }
        let page_size = params.page_size.unwrap_or(512).clamp(1, 4096) as usize;
        if cursor > paths.len() {
            return Err(KernelError::Operation(
                "file scan cursor is out of range".to_string(),
            ));
        }
        let end = (cursor + page_size).min(paths.len());
        let total = paths.len();
        let page = paths
            .into_iter()
            .skip(cursor)
            .take(end - cursor)
            .collect::<Vec<_>>();
        Ok(json!({
            "paths": page,
            "fingerprint": fingerprint,
            "cursor": cursor,
            "nextCursor": if end < total { Some(end) } else { None },
            "total": total,
        }))
    }

    fn measure(&self, resource: &ResolvedFileResource) -> Result<Value, KernelError> {
        let metadata = match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(json!({
                    "logicalBytes": Value::Null,
                    "allocatedBytes": Value::Null,
                    "unknown": true,
                    "missing": true,
                }));
            }
            Err(error) => return Err(error.into()),
        };
        let mut logical = 0u64;
        let mut allocated = 0u64;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            self.measure_directory(&resource.absolute, &mut logical, &mut allocated)?;
        } else {
            logical = metadata.len();
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                allocated = metadata.blocks().saturating_mul(512);
            }
        }
        #[cfg(unix)]
        let allocated_value = json!(allocated);
        #[cfg(not(unix))]
        let allocated_value = Value::Null;
        Ok(json!({
            "logicalBytes": logical,
            "allocatedBytes": allocated_value,
            "unknown": false,
            "missing": false,
        }))
    }
}

impl Storage {
    pub(crate) fn prepare_file_inventory(
        &mut self,
        method: &str,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<InventoryTask, KernelError> {
        let query = match method {
            "file.scan" => Query::Scan(parse_file_params(params)?),
            "file.measure" => Query::Measure(parse_file_params(params)?),
            _ => return Err(KernelError::Protocol("unknown inventory method".into())),
        };
        let root_id = match &query {
            Query::Scan(params) => &params.root_id,
            Query::Measure(params) => &params.root_id,
        };
        let lease = match &query {
            Query::Scan(params) => params
                .lease_id
                .as_deref()
                .map(|id| self.active_file_worker_lease(grant, root_id, id).cloned())
                .transpose()?,
            Query::Measure(_) => None,
        };
        let task = InventoryTask {
            root: self.admitted_file_root(root_id, grant)?,
            lease,
            query,
            grant: grant.clone(),
            cancellation,
            #[cfg(test)]
            traversal_hold: std::sync::Mutex::new(None),
        };
        task.check_cancelled()?;
        if let Some(id) = task.lease_id() {
            self.retained_file_leases.insert(
                id.to_owned(),
                RetainedFileLease {
                    release_requested: false,
                },
            );
        }
        Ok(task)
    }

    pub(crate) fn finish_file_inventory(
        &self,
        task: &InventoryTask,
        result: InventoryResult,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        task.check_cancelled()?;
        // Filesystem revalidation belongs to the drained worker. This boundary
        // compares only the original Storage-owned registration and authority.
        let root = self.admitted_file_root(&task.root.root_id, grant)?;
        if root.canonical_root != task.root.canonical_root
            || root.owning_workspace_id != task.root.owning_workspace_id
            || root.execution_workspace_id != task.root.execution_workspace_id
            || grant.grant_id != task.grant.grant_id
        {
            return Err(KernelError::Authorization(
                "inventory authority changed before completion".into(),
            ));
        }
        Ok(result.value)
    }
}
