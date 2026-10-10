//! Storage lifecycle, catalog validation, process ownership, and cancellation state.
use super::*;

impl Storage {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(super) fn catalog_schema_fingerprint() -> String {
        format!(
            "sha256-{}",
            hex::encode(Sha256::digest(CATALOG_SCHEMA.as_bytes()))
        )
    }

    pub(super) fn validate_catalog_schema(conn: &Connection) -> Result<(), KernelError> {
        let user_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if user_version != CATALOG_USER_VERSION {
            return Err(KernelError::Storage(format!(
                "catalog user_version does not match format {}: {user_version}",
                STORAGE_FORMAT_VERSION
            )));
        }
        let fingerprint: Option<String> = conn
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_fingerprint'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let expected_fingerprint = Self::catalog_schema_fingerprint();
        if fingerprint.as_deref() != Some(expected_fingerprint.as_str()) {
            return Err(KernelError::Storage(
                "catalog schema fingerprint does not match this kernel".to_string(),
            ));
        }
        let tables = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let expected_tables = REQUIRED_TABLES
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        if tables != expected_tables {
            return Err(KernelError::Storage(format!(
                "catalog table set is corrupt: expected {:?}, found {:?}",
                expected_tables, tables
            )));
        }
        let indexes = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let expected_indexes = REQUIRED_INDEXES
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        if indexes != expected_indexes {
            return Err(KernelError::Storage(format!(
                "catalog index set is corrupt: expected {:?}, found {:?}",
                expected_indexes, indexes
            )));
        }
        for (table, expected) in REQUIRED_COLUMNS {
            let pragma = format!("PRAGMA table_info({table})");
            let columns = conn
                .prepare(&pragma)?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            let expected = expected
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>();
            if columns != expected {
                return Err(KernelError::Storage(format!(
                    "catalog columns are corrupt for {table}: expected {:?}, found {:?}",
                    expected, columns
                )));
            }
        }
        Ok(())
    }

    pub(crate) fn open(root: &Path, host_id: &str) -> Result<Self, KernelError> {
        fs::create_dir_all(root)?;
        let lock_path = root.join("kernel.lock");
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        if file.try_lock_exclusive().is_err() {
            return Err(KernelError::Storage(format!(
                "storage is owned by another Host: {}",
                root.display()
            )));
        }
        file.set_len(0)?;
        let lock_record =
            json!({"hostId": host_id, "pid": std::process::id(), "createdAt": now_ms()});
        file.write_all(lock_record.to_string().as_bytes())?;
        file.sync_all()?;
        let catalog_path = root.join("catalog.sqlite");
        let catalog_existed = catalog_path.exists();
        let (format, catalog_empty): (Option<String>, bool) = if catalog_existed {
            let probe =
                Connection::open_with_flags(&catalog_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let format = match probe
                .query_row(
                    "SELECT value FROM metadata WHERE key = 'format_version'",
                    [],
                    |row| row.get(0),
                )
                .optional()
            {
                Ok(format) => format,
                Err(rusqlite::Error::SqliteFailure(_, Some(message)))
                    if message.contains("no such table") =>
                {
                    None
                }
                Err(error) => return Err(error.into()),
            };
            let empty = probe.query_row(
                "SELECT COUNT(*) = 0 FROM sqlite_master WHERE type = 'table'",
                [],
                |row| row.get(0),
            )?;
            (format, empty)
        } else {
            (None, true)
        };
        let initialize_catalog = !catalog_existed || (format.is_none() && catalog_empty);
        if !initialize_catalog {
            match format.as_deref() {
                Some(value) if value == STORAGE_FORMAT_VERSION => {}
                Some(value) => {
                    return Err(KernelError::Storage(format!(
                        "unsupported catalog format version: {value}"
                    )))
                }
                None => {
                    return Err(KernelError::Storage(
                        "catalog format version is missing".to_string(),
                    ))
                }
            }
        }
        let conn = Connection::open(catalog_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if initialize_catalog {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            if let Err(error) = conn.execute_batch(CATALOG_SCHEMA).and_then(|_| {
                conn.execute(
                    "INSERT INTO metadata(key, value) VALUES ('format_version', ?1)",
                    params![STORAGE_FORMAT_VERSION],
                )?;
                conn.execute(
                    "INSERT INTO metadata(key, value) VALUES ('schema_fingerprint', ?1)",
                    params![Self::catalog_schema_fingerprint()],
                )?;
                conn.pragma_update(None, "user_version", CATALOG_USER_VERSION)
            }) {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error.into());
            }
            conn.execute_batch("COMMIT")?;
        } else {
            Self::validate_catalog_schema(&conn)?;
        }
        for directory in ["objects", "staging"] {
            fs::create_dir_all(root.join(directory))?;
        }
        // Cleanup requires both the exclusive owner and a verified current catalog.
        // Unsupported or corrupt formats must retain their original in-flight assets.
        if let Ok(entries) = fs::read_dir(root.join("staging")) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|value| value.to_str()) == Some("stream") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        // Query pins belong to the process epoch that created them. Durable
        // revision pins and pending domain-operation references remain intact.
        conn.execute("DELETE FROM pins WHERE ephemeral = 1", [])?;
        let mut storage = Self {
            root: PathBuf::from(root),
            conn,
            _lock: StorageLock { _file: file },
            cancellation: None,
            streams: HashMap::new(),
            branch_builders: HashMap::new(),
            branch_write_builders: HashMap::new(),
            verified_objects: BTreeSet::new(),
            file_roots: HashMap::new(),
            file_leases: HashMap::new(),
            retained_file_leases: HashMap::new(),
            materializations: HashMap::new(),
            result_publications: BTreeSet::new(),
            processes: crate::process::ProcessManager::default(),
            computations: crate::compute::ComputeManager::default(),
        };
        // A process may have exited after the SQLite commit and before the
        // object unlink. Retry durable cleanup on the next owner start; a
        // failure remains visible through health instead of being swallowed.
        storage.refresh_process_records()?;
        storage.sweep_orphan_objects()?;
        storage.drain_gc_files()?;
        Ok(storage)
    }

    pub(crate) fn set_cancellation(&mut self, cancellation: Arc<AtomicBool>) {
        self.cancellation = Some(cancellation);
    }

    pub(crate) fn clear_cancellation(&mut self) {
        self.cancellation = None;
    }

    pub(super) fn check_cancelled(&self) -> Result<(), KernelError> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(|token| token.load(Ordering::Acquire))
        {
            return Err(KernelError::Cancelled);
        }
        Ok(())
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;
    #[test]
    fn obsolete_storage_rejection_preserves_catalog_objects_and_inflight_streams() {
        let root = std::env::temp_dir().join(format!("varin-rejected-storage-{}", Uuid::new_v4()));
        let storage = Storage::open(&root, "original-host").unwrap();
        storage
            .conn
            .execute(
                "UPDATE metadata SET value='10' WHERE key='format_version'",
                [],
            )
            .unwrap();
        drop(storage);
        let object = root.join("objects/retained-original");
        let stream = root.join("staging/original.stream");
        fs::write(&object, b"original immutable bytes").unwrap();
        fs::write(&stream, b"original in-flight bytes").unwrap();
        let catalog = fs::read(root.join("catalog.sqlite")).unwrap();
        assert!(
            matches!(Storage::open(&root,"replacement-host"),Err(KernelError::Storage(message)) if message.contains("unsupported catalog format version: 10"))
        );
        assert_eq!(fs::read(root.join("catalog.sqlite")).unwrap(), catalog);
        assert_eq!(fs::read(&object).unwrap(), b"original immutable bytes");
        assert_eq!(fs::read(&stream).unwrap(), b"original in-flight bytes");
        fs::remove_dir_all(root).unwrap();
    }
}
