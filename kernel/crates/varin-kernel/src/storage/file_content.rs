//! Immutable file versions. A range version names a flat set of ordinary
//! content-object slices, so repeated forks never build ancestor read chains.
use super::*;
use serde::{Deserialize, Serialize};

pub(crate) const RANGE_PREFIX: &str = "ranges-";
/// The existing Storage verification cache can be shared with byte workers.
/// Collection invalidates facts for removed objects; it owns no bytes or grants.
#[derive(Clone, Default)]
pub(crate) struct VerifiedObjects(Arc<std::sync::Mutex<BTreeSet<String>>>);
impl VerifiedObjects {
    pub(crate) fn contains(&self, hash: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(hash)
    }
    pub(crate) fn insert(&self, hash: String) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(hash);
    }
    pub(crate) fn remove(&self, hash: &str) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(hash);
    }
    pub(crate) fn clear(&self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
}
pub(crate) fn is_range(reference: &str) -> bool {
    reference.starts_with(RANGE_PREFIX)
}
pub(crate) fn valid_reference(reference: &str) -> bool {
    let hash = reference.strip_prefix(RANGE_PREFIX).unwrap_or(reference);
    varin_runtime::content::object_path(Path::new("."), hash).is_ok()
}
pub(crate) fn path(root: &Path, reference: &str) -> Result<PathBuf, KernelError> {
    if let Some(hash) = reference.strip_prefix(RANGE_PREFIX) {
        varin_runtime::content::object_path(&root.join("file-versions"), hash)
            .map_err(|error| KernelError::Storage(error.to_string()))
    } else {
        crate::protocol::object_path(root, reference)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Range {
    pub offset: u64,
    pub length: u64,
    pub object_hash: String,
    pub object_offset: u64,
    pub object_length: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Version {
    pub format: u32,
    pub byte_length: u64,
    pub ranges: Vec<Range>,
}
impl Version {
    pub(crate) fn validate(&self) -> Result<(), KernelError> {
        if self.format != 1 {
            return Err(KernelError::Storage(
                "Unsupported immutable file version; original data was preserved".into(),
            ));
        }
        let mut end = 0;
        let mut lengths = BTreeMap::new();
        for range in &self.ranges {
            let to = range.offset.checked_add(range.length);
            let object_end = range.object_offset.checked_add(range.length);
            if range.length == 0
                || range.offset < end
                || to.is_none_or(|to| to > self.byte_length)
                || object_end.is_none_or(|to| to > range.object_length)
                || is_range(&range.object_hash)
                || !valid_reference(&range.object_hash)
                || lengths
                    .insert(&range.object_hash, range.object_length)
                    .is_some_and(|length| length != range.object_length)
            {
                return Err(KernelError::Storage("Invalid immutable file range".into()));
            }
            end = to.unwrap();
        }
        Ok(())
    }
    pub(crate) fn load(root: &Path, reference: &str) -> Result<Self, KernelError> {
        let bytes = fs::read(path(root, reference)?)?;
        let expected = format!("ranges-sha256-{}", hex::encode(Sha256::digest(&bytes)));
        if reference != expected {
            return Err(KernelError::Storage(
                "Immutable file version is corrupt".into(),
            ));
        }
        let version: Self = serde_json::from_slice(&bytes)?;
        version.validate()?;
        Ok(version)
    }
    pub(crate) fn base(root: &Path, reference: &str, length: u64) -> Result<Self, KernelError> {
        if is_range(reference) {
            let version = Self::load(root, reference)?;
            if version.byte_length != length {
                return Err(KernelError::Storage(
                    "Immutable file version length changed".into(),
                ));
            }
            Ok(version)
        } else {
            Ok(Self {
                format: 1,
                byte_length: length,
                ranges: if length == 0 {
                    vec![]
                } else {
                    vec![Range {
                        offset: 0,
                        length,
                        object_hash: reference.into(),
                        object_offset: 0,
                        object_length: length,
                    }]
                },
            })
        }
    }
    pub(crate) fn slice(&self, from: u64, to: u64) -> Vec<Range> {
        let start = self
            .ranges
            .partition_point(|range| range.offset + range.length <= from);
        self.ranges[start..]
            .iter()
            .take_while(|range| range.offset < to)
            .filter_map(|range| {
                let start = range.offset.max(from);
                let end = (range.offset + range.length).min(to);
                (start < end).then(|| Range {
                    offset: start,
                    length: end - start,
                    object_hash: range.object_hash.clone(),
                    object_offset: range.object_offset + start - range.offset,
                    object_length: range.object_length,
                })
            })
            .collect()
    }
    pub(crate) fn dependencies(&self) -> BTreeMap<String, u64> {
        self.ranges
            .iter()
            .map(|range| (range.object_hash.clone(), range.object_length))
            .collect()
    }
    /// Only the small descriptor is written here; changed bytes already reside
    /// in retained ordinary objects. Call on a worker before root publication.
    pub(crate) fn install(
        &self,
        root: &Path,
        cancelled: &AtomicBool,
    ) -> Result<String, KernelError> {
        self.validate()?;
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let bytes = serde_json::to_vec(self)?;
        let reference = format!("ranges-sha256-{}", hex::encode(Sha256::digest(&bytes)));
        let target = path(root, &reference)?;
        if target.try_exists()? {
            Self::load(root, &reference)?;
            return Ok(reference);
        }
        let objects = root.join("file-versions").join("objects");
        fs::create_dir_all(target.parent().expect("version shard"))?;
        sync_directory(root)?;
        sync_directory(&root.join("file-versions"))?;
        sync_directory(&objects)?;
        let temporary = root
            .join("staging")
            .join(format!("{}.sealed", Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            durable_rename(&temporary, &target)?;
            sync_directory(target.parent().expect("version shard"))?;
            sync_directory(&root.join("staging"))?;
            Ok(reference)
        })();
        let _ = fs::remove_file(&temporary);
        result
    }
}

/// One content interface for fixed reads, native handles, export and recovery.
/// Verification happens on a byte worker; a version never exposes a raw backing
/// descriptor to a caller that could mutate shared bytes.
pub(crate) struct Reader {
    root: PathBuf,
    version: Version,
    position: u64,
    object: Option<(String, File)>,
    verified: VerifiedObjects,
    cancelled: Arc<AtomicBool>,
}
impl Reader {
    pub(crate) fn open(
        root: &Path,
        reference: &str,
        length: u64,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Self, KernelError> {
        Ok(Self {
            root: root.into(),
            version: Version::base(root, reference, length)?,
            position: 0,
            object: None,
            verified: VerifiedObjects::default(),
            cancelled,
        })
    }
    pub(crate) fn with_verification(mut self, verified: VerifiedObjects) -> Self {
        self.verified = verified;
        self
    }
    pub(crate) fn read_at(&mut self, offset: u64, output: &mut [u8]) -> io::Result<usize> {
        let cancelled = self.cancelled.clone();
        self.read_at_cancellable(offset, output, &cancelled)
    }
    pub(crate) fn read_at_cancellable(
        &mut self,
        offset: u64,
        output: &mut [u8],
        cancelled: &AtomicBool,
    ) -> io::Result<usize> {
        if cancelled.load(Ordering::Acquire) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let count = self
            .version
            .byte_length
            .saturating_sub(offset)
            .min(output.len() as u64) as usize;
        output[..count].fill(0);
        let end = offset + count as u64;
        let start = self
            .version
            .ranges
            .partition_point(|range| range.offset + range.length <= offset);
        for range in self.version.ranges[start..]
            .iter()
            .take_while(|range| range.offset < end)
        {
            if self
                .object
                .as_ref()
                .is_none_or(|(hash, _)| hash != &range.object_hash)
            {
                let mut file = File::open(
                    crate::protocol::object_path(&self.root, &range.object_hash)
                        .map_err(io::Error::other)?,
                )?;
                if !file.metadata()?.is_file() || file.metadata()?.len() != range.object_length {
                    return Err(io::Error::other("Immutable content object length changed"));
                }
                if !self.verified.contains(&range.object_hash) {
                    let mut digest = Sha256::new();
                    let mut buffer = [0; 128 * 1024];
                    loop {
                        if cancelled.load(Ordering::Acquire) {
                            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
                        }
                        let count = file.read(&mut buffer)?;
                        if count == 0 {
                            break;
                        }
                        digest.update(&buffer[..count]);
                    }
                    if format!("sha256-{}", hex::encode(digest.finalize())) != range.object_hash {
                        return Err(io::Error::other("Immutable content object is corrupt"));
                    }
                    self.verified.insert(range.object_hash.clone());
                }
                self.object = Some((range.object_hash.clone(), file));
            }
            let from = offset.max(range.offset);
            let to = end.min(range.offset + range.length);
            let file = &mut self.object.as_mut().expect("verified range object").1;
            file.seek(SeekFrom::Start(range.object_offset + from - range.offset))?;
            file.read_exact(&mut output[(from - offset) as usize..(to - offset) as usize])?;
        }
        Ok(count)
    }
}

pub(crate) fn copy_to(
    root: &Path,
    reference: &str,
    length: u64,
    output: &mut impl Write,
    cancelled: &AtomicBool,
) -> Result<(), KernelError> {
    let mut reader = Reader::open(root, reference, length, Arc::new(AtomicBool::new(false)))?;
    let mut buffer = [0; 128 * 1024];
    let mut offset = 0;
    loop {
        let count = reader.read_at_cancellable(offset, &mut buffer, cancelled)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
        offset += count as u64;
    }
    Ok(())
}
pub(crate) fn read_all(
    root: &Path,
    reference: &str,
    length: u64,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, KernelError> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve(
            usize::try_from(length)
                .map_err(|_| KernelError::Operation("File exceeds addressable memory".into()))?,
        )
        .map_err(|_| KernelError::Operation("Insufficient memory to read this file".into()))?;
    copy_to(root, reference, length, &mut bytes, cancelled)?;
    Ok(bytes)
}
pub(crate) fn matches_file(
    root: &Path,
    reference: &str,
    length: u64,
    target: &Path,
    cancelled: &AtomicBool,
) -> Result<bool, KernelError> {
    if !is_range(reference) {
        return Ok(hash_file(target)? == (reference.into(), length));
    }
    let mut actual = File::open(target)?;
    if actual.metadata()?.len() != length {
        return Ok(false);
    }
    let mut expected = Reader::open(root, reference, length, Arc::new(AtomicBool::new(false)))?;
    let mut left = [0; 128 * 1024];
    let mut right = [0; 128 * 1024];
    let mut offset = 0;
    loop {
        let count = expected.read_at_cancellable(offset, &mut left, cancelled)?;
        if count == 0 {
            break;
        }
        actual.read_exact(&mut right[..count])?;
        if left[..count] != right[..count] {
            return Ok(false);
        }
        offset += count as u64;
    }
    Ok(true)
}
impl Read for Reader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = self.read_at(self.position, output)?;
        self.position += count as u64;
        Ok(count)
    }
}
impl Seek for Reader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let next = match position {
            SeekFrom::Start(position) => i128::from(position),
            SeekFrom::Current(delta) => i128::from(self.position) + i128::from(delta),
            SeekFrom::End(delta) => i128::from(self.version.byte_length) + i128::from(delta),
        };
        self.position = u64::try_from(next)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid file offset"))?;
        Ok(self.position)
    }
}

/// Physical sources report a byte digest. Resolve a version only when a
/// physical transaction needs that comparison; forks never request this work.
pub(super) fn physical_state(
    root: &Path,
    state: &super::file_resources::FileState,
    cancelled: &AtomicBool,
) -> Result<super::file_resources::FileState, KernelError> {
    let mut state = state.clone();
    if let super::file_resources::FileState::RegularFile {
        object_hash,
        byte_length,
        ..
    } = &mut state
    {
        if is_range(object_hash) {
            struct HashWriter(Sha256);
            impl Write for HashWriter {
                fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                    self.0.update(bytes);
                    Ok(bytes.len())
                }
                fn flush(&mut self) -> io::Result<()> {
                    Ok(())
                }
            }
            let mut writer = HashWriter(Sha256::new());
            copy_to(root, object_hash, *byte_length, &mut writer, cancelled)?;
            *object_hash = format!("sha256-{}", hex::encode(writer.0.finalize()));
        }
    }
    Ok(state)
}
