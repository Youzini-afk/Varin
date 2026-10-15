//! One immutable-object reader, with short Storage admission and completion.
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
pub(crate) struct BlobReadTask {
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
pub(crate) struct PreparedBlobRead {
    value: Value,
    verified: bool,
}
impl BlobReadTask {
    pub(crate) fn params(&self) -> &Value {
        &self.params
    }
    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancellation.clone()
    }
    /// The worker tail retains a separate reference while its completion is queued.
    pub(crate) fn retain_worker(&self) -> BlobReadRetention {
        BlobReadRetention {
            _lifetime: self.retention._lifetime.clone(),
        }
    }
    pub(crate) fn with_file_output(mut self, path: String, source: Value) -> Self {
        self.file_output = Some((path, source));
        self
    }
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
    pub(crate) fn run(&self) -> Result<PreparedBlobRead, KernelError> {
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
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = vec![0u8; self.length];
        for part in bytes.chunks_mut(128 * 1024) {
            self.check_cancelled()?;
            file.read_exact(part)?;
        }
        self.check_cancelled()?;
        let next = self.offset + self.length as u64;
        let mut value = json!({"hash":self.hash,"byteLength":self.byte_length,"offset":self.offset,"nextOffset":next,"eof":next >= self.byte_length});
        if let Some((path, source)) = &self.file_output {
            match String::from_utf8(bytes) {
                Ok(text) => value["text"] = Value::String(text),
                Err(error) => {
                    value["bytesBase64"] = Value::String(BASE64.encode(error.into_bytes()))
                }
            }
            value = json!({"path":path,"source":source,"missing":false,"content":value});
        } else {
            value["bytesBase64"] = Value::String(BASE64.encode(bytes));
        }
        self.checkpoint(BlobReadPhase::Encoded)?;
        Ok(PreparedBlobRead {
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
        if byte_length > MAX_BLOB_RESPONSE_BYTES as u64 && params.get("length").is_none() {
            return Err(KernelError::Operation(
                "content object is larger than one response frame; request a byte range".into(),
            ));
        }
        if length > MAX_BLOB_RESPONSE_BYTES as u64 {
            return Err(KernelError::Operation(
                "requested byte range is larger than one response frame".into(),
            ));
        }
        let start = offset.min(byte_length);
        let end = start.saturating_add(length).min(byte_length);
        let length = usize::try_from(end - start)
            .map_err(|_| KernelError::Operation("requested object range is too large".into()))?;
        Ok(BlobReadTask {
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
        })
    }
    pub(crate) fn finish_blob_read(
        &mut self,
        task: &BlobReadTask,
        result: Result<PreparedBlobRead, KernelError>,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
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
        let prepared = result?;
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
