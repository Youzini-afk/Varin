# @varin/extension-loader

Surface-side lifecycle loader for external declarative, managed, isolated, and trusted-native
extensions. Manifest contributions use a public data-only implementation and require no asset or
module read. Executable entrypoints with no activation event, `application-startup`, or `background`
start eagerly. `command`, `contribution-visible`, `workspace-match`, and `service-request` entrypoints
remain inactive until the matching real event is sent through `triggerActivation`; manifest data stays
visible in the meantime without executing extension code.

Activation and candidate replacement remain Surface transactions. A triggered entrypoint replaces its
declarative implementation with the dynamic generation atomically, preserves declarations the module
does not override, and keeps the selected generation when candidate activation fails. Disable clears
the event latch, withdraws every owner, and requires a fresh event after re-enable.

Executable artifacts remain authenticated and content addressed. The loader verifies every received
byte, evaluates self-contained browser bundles without credential-bearing module URLs, and owns
styles, object URLs, isolated realms, capability bindings, service requirements, actual state, and
generation-safe cleanup across disable, host switch, update, and rollback.

Surface hosts can inject `externalServiceFactories`. Each factory declares one service descriptor and stable `providerKey`, then
creates an instance from the loader-supplied consumer `SurfaceOwnerIdentity`; extension code cannot
submit its own owner. Returned disposers transfer to the activation owner scope. Host service proxies
keep their existing application-host routing, while managed and isolated entrypoints can call a
Surface-local service's serializable methods through the same declared requirement. A missing optional
factory never blocks activation.

Catalog watching schedules coalesced per-extension preparation; a slow module, mount, or retired
owner does not hold unrelated extensions behind a loader-wide queue. Stop fences in-flight work
before draining owner cleanup. Without an explicit update group, a selected artifact is consumed independently of Host publication:
Agent-authored packages use this same path and a Surface activation failure preserves its previous
local owner without undoing an already selected Host artifact. Exact candidate promotion to selected
is treated as an existing commit, never as a request to execute or grant a different artifact.

Connected Workbench consumers stage their real mounts through the Surface runtime's local preparation
lease. A failed mount rolls back the candidate's CSS, asset URLs, and service instances while retaining
the old generation. No mounted consumer means no UI readiness barrier for an optional/headless Host.

`manifest.updateReadiness.surfaceEntrypoints` declares the one extension's Host/Surface update group.
Only an enabled, reviewed candidate with `applyRequested` enters proactive group preparation. Every
listed member is prepared, including lazy entrypoints and declarative entries with their own real
owner generations. Unlisted optional entrypoints retain their existing owners and follow the selected
artifact afterward. A Surface that cannot prepare the complete group leaves the application request
waiting; the group never means all windows or all installed extensions.

The existing Surface transaction validates resources, context, services, and connected mounts before
calling `selectCandidate` with the exact Host preparation identity and local member generations.
Connected mount closure, render failure, owner replacement, Host change, disable, and access changes
cancel the in-flight request through its existing transport. Once the Host's durable commit has begun,
its result owns the selection. If the response is lost, an authoritative Host-state read may confirm the
same selected artifact; an unavailable result remains unconfirmed and the ordinary watcher reconciles
later. Local resource rollback never asserts that a Host selection or a tool receipt was rolled back.
Already selected artifacts, initial enable, and Host restart do not acquire this update-only barrier.
Readiness without a connected mount establishes prepared modules/resources, not a presented screen.

Service requirements declare `realms: ["surface"]`, `["host"]`, or both explicitly; each realm consumes
only its own requirements. The loader resolves Surface requirements from canonical Host declarations,
its local factories, and mounted Surface declarations, using the Host routing document and the actual
session/runtime/workspace/profile context. Routing remains the only mutable choice authority. A
scope or dependency change prepares a replacement even when the package artifact is unchanged;
failure keeps the old visible owner and its original clients.

Every prepared Surface owner opens one authenticated `watchServiceLease` POST event stream, including
local-only owners with an empty Host service list. Host readiness supplies exact provider instance
snapshots and pins the consumer's own Host root when present. All candidate streams become ready
before group `prepareCandidate`; module reads then use the authoritative artifact slot. Local
factories remain local and are created only for the resolved choices. `exactProviderIds` records the
frozen Host/local references passed to activation, not a second routing table.

Invocation carries the original routing context, lease identity, exact provider ID, and owner
cancellation signal. Closing a stream withdraws its Host roots while admitted Host calls retain their
own pins; ordinary replacement does not cancel those calls through the stream signal. Rollback,
retirement, and loader stop close the original streams. An error, revocation, or unexpected stream end
invalidates that combination and retires its consumers; the stream client never reconnects or silently
reselects an existing handle. The separate catalog watcher continues ordinary catalog reconciliation.

For trusted-native Host updates, the watcher prepares an explicitly requested group only while its
original clean-process handoff is preparing or waiting for Surface readiness. Pending restart and failed
attempts cannot make a Surface load a new Host generation in the old process. Publication includes the
actual validated connected-consumer lease count in addition to Host preparation and member generations.
A count of zero establishes module preparation only. A failed final participant records the original
handoff failure; another still-connected candidate participant retains its shared Host preparation.
