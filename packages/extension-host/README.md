# @varin/extension-host

Trusted application-host ownership for the Varin extension catalog.

The host stores manifests, installation records, desired state, capability grants, application-host
identity, and truthful diagnostics. It materializes npm, Git, local-directory, and registered built-in
sources without lifecycle scripts; managed Surface entrypoints are bundled into immutable SHA-256
artifacts. Selected and candidate versions remain separate until a Surface activation transaction
successfully selects the candidate with a catalog revision precondition.

Published extensions can point a managed entrypoint at a self-contained `.cjs` browser bundle; it is
copied verbatim and works in hosts that intentionally do not ship a source compiler. Other supported
source entrypoints are bundled by the application host with esbuild.

The host serves verified artifact bytes through authenticated Runtime API operations. Public catalog
responses never expose source specifiers or resolved filesystem paths, and asset responses never put
credentials in module or resource URLs. Brokered and explicitly trusted-native Host entrypoints use
generation-scoped lifecycle ownership, versioned services, revisioned storage, candidate rollback,
and persisted multi-scope service routing.

Distribution-owned Host extensions use the same immutable artifact and broker lifecycle as installed
extensions. Their requested Host capabilities are granted only while reconciling the distribution
definition; executable artifacts are materialized lazily when their activation event is first requested,
so declarative built-ins do not add startup I/O.

Language activation carries the requested language ID. The distribution's provider catalog identifies
which built-in extension owns it, so opening a TypeScript document does not first prepare the unrelated
Python and other language pack. Third-party extensions retain their declared workspace activation.

Built-in source directories are read-only distribution assets. Preparation copies them once into the
managed immutable artifact; it does not first duplicate the whole package into another temporary source
tree or install missing dependencies into the application directory.

Registered built-in package roots must identify physical directories that the Host can canonicalize and
copy. Archive-backed distributions resolve their logical module address to the corresponding unpacked
directory before constructing the package manager; brokered processes are launched only from the
resulting immutable artifact, never from an application archive.

Host activation is serialized per extension owner, not across the catalog. Dependency preparation
resolves before owner admission; concurrent consumers reuse the provider generation after its
preparation finishes. Independent startup and retirement proceed in parallel. A canceled or stale
preparation cannot publish, and shutdown closes admission before aborting unpublished broker owners.
Service publication reserves only conflicting declared single-provider services during storage/catalog
commit; registry publication itself is synchronous. Retired generations still drain their pinned calls
before transport disposal. Failed replacement routing rollback touches only selections it changed.

Capability decisions are part of activation identity. A changed selected grant advances the desired
revision; candidate grant reviews are checked independently before publication. Revocations update
the Host-owned grant arrays used by live and draining transport callbacks before replacement awaits,
so retaining an old implementation after a failed update cannot retain revoked privileges.

`ApplicationExtensionRuntime.prepareService` resolves the existing scoped routing configuration once
and returns an exact-generation service handle. Production service invocation uses this same binding
path. Registry invocation indexes only the requested service (or directly looks up an explicit
provider); it does not scan all installed providers. Selected-provider failure never falls back to a
different implementation. Non-authoritative routing cannot create a new binding.

`ApplicationExtensionRuntime.queryContracts` lists/describes current service and UI-slot contracts from the
same manifest, routing, registry and workbench owners. Those metadata operations never activate a provider or invoke its
`inspect` callback. Read-only workbench snapshots do not migrate profiles or resolve/create workspace
identities. Revisions and original lifecycle codes distinguish declared/cold, active, draining,
disabled, failed and unresolved selections. Missing method metadata is `undeclared`, not an empty
schema. A normal preparation failure is recorded by its original extension owner, without replacing
an older still-active generation. Unsupported shell contract versions remain unresolved rather than
being parsed as the current format. Host slot metadata cannot prove a Surface is actually mounted.

Optional `ServiceProvision.contract` carries method/event schemas, author examples and package-relative
source locations through the same manifest and activation descriptor. A declared method must be
callable through the original handler lookup at activation. Tool execute schemas derive from the
existing `tool` declaration; no second tool schema is maintained. This is a finite author contract,
not automatic reflection over every Application API or every provider implementation.

The explicit `read/source` query reads package-relative UTF-8 source through the existing package
manager and immutable artifact verifier. Metadata supplies the exact selected/candidate artifact
integrity; a same-version replacement cannot redirect an old request to new bytes. Candidate references
identify the candidate package, not the selected service descriptor. No query materializes a missing
built-in artifact, activates a provider, or reads the mutable installation checkout. Missing source,
unmaterialized/unavailable artifacts, stale slots, invalid text/ranges and verified corruption remain
distinct. A retained old directory alone does not authorize reading it as the current selected slot.

Source pages use UTF-8 byte offsets, defaulting to offset 0 and a 16 KiB budget. The final code point
may extend the page by at most three bytes; `nextOffset` is the exact continuation. Empty files and
EOF return a found empty page. Each read verifies the original full-file hash in asynchronous 64 KiB
chunks, retaining only the requested page; consequently reading many small pages re-reads the file.
There is no second source cache or hash authority. Cancellation closes the actual file stream, and
the package manager rechecks only the requested slot before publishing. Source bodies in an Agent
call remain ordinary tool results in the original ContentStore/history, including after GC/reopen.

A bound handle admits ordinary calls while its generation is active. A caller freezing an exchange
can explicitly pin that generation, including its real broker drain lifetime, and must release the
pin after settling the exchange. An accepted child can derive an independent pin through `bindPinned`
from that exact still-retained generation; it cannot revive an unpinned retired provider. The original
supervisor keeps its artifact identity through actual owner retirement. Normal replacement preserves
pinned calls; disable/crash drainage
revokes both the active generation and older retained generations without waiting for abandoned pins.
The first production native consumer is `varin.context.fragments@1`: existing scoped routing selects
one brokered package, its frozen declaration crosses the private context boundary, and Rust's existing
composition resolver/registry binds a typed immutable transform. The SDK's `provideContextFragments`
helper and `inspect` metadata share the contract; the packaged default and installable project example
use the ordinary lifecycle. `varin.retrieval.plan@1` also uses this binding path: its declarative
stage choices are frozen with the executing artifact and a separate pin for every native query.
It supplies no filesystem or model capability to the extension. See `examples/extensions/project-context` for the actual author
and project-selection path.

Brokered process shutdown has a configurable `brokerShutdownGraceMs` (default 5000 ms).
This is a cleanup grace addressing an observed indefinitely hanging disposer, not a model/tool
execution deadline. Normal replacement first drains valid old-generation exchange pins; only
entry into final process disposal starts the grace. At expiry the Host kills that broker and waits
for its actual exit. The existing owner diagnostics record `broker_cleanup_unconfirmed`: process
exit does not mean the extension's cleanup or any external effect was completed or undone.
Independent owners still finish shutdown even if another owner reports a failure. Trusted-native
extensions retain their distinct in-process cleanup/restart contract.

Tool services add `tool` metadata to their existing service provision. The standalone manifest,
activation declaration, registry snapshot and SDK `inspect` response preserve that same descriptor;
a mismatched or missing tool activation is rejected before publication. The executing tool Host compiles the declared
input/output schemas. `operation: read` does not grant permissions or certify side-effect-free code.

Trusted callers attach a Host-only `HostInvocationScope` to an exact service pin. The broker sends
only a fresh opaque invocation token, resolves it against its exact extension owner/generation, and
injects the original scope object into nested capability calls. `value` never crosses the worker wire.
Call-scoped capability clients and async invocation context cannot retain authority after the real
service callback finishes. Cancellation aborts nested work while retaining callback/drain ownership
until the real response or process exit. Request-delivery/process/IPC failures revoke and terminate the
unreliable broker; sending a kill signal alone does not settle pending callbacks. Ordinary unscoped
capability calls retain owner-grant semantics.
A pin's `revocationSignal` wakes waiting preparation on explicit disable/crash/revocation; ordinary
replacement leaves it live, including a frozen pin that has not yet made its first call.

Agent-authored packages use the same artifact and catalog owners. The trusted
`stageCapturedPackage` seam accepts only a tree already captured from the original Run's SourceView;
public installation source specifiers cannot create a `source_view`. Its first installation retains a
real selected artifact but is always disabled, even when it requests no capabilities. Further edits
stage the existing candidate slot and preserve enablement and capability decisions. The ordinary
`extension_package` effect tool never enables a package or creates capability decisions.

`applyPackageCandidate` consumes the exact authorized tool request, existing enablement and reviewed
candidate, then records the ordinary `applyRequested` intent before preparing/publishing. Results
separate `application_requested` from `selected`; neither asserts an actual Surface mount. Cancelling
after that commit leaves the application intent durable and may resume it on restart. A started
preparation is retained until its actual broker/build work drains. The original ToolBridge resends a
lost receipt while the Host survives. After full Host loss, unconfirmed Operations remain Unknown;
the catalog restores committed lifecycle state without replaying the Agent tool or recapturing a
mutable source. Cleanup diagnostics cannot erase an already obtained mutation result.

Captured package compilation uses the original esbuild context with cancellation/disposal and permits
resolution only inside the captured dependency closure (plus Node builtins for Host code). It installs
no dependencies. Captured compilation uses only the package-root `tsconfig.json`, when present;
otherwise it disables ambient configuration lookup. JSONC, relative config inheritance and captured
configuration dependencies are preserved. Every `extends` target must remain in the captured tree.
The artifact owner derives a disposable compiler copy including dependencies and same-directory
normalized config shadows, leaving the captured source and artifact text unchanged. Missing or external
configuration dependencies require inclusion in the package or a prebuilt entrypoint. Copying/hashing,
config normalization and builds happen outside catalog locks and drain before cleanup. Source provenance records
the original view and captured-content identity; it grants no filesystem access. An exact candidate
asset or managed-entrypoint request may finish after that same artifact has been selected; explicit
`read/source` queries still require their current selected/candidate slot.
Runtime notification errors are reported through `onObserverError` (the Host error log by default);
each remaining subscriber is still notified, and observer failures cannot change a committed result.

After Host publication commits, selection returns without waiting for older model/child pins to be
released. The same supervisor retains each exact previous instance and its retirement promise:
registry finalization waits for both those pins and real callbacks before disposing that transport.
Each replacement takes over only its active predecessor; an older draining generation stays with
its own retirement, so a long-lived A pin does not also retain an unused B after B→C publication.
Candidate selection and selected-owner replacement use the same path. Normal replacement does not
revoke an old pin. Explicit disable, force termination and shutdown cover retiring generations too;
teardown still waits for actual callbacks and transport cleanup. Retirement failures preserve the new
active owner and are reported through its existing diagnostics and teardown error aggregation.

Prepared-candidate cleanup from an optional consumer is queued and cannot invalidate an independent
selection of the same artifact. A caller cancellation stops that caller before publication begins,
after the shared preparation has actually ended; it does not revoke shared preparation or another
caller's selection. Once the publication transaction starts, its actual result wins over caller
cancellation. Explicit candidate rejection first commits the original catalog CAS, then reconciles
and drains the now-invalid preparation. Disable and shutdown retain global lifecycle revocation.

## Explicit Host/Surface update groups

`manifest.updateReadiness.surfaceEntrypoints` opts the candidate's Host and named local Surface
entrypoints into one update publication dependency. An ordinary Agent apply first persists the
original `applyRequested` fact. Without a participating prepared Surface it returns
`application_requested` and records `required_surface_readiness`; a valid selected Host remains
active. The supervisor never waits for all windows, does not infer membership from packaged UI,
and never makes selected startup/recovery depend on an open window.

The original prepared Host instance supplies its preparation ID, application Host identity, desired
revision, and generation. The trusted Surface host submits its matching local preparation members
through the existing selection route after actual connected-consumer mount preparation. Publication
checks the exact artifact, review, request intent and revision in the original Catalog lock, then
runs a synchronous Host-only owner/readiness/request-cancellation check immediately before the
Catalog write. Preparation, mounts and retirement stay outside that lock. Aborting one HTTP request
before this boundary prevents its commit; after it, the actual committed selection wins. A lost
response requires reading the selected artifact, not claiming rollback or inferring a dead window
from a long-poll timeout. No persistent membership or second selection authority is introduced.

For an explicitly requested group, one Surface's failed mount/cleanup does not revoke the shared
prepared Host. That unpublished owner belongs to the original pending application request until
retry or an authoritative candidate replacement, discard, capability/desired change, or shutdown.
Staging a replacement withdraws only obsolete preparation and does not cold-activate another
provider. Ordinary replacement preserves frozen exchange/child pins and their original retirement;
explicit disable/revocation retains its existing stronger cancellation semantics.

Trusted-native Host modules cannot safely prepare beside a loaded predecessor. Such a grouped
update reports `trusted_native_group_update_requires_restart_handoff`, retains the old selection,
and does not use the old cold-restart shortcut to bypass Surface readiness. The supported explicit
path is to disable the extension, apply the reviewed candidate while disabled, restart the
application Host, then enable it. Disabled selection does not activate or fake a Host preparation.
A hot grouped native restart handoff is not implemented by this update contract.

An unpublished broker crash invalidates only its own preparation, never a still-valid selected
predecessor. If the Catalog has already selected the candidate, subsequent stop/crash does not roll
back its committed storage migration. The original registry closes old new-call admission while
retained old exchange pins drain; recovery prepares the committed selected artifact. Controlled
transport tests exercise these interruption windows against the real artifact, Catalog and storage
owners; they do not claim a whole-process or cross-process atomic transaction.
