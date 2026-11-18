# Performance: Costs, Boundaries & Measurement

Measure changes by user-perceived outcomes: streaming smoothness, action responsiveness, correctness, multi-device consistency, and disconnect recovery. Synthetic speedups do not equate to lower model latency, better provider caching, or faster packaged startup.

## Costs and Boundaries

- **Cross-process IPC**: Every Host ↔ Rust call is a cross-process round trip. Calling it inside a loop turns one view into dozens of round trips (`Promise.all` does not turn per-item IPC into a batch query when the peer serializes work).
- **Disk & SQLite**: File locks, `fsync`, and full-file rewrites cost milliseconds (more on Windows). A single SQLite writer, single actor thread, or tight request window serializes everything behind it.
- **Observer fan-out**: One event fanned out to N observers multiplies each observer's work by N — avoid "refetch everything on any event" observers.
- **Validate at real trust boundaries**: Validate at renderer/remote HTTP entry, extension/broker boundaries, provider/network responses, and external process output. Do not duplicate generic shape checks across the typed, authenticated same-build Host ↔ Rust wire or in-process calls.
- **Cache immutable & single-writer facts**:
  - Immutable ownership (Thread → principal; Run/Operation/Input → Thread) can be cached in-process.
  - Single-writer data (principals, paired clients) can stay resident in memory and update on write rather than lock-reading disk per request.
  - Externally editable config files (`settings.json`, etc.) check file signatures before reusing cached parsed bodies.
- **Durability**: WAL + `synchronous=NORMAL` prevents corruption and dangling references as long as content bytes flush before the referencing metadata commits.
- **Short critical sections**: Keep Catalog/Storage locks brief; run large body reads, compute, and materialization outside writer locks while retaining leases/cancellation.
- **Delete redundant defense**: Checks that protect against no real untrusted input or failure mode add latency without safety. Remove them together with tests that only exist to assert them.

## Key Implementation Entrypoints

- Auth & settings caching: [ui-auth](../packages/web/application-host/lib/ui-auth/DOCUMENTATION.md), [settings-store](../packages/settings-store/DOCUMENTATION.md)
- Rust composite reads & transport scheduling: [varin-runtime](../kernel/crates/varin-runtime/README.md), [kernel transport](../kernel/README.md#transport-lifetime)
- Client observation bus & streaming projections: [application-client](../packages/application-client/README.md), [UI stores](../packages/ui/src/stores/DOCUMENTATION.md)

## Measurement

Compare identical workloads on the same build type while verifying correctness. Prefer deterministic work counts (IPC calls, snapshot reads, renders) for regression tests; record cold/warm, platform, and sample counts when reporting wall-clock numbers.

```sh
node --import tsx scripts/measure-document-registry.mjs
node --import tsx scripts/measure-interaction-hotpaths.mjs /path/to/checkout artifacts/performance/host.json
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib measure_catalog_read_hotpaths -- --ignored --nocapture
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 engine
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 ipc
```

- [measure-interaction-hotpaths.mjs](../scripts/measure-interaction-hotpaths.mjs): Host Documents file-op counts, UI embed/layout counts, and snapshot counts (uses portable fixtures — not full durable save/server latency).
- [measure-kernel.mjs](../scripts/measure-kernel.mjs): `--compute-hotpaths` against a staged release kernel.
- Browser profiling: [scripts/profile-browser.md](../scripts/profile-browser.md).
