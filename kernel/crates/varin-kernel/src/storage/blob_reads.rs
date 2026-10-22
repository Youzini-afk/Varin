//! Object and physical-file readers, with short Storage admission and completion.
//! Transient retention keeps bytes alive; it never grants access to those bytes.
use super::*;

#[derive(Default)]
pub(super) struct BlobReadRoots(BTreeMap<String, Arc<()>>);
#[derive(Clone)]
pub(crate) struct BlobReadRetention {
    _lifetime: Arc<()>,
}
impl BlobReadRoots {
    pub(super) fn retain(&mut self, hash: &str) -> BlobReadRetention {
        BlobReadRetention {
            _lifetime: self.0.entry(hash.into()).or_default().clone(),
        }
    }
    pub(super) fn contains(&self, hash: &str) -> bool {
        self.0
            .get(hash)
            .is_some_and(|root| Arc::strong_count(root) > 1)
    }
    pub(super) fn active_hashes(&mut self) -> BTreeSet<String> {
        self.0.retain(|_, root| Arc::strong_count(root) > 1);
        self.0.keys().cloned().collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum BlobReadPhase {
    Verify,
    Read,
    Encoded,
}
pub(crate) struct ImmutableReadTask {
    params: Value,
    hash: String,
    path: PathBuf,
    byte_length: u64,
    offset: u64,
    length: usize,
    verify: bool,
    cancellation: Arc<AtomicBool>,
    retention: BlobReadRetention,
    file_output: Option<(String, Value)>,
    #[cfg(test)]
    hold: std::sync::Mutex<Option<(BlobReadPhase, Box<dyn FnOnce() + Send>)>>,
}
pub(crate) struct PreparedImmutableRead {
    value: Value,
    verified: bool,
}
pub(crate) enum BlobReadTask {
    Immutable(ImmutableReadTask),
    File(super::file_reads::FileReadTask),
}
pub(crate) enum PreparedBlobRead {
    Immutable(PreparedImmutableRead),
    File(super::file_reads::PreparedFileRead),
}
impl BlobReadTask {
    pub(crate) fn params(&self) -> &Value {
        match self { Self::Immutable(task) => &task.params, Self::File(task) => &task.params }
    }
    pub(crate) fn method(&self) -> &'static str {
        match self { Self::Immutable(_) => "storage.getBlob", Self::File(_) => "file.read" }
    }
    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        match self { Self::Immutable(task) => task.cancellation.clone(), Self::File(task) => task.cancellation.clone() }
    }
    pub(crate) fn retain_worker(&self) -> Option<BlobReadRetention> {
        match self { Self::Immutable(task) => Some(task.retention.clone()), Self::File(_) => None }
    }
    pub(crate) fn with_file_output(mut self, path: String, source: Value) -> Self {
        if let Self::Immutable(task) = &mut self { task.file_output = Some((path, source)); }
        self
    }
    #[cfg(test)]
    pub(crate) fn hold_at(&mut self, phase: BlobReadPhase, hold: Box<dyn FnOnce() + Send>) {
        match self { Self::Immutable(task) => task.hold_at(phase, hold), Self::File(task) => task.hold_at(hold) }
    }
    pub(crate) fn run(&self) -> Result<PreparedBlobRead, KernelError> {
        match self { Self::Immutable(task) => task.run().map(PreparedBlobRead::Immutable),
            Self::File(task) => task.run().map(PreparedBlobRead::File) }
    }
}
impl ImmutableReadTask {
    #[cfg(test)]
    pub(crate) fn hold_at(&mut self, phase: BlobReadPhase, hold: Box<dyn FnOnce() + Send>) {
        *self.hold.get_mut().unwrap() = Some((phase, hold));
    }
    fn checkpoint(&self, phase: BlobReadPhase) -> Result<(), KernelError> {
        #[cfg(test)]
        {
            let mut hold = self.hold.lock().unwrap();
            if hold
                .as_ref()
                .is_some_and(|(expected, _)| *expected == phase)
            {
                let (_, callback) = hold.take().unwrap();
                drop(hold);
                callback();
            }
        }
        #[cfg(not(test))]
        let _ = phase;
        self.check_cancelled()
    }
    fn check_cancelled(&self) -> Result<(), KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    }
    pub(crate) fn run(&self) -> Result<PreparedImmutableRead, KernelError> {
        self.check_cancelled()?;
        let mut file = File::open(&self.path)?;
        if file.metadata()?.len() != self.byte_length {
            return Err(KernelError::Storage(format!(
                "content object metadata is missing or corrupt: {}",
                self.hash
            )));
        }
        if self.verify {
            self.checkpoint(BlobReadPhase::Verify)?;
            let mut digest = Sha256::new();
            let mut length = 0u64;
            let mut buffer = [0u8; 128 * 1024];
            loop {
                self.check_cancelled()?;
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                digest.update(&buffer[..read]);
                length = length
                    .checked_add(read as u64)
                    .ok_or_else(|| KernelError::Storage("content length overflow".into()))?;
            }
            if length != self.byte_length
                || format!("sha256-{}", hex::encode(digest.finalize())) != self.hash
            {
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {}",
                    self.hash
                )));
            }
        }
        self.checkpoint(BlobReadPhase::Read)?;
        if let Some(mut lines) = super::line_reads::LineRead::from_params(&self.params)? {
            file.seek(SeekFrom::Start(0))?;
            let mut buffer = [0u8; 128 * 1024];
            while !lines.complete() {
                self.check_cancelled()?;
                let count = file.read(&mut buffer)?;
                if count == 0 { break; }
                lines.push(&buffer[..count])?;
            }
            let mut value = lines.content(self.byte_length);
            value["hash"] = json!(self.hash);
            if let Some((path, source)) = &self.file_output {
                value = json!({"path":path,"source":source,"missing":false,"content":value});
            }
            self.checkpoint(BlobReadPhase::Encoded)?;
            return Ok(PreparedImmutableRead { value, verified: self.verify });
        }
        let next = self.offset + self.length as u64;
        // Text file pages, like live file reads, include complete boundary
        // characters. Generic getBlob remains an exact raw byte-range API.
        let padded=self.file_output.is_some() && self.length>0;
        let from=if padded {self.offset.saturating_sub(3)} else {self.offset};
        let to=if padded {next.saturating_add(3).min(self.byte_length)} else {next};
        file.seek(SeekFrom::Start(from))?;
        let mut bytes = vec![0u8; (to-from) as usize];
        for part in bytes.chunks_mut(128 * 1024) {
            self.check_cancelled()?;
            file.read_exact(part)?;
        }
        self.check_cancelled()?;
        let mut value = json!({"hash":self.hash,"byteLength":self.byte_length,"offset":self.offset,"nextOffset":next,"eof":next >= self.byte_length});
        if let Some((path, source)) = &self.file_output {
            let left=(self.offset-from) as usize;let right=(next-from) as usize;
            let(mut start,mut end)=(left,right);
            if padded {
                while start>0 && bytes.get(start).is_some_and(|byte|byte & 0xc0==0x80) {start-=1;}
                while end<bytes.len() && bytes[end] & 0xc0==0x80 {end+=1;}
            }
            match std::str::from_utf8(&bytes[start..end]) {
                Ok(text) if !text.contains('\0') => {
                    value["text"]=json!(text);value["offset"]=json!(from+start as u64);
                    value["nextOffset"]=json!(from+end as u64);value["eof"]=json!(from+end as u64>=self.byte_length);
                },
                _ => {value["bytesBase64"]=json!(BASE64.encode(&bytes[left..right]));value["encoding"]=json!("base64");}
            }
            value = json!({"path":path,"source":source,"missing":false,"content":value});
        } else {
            value["bytesBase64"] = Value::String(BASE64.encode(bytes));
        }
        self.checkpoint(BlobReadPhase::Encoded)?;
        Ok(PreparedImmutableRead {
            value,
            verified: self.verify,
        })
    }
}
impl Storage {
    pub(crate) fn prepare_blob_read(
        &mut self,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<BlobReadTask, KernelError> {
        if cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let hash = params
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("hash is required".into()))?;
        self.validate_blob_read_source(
            params,
            hash,
            &grant.grant_id,
            grant.capabilities.contains("storage.admin"),
        )?;
        let path = object_path(&self.root, hash)?;
        let recorded: Option<i64> = self
            .conn
            .query_row(
                "SELECT byte_length FROM blobs WHERE hash=?1",
                [hash],
                |row| row.get(0),
            )
            .optional()?;
        let byte_length = recorded
            .and_then(|length| u64::try_from(length).ok())
            .ok_or_else(|| {
                KernelError::Storage(format!(
                    "content object metadata is missing or corrupt: {hash}"
                ))
            })?;
        let offset = match params.get("offset") {
            Some(value) => value.as_u64().ok_or_else(|| {
                KernelError::Operation("offset must be a non-negative integer".into())
            })?,
            None => 0,
        };
        let length = match params.get("length") {
            Some(value) => value.as_u64().ok_or_else(|| {
                KernelError::Operation("length must be a non-negative integer".into())
            })?,
            None => byte_length.saturating_sub(offset),
        };
        let line_read = super::line_reads::LineRead::from_params(params)?.is_some();
        if !line_read && byte_length > MAX_BLOB_RESPONSE_BYTES as u64 && params.get("length").is_none() {
            return Err(KernelError::Operation(
                "content object is larger than one response frame; request a byte range".into(),
            ));
        }
        if !line_read && length > MAX_BLOB_RESPONSE_BYTES as u64 {
            return Err(KernelError::Operation(
                "requested byte range is larger than one response frame".into(),
            ));
        }
        let start = offset.min(byte_length);
        let end = start.saturating_add(length).min(byte_length);
        let length = usize::try_from(end - start)
            .map_err(|_| KernelError::Operation("requested object range is too large".into()))?;
        Ok(BlobReadTask::Immutable(ImmutableReadTask {
            params: params.clone(),
            hash: hash.into(),
            path,
            byte_length,
            offset: start,
            length,
            verify: !self.verified_objects.contains(hash),
            cancellation,
            retention: self.blob_read_roots.retain(hash),
            file_output: None,
            #[cfg(test)]
            hold: Default::default(),
        }))
    }
    pub(crate) fn finish_blob_read(
        &mut self,
        task: &BlobReadTask,
        result: Result<PreparedBlobRead, KernelError>,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let task = match task {
            BlobReadTask::Immutable(task) => task,
            BlobReadTask::File(task) => return self.finish_file_read(task, result.and_then(|value| match value {
                PreparedBlobRead::File(value) => Ok(value),
                _ => Err(KernelError::Storage("file reader result changed".into())),
            }), grant),
        };
        task.check_cancelled()?;
        self.validate_blob_read_source(
            &task.params,
            &task.hash,
            &grant.grant_id,
            grant.capabilities.contains("storage.admin"),
        )?;
        let recorded: Option<i64> = self
            .conn
            .query_row(
                "SELECT byte_length FROM blobs WHERE hash=?1",
                [&task.hash],
                |row| row.get(0),
            )
            .optional()?;
        if recorded.and_then(|length| u64::try_from(length).ok()) != Some(task.byte_length) {
            return Err(KernelError::Storage(
                "content object metadata changed during read".into(),
            ));
        }
        let PreparedBlobRead::Immutable(prepared) = result? else { return Err(KernelError::Storage("blob reader result changed".into())); };
        if prepared.verified {
            self.verified_objects.insert(task.hash.clone());
        }
        Ok(prepared.value)
    }
    #[cfg(test)]
    pub(crate) fn clear_blob_verification(&mut self) {
        self.verified_objects.clear();
    }
    /// Synchronous unit fixtures drive the same stages; production uses Kernel workers.
    #[cfg(test)]
    pub(super) fn read_blob_fixture(
        &mut self,
        params: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let task = self.prepare_blob_read(
            params,
            grant,
            self.cancellation
                .clone()
                .unwrap_or_else(|| Arc::new(AtomicBool::new(false))),
        )?;
        let result = task.run();
        self.finish_blob_read(&task, result, grant)
    }
}
