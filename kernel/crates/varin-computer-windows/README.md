# Windows Computer helper

`VarinComputer.exe` is an independent desktop adapter owned by the existing Application Host
ComputerService. It does not link the resource kernel or Agent runtime. The shared toolchain and
Cargo.lock govern its four direct dependencies: serde, serde_json, base64 and Windows bindings.

The [driver contract](../../../packages/computer-driver/README.md) is the protocol authority;
[implementation and acceptance](../../../docs/design/native-computer-helper.md) describes delivery
and the remaining platform evidence. From the repository root on Windows:

```sh
bun run computer:build
node packages/computer-driver/windows/build-helper.mjs --test
node packages/computer-driver/windows/smoke-helper.mjs
```

The build entry resolves Visual Studio/SDK tools and the pinned Rust version, builds a target-specific
release with version resources, validates imports/architecture/signature and stages a matching manifest.
A plain Cargo binary is not a replacement for this verified release artifact.

Portable tests run on every host with `cargo test --manifest-path kernel/Cargo.toml -p
varin-computer-windows --locked`. Windows-only tests use the real helper/control pipe and in-memory WIC
images, never a private application or injected desktop input. Cross-target `cargo check --tests` checks
bindings and test compilation; it does not prove native execution, linking, signature or desktop behavior.

The operation worker owns MTA COM objects. The main thread monitors stdin and the separate control
thread owns a one-user, local-only pipe. Only short input sends/tracking share the input lock. No UIA,
synchronous message or capture call may run while holding that lock. The read-only capture role does
not create UIA objects. EOF fences/releases and exits independently of a blocked provider.

Code ports retain the original upstream MIT provenance documented in the repository
[third-party notices](../../../THIRD_PARTY_NOTICES.md).

## Semantic reads and state actions

`query_elements` uses UIA conditions in the selected window or retained `within` subtree. Only
matching property caches cross the provider boundary. An explicit `max_tree_nodes` or
`max_tree_depth` switches to a bounded subtree walk and reports incomplete coverage instead of
claiming absence. Exact `element` reads refresh just that retained element. Long values beyond
the short-value budget are unavailable in exact property responses, never truncated equality
proof. Password values are neither returned nor used as a value-query oracle.

`get_app_state` accepts `within` and `view: outline|tree`, and emits native `parentIndex`, `depth`,
known states, `hasChildren`/`hasMoreChildren`, and scope completeness. Missing states are omitted;
indeterminate checkbox state is `mixed`. Tree text is a projection of these same records.

The MTA retains opaque `nativeElementId` targets, deduplicated by native identity within a window
instance. Other reads do not retire them. The Host releases unreferenced records through
`release_elements {elements:[...]}`. Failed/cancelled reads roll back unpublished handles. Native
window tokens include process-instance checks and queued WinEvent destroy notifications, so reused
window handles do not inherit old references. The lifetime callback carries only HWND scalars; COM
objects remain on the original MTA. Semantic condition events are not advertised: waits use short
Host-owned polling reads. `query_elements {window_only:true}` performs no element traversal.

`set_checked`, `set_expanded`, `select` (`selection: replace|add|remove`) and `scroll_into_view`
use their actual UIA patterns. Already-satisfied state changes return `effect:none`; dispatched
changes report the actual mechanism and any direct property verification. Toggle-based checked
changes send at most one toggle and never silently cycle a tri-state control until it happens to
match. A primary single-left `auto` click tries a confirmed native pattern first; physical fallback
is allowed only when native pattern availability explicitly proves that no semantic action was
called. Provider errors, timeouts and failed verification never trigger a second mechanism.

Read cancellation fences only that request and does not release another request's held input.
Geometry/DPI checks remain on physical input; identity-confirmed semantic actions do not require
an unchanged window position. No action implicitly captures the whole window for verification.

Additional real-UIA acceptance (Windows interactive session only):

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-computer-windows \
  retained_native_queries_state_actions_and_window_lifetime -- --ignored
```

This test creates its own standard Win32 controls and exercises native matching, retained references,
state no-ops/verification, outline truncation, release and window lifetime. It does not read unrelated
applications or inject physical input. Cross-target compilation alone does not establish its result.
