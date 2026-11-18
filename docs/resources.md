# Resources, Files, Processes & Recovery

Navigation projects, Threads, Sources (what bytes an execution reads), and Resource Hosts (where side effects run) are independent concepts. A conversation needs no project to use files/commands, and can explicitly target another connected Host's Source.

Key owners: [Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md) · [WorkingState](../packages/web/application-host/lib/harness/working-state) · [native-workspaces.ts](../packages/web/application-host/lib/kernel/native-workspaces.ts) · [workspace_resources.rs](../kernel/crates/varin-kernel/src/workspace_resources.rs) · [process](../packages/web/application-host/lib/process/DOCUMENTATION.md) · [recovery](../packages/web/application-host/lib/recovery/DOCUMENTATION.md) · [computer](../packages/web/application-host/lib/computer/DOCUMENTATION.md).

## Immutable Attachments

- An attachment is a version-pinned read handle held by its owner — not a public URL, file hash, or directory grant. Host `thread-attachments` resolves uploads/materials/captures; Rust Storage holds immutable blobs/records; Catalog stores typed links only.
- Arbitrary binary formats stream without format whitelists (`attachment-stream` transfers blobs in one HTTP response across Hosts with hash/length verification). `file.capture` commits read receipt + retention atomically (`retentionRecordId`).
- Tools read attachments via `file_read({ ref })`, `document_read`, Office tools, or `resource_read` (`content` paged bytes or `path` read-only file on the executing Host). Surviving recipients retain access even if the sender or source file is deleted.

## Browser Resources

- Managed independently of workspaces. Catalog covers embedded Electron browser, Linux desktop browser, configured CDP endpoints (`settings.json`, replacing legacy `VARIN_BROWSER_CDP_*` env vars once saved), and tabs shared via the opt-in Chrome/Edge [browser-connector](../packages/browser-connector/README.md).
- `browser_resources` discovers providers; `browser_tabs` selects tabs; operations bind `(resource, instance, tab)`. Remote views stream owner observations rather than loading a second client iframe.
- Writes serialize per tab; user takeover pauses writes until active calls settle and hands control back cleanly. "View browser" only switches observation; "Use for current task" persists the task's browser preference. Uploads/downloads stream through file/attachment owners — file paths are never sent across devices.

## Model Short Resource References

- Tools return compact Catalog-allocated refs (`file:8`, `proc:4`, `env:2`, `material:7`, `page:6`, `obs:9`) binding exact owner, Source, version/codec, or control epoch. Prose paths, URLs, and symbols are never string-scanned.
- File refs carry `readVersion`, encoding, BOM, and line endings so edits detect conflicts instead of overwriting newer disk state. `nextRead` fixes query + cursor so retries don't advance cursors twice.
- Raw `data` stays intact for UI/audit/export; `model_data` is a one-shot model projection. JSON exports retain descriptors and must be re-localized by a receiving Catalog's resource owner.

## Source Selection & Multi-Location Execution

- **User Files panel** (`/api/resource-files`): Uses explicit `(resourceOwner, workspaceId, root)`. Text editing routes through `DocumentsAPI` (forwarding to remote Hosts when configured, never hijacking the global active workspace).
- **Live execution sources**: Ordinary Varin/lead/shared tasks get device filesystem access on their resource Host (project dir sets relative cwd; absolute paths follow OS account access unless Host deployment lockdown is enabled). Default start location comes from saved Host preference → Bot home dir / user home dir.
- **Work locations**: Live native Runs use `work_locations({ query })` to find bookmarks/projects/paths, pass `location` per call on `file_*` / `process_spawn`, switch future default via `work_location_switch`, and copy/move across devices via `work_location_transfer` (moves verify target write before conditional source delete).
- **Source modes**:
  - `LiveRoot`: Admitted physical directory (saved files; no OS isolation against external writers).
  - `FixedBranch`: Immutable branch/revision; materializes an execution copy on first command (`workspace MCP` still requires explicit execution source).
  - `Materialized`: Bound execution copy + immutable baseline.
  - `NativeWorkspace`: Logical `(workspace, branch, subdir)` mounted per Host epoch via WinFsp / FUSE / FSKit / macFUSE (mount path is ephemeral, never persisted).
  - Source-free: Valid when no file/process capability is needed.

## Immutable WorkingState & Native Workspaces

- **Content-addressed trees** (`varin-kernel` Storage): Immutable trees, revisions, SHA-256 blobs, pins, and conditional path ops (`branch.fork`, `branch.path.inspect/apply`, `branch.rename`).
- **Range-based dirty files**: Partial edits publish immutable `ranges-sha256-...` descriptors referencing base blob slices + new appended bytes (flat single-level slice refs, no deep ancestor chains), avoiding full-file rewrites on fork/publish.
- **Native Workspace mounts**:
  - Backends: Windows **WinFsp** (local UNC + single shared user drive letter per kernel), Linux **FUSE** (writeback cache only when `FUSE_HAS_SYNCFS` is truly supported), macOS **FSKit** (preferred) / **macFUSE** (`libfuse3`). Missing backend fails fast at preflight with `workspace_backend_unavailable` — never silently downgrades to `shared`.
  - Windows confirms release of its original drive mapping before refreshing Explorer. macOS mounts internal volumes with `nobrowse`. On Unix the kernel reconciles its prior mount generations against the OS mount table and removes empty mount directories. Project settings observe the current mount without opening one. If a backend refuses to detach, inspection retains the reason on the original workspace.
  - Preserves permissions, timestamps, xattrs, Windows security descriptors, and symlinks/junctions in a paired metadata branch. `workspace.adopt` imports initial physical trees using APFS clone / Linux reflink CoW where supported.
  - Mount/unmount, sealing, and I/O run on worker threads so Storage stays responsive to mount callbacks. Closing a session closes new opens first and waits for real OS handles to drain.
  - Implementation & real-mount tests: [kernel/README.md](../kernel/README.md).

## File Admission, Text Encoding & Observation

- **Admission & leases**: Host Documents owns root admission/revisions/Surface coordination; Rust Storage owns canonical exact/subtree leases and physical I/O (including symlinks/case-folding). Heavy file I/O, hashing, and edits run on workers outside the Storage control thread.
- **Observation & capture reuse**: OS watchers emit invalidation hints only (Linux inotify narrows directory rescanning; Windows rescans full inventory). [capture_resources.rs](../kernel/crates/varin-kernel/src/storage/capture_resources.rs) reuses verified blobs only when native file identity + change time + object hash all match.
- **File tools contract**:
  - `file_read`: Defaults to 64 KiB byte pages (or mutually exclusive 1-based `startLine`/`endLine`), returning opaque `readVersion` (encoding + state token) and `objectHash`.
  - `file_write` / edits: Pass `readVersion` for conditional replace (`mode: create | replace`); conflicts return `file_version_conflict`.
  - `file_list`: Interleaves multi-directory recursion, respects `.git`/`node_modules`/`.worktrees`/gitignore on recursive discovery (explicit paths enter ignored dirs), and returns `emptyResult` hints rather than silently dropping filters.
- **Unified Rust text codecs**: Shared by Documents, Agent file tools, and Compute (UTF-8, UTF-16 LE/BE with BOM, GB18030/GBK/`gb2312-strict`, Big5, Shift-JIS/EUC-JP/ISO-2022-JP, EUC-KR, Windows/ISO-8859/KOI8/Mac). Detection checks explicit config → BOM → header declaration → UTF-8 → project default (`textEncoding.defaultEncoding` / `files` rules) → `chardetng`. Unencodable edits fail with exact location instead of inserting `?`; untouched bytes/line endings are preserved.

## Processes, Shells & Operation Lifetime

- **ProcessManager / guardian**: Separate mode of the `varin-kernel` binary owning pipe/PTY, ordered stdin/resize, raw byte spools, and real process-tree cleanup (Windows named Jobs with ConPTY base-handle tracking; Linux managed sessions + subreaper). Kernel exit closes the control pipe and triggers tree teardown.
- **Reading output** (`process_read`):
  - `mode: "text"` (default): Strips ANSI, streams continuous per-channel UTF-8 (or configured `outputEncoding`) with Base64 fallback for binary/invalid sequences.
  - `mode: "raw"`: Exact bytes.
  - `mode: "screen"`: Incremental PTY virtual terminal screen (dimensions, cursor, alt-screen) — no replaying redraw noise.
  - Cursors always count raw bytes (`nextCursor`, `outputSummary`, `outputState: running | finishing | complete | output_error | unknown`). Reading never consumes retained output.
- **Shell environment** (`platform/execution-environment.ts`): Frozen per model request on the actual execution Host. Windows Agent `auto` order: explicit env → Git Bash → `pwsh` → Windows PowerShell → CMD (excludes WSL bash). Direct `[program, ...args]` never concatenates into a shell string. Bundled ripgrep (`resources/tools`) is exposed on PATH without overriding user tools.
- **Stop vs detach**: Closing terminal UI detaches only; `process_stop` requests guardian tree kill and distinguishes `stopping` from confirmed `exited`.

## Affected-File Recovery

- Recovery records only files touched by controlled write/edit/Integration ops (keeping first-before and last-after per user input; never scans whole projects). Shell/Git/external edits mark coverage incomplete without blocking restore of recorded files.
- `recovery_points` & `file_restore` (`current:before`, named/turn checkpoint, or undo) compute expected-current vs target, save safety/redo blobs, and apply conditionally with Documents dirty-buffer barriers.
- **Joint conversation + file recovery**: Persists plan/safety first, commits file phase, then commits Catalog branch navigation (lost nav responses check original command receipt). Multi-Host recovery uses a metadata-only coordinator + per-Host participant journals (recoverable coordination, not cross-Host atomic transaction).
- User workflow: [ops/recovery.md](ops/recovery.md).

## Managed Hosts, Schedules & Computer Use

- **Managed Host routing**: Pins `(coordinator, target Host/connection, Source, invocation)` and re-checks paired-client permissions on the target. Project `scheduled_task` requires whole-project Source access and commits a begin-fence on the asset Host before dispatching ([scheduled-tasks](../packages/web/application-host/lib/scheduled-tasks/DOCUMENTATION.md)).
- **Computer Use**: `ComputerService` owns discovery, resident drivers, single-controller / multi-observer assignments, takeover, and remote routing.
  - **Windows**: Packaged native `VarinComputer.exe` (UIA on dedicated MTA thread; separate capture process; signed manifest verified).
  - **macOS**: Resident Swift bundle (AX, ScreenCaptureKit, CGEvent).
  - **Linux**: X11 AT-SPI / managed desktop / CDP / LibreOffice UNO, plus Wayland RemoteDesktop/ScreenCast portal + PipeWire.
  - `computer_query` and `computer_await` run on the target Host without holding the input lane. Details: [computer/DOCUMENTATION.md](../packages/web/application-host/lib/computer/DOCUMENTATION.md) · [computer-driver/README.md](../packages/computer-driver/README.md).
