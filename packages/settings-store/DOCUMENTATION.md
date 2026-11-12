# Settings file store

[The store](src/index.ts) is the single settings-document reader/writer shared by
Electron and the Application Host. Instances for the same resolved path share
cached JSON text, never a mutable parsed object. `read()` and `readSync()` parse a
fresh object without file I/O after loading. Each caller retains its own default
when neither the document nor the recovery copy exists.

A directory watch invalidates external replacements, writes and removals,
including atomic rename. Missing directories or unavailable watches fall back
to file identity, modification time and size checks. Watch errors and directory
replacement return to that fallback until a new watch can attach. File corruption
is an error, not permission to overwrite it with defaults.

Mutations serialize in-process and acquire a cross-process lock. They always read
the current file under that lock instead of using the read cache. Successful
atomic replacement publishes its text to all local instances; a failed replacement
does not publish the candidate. Transactions returning `write: false` do not
rewrite the document. The transient lock marker is not fsynced: it coordinates
live processes and is not recovery data. Windows replacement retains the previous
complete document until the replacement succeeds.

[Behavior tests](src/index.test.ts) cover independent instances, external writes,
watch fallback, immutable results, no-I/O warm reads, permissions and recovery.
