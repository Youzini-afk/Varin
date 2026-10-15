//! Observe real content publication before its Catalog reference can commit.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};
use varin_runtime::Catalog;

fn objects(root: &Path) -> BTreeSet<PathBuf> {
    std::fs::read_dir(root.join("content/objects")).unwrap()
        .flat_map(|shard| std::fs::read_dir(shard.unwrap().path()).unwrap())
        .map(|entry| entry.unwrap().path()).collect()
}

pub fn large_text() -> String {
    let mut seed = 0x12345678u32;
    (0..8 * 1024 * 1024).map(|_| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (b'a' + (seed % 26) as u8) as char
    }).collect()
}

pub fn during_write<T: Send + 'static>(
    root: &Path,
    db: &Arc<Mutex<Catalog>>,
    write: impl FnOnce(Arc<Mutex<Catalog>>) -> T + Send + 'static,
    inspect: impl FnOnce(&mut Catalog),
) -> T {
    let before = objects(root);
    let worker_db = db.clone();
    let worker = std::thread::spawn(move || write(worker_db));
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut inspect = Some(inspect);
    let mut observed = false;
    while !worker.is_finished() && Instant::now() < deadline {
        if objects(root).difference(&before).next().is_some() {
            match db.try_lock() {
                Ok(mut catalog) => {
                    // The inspection checks the reference is still uncommitted. A body already
                    // installed on disk, plus available Catalog, proves the intended window.
                    inspect.take().unwrap()(&mut catalog);
                    observed = true;
                    break;
                }
                Err(TryLockError::WouldBlock) => (),
                Err(error) => panic!("Catalog failed during publication: {error}"),
            }
        }
        std::thread::yield_now();
    }
    let result = worker.join().unwrap();
    assert!(observed, "no Catalog access was possible during real body publication");
    result
}
