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
    storage_root: PathBuf,
    recorded_length: u64,
    stored_representation: bool,
    verification: super::file_content::VerifiedObjects,
    params: Value,
    hash: String,
    path: PathBuf,
    byte_length: u64,
    offset: u64,
    length: usize,
    verify: bool,
    cancellation: Arc<AtomicBool>,
    retention: BlobReadRetention,
    file_output: Option<(String, Value, String)>,
    text_receipt: Option<crate::text::Format>,
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
    /// Hash assembled immutable bytes on the admitted worker, never the range
    /// descriptor. Used only when comparing a fixed basis with physical bytes.
    pub(crate) fn content_digest(&self)->Result<String,KernelError>{
        let Self::Immutable(task)=self else{return Err(KernelError::Storage("Expected immutable content reader".into()));};
        let mut reader=super::file_content::Reader::open(&task.storage_root,&task.hash,task.byte_length,task.cancellation.clone())?.with_verification(task.verification.clone());
        let mut digest=Sha256::new();let mut buffer=[0u8;128*1024];let mut length=0;
        loop {task.check_cancelled()?;let count=reader.read(&mut buffer)?;if count==0{break;}digest.update(&buffer[..count]);length+=count as u64;}
        if length!=task.byte_length{return Err(KernelError::Storage("Immutable baseline length changed".into()));}
        Ok(format!("sha256-{}",hex::encode(digest.finalize())))
    }
    pub(crate) fn with_text_receipt(mut self,format:Option<crate::text::Format>)->Self {if let Self::Immutable(task)=&mut self{task.text_receipt=format;}self}

    pub(crate) fn params(&self) -> &Value {
        match self { Self::Immutable(task) => &task.params, Self::File(task) => &task.params }
    }
    pub(crate) fn method(&self) -> &'static str {
        match self { Self::Immutable(_) => "storage.getBlob", Self::File(task) => task.method() }
    }
    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        match self { Self::Immutable(task) => task.cancellation.clone(), Self::File(task) => task.cancellation.clone() }
    }
    pub(crate) fn retain_worker(&self) -> Option<BlobReadRetention> {
        match self { Self::Immutable(task) => Some(task.retention.clone()), Self::File(_) => None }
    }
    pub(crate) fn with_file_output(mut self, path: String, source: Value, read_version: String) -> Self {
        if let Self::Immutable(task) = &mut self { task.file_output = Some((path, source, read_version)); }
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
        trait ReadSeek: Read + Seek {}
        impl<T: Read + Seek> ReadSeek for T {}
        let ranged = super::file_content::is_range(&self.hash) && !self.stored_representation;
        let mut file: Box<dyn ReadSeek> = if ranged {
            // `path` for a version is its descriptor; the resource root remains
            // separate so no consumer mistakes descriptor bytes for file bytes.
            Box::new(super::file_content::Reader::open(&self.storage_root, &self.hash, self.byte_length, self.cancellation.clone())?.with_verification(self.verification.clone()))
        } else { Box::new(File::open(&self.path)?) };
        if !ranged && fs::metadata(&self.path)?.len() != self.byte_length {
            return Err(KernelError::Storage(format!(
                "content object metadata is missing or corrupt: {}",
                self.hash
            )));
        }
        if self.verify && !ranged {
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
                || format!("sha256-{}", hex::encode(digest.finalize())) != self.hash.strip_prefix("ranges-").unwrap_or(&self.hash)
            {
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {}",
                    self.hash
                )));
            }
        }
        self.checkpoint(BlobReadPhase::Read)?;
        if let Some((path,source,version))=&self.file_output {
            let format=if let Some(format)=&self.text_receipt {Ok(format.clone())}else{crate::text::stream::probe(&mut *file,&self.params,&||self.check_cancelled())?};
            let mut content=crate::text::stream::page(&mut *file,self.byte_length,&self.params,format,&||self.check_cancelled())?;
            content["hash"]=json!(self.hash);
            let version=content["format"]["encoding"].as_str().map(|encoding|super::file_mutations::text_read_version(version,encoding)).unwrap_or_else(||version.clone());
            self.checkpoint(BlobReadPhase::Encoded)?;
            return Ok(PreparedImmutableRead{value:json!({"path":path,"source":source,"missing":false,"readVersion":version,"content":content}),verified:self.verify});
        }
        let next = self.offset + self.length as u64;
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes=vec![0u8;self.length];
        for part in bytes.chunks_mut(128*1024){self.check_cancelled()?;file.read_exact(part)?;}
        let value=json!({"hash":self.hash,"byteLength":self.byte_length,"offset":self.offset,"nextOffset":next,"eof":next>=self.byte_length,"bytesBase64":BASE64.encode(bytes)});
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
        let path = super::file_content::path(&self.root, hash)?;
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
        let recorded_length = byte_length;
        if params.get("representation").is_some_and(|value| value.as_str() != Some("manifest")) {
            return Err(KernelError::Operation("Unknown immutable content representation".into()));
        }
        let stored_representation = params.get("representation").and_then(Value::as_str) == Some("manifest");
        if stored_representation && !super::file_content::is_range(hash) {
            return Err(KernelError::Operation("Only an immutable range version has a manifest representation".into()));
        }
        let byte_length = if stored_representation { fs::metadata(&path)?.len() } else { byte_length };
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
            storage_root: self.root.clone(),
            recorded_length,
            verification: self.verified_objects.clone(),
            stored_representation,
            byte_length,
            offset: start,
            length,
            verify: !self.verified_objects.contains(hash),
            cancellation,
            retention: self.blob_read_roots.retain(hash),
            file_output: None,
            text_receipt:None,
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
        if recorded.and_then(|length| u64::try_from(length).ok()) != Some(task.recorded_length) {
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
