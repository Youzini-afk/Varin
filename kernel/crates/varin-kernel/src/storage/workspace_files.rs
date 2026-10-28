//! Native private file generations. Writes append only their changed bytes;
//! snapshots retain immutable ranges while later writes keep using the handle.
//! This is an in-process file-service primitive, not a per-syscall JSON endpoint.
use super::*;
use imbl::OrdMap;
use std::sync::Mutex;

#[derive(Default)]
struct CleanupState {
    files: BTreeMap<PathBuf, String>,
    scan: Option<(PathBuf, String)>,
}
#[derive(Default)]
pub(super) struct StagingCleanup(Mutex<CleanupState>);
impl StagingCleanup {
    fn remove(&self, path: &Path) {
        let failure = match fs::remove_file(path) {
            Ok(()) => None,
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => Some(error.to_string()),
        };
        let mut pending = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(failure) = failure {
            pending.files.insert(path.to_owned(), failure);
        } else {
            pending.files.remove(path);
        }
    }
    pub(super) fn recover(&self, staging: &Path) {
        let result = (|| -> Result<(), io::Error> {
            for entry in fs::read_dir(staging)? {
                let entry = entry?;
                let path = entry.path();
                if matches!(
                    path.extension().and_then(|value| value.to_str()),
                    Some("private" | "sealed")
                ) && path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| Uuid::parse_str(value).is_ok())
                {
                    self.remove(&path);
                }
            }
            Ok(())
        })();
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .scan = result
            .err()
            .map(|error| (staging.to_owned(), error.to_string()));
    }
    pub(super) fn retry(&self) {
        let (paths, scan) = {
            let pending = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                pending.files.keys().cloned().collect::<Vec<_>>(),
                pending.scan.as_ref().map(|(path, _)| path.clone()),
            )
        };
        if let Some(staging) = scan {
            self.recover(&staging);
        }
        for path in paths {
            self.remove(&path);
        }
    }
    pub(super) fn status(&self) -> (i64, Vec<String>) {
        let pending = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut failures = pending
            .files
            .iter()
            .map(|(path, error)| format!("private staging {}: {error}", path.display()))
            .collect::<Vec<_>>();
        if let Some((path, error)) = &pending.scan {
            failures.push(format!("private staging scan {}: {error}", path.display()));
        }
        (
            (pending.files.len() + usize::from(pending.scan.is_some())) as i64,
            failures,
        )
    }
}

#[derive(Clone, Debug)]
struct Extent {
    length: u64,
    log_offset: u64,
}

struct ImmutableFile {
    verification: super::file_content::VerifiedObjects,
    root: PathBuf,
    reader: Mutex<Option<super::file_content::Reader>>,
    dependencies: BTreeMap<String, u64>,
    _range_retention: Vec<blob_reads::BlobReadRetention>,
    path: PathBuf,
    file: std::sync::OnceLock<File>,
    hash: String,
    length: u64,
    verified: Mutex<bool>,
    _retention: blob_reads::BlobReadRetention,
}

struct PrivateLog {
    file: Option<File>,
    path: PathBuf,
    cleanup: Arc<StagingCleanup>,
}
impl PrivateLog {
    fn file(&self) -> &File {
        self.file.as_ref().expect("live private log")
    }
}
impl Drop for PrivateLog {
    fn drop(&mut self) {
        drop(self.file.take());
        self.cleanup.remove(&self.path);
    }
}

struct Generation {
    base: Option<Arc<ImmutableFile>>,
    base_length: u64,
    length: u64,
    extents: OrdMap<u64, Extent>,
    log: Option<Arc<PrivateLog>>,
    log_length: u64,
    generation: u64,
}

/// All native handles of one open file identity share this value. No writable
/// descriptor to a shared content object is ever exposed to the file backend.
pub(crate) struct PrivateFile {
    id: String,
    staging: PathBuf,
    generation: Mutex<Generation>,
    revoked: Arc<AtomicBool>,
    cleanup: Arc<StagingCleanup>,
}

/// Append-only range references are stable without copying the active backing.
/// The file's subsequent append, overwrite and truncate cannot alter this view.
#[derive(Clone)]
pub(crate) struct FileSnapshot {
    file_id: String,
    base: Option<Arc<ImmutableFile>>,
    base_length: u64,
    length: u64,
    extents: OrdMap<u64, Extent>,
    log: Option<Arc<PrivateLog>>,
    generation: u64,
    revoked: Arc<AtomicBool>,
    cleanup: Arc<StagingCleanup>,
}

/// Unpublished complete object, produced on a file worker. Its exact hash must
/// be retained by Storage before installation; Drop cleans only its own file.
pub(crate) struct SealedFile {
    file_id: String,
    staging: PathBuf,
    staged: bool,
    hash: String,
    length: u64,
    generation: u64,
    revoked: Arc<AtomicBool>,
    cleanup: Arc<StagingCleanup>,
}
#[derive(Clone)]
pub(crate) struct InstalledFile {
    file_id: String,
    content: Arc<ImmutableFile>,
    generation: u64,
}
impl InstalledFile {
    pub(super) fn record(&self, storage: &mut Storage) -> Result<(), KernelError> {
        if self.content.verified.try_lock().is_ok_and(|verified| *verified) {
            storage.verified_objects.insert(self.content.hash.clone());
        }
        for (hash, length) in self.content.dependencies.iter().map(|(hash, length)| (hash.as_str(), *length))
            .chain(std::iter::once((self.content.hash.as_str(), self.content.length))) {
            storage.conn.execute("INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES(?1,?2)",
                params![hash, i64::try_from(length).map_err(|_| KernelError::Operation("Content length exceeds Storage range".into()))?])?;
        }
        Ok(())
    }
    pub(super) fn state(&self, mode: u32) -> PathState {
        PathState::RegularFile {
            object_hash: self.content.hash.clone(),
            byte_length: self.content.length,
            mode,
        }
    }
}

pub(crate) struct FilePublication {
    receipt: Value,
    file: Arc<PrivateFile>,
    installed: InstalledFile,
}
impl FilePublication {
    pub(crate) fn committed(&self) -> bool {
        self.receipt["status"] == "committed"
    }
    /// Finish on the file worker after the Storage transaction returned. A
    /// backing unlink can involve the native filesystem and stays off control.
    pub(crate) fn finish(self) -> Value {
        if self.receipt["status"] == "committed" && !self.file.revoked.load(Ordering::Acquire) {
            // Compaction is conditional on the acknowledged generation. A later
            // write or revocation leaves the original durable receipt intact.
            let _ = self.file.rebase(&self.installed);
        }
        self.receipt
    }
}
impl Drop for SealedFile {
    fn drop(&mut self) {
        if self.staged {
            self.cleanup.remove(&self.staging);
        }
    }
}

fn check(cancelled: &AtomicBool) -> Result<(), KernelError> {
    if cancelled.load(Ordering::Acquire) {
        Err(KernelError::Cancelled)
    } else {
        Ok(())
    }
}

fn prepare_sparse_file(file: &File) -> Result<(), KernelError> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::{ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED},
            System::{Ioctl::FSCTL_SET_SPARSE, IO::DeviceIoControl},
        };
        let mut returned = 0;
        if unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_SET_SPARSE,
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(),Some(code) if code==ERROR_INVALID_FUNCTION as i32 || code==ERROR_NOT_SUPPORTED as i32)
            {
                return Err(error.into());
            }
        }
    }
    #[cfg(not(windows))]
    let _ = file;
    Ok(())
}

fn read_at(file: &File, mut offset: u64, mut bytes: &mut [u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        #[cfg(unix)]
        let count = std::os::unix::fs::FileExt::read_at(file, bytes, offset)?;
        #[cfg(windows)]
        let count = std::os::windows::fs::FileExt::seek_read(file, bytes, offset)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "private file range is incomplete",
            ));
        }
        offset += count as u64;
        bytes = &mut bytes[count..];
    }
    Ok(())
}

fn write_at(file: &File, mut offset: u64, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        #[cfg(unix)]
        let count = std::os::unix::fs::FileExt::write_at(file, bytes, offset)?;
        #[cfg(windows)]
        let count = std::os::windows::fs::FileExt::seek_write(file, bytes, offset)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "private file write made no progress",
            ));
        }
        offset += count as u64;
        bytes = &bytes[count..];
    }
    Ok(())
}

impl ImmutableFile {
    fn read_at(&self, offset: u64, output: &mut [u8], cancellation: &AtomicBool) -> Result<(), KernelError> {
        if super::file_content::is_range(&self.hash) {
            let mut reader = self.reader.lock().map_err(|_| KernelError::Storage("Immutable range reader lock failed".into()))?;
            if reader.is_none() {
                *reader = Some(super::file_content::Reader::open(&self.root, &self.hash, self.length, Arc::new(AtomicBool::new(false)))?.with_verification(self.verification.clone()));
            }
            if reader.as_mut().unwrap().read_at_cancellable(offset, output, cancellation)? != output.len() {
                return Err(KernelError::Storage("Immutable file range was truncated".into()));
            }
            Ok(())
        } else { self.verify(cancellation)?; Ok(read_at(self.file()?, offset, output)?) }
    }
    fn file(&self) -> Result<&File, KernelError> {
        if self.file.get().is_none() {
            // This is reached only by a byte worker. Storage admission retains
            // the exact object first, so GC cannot remove it before lazy open.
            let file = File::open(&self.path)?;
            if !file.metadata()?.is_file() {
                return Err(KernelError::Storage(
                    "workspace object is not a regular file".into(),
                ));
            }
            let _ = self.file.set(file);
        }
        Ok(self.file.get().expect("opened immutable byte handle"))
    }
    fn verify(&self, cancellation: &AtomicBool) -> Result<(), KernelError> {
        let mut verified = self
            .verified
            .lock()
            .map_err(|_| KernelError::Storage("immutable verification lock poisoned".into()))?;
        if *verified {
            return Ok(());
        }
        check(cancellation)?;
        if super::file_content::is_range(&self.hash) {
            super::file_content::Version::load(&self.root, &self.hash)?;
            *verified = true;
            return Ok(());
        }
        let file = self.file()?;
        if file.metadata()?.len() != self.length {
            return Err(KernelError::Storage(
                "workspace base object length changed".into(),
            ));
        }
        let mut digest = Sha256::new();
        let mut offset = 0;
        let mut bytes = [0; 128 * 1024];
        while offset < self.length {
            check(cancellation)?;
            let length = (self.length - offset).min(bytes.len() as u64) as usize;
            read_at(file, offset, &mut bytes[..length])?;
            digest.update(&bytes[..length]);
            offset += length as u64;
        }
        if format!("sha256-{}", hex::encode(digest.finalize())) != self.hash {
            return Err(KernelError::Storage(
                "workspace base object is corrupt".into(),
            ));
        }
        *verified = true;
        Ok(())
    }
}

impl Generation {
    fn snapshot(
        &self,
        file_id: String,
        revoked: Arc<AtomicBool>,
        cleanup: Arc<StagingCleanup>,
    ) -> FileSnapshot {
        FileSnapshot {
            file_id,
            base: self.base.clone(),
            base_length: self.base_length,
            length: self.length,
            extents: self.extents.clone(),
            log: self.log.clone(),
            generation: self.generation,
            revoked,
            cleanup,
        }
    }
    fn replace_range(&mut self, start: u64, length: u64, log_offset: u64) {
        let end = start + length;
        let mut affected = Vec::new();
        if let Some((&offset, extent)) = self.extents.range(..start).next_back() {
            if offset + extent.length > start {
                affected.push(offset);
            }
        }
        affected.extend(self.extents.range(start..end).map(|(&offset, _)| offset));
        for offset in affected {
            let extent = self.extents.remove(&offset).expect("selected range");
            let previous_end = offset + extent.length;
            if offset < start {
                self.extents.insert(
                    offset,
                    Extent {
                        length: start - offset,
                        log_offset: extent.log_offset,
                    },
                );
            }
            if previous_end > end {
                self.extents.insert(
                    end,
                    Extent {
                        length: previous_end - end,
                        log_offset: extent.log_offset + end - offset,
                    },
                );
            }
        }
        self.extents.insert(start, Extent { length, log_offset });
        // Sequential writes remain one range; metadata does not grow per syscall.
        let (mut start, mut length, mut log_offset) = (start, length, log_offset);
        if let Some((&previous, extent)) = self.extents.range(..start).next_back() {
            if previous + extent.length == start && extent.log_offset + extent.length == log_offset
            {
                let previous_extent = self.extents.remove(&previous).unwrap();
                self.extents.remove(&start);
                length += previous_extent.length;
                start = previous;
                log_offset = previous_extent.log_offset;
            }
        }
        let end = start + length;
        if let Some(next) = self.extents.get(&end) {
            if log_offset + length == next.log_offset {
                length += next.length;
                self.extents.remove(&end);
            }
        }
        self.extents.insert(start, Extent { length, log_offset });
    }
}

impl PrivateFile {
    /// Open the retained base on the native callback/byte worker, after its
    /// control admission has returned. No filesystem I/O runs on Storage here.
    pub(super) fn open_base(&self) -> Result<(), KernelError> {
        check(&self.revoked)?;
        let base = self
            .generation
            .lock()
            .map_err(|_| KernelError::Storage("private file generation lock poisoned".into()))?
            .base
            .clone();
        if let Some(base) = base {
            base.file()?;
        }
        check(&self.revoked)
    }
    #[cfg(test)]
    pub(super) fn new_for_test(staging: PathBuf) -> Self {
        Self::new(
            staging,
            None,
            Arc::new(AtomicBool::new(false)),
            Arc::default(),
        )
    }
    fn new(
        staging: PathBuf,
        base: Option<Arc<ImmutableFile>>,
        revoked: Arc<AtomicBool>,
        cleanup: Arc<StagingCleanup>,
    ) -> Self {
        let length = base.as_ref().map_or(0, |base| base.length);
        Self {
            id: Uuid::new_v4().to_string(),
            staging,
            revoked,
            cleanup,
            generation: Mutex::new(Generation {
                base,
                base_length: length,
                length,
                extents: OrdMap::new(),
                log: None,
                log_length: 0,
                generation: 0,
            }),
        }
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Generation>, KernelError> {
        check(&self.revoked)?;
        let guard = self
            .generation
            .lock()
            .map_err(|_| KernelError::Storage("private file lock poisoned".into()))?;
        check(&self.revoked)?;
        Ok(guard)
    }
    /// Taking a version boundary performs no full-file copy or hashing.
    pub(crate) fn snapshot(&self) -> Result<FileSnapshot, KernelError> {
        Ok(self
            .lock()?
            .snapshot(self.id.clone(), self.revoked.clone(), self.cleanup.clone()))
    }
    pub(crate) fn read(&self, offset: u64, bytes: &mut [u8]) -> Result<usize, KernelError> {
        self.snapshot()?.read(offset, bytes, &self.revoked)
    }
    /// Returns the actual selected offset too, so append receipts never guess it.
    pub(crate) fn write(
        &self,
        offset: Option<u64>,
        bytes: &[u8],
    ) -> Result<(u64, usize), KernelError> {
        let mut generation = self.lock()?;
        let offset = offset.unwrap_or(generation.length);
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| KernelError::Operation("file write range overflows".into()))?;
        i64::try_from(end).map_err(|_| {
            KernelError::Operation("file write exceeds the native signed file-offset range".into())
        })?;
        if bytes.is_empty() {
            return Ok((offset, 0));
        }
        let log_end = generation
            .log_length
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| KernelError::Operation("private backing length overflows".into()))?;
        let next_generation = generation
            .generation
            .checked_add(1)
            .ok_or_else(|| KernelError::Storage("file generation overflow".into()))?;
        if generation.log.is_none() {
            let path = self.staging.join(format!("{}.private", Uuid::new_v4()));
            let file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&path)?;
            generation.log = Some(Arc::new(PrivateLog {
                file: Some(file),
                path,
                cleanup: self.cleanup.clone(),
            }));
        }
        let log_offset = generation.log_length;
        // Failed writes are outside the published extent map. A retry appends
        // at the same unused offset; readers never observe a partial candidate.
        write_at(generation.log.as_ref().unwrap().file(), log_offset, bytes)?;
        generation.replace_range(offset, bytes.len() as u64, log_offset);
        generation.log_length = log_end;
        generation.length = generation.length.max(end);
        generation.generation = next_generation;
        Ok((offset, bytes.len()))
    }
    pub(crate) fn truncate(&self, length: u64) -> Result<(), KernelError> {
        i64::try_from(length).map_err(|_| {
            KernelError::Operation("file length exceeds the native signed file-offset range".into())
        })?;
        let mut generation = self.lock()?;
        if length == generation.length {
            return Ok(());
        }
        let next_generation = generation
            .generation
            .checked_add(1)
            .ok_or_else(|| KernelError::Storage("file generation overflow".into()))?;
        generation.base_length = generation.base_length.min(length);
        if generation.base_length == 0 {
            generation.base = None;
        }
        if length == 0 {
            generation.extents.clear();
        } else {
            let removed = generation
                .extents
                .range(length..)
                .map(|(&offset, _)| offset)
                .collect::<Vec<_>>();
            for offset in removed {
                generation.extents.remove(&offset);
            }
        }
        if let Some((&offset, extent)) = generation.extents.range(..length).next_back() {
            if offset + extent.length > length {
                let log_offset = extent.log_offset;
                generation.extents.insert(
                    offset,
                    Extent {
                        length: length - offset,
                        log_offset,
                    },
                );
            }
        }
        if generation.extents.is_empty() {
            generation.log = None;
            generation.log_length = 0;
        }
        generation.length = length;
        generation.generation = next_generation;
        Ok(())
    }
    pub(crate) fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }
    fn rebase(&self, installed: &InstalledFile) -> Result<bool, KernelError> {
        if self.id != installed.file_id {
            return Err(KernelError::Authorization(
                "file snapshot belongs to another private handle".into(),
            ));
        }
        let mut current = self.lock()?;
        if current.generation != installed.generation {
            return Ok(false);
        }
        current.base = Some(installed.content.clone());
        current.base_length = installed.content.length;
        current.extents.clear();
        current.log = None;
        current.log_length = 0;
        Ok(true)
    }
}

impl FileSnapshot {
    /// Persist only changed ranges. Existing slices are flattened by descriptor,
    /// never reconstructed or hashed as a complete file at a fork boundary.
    pub(crate) fn freeze(&self, root: &Path, port: &super::workspace_session::StoragePort,
        cancellation: &AtomicBool) -> Result<InstalledFile, KernelError> {
        use super::file_content::{Range, Version};
        check(cancellation)?; check(&self.revoked)?;
        if self.extents.is_empty() {
            if let Some(base) = &self.base {
                if self.length == base.length && self.base_length == base.length {
                    return Ok(InstalledFile { file_id: self.file_id.clone(), content: base.clone(), generation: self.generation });
                }
            }
        }
        // New/empty files already contain only new bytes. Keep the ordinary
        // blob representation when no old file ranges would be copied.
        if self.base.is_none() || self.length == 0 || self.extents.get(&0).is_some_and(|extent| extent.length == self.length) {
            let sealed = self.seal(&root.join("staging"), cancellation)?;
            let (retention, sealed) = port.call(move |storage| Ok((storage.retain_private_file(&sealed), sealed)))?;
            return sealed.install(root, retention, cancellation);
        }
        let base = self.base.as_ref().unwrap();
        let previous = Version::base(root, &base.hash, base.length)?;
        let base_end = self.base_length.min(self.length);
        let mut ranges = Vec::new(); let mut position = 0;
        let mut changed = Vec::new();
        struct Input<'a> { snapshot: &'a FileSnapshot, position: u64, end: u64, cancellation: &'a AtomicBool }
        impl Read for Input<'_> {
            fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
                let count = (self.end-self.position).min(output.len() as u64) as usize;
                if count == 0 { return Ok(0); }
                let read = self.snapshot.read(self.position, &mut output[..count], self.cancellation).map_err(io::Error::other)?;
                self.position += read as u64; Ok(read)
            }
        }
        for (&offset, extent) in &self.extents {
            check(cancellation)?;
            ranges.extend(previous.slice(position.min(base_end), offset.min(base_end)));
            let sealed = SealedFile::capture(&root.join("staging"), Input { snapshot: self, position: offset,
                end: offset + extent.length, cancellation }, self.revoked.clone(), self.cleanup.clone(), cancellation, |_| Ok(()))?;
            let (retention, sealed) = port.call(move |storage| Ok((storage.retain_private_file(&sealed), sealed)))?;
            let installed = sealed.install(root, retention, cancellation)?;
            ranges.push(Range { offset, length: extent.length, object_hash: installed.content.hash.clone(),
                object_offset: 0, object_length: installed.content.length });
            changed.push(installed); position = offset + extent.length;
        }
        ranges.extend(previous.slice(position.min(base_end), base_end));
        let version = Version { format: 1, byte_length: self.length, ranges };
        version.validate()?;
        let hash = format!("ranges-sha256-{}", hex::encode(Sha256::digest(serde_json::to_vec(&version)?)));
        let dependencies = version.dependencies();
        let kept = hash.clone(); let chunks = dependencies.keys().cloned().collect::<Vec<_>>();
        let (retention, range_retention, verification) = port.call(move |storage| Ok((storage.blob_read_roots.retain(&kept),
            chunks.iter().map(|hash| storage.blob_read_roots.retain(hash)).collect::<Vec<_>>(), storage.verified_objects.clone())))?;
        version.install(root, cancellation)?;
        check(&self.revoked)?;
        Ok(InstalledFile { file_id: self.file_id.clone(), generation: self.generation,
            content: Arc::new(ImmutableFile { root: root.into(), reader: Mutex::new(None), dependencies, verification,
                _range_retention: range_retention, path: super::file_content::path(root, &hash)?,
                file: std::sync::OnceLock::new(), hash, length: self.length, verified: Mutex::new(true), _retention: retention }) })
    }
    pub(super) fn empty(revoked: Arc<AtomicBool>, cleanup: Arc<StagingCleanup>) -> Self {
        Self {
            file_id: Uuid::new_v4().to_string(),
            base: None,
            base_length: 0,
            length: 0,
            extents: OrdMap::new(),
            log: None,
            generation: 0,
            revoked,
            cleanup,
        }
    }
    pub(crate) fn byte_length(&self) -> u64 {
        self.length
    }
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }
    pub(crate) fn read(
        &self,
        offset: u64,
        output: &mut [u8],
        cancellation: &AtomicBool,
    ) -> Result<usize, KernelError> {
        check(cancellation)?;
        check(&self.revoked)?;
        if offset >= self.length || output.is_empty() {
            return Ok(0);
        }
        let count = (self.length - offset).min(output.len() as u64) as usize;
        let end = offset + count as u64;
        let bytes = &mut output[..count];
        bytes.fill(0);
        let mut base_verified = false;
        let mut base_range = |from: u64, to: u64, output: &mut [u8]| -> Result<(), KernelError> {
            let to = to.min(self.base_length);
            if from < to {
                let base = self.base.as_ref().expect("immutable range backing");
                if !base_verified {
                    base.verify(cancellation)?;
                    base_verified = true;
                }
                base.read_at(from, &mut output[..(to - from) as usize], cancellation)?;
            }
            Ok(())
        };
        let first = self
            .extents
            .range(..=offset)
            .next_back()
            .map(|(&start, _)| start)
            .unwrap_or(offset);
        let mut position = offset;
        for (&start, extent) in self.extents.range(first..end) {
            check(cancellation)?;
            check(&self.revoked)?;
            let from = start.max(position);
            let to = (start + extent.length).min(end);
            if from < to {
                if position < from {
                    base_range(
                        position,
                        from,
                        &mut bytes[(position - offset) as usize..(from - offset) as usize],
                    )?;
                }
                read_at(
                    self.log.as_ref().expect("range backing").file(),
                    extent.log_offset + from - start,
                    &mut bytes[(from - offset) as usize..(to - offset) as usize],
                )?;
                position = to;
            }
        }
        if position < end {
            base_range(position, end, &mut bytes[(position - offset) as usize..])?;
        }
        check(cancellation)?;
        check(&self.revoked)?;
        Ok(count)
    }
    /// Finite worker work: one changed file is serialized, not its workspace.
    pub(crate) fn seal(
        &self,
        staging: &Path,
        cancellation: &AtomicBool,
    ) -> Result<SealedFile, KernelError> {
        check(cancellation)?;
        check(&self.revoked)?;
        let path = staging.join(format!("{}.sealed", Uuid::new_v4()));
        let mut candidate = SealedFile {
            file_id: self.file_id.clone(),
            staging: path,
            staged: false,
            hash: String::new(),
            length: self.length,
            generation: self.generation,
            revoked: self.revoked.clone(),
            cleanup: self.cleanup.clone(),
        };
        // Creating a native file starts at zero bytes. Its content identity is
        // known without writing/fsyncing another empty staging file per inode.
        // Installation still retains/verifies the object and creates it if GC
        // removed the shared empty object before this request acquired it.
        if self.length == 0 {
            candidate.hash = format!("sha256-{}", hex::encode(Sha256::digest([])));
            return Ok(candidate);
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&candidate.staging)?;
        candidate.staged = true;
        prepare_sparse_file(&file)?;
        let mut digest = Sha256::new();
        let mut offset = 0;
        let mut bytes = [0; 128 * 1024];
        while offset < self.length {
            check(cancellation)?;
            let count = self.read(offset, &mut bytes, cancellation)?;
            if bytes[..count].iter().all(|byte| *byte == 0) {
                file.seek(SeekFrom::Current(count as i64))?;
            } else {
                file.write_all(&bytes[..count])?;
            }
            digest.update(&bytes[..count]);
            offset += count as u64;
        }
        file.set_len(self.length)?;
        file.sync_all()?;
        check(cancellation)?;
        check(&self.revoked)?;
        candidate.hash = format!("sha256-{}", hex::encode(digest.finalize()));
        Ok(candidate)
    }
}

impl SealedFile {
    /// Import already-existing bytes directly into their immutable object. There
    /// is no live writable inode yet, so an empty file and range log add no value.
    pub(super) fn capture(
        staging: &Path, mut source: impl Read, revoked: Arc<AtomicBool>,
        cleanup: Arc<StagingCleanup>, cancellation: &AtomicBool,
        mut progress: impl FnMut(u64) -> Result<(), KernelError>,
    ) -> Result<Self, KernelError> {
        let mut candidate = Self { file_id: Uuid::new_v4().to_string(),
            staging: staging.join(format!("{}.sealed", Uuid::new_v4())), staged: false,
            hash: String::new(), length: 0, generation: 0, revoked, cleanup };
        let mut file = OpenOptions::new().create_new(true).write(true).open(&candidate.staging)?;
        candidate.staged = true;
        prepare_sparse_file(&file)?;
        let mut digest = Sha256::new();
        let mut bytes = [0; 128 * 1024];
        loop {
            check(cancellation)?; check(&candidate.revoked)?;
            let count = source.read(&mut bytes)?;
            if count == 0 { break; }
            if bytes[..count].iter().all(|byte| *byte == 0) { file.seek(SeekFrom::Current(count as i64))?; }
            else { file.write_all(&bytes[..count])?; }
            digest.update(&bytes[..count]); candidate.length += count as u64;
            progress(count as u64)?;
        }
        file.set_len(candidate.length)?; file.sync_all()?;
        candidate.hash = format!("sha256-{}", hex::encode(digest.finalize()));
        Ok(candidate)
    }
    /// Call only after Storage retained this exact hash. Installation does no
    /// catalog mutation and can run while the original owner handles controls.
    pub(crate) fn install(
        mut self,
        storage: &Path,
        retention: blob_reads::BlobReadRetention,
        cancellation: &AtomicBool,
    ) -> Result<InstalledFile, KernelError> {
        check(cancellation)?;
        check(&self.revoked)?;
        let target = object_path(storage, &self.hash)?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(KernelError::Storage(
                        "workspace object path is not a regular file".into(),
                    ));
                }
                let mut digest = Sha256::new();
                let mut file = File::open(&target)?;
                let mut length = 0;
                let mut bytes = [0; 128 * 1024];
                loop {
                    check(cancellation)?;
                    check(&self.revoked)?;
                    let count = file.read(&mut bytes)?;
                    if count == 0 {
                        break;
                    }
                    digest.update(&bytes[..count]);
                    length += count as u64;
                }
                if length != self.length
                    || format!("sha256-{}", hex::encode(digest.finalize())) != self.hash
                {
                    return Err(KernelError::Storage(
                        "existing workspace content object is corrupt".into(),
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !self.staged {
                    let file = OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(&self.staging)?;
                    self.staged = true;
                    file.sync_all()?;
                }
                let shard = target.parent().expect("object shard");
                fs::create_dir_all(shard)?;
                sync_directory(&storage.join("objects"))?;
                check(cancellation)?;
                check(&self.revoked)?;
                durable_rename(&self.staging, &target)?;
                self.staged = false;
                sync_directory(shard)?;
                sync_directory(&storage.join("staging"))?;
            }
            Err(error) => return Err(error.into()),
        }
        Ok(InstalledFile {
            file_id: self.file_id.clone(),
            generation: self.generation,
            content: Arc::new(ImmutableFile {
                verification: super::file_content::VerifiedObjects::default(),
                root: storage.into(), reader: Mutex::new(None), dependencies: BTreeMap::new(), _range_retention: vec![],
                file: std::sync::OnceLock::from(File::open(&target)?),
                path: target,
                hash: self.hash.clone(),
                length: self.length,
                verified: Mutex::new(true),
                _retention: retention,
            }),
        })
    }
}

impl Storage {
    /// Called in the namespace creation transaction while the installed object's
    /// read retention is held. The branch consumes this ordinary blob owner.
    pub(super) fn admit_imported_file(&mut self, operation: &str, file: &InstalledFile, actor: &Grant) -> Result<String, KernelError> {
        let owner = blob_owner_id(&format!("workspace-import:{operation}"));
        file.record(self)?;
        self.record_object_owner(&owner, &file.content.hash, actor.owning_workspace.as_deref(), Some(operation), &actor.grant_id)?;
        Ok(owner)
    }
    /// The source is selected by the native Storage owner. Backends receive a
    /// scoped byte handle, never an authority-bearing arbitrary object path.
    pub(crate) fn open_private_file(
        &mut self,
        branch_id: &str,
        path: &str,
        grant: &Grant,
        revoked: Arc<AtomicBool>,
    ) -> Result<(Arc<PrivateFile>, Value), KernelError> {
        let current = self.load_grant(&grant.grant_id)?;
        if current.state != crate::model::GrantState::Active
            || current.kernel_epoch != grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "private file's original grant is no longer active".into(),
            ));
        }
        let grant = &current;
        require_capability(grant, "storage.getBlob")?;
        require_capability(grant, "branch.path.apply")?;
        let path = Self::validate_path(path)?.join("/");
        let branch = self.branch(branch_id)?;
        if grant.owning_workspace.as_deref() != Some(&branch.workspace_id)
            || !path_allowed(grant, &path)
        {
            return Err(KernelError::Authorization(
                "private file source is outside the original workspace/path".into(),
            ));
        }
        let observed = self.branch_path_inspect(&json!({"branchId":branch_id,"path":path}))?;
        let state: PathState = self.parse_state(&observed["state"])?;
        self.validate_blob_metadata(&state)?;
        let base = match state {
            PathState::RegularFile {
                object_hash,
                byte_length,
                ..
            } => Some(Arc::new(ImmutableFile {
                verification: self.verified_objects.clone(),
                root: self.root.clone(), reader: Mutex::new(None), dependencies: BTreeMap::new(), _range_retention: vec![],
                path: super::file_content::path(&self.root, &object_hash)?,
                file: std::sync::OnceLock::new(),
                length: byte_length,
                verified: Mutex::new(self.verified_objects.contains(&object_hash)),
                _retention: self.blob_read_roots.retain(&object_hash),
                hash: object_hash,
            })),
            PathState::Missing => None,
            _ => {
                return Err(KernelError::Operation(
                    "private byte handles require a regular file or missing create target".into(),
                ))
            }
        };
        let file = Arc::new(PrivateFile::new(
            self.root.join("staging"),
            base,
            revoked,
            self.private_cleanup.clone(),
        ));
        let handles = self
            .private_files
            .entry(grant.grant_id.clone())
            .or_default();
        handles.retain(|handle| handle.strong_count() > 0);
        handles.push(Arc::downgrade(&file));
        Ok((file, observed))
    }

    pub(super) fn revoke_private_files(&mut self, grant: &str) {
        for revoked in self
            .workspace_revocations
            .remove(grant)
            .into_iter()
            .flatten()
            .filter_map(|weak| weak.upgrade())
        {
            revoked.store(true, Ordering::Release);
        }
        for handle in self
            .private_files
            .remove(grant)
            .into_iter()
            .flatten()
            .filter_map(|handle| handle.upgrade())
        {
            handle.revoke();
        }
    }

    pub(crate) fn retain_private_file(
        &mut self,
        candidate: &SealedFile,
    ) -> blob_reads::BlobReadRetention {
        self.blob_read_roots.retain(&candidate.hash)
    }

    pub(super) fn publish_workspace_checkpoint(
        &mut self,
        source: &str,
        pin: &str,
        workspace: &str,
        target: &str,
        operation: &str,
        selected: &str,
        files: &[(Vec<String>, u32, InstalledFile)],
        actor: &Grant,
        metadata_head: &super::workspace_metadata::Head,
        metadata_pin: &str,
        metadata: &[(String, super::workspace_metadata::Metadata)],
        session_id: Uuid,
        request_grant_id: &str,
    ) -> Result<Value, KernelError> {
        let grant = self.load_grant(&actor.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != actor.kernel_epoch
            || grant.owning_workspace.as_deref() != Some(workspace)
            || !path_allowed(&grant, "")
        {
            return Err(KernelError::Authorization(
                "checkpoint requires its original active workspace owner".into(),
            ));
        }
        require_capability(&grant, "branch.fork")?;
        let pinned = self.pin_read(
            &json!({"pinId":pin,"includeEntries":false}),
            &actor.grant_id,
        )?;
        if pinned["branchId"] != source || pinned["workspaceId"] != workspace {
            return Err(KernelError::Authorization(
                "checkpoint pin belongs to another workspace".into(),
            ));
        }
        let pinned_metadata = self.pin_read(
            &json!({"pinId":metadata_pin,"includeEntries":false}),
            &actor.grant_id,
        )?;
        if metadata_head.branch_id != source
            || pinned_metadata["branchId"] != metadata_head.metadata_branch
            || pinned_metadata["workspaceId"] != workspace
        {
            return Err(KernelError::Authorization(
                "filesystem metadata pin belongs to another checkpoint".into(),
            ));
        }
        let original_root = pinned["root"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("Checkpoint pin has no root".into()))?;
        let base = if selected.is_empty() {
            original_root.to_owned()
        } else {
            let node = self
                .find_path_node(original_root, &Self::validate_path(selected)?)?
                .ok_or_else(|| {
                    KernelError::NotFound("sourcePath directory does not exist".into())
                })?;
            let TrieNode::Path { state, children } = self.load_node(&node)? else {
                return Err(KernelError::Storage(
                    "sourcePath points to a namespace index".into(),
                ));
            };
            if state.as_ref().is_some_and(|state| !state.is_directory()) {
                return Err(KernelError::Operation(
                    "sourcePath must select a directory".into(),
                ));
            }
            // Only the ancestor chain is read. The child shares the selected
            // persistent subtree; it does not enumerate or rehash its files.
            self.store_node(&TrieNode::Path {
                state: None,
                children,
            })?
        };
        let mut entries = Vec::new();
        for (paths, mode, file) in files {
            for path in paths {
                let relative = if selected.is_empty() {
                    path.as_str()
                } else {
                    path.strip_prefix(selected)
                        .and_then(|tail| tail.strip_prefix('/'))
                        .ok_or_else(|| {
                            KernelError::Authorization(
                                "Checkpoint file is outside sourcePath".into(),
                            )
                        })?
                };
                entries.push((Self::validate_path(relative)?, file.state(*mode)));
            }
        }
        let input = json!({"operationId":operation,"workspaceId":workspace,"branchId":target,"baseRef":base,"sourcePath":selected,
            "sourcePinId":pin,"entries":entries,"draftBasePaths":[],"captureScopes":[],
            "filesystemHead":metadata_head,"metadataPin":metadata_pin,"metadata":metadata,"sessionId":session_id,"requestGrantId":request_grant_id});
        super::operations::idempotent(self, "workspace.checkpoint.fork", &input, |s| {
            for (_, _, file) in files {
                file.record(s)?;
            }
            let root = s.root_apply(&base, &entries)?;
            s.record_root_blob_hashes(
                &root,
                entries
                    .iter()
                    .filter_map(|(_, state)| state.object_hash().map(str::to_owned)),
            )?;
            if selected.is_empty() {
                s.record_root_parent(&root, &base)?;
            }
            // Dispatch-time dirty bytes are part of the child's baseline, not
            // new changes authored by that child after it starts.
            let mut result = s.create_filesystem_snapshot_branch(
                source, target, workspace, &root, operation, actor,
            )?;
            let root = pinned_metadata["root"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("metadata checkpoint has no root".into()))?;
            s.fork_workspace_metadata(metadata_head, target, root, actor, metadata, selected)?;
            result["filesystem"] = json!({"sourceBranchId":source,"targetBranchId":target,"sourcePath":selected,"sessionId":session_id,"ownerGrantId":actor.grant_id,"requestGrantId":request_grant_id});
            Ok(result)
        })
    }

    pub(crate) fn publish_private_file(
        &mut self,
        operation_id: &str,
        branch_id: &str,
        path: &str,
        expected: &Value,
        mode: u32,
        file: &Arc<PrivateFile>,
        installed: &InstalledFile,
        grant: &Grant,
    ) -> Result<FilePublication, KernelError> {
        self.publish_private_file_metadata(
            operation_id,
            branch_id,
            path,
            expected,
            mode,
            file,
            installed,
            grant,
            None,
            true,
        )
    }
    pub(super) fn publish_private_file_metadata(
        &mut self,
        operation_id: &str,
        branch_id: &str,
        path: &str,
        expected: &Value,
        mode: u32,
        file: &Arc<PrivateFile>,
        installed: &InstalledFile,
        grant: &Grant,
        metadata: Option<&super::workspace_metadata::Metadata>,
        durable_receipt: bool,
    ) -> Result<FilePublication, KernelError> {
        if file.id != installed.file_id {
            return Err(KernelError::Authorization(
                "file snapshot belongs to another private handle".into(),
            ));
        }
        let stored = self.load_grant(&grant.grant_id)?;
        if stored.state != crate::model::GrantState::Active
            || stored.kernel_epoch != grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "private file's original grant is no longer active".into(),
            ));
        }
        require_capability(&stored, "branch.path.apply")?;
        let path = Self::validate_path(path)?.join("/");
        let branch = self.branch(branch_id)?;
        if stored.owning_workspace.as_deref() != Some(&branch.workspace_id)
            || !path_allowed(&stored, &path)
            || expected["branchId"] != branch_id
            || expected["path"] != path
        {
            return Err(KernelError::Authorization(
                "private file publication changed its admitted source".into(),
            ));
        }
        let owner = blob_owner_id(&format!("private-file:{operation_id}"));
        let content = &installed.content;
        let aliases = match metadata {
            Some(metadata) => self.workspace_file_links(
                branch_id,
                metadata.binding.file_id,
                Some(&path),
                &stored,
            )?,
            None => vec![path.clone()],
        };
        if !aliases.contains(&path) {
            return Err(KernelError::Storage(
                "published hard-link inode lost its original name".into(),
            ));
        }
        let mut changes = Vec::with_capacity(aliases.len());
        for alias in aliases {
            if !path_allowed(&stored, &alias) {
                return Err(KernelError::Authorization(
                    "hard-link update exceeds the original path scope".into(),
                ));
            }
            let original = if alias == path {
                expected.clone()
            } else {
                self.branch_path_inspect(&json!({"branchId":branch_id,"path":alias}))?
            };
            if original["state"] != expected["state"] {
                return Err(KernelError::Storage(
                    "hard-link names have different published content".into(),
                ));
            }
            let mut change = json!({"path":alias,"expectedState":original["state"],"expectedNode":original["node"],
                "state":{"kind":"regular-file","objectHash":content.hash,"byteLength":content.length,"mode":mode},"ownerId":owner});
            if change["expectedNode"].is_null() {
                change.as_object_mut().unwrap().remove("expectedNode");
            }
            changes.push(change);
        }
        let input = json!({"operationId":operation_id,"workspaceId":branch.workspace_id,"branchId":branch_id,
            "fileGeneration":installed.generation,"metadata":metadata,"changes":changes});
        // Optional expectedNode is omitted for a missing target.
        let mut input = input;
        if metadata.is_none() {
            input.as_object_mut().unwrap().remove("metadata");
        }
        let apply = |storage: &mut Storage| {
            installed.record(storage)?;
            storage.record_object_owner(
                &owner,
                &content.hash,
                Some(&branch.workspace_id),
                Some(operation_id),
                &stored.grant_id,
            )?;
            let mut change = input.clone();
            change.as_object_mut().unwrap().remove("fileGeneration");
            change.as_object_mut().unwrap().remove("metadata");
            let result = storage.branch_path_apply(&change, &stored.grant_id)?;
            if result["status"] == "committed" {
                if let Some(metadata) = metadata {
                    storage.save_workspace_metadata(branch_id, &path, metadata, &stored)?;
                }
            }
            if result["status"] != "committed" {
                storage.release_object_owner(
                    &json!({"ownerId":owner}),
                    Some(&branch.workspace_id),
                    &stored.grant_id,
                )?;
            }
            Ok(result)
        };
        // Native syscalls have no externally retryable operation ID. Commit
        // bytes + metadata atomically without a permanent receipt per flush.
        // Explicit publication requests keep their original replay contract.
        let result = if durable_receipt {
            super::operations::idempotent(self, "workspace.file.publish", &input, apply)
        } else {
            self.filesystem_transaction(apply)
        }?;
        Ok(FilePublication {
            receipt: result,
            file: file.clone(),
            installed: installed.clone(),
        })
    }
}
