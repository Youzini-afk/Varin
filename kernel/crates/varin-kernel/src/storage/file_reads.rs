//! Root/path resolution, opening, hashing and final filesystem validation all
//! run on the file worker. Storage only admits and rechecks its original records;
//! native filesystem callbacks can therefore use that same Storage owner.
use super::file_resource_leases::{canonical_lease_path, covers};
use super::file_resources::{
    file_mode, normalized_relative_path, resolve_admitted_resource, FileState,
};
use super::*;

pub(crate) struct FileReadTask {
    _native_retention:Option<Arc<super::native_sources::NativeReadRetention>>,
    pub params: Value,
    pub cancellation: Arc<AtomicBool>,
    root: FileRoot,
    grant: Grant,
    leases: Vec<FileLease>,
    response: bool,
    identity_only: bool,
    regular_only: bool,
    retained_lease: bool,
    identity_method: Option<&'static str>,
    expected_key: Option<String>,
    live_root: Option<varin_runtime::catalog::launches::LiveRoot>,
    #[cfg(test)]
    hold: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
pub(crate) struct PreparedFileRead {
    pub value: Value,
    pub state: FileState,
    resource: crate::model::CanonicalFileLeaseResource,
}
fn unchanged(before: &fs::Metadata, after: &fs::Metadata) -> io::Result<bool> {
    #[allow(unused_mut)]
    let mut same = after.is_file()
        && !after.file_type().is_symlink()
        && before.len() == after.len()
        && before.modified()? == after.modified()?
        && file_mode(before) == file_mode(after);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        same &= before.dev() == after.dev() && before.ino() == after.ino();
    }
    Ok(same)
}
impl FileReadTask {
    #[cfg(test)]
    pub(crate) fn hold_at(&mut self, hold: Box<dyn FnOnce() + Send>) {
        *self.hold.get_mut().unwrap() = Some(hold);
    }
    pub(crate) fn identity_only(mut self) -> Self {
        self.identity_only = true;
        self
    }
    pub(crate) fn mutation_identity(mut self) -> Self {
        self.identity_only = true;
        self.identity_method = Some("file.apply");
        self
    }
    pub(crate) fn regular_identity(mut self) -> Self {
        self.identity_only = true;
        self.regular_only = true;
        self
    }
    pub(crate) fn method(&self) -> &'static str {
        if let Some(method) = self.identity_method { method }
        else if self.regular_only {
            "file.read.check"
        } else {
            "file.read"
        }
    }
    pub(crate) fn with_expected_key(mut self, key: String) -> Self {
        self.expected_key = Some(key);
        self
    }
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
    fn canonical(
        &self,
        absolute: &Path,
    ) -> Result<crate::model::CanonicalFileLeaseResource, KernelError> {
        let canonical = crate::model::CanonicalFileLeaseResource {
            absolute: canonical_lease_path(absolute.to_path_buf())?,
            subtree: false,
        };
        let key = serde_json::to_string(&[
            "file",
            self.grant.host_id.as_str(),
            canonical
                .absolute
                .to_str()
                .ok_or_else(|| KernelError::Authorization("File resource is not UTF-8".into()))?,
        ])?;
        if self
            .expected_key
            .as_ref()
            .is_some_and(|expected| expected != &key)
        {
            return Err(KernelError::Authorization(
                "Canonical file resource changed after admission".into(),
            ));
        }
        // Resolving a scheduler key does not acquire or inspect file contents.
        // The actual read checks exclusion after its canonical turn is admitted.
        if self.identity_only {
            return Ok(canonical);
        }
        let selected = self.params["leaseId"].as_str();
        if let Some(id) = selected {
            let held = self
                .leases
                .iter()
                .find(|lease| lease.lease_id == id)
                .ok_or_else(|| {
                    KernelError::Operation("File read lease is no longer active".into())
                })?;
            if held.grant_id != self.grant.grant_id
                || held.root_id != self.root.root_id
                || !held
                    .canonical_resources
                    .iter()
                    .any(|resource| covers(resource, &canonical))
            {
                return Err(KernelError::Authorization(
                    "File read is outside its original lease".into(),
                ));
            }
        }
        for lease in &self.leases {
            if selected == Some(lease.lease_id.as_str()) {
                continue;
            }
            if lease
                .canonical_resources
                .iter()
                .any(|held| covers(held, &canonical))
            {
                return Err(KernelError::Operation(format!(
                    "File resource is busy under lease {}",
                    lease.lease_id
                )));
            }
        }
        Ok(canonical)
    }
    pub(crate) fn run(&self) -> Result<PreparedFileRead, KernelError> {
        #[cfg(test)]
        if let Some(hold) = self.hold.lock().unwrap().take() {
            hold();
        }
        self.check()?;
        if let Some(root) = &self.live_root {
            if root.host_id != self.grant.host_id
                || root.root_id != self.root.root_id
                || fs::canonicalize(&root.canonical_root)? != self.root.canonical_root
            {
                return Err(KernelError::Authorization(
                    "Live source environment identity changed".into(),
                ));
            }
        }
        let requested = self.params["path"].as_str().expect("admitted path");
        let resource = resolve_admitted_resource(&self.root, requested, &self.grant, false)?;
        let canonical = self.canonical(&resource.absolute)?;
        if self.identity_only {
            if self.regular_only {
                let metadata = fs::symlink_metadata(&resource.absolute)?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(KernelError::Authorization(
                        "Retrieval read admission requires a regular file, not a symlink".into(),
                    ));
                }
                let after = resolve_admitted_resource(&self.root, requested, &self.grant, false)?;
                if after.absolute != resource.absolute
                    || self.canonical(&after.absolute)? != canonical
                {
                    return Err(KernelError::Authorization(
                        "Canonical file resource changed during read admission".into(),
                    ));
                }
            }
            return Ok(PreparedFileRead {
                value: json!({"resourceKey":serde_json::to_string(&["file", self.grant.host_id.as_str(), canonical.absolute.to_str().unwrap()])?}),
                state: FileState::Unsupported,
                resource: canonical,
            });
        }
        let metadata = match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let simple = match metadata.as_ref() {
            None => Some(FileState::Missing),
            Some(meta) if meta.file_type().is_symlink() => Some(FileState::Symlink {
                native: None,
                symlink_target: fs::read_link(&resource.absolute)?
                    .into_os_string()
                    .into_string()
                    .map_err(|_| KernelError::Operation("Symlink target is not UTF-8".into()))?,
                mode: Some(file_mode(meta)),
            }),
            Some(meta) if meta.is_dir() => Some(FileState::Directory {
                native: None,
                mode: Some(file_mode(meta)),
            }),
            Some(meta) if !meta.is_file() => Some(FileState::Unsupported),
            _ => None,
        };
        if let Some(mut state) = simple {
            if matches!(state, FileState::Directory {..}|FileState::Symlink {..}) {
                let attributes=match &resource.native {Some(owner)=>owner.attributes(&resource.path)?,None=>crate::native_metadata::observe(&resource.absolute)?.attributes};
                if resource.native.is_some(){match &mut state{FileState::Directory{mode,..}|FileState::Symlink{mode,..}=>*mode=Some(attributes.mode),_=>()}}
                state.set_native(crate::native_metadata::recoverable(&attributes,resource.native.is_some())?);
            }
            self.check()?;
            let after = resolve_admitted_resource(&self.root, requested, &self.grant, false)?;
            if after.absolute != resource.absolute || self.canonical(&after.absolute)? != canonical
            {
                return Err(KernelError::Authorization(
                    "File resource changed while reading".into(),
                ));
            }
            let mut value = json!({"path":requested,"source":{"rootId":self.root.root_id},"missing":matches!(state,FileState::Missing)});
            if matches!(state, FileState::Missing) {
                value["readVersion"] = json!(super::file_mutations::read_version(
                    &self.root.root_id,
                    &resource.path,
                    &state
                )?);
            } else {
                value["state"] = serde_json::to_value(&state)?;
            }
            return Ok(PreparedFileRead {
                value,
                state,
                resource: canonical,
            });
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(&resource.absolute)?;
        let before = file.metadata()?;
        if !before.is_file() || !unchanged(metadata.as_ref().unwrap(), &before)? {
            return Err(KernelError::Operation("File changed before read".into()));
        }
        let start = self.params["offset"]
            .as_u64()
            .unwrap_or(0)
            .min(before.len());
        let length = self
            .params
            .get("length")
            .map(|value| {
                value
                    .as_u64()
                    .ok_or_else(|| KernelError::Operation("Invalid byte range".into()))
            })
            .transpose()?
            .unwrap_or(before.len().saturating_sub(start));
        if self.response
            && super::line_reads::LineRead::from_params(&self.params)?.is_none()
            && length > MAX_BLOB_RESPONSE_BYTES as u64
        {
            return Err(KernelError::Operation(
                "file is larger than one response frame; request a byte range".into(),
            ));
        }
        let end = start.saturating_add(length).min(before.len());
        let mut file = file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut hash = Sha256::new();
        let mut position = 0u64;
        // Three surrounding bytes are enough to align a UTF-8 codepoint.
        let from = start.saturating_sub(3);
        let to = end.saturating_add(3).min(before.len());
        let mut bytes = Vec::new();
        let mut lines = super::line_reads::LineRead::from_params(&self.params)?;
        bytes
            .try_reserve_exact(if lines.is_some() {
                0
            } else {
                (to - from) as usize
            })
            .map_err(|_| {
                KernelError::Operation("Insufficient memory for the requested file range".into())
            })?;
        let mut buffer = [0u8; 128 * 1024];
        while position < before.len() {
            self.check()?;
            let capacity = (before.len() - position).min(buffer.len() as u64) as usize;
            let count = file.read(&mut buffer[..capacity])?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            let next = position + count as u64;
            let left = from.max(position);
            let right = to.min(next);
            if let Some(lines) = &mut lines {
                lines.push(&buffer[..count])?;
            } else if left < right {
                bytes.extend_from_slice(
                    &buffer[(left - position) as usize..(right - position) as usize],
                );
            }
            position = next;
        }
        self.check()?;
        let after = file.metadata()?;
        let current = fs::symlink_metadata(&resource.absolute)?;
        if position != before.len() || !unchanged(&before, &after)? || !unchanged(&after, &current)?
        {
            return Err(KernelError::Operation(
                "file changed while being read".into(),
            ));
        }
        self.check()?;
        let resolved = super::file_resources::resolve_admitted_resource(
            &self.root,
            &resource.path,
            &self.grant,
            false,
        )?;
        if resolved.absolute != resource.absolute {
            return Err(KernelError::Authorization(
                "File pathname changed while reading".into(),
            ));
        }
        let content_hash = format!("sha256-{}", hex::encode(hash.finalize()));
        let mut state = FileState::RegularFile {
            native: None,
            object_hash: content_hash.clone(),
            byte_length: position,
            mode: Some(file_mode(&after)),
        };
        let attributes=match &resource.native{Some(owner)=>owner.attributes(&resource.path)?,None=>crate::native_metadata::observe(&resource.absolute)?.attributes};
        if resource.native.is_some(){if let FileState::RegularFile{mode,..}=&mut state{*mode=Some(attributes.mode);}}
        state.set_native(crate::native_metadata::recoverable(&attributes,resource.native.is_some())?);
        let version = super::file_mutations::read_version(
            self.params["rootId"].as_str().expect("admitted root"),
            &resource.path,
            &state,
        )?;
        if let Some(lines) = lines {
            let mut content = lines.content(position);
            content["hash"] = json!(content_hash);
            return Ok(PreparedFileRead {
                value: json!({"path":self.params["path"],"source":{"rootId":self.params["rootId"]},
                "missing":false,"readVersion":version,"content":content}),
                state,
                resource: canonical,
            });
        }
        let left = (start - from) as usize;
        let right = (end - from) as usize;
        let mut aligned_start = left;
        let mut aligned_end = right;
        if left != right {
            while aligned_start > 0 && bytes.get(aligned_start).is_some_and(|b| b & 0xc0 == 0x80) {
                aligned_start -= 1;
            }
            while aligned_end < bytes.len() && bytes[aligned_end] & 0xc0 == 0x80 {
                aligned_end += 1;
            }
        }
        let mut content = json!({"byteLength":position,"hash":content_hash});
        match std::str::from_utf8(&bytes[aligned_start..aligned_end]) {
            Ok(text) if !text.contains('\0') => {
                content["text"] = json!(text);
                content["offset"] = json!(from + aligned_start as u64);
                content["nextOffset"] = json!(from + aligned_end as u64);
                content["eof"] = json!(from + aligned_end as u64 >= position);
            }
            _ => {
                content["bytesBase64"] = json!(BASE64.encode(&bytes[left..right]));
                content["encoding"] = json!("base64");
                content["offset"] = json!(start);
                content["nextOffset"] = json!(end);
                content["eof"] = json!(end >= position);
            }
        }
        content["returnedBytes"] =
            json!(content["nextOffset"].as_u64().unwrap() - content["offset"].as_u64().unwrap());
        Ok(PreparedFileRead {
            value: json!({"path":self.params["path"],"source":{"rootId":self.params["rootId"]},
            "missing":false,"readVersion":version,"content":content}),
            state,
            resource: canonical,
        })
    }
}
impl Storage {
    pub(crate) fn prepare_file_read(
        &self,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<FileReadTask, KernelError> {
        self.prepare_file_read_inner(params, grant, cancellation, true, false)
    }
    pub(super) fn prepare_retained_mutation_read(&self, params: &Value, grant: &Grant, cancellation: Arc<AtomicBool>) -> Result<FileReadTask, KernelError> {
        self.prepare_file_read_inner(params, grant, cancellation, false, true)
    }
    fn prepare_file_read_inner(
        &self,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
        response: bool,
        retained_lease: bool,
    ) -> Result<FileReadTask, KernelError> {
        let root_id = params["rootId"]
            .as_str()
            .ok_or_else(|| KernelError::Authorization("Physical source root is missing".into()))?;
        let requested = params["path"]
            .as_str()
            .ok_or_else(|| KernelError::Operation("File path is missing".into()))?;
        let (path, _) = normalized_relative_path(requested, false)?;
        if !path_allowed(grant, &path) {
            return Err(KernelError::Authorization(
                "File read is outside grant scope".into(),
            ));
        }
        if let Some(id) = params["leaseId"].as_str() {
            if retained_lease {
                self.assert_retained_canonical_file_lease(grant, root_id, &[], id)?;
            } else { self.active_file_worker_lease(grant, root_id, id)?; }
        }
        let task = FileReadTask {
            _native_retention:self.retain_native_reader(root_id)?,
            params: params.clone(),
            cancellation,
            root: self.admitted_file_root(root_id, grant)?,
            grant: grant.clone(),
            leases: self.file_leases.values().cloned().collect(),
            response,
            identity_only: false,
            regular_only: false,
            retained_lease,
            identity_method: None,
            expected_key: None,
            live_root: None,
            #[cfg(test)]
            hold: Default::default(),
        };
        task.check()?;
        Ok(task)
    }
    pub(crate) fn finish_file_read(
        &mut self,
        task: &FileReadTask,
        result: Result<PreparedFileRead, KernelError>,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        task.check()?;
        let root = self.admitted_file_root(&task.root.root_id, grant)?;
        if root.canonical_root != task.root.canonical_root
            || root.owning_workspace_id != task.root.owning_workspace_id
            || root.execution_workspace_id != task.root.execution_workspace_id
            || grant.grant_id != task.grant.grant_id
        {
            return Err(KernelError::Authorization(
                "File read authority changed before completion".into(),
            ));
        }
        let prepared = result?;
        if !task.identity_only {
            if task.retained_lease {
                self.assert_retained_canonical_file_lease(grant, &root.root_id, &[prepared.resource], task.params["leaseId"].as_str().expect("retained mutation lease"))?;
            } else { self.assert_canonical_file_lease(
                grant,
                &root.root_id,
                &[prepared.resource],
                task.params["leaseId"].as_str(),
            )?; }
        }
        Ok(prepared.value)
    }
}
