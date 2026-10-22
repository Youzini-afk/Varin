//! Physical reads hash the complete observed file on a worker and retain only
//! the requested range. The Storage owner admits and rechecks the original root.
use super::file_resources::{FileState, file_mode};
use super::*;

pub(crate) struct FileReadTask {
    pub params: Value,
    pub cancellation: Arc<AtomicBool>,
    file: File,
    absolute: PathBuf,
    resource_path: String,
    before: fs::Metadata,
    grant: Grant,
    start: u64,
    end: u64,
    #[cfg(test)]
    hold: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
pub(crate) struct PreparedFileRead {
    pub value: Value,
    pub state: FileState,
    after: fs::Metadata,
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
    fn check(&self) -> Result<(), KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    }
    pub(crate) fn run(&self) -> Result<PreparedFileRead, KernelError> {
        #[cfg(test)]
        if let Some(hold) = self.hold.lock().unwrap().take() {
            hold();
        }
        self.check()?;
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut hash = Sha256::new();
        let mut position = 0u64;
        // Three surrounding bytes are enough to align a UTF-8 codepoint.
        let from = self.start.saturating_sub(3);
        let to = self.end.saturating_add(3).min(self.before.len());
        let mut bytes = Vec::new();
        let mut lines = super::line_reads::LineRead::from_params(&self.params)?;
        bytes.try_reserve_exact(if lines.is_some() { 0 } else { (to - from) as usize }).map_err(|_| {
            KernelError::Operation("Insufficient memory for the requested file range".into())
        })?;
        let mut buffer = [0u8; 128 * 1024];
        while position < self.before.len() {
            self.check()?;
            let capacity = (self.before.len() - position).min(buffer.len() as u64) as usize;
            let count = file.read(&mut buffer[..capacity])?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            let next = position + count as u64;
            let left = from.max(position);
            let right = to.min(next);
            if let Some(lines) = &mut lines { lines.push(&buffer[..count])?; }
            else if left < right {
                bytes.extend_from_slice(
                    &buffer[(left - position) as usize..(right - position) as usize],
                );
            }
            position = next;
        }
        self.check()?;
        let after = file.metadata()?;
        let current = fs::symlink_metadata(&self.absolute)?;
        if position != self.before.len()
            || !unchanged(&self.before, &after)?
            || !unchanged(&after, &current)?
        {
            return Err(KernelError::Operation(
                "file changed while being read".into(),
            ));
        }
        let content_hash=format!("sha256-{}",hex::encode(hash.finalize()));
        let state = FileState::RegularFile {
            object_hash: content_hash.clone(),
            byte_length: position,
            mode: Some(file_mode(&after)),
        };
        let version = super::file_mutations::read_version(
            self.params["rootId"].as_str().expect("admitted root"),
            &self.resource_path,
            &state,
        )?;
        if let Some(lines) = lines {
            let mut content=lines.content(position);content["hash"]=json!(content_hash);
            return Ok(PreparedFileRead { value: json!({"path":self.params["path"],"source":{"rootId":self.params["rootId"]},
                "missing":false,"readVersion":version,"content":content}), state, after });
        }
        let left = (self.start - from) as usize;
        let right = (self.end - from) as usize;
        let mut start = left;
        let mut end = right;
        if left != right {
            while start > 0 && bytes.get(start).is_some_and(|b| b & 0xc0 == 0x80) {
                start -= 1;
            }
            while end < bytes.len() && bytes[end] & 0xc0 == 0x80 {
                end += 1;
            }
        }
        let mut content = json!({"byteLength":position,"hash":content_hash});
        match std::str::from_utf8(&bytes[start..end]) {
            Ok(text) if !text.contains('\0') => {
                content["text"] = json!(text);
                content["offset"] = json!(from + start as u64);
                content["nextOffset"] = json!(from + end as u64);
                content["eof"] = json!(from + end as u64 >= position);
            }
            _ => {
                content["bytesBase64"] = json!(BASE64.encode(&bytes[left..right]));
                content["encoding"] = json!("base64");
                content["offset"] = json!(self.start);
                content["nextOffset"] = json!(self.end);
                content["eof"] = json!(self.end >= position);
            }
        }
        Ok(PreparedFileRead {
            value: json!({"path":self.params["path"],"source":{"rootId":self.params["rootId"]},
            "missing":false,"readVersion":version,"content":content}),
            state,
            after,
        })
    }
}

impl Storage {
    pub(crate) fn prepare_file_read(
        &mut self,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Option<FileReadTask>, KernelError> {
        self.prepare_file_read_inner(params, grant, cancellation, true)
    }
    pub(super) fn prepare_file_mutation_read(
        &mut self,
        params: &Value,
        grant: &Grant,
    ) -> Result<Option<FileReadTask>, KernelError> {
        let cancellation = self.cancellation.clone().unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        self.prepare_file_read_inner(params, grant, cancellation, false)
    }
    fn prepare_file_read_inner(
        &mut self,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
        response: bool,
    ) -> Result<Option<FileReadTask>, KernelError> {
        let resource = self.resolve_file_read(params, grant)?;
        match fs::symlink_metadata(&resource.absolute) {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            _ => {}
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
        if !before.is_file() {
            return Err(KernelError::Operation("file changed before read".into()));
        }
        let start = params["offset"].as_u64().unwrap_or(0).min(before.len());
        let length = params
            .get("length")
            .map(|value| {
                value
                    .as_u64()
                    .ok_or_else(|| KernelError::Operation("invalid byte range".into()))
            })
            .transpose()?
            .unwrap_or(before.len().saturating_sub(start));
        if response && super::line_reads::LineRead::from_params(params)?.is_none() && length > MAX_BLOB_RESPONSE_BYTES as u64 {
            return Err(KernelError::Operation(
                "file is larger than one response frame; request a byte range".into(),
            ));
        }
        let end = start.saturating_add(length).min(before.len());
        Ok(Some(FileReadTask {
            params: params.clone(),
            cancellation,
            file,
            absolute: resource.absolute,
            resource_path: resource.path,
            before,
            grant: grant.clone(),
            start,
            end,
            #[cfg(test)]
            hold: Default::default(),
        }))
    }

    pub(crate) fn finish_file_read(
        &mut self,
        task: &FileReadTask,
        result: Result<PreparedFileRead, KernelError>,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        task.check()?;
        let resource = self.resolve_file_read(&task.params, grant)?;
        let prepared = result?;
        if grant.grant_id != task.grant.grant_id
            || resource.absolute != task.absolute
            || !unchanged(&prepared.after, &fs::symlink_metadata(&resource.absolute)?)?
        {
            return Err(KernelError::Operation(
                "file changed while being read".into(),
            ));
        }
        Ok(prepared.value)
    }
}
