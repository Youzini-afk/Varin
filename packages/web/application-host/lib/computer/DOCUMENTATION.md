# Computer Use admission and feedback

`ComputerService` owns the existing catalog, native drivers, ordered input lane, human control,
remote routing and viewer stream. `computer-automation.ts` adds ephemeral assignments over that same
lane. It does not create another scheduler or another desktop backend.

## Thread identity and desktop assignments

The protocol's `ComputerWorkRef` distinguishes Pi sessions from Agent Thread/branch identity;
`ComputerExecutionRef` adds the actual Run. Idle work has no execution. Native work never acquires a
synthetic Pi session or Registry record. The Rust `runtime.computer.scope` request resolves native
lineage from the original Catalog and the branch's active Run, including source-less work; a context
or auxiliary Run does not become the branch owner. Tool calls additionally validate their real
ModelStep or PolicyAction Operation. `computer-actor.ts` resolves the Pi broker's session through the actual Registry Thread/Run and its durable
ancestors. Attached Agent, research and Bot roots retain their main-agent role even though their Thread
kind is `discussion`. Retrieval presets and ordinary discussion children receive observation only.
The caller cannot supply a parent, Run or role to the model-facing API.

Native calls use the shipped `varin.builtin.computer` ordinary extension. Its single declaration
owns `computer_list/apps/observe/act/cancel/release/request/access/grant/deny/wait`,
`computer_control/open/put/install`, `computer_browser_read/browser`, `computer_office_read/office`,
`computer_evidence` and `computer_environment`,
their schemas, completion modes and read/effect classification.
The original extension capability review, immutable binding and ToolInvocationAuthority remain in
force. `computer.use` dispatches through this service, not a separate desktop backend. Actual global
and trusted-project Computer settings can disable dispatch. The original tool binding freezes the
default desktop once per execution; replay restores that configuration rather than reading a new
sidebar selection or default. Explicit desktop selection and actual assignments still take precedence.
An invalid captured Computer default makes that service candidate unavailable through the existing
tool-preparation projection. Unrelated tools can still prepare, even when the Computer provider was
already active. Required saved Computer bindings remain exact; errors do not become a null default.

Application adaptation uses the original ComputerService, driver and remote assignment token.
Browser status/tabs/snapshot/screenshot and Office status/docs/read have read-only schemas;
launch/navigation/evaluate/click/type and Office open/write/insert/save/export have effect schemas.
Even an expression described as read-only requires the browser effect tool. Child labels, script
nesting and a read assignment cannot upgrade these permissions. Target resolution and actual
assignment admission precede the existing physical lane. The returned application automation epoch
can be supplied on later input; a changed epoch or a handback requiring a fresh scene rejects old work.
For input-ready observations, `computer_control` first awaits the existing control reservation,
including its owning remote peer, then returns the original assignment/control state without sending
application input. A child still needs its root's control grant. The first effect can also upgrade a
root's observation assignment; that new peer assignment invalidates the old read epoch. Its rejection
has a no-input receipt and directs the caller to read a fresh scene. No old observation is relabelled.
Only a successful fresh scene read by the current controller can clear its handback fence; another
observer cannot satisfy that requirement. The owner compares the original actor identity, including
peer origin and assignment, rather than a tool label or an observer lease ID. A lost control-reservation
ACK with an unconfirmed drop retains the original assignment cleanup and an unknown result.

`computer_put` returns the stored managed-home file revision. `computer_install` preserves each
package result, including failure. A non-managed desktop reports its actual unavailable capability.
The original application driver receipt separates effect and input-writer completion; loss of a
response remains unknown. Aborting open/browser/office input joins the original lane's physical
release and callback drain rather than treating the observer promise as a stopped writer. A normal
driver response ends that call, not the assignment or the application's own asynchronous work.
Remote application receipts must contain the owning Host's execution evidence; missing evidence
does not become success. File-write/install failures after entering the external writer retain
unknown effects and unconfirmed writer status when the original backend supplies no stronger proof.
The target's own pre-dispatch failure type carries no-input/stopped evidence through the existing
authenticated route; the source preserves it instead of guessing from an HTTP status or turning a
safe stale-epoch rejection into an unresolved writer. The same proof covers a revoked peer token
rejected before entering the endpoint. Managed installer and file helpers retain their exact completion
phase: validation before spawn proves no dispatch; a helper that exited proves stopped even when its
response is malformed or rejected. Exit status alone does not prove that no file/package effects occurred.

Browser screenshot data URLs are decoded by their producer adapter into typed media parts with the
reported image MIME type. JSON keeps only its part index and other result metadata. The original
evidence journal now retains the admitted work/Run as well as legacy Pi session association; it never
substitutes a role label or records expressions, typed text, URLs with credentials or file bytes.
An authenticated remote observer can read this same journal without requesting control.

`computer_environment` inspects the accepted Run's frozen source and original desktop assignments.
It explicitly reports that native placement mutation and service forwarding are unavailable.
The existing Pi placement/forward owners require a Pi Registry session; Native work does not invent
one or represent a still-live listener as a completed short tool. Native placement/forward Jobs,
desktop prepare/start/stop and artifact registration remain separate integration work; the existing
product/Pi capabilities are unchanged.

Native child tasks, with or without a file source, request a desktop through their real ModelStep or PolicyAction
Operation. Catalog owns the request, original decision and durable Wait; reasons and notification
bodies use ContentStore. Acceptance queues one typed Environment input for the root in the same
commit. A root parked on the requesting child's actual dependency chain can end that observation
without cancelling or reporting the child complete; unrelated observations remain intact. An idle
root resumes through the normal launch capture, Goal, pause and question admission boundaries.
A terminal requester invalidates an undelivered notification instead of waking an obsolete task.

Root tool decisions and authenticated user decisions share that request owner. The user can decide
from an idle root without inventing a Run. A stable command key binds the original choice/reason;
changing either is a conflict. Grant reserves the original physical assignment before publishing
`granted`. Cancellation that wins publication releases that exact reservation. Lost publication
reconciles the same claim; Host restart or an absent original reservation never silently reissues it.
Short claim reconciliation and original terminal cleanup do not load request reasons. Public detail
reads still report missing/corrupt content instead of silently replacing it.

`computer_wait` is a distinct Job observation: acceptance releases its slot, and an original decision
adds one Environment fact after recovery. Cancelling this Wait leaves the request and assignment
alone. `granted` records the earlier ready assignment; `released`/`unavailable` reflect the current
physical projection, not a rewrite of the decision. Each Native child assignment belongs to its own
Run, so a root's natural completion does not terminate independent child work. Native actors carry
per-tool invocation policy; Pi keeps its own read-only role rules. Neither adds a second grant list.

Source-less pure-capability children use the original ChildTask admission with explicit absent file
authority and no applicable file result. They retain their own Run, selected capabilities and original
Computer permissions. Trusted handback uses the original execution/input path described below;
persistent scripts invoke these same ordinary Computer tools through the original tools.invoke permission
and dispatch scope. Closing their original script call triggers the same physical stop and drain path.
These limits are independent of the existing Pi capabilities below; selected tools alone never grant
a desktop assignment.

Pi workers and retrieval threads have the `computer` tool when Computer Use is enabled. A child calls
`computer` with `action:"request"`, desktopId, access (`observe` or `control`) and reason. The Host wakes
the main conversation with the request identity. The main agent coordinates the work segment with
`grant`/`deny`. A grant fixes the child's desktop environment without replacing its shell target.
`wait:true` releases its execution slot and awaits a decision event without polling or a reply timer;
the default returns immediately so the child can do other work. Abort, denial and Run termination
settle that wait. `access` returns assignments and requests; `releaseAssignment` ends a work segment.

There is one controller per physical desktop, including the main agent. Observers coexist with it.
Separate windows on one desktop share control; separate desktops/VMs can run in parallel. Observation
IDs are owned by session and Run, so another observer does not replace a controller's current tree.
Control epochs include the execution identity, invalidating cached application objects across rounds.

Remote assignments are reserved at the owning Host before a source Host confirms a grant. Automatic
HTTP operations require its opaque assignment token and recheck it at dispatch. Peer observers do not
release a peer controller. Lost claim receipts are released by source lifetime, assignment identity,
actor identity and access mode too. A revoked assignment cannot arrive late and become live after
release; a new work segment has a new identity. Source/target restarts do not silently renew tokens.
A crashed source's remaining
reservation requires explicit human takeover on the target; there is no speculative expiry timer.

## Cancel work and transfer control

The conversation overview captures an exact execution: explicit root Stop captures its current Computer
family, while child Stop targets that child. An idle root can stop a displayed live child assignment. Native
uses `ThreadsAPI.computer` through the authenticated `/api/threads/computer/state`, `/decide` and `/stop` routes;
Pi retains `automation/stop` with its actual session and displayed Run. Old cleanup is addressed by
its own work and Run, including when shown under an idle root. Known accepted cleanup starts before
waiting for a new identity projection; stale work cannot stop a replacement execution.

The full desktop viewer instead calls `/api/computers/desktops/:id/stop` with the displayed
`automationEpoch`. Its real target owner validates the generation; a remote actor is never sent to
the viewing Host's local Thread owner. The Electron control bar calls the original desktop owner
directly. The Host invalidates old admission tickets, denies
matching pending requests, cancels exact-Run Computer REPL evaluations, drains native/external work,
releases held input and ends those assignments. Other desktop assignments remain independent.
Permissions are unchanged: fresh work in the same Run can acquire an assignment after release.
Old scripts and observation bindings cannot resume through that new assignment.

Native terminal cleanup is also a product consumer, not a requirement for the model to call release.
Original runtime/owner notifications wake reconciliation of Computer's already accepted executions;
the original Catalog must confirm completed/failed/cancelled before `finishExecution` runs. A tool
binding update or kernel channel reset alone is not terminal evidence. Reconciliation has no timer or
second execution ledger; original physical release rules still apply.

Pi receives its existing passive user-cancellation notification. Native cancellation and takeover
are typed Environment facts, transferred from the original desktop outbox to Catalog. They retain
original actor/desktop/control identity and distinguish confirmed release from unknown cleanup.
The operation reports any known partial effects. `cancelling` lasts through release; success returns to `enabled` and removes the work banner.
`cancel-unconfirmed` preserves a real release failure for recovery. There is no stopped-round state.

Human takeover requires an explicit action. It suspends the assignment, interrupts its active Pi script,
invalidates queued input and releases managed keys/buttons; physical mouse motion does not transfer
ownership. Target/focus changes interrupt the affected action and retain Agent ownership. Handback
keeps an otherwise live assignment, invalidates old observations and retains a durable continuation for the actor
captured at takeover, with its root informed. Pi retains its existing current-Run behavior. Native
handback enters an eligible active Run at its legal input boundary, or uses the original root/child
continuation owner after natural completion. The successor is a real Run with the original frozen
launch and typed Environment history, including source-free children. Catalog derives root lineage;
root fanout is passive, and a notice grants no assignment or permission. Natural completion still
releases the old assignment: retaining the original handoff fact does not authorize the ended Run. A replaced execution is
passive; explicit Run/tree Stop and ended Goal cannot be revived. Existing Goal/pause/question holds
and unrelated observation Waits remain authoritative.

The original interrupted-control record survives Native natural completion as provenance only.
After return it is marked returned, is not presented as a human operator and cannot restore an ended
Run or lease. It retains the exact actor/event for Stop even after the input-acceptance ACK. A new
actual control assignment or takeover replaces it; an observer does not. On restart it is read from
the original desktop record, separately from physical-release markers.

The desktop outbox keeps each immutable kind/ID until a definite Catalog input-acceptance receipt.
A lost response retries that identity without creating a second input or execution. Computer Stop
captures exact pending handback IDs and persists its original short cancellation command until ACK,
including when body transfer is slow or has not committed. These revocations bypass failed fact
bodies. Replaying an old Stop does not cancel a later handback in the same Run, erase already-delivered
history or stop a whole successor Run. Physical release starts independently of these metadata
transfers. A new action still requires fresh observation and the current per-call binding; old queued
actions cannot resume. No polling scheduler or second desktop/execution ledger is introduced.
The latest observer/usage record never selects the recipient. Remote control assignments subscribe
to the owning Host's control stream without frames, even when no viewer is open.

For an already resolved local desktop, explicit cancel/takeover and the control bar's original
`automation.cancelDesktop` route fence the existing lane and start its physical interrupt before
waiting for catalog reads, script revocation, control persistence or diagnostic writes. Placement is
remembered only after the original desktop record is loaded; an unknown or remote target still uses
its owning resolver. An observer releasing its assignment does not stop another controller.
The release acknowledgement and the old lane callback must both finish before cleanup is confirmed.
A persistence/revocation failure after input release remains an actionable partial failure; it does
not pretend that human-control persistence succeeded or restart the old queued input.

Windows owns synthetic input in `input-controller.cs` on a thread separate from PowerShell's UIA
calls. A release side channel fences the native owner and acknowledges key/button release before
the Host closes that helper. The next operation starts a new helper. A crashed helper cannot prove
release. Normal assignment completion restores the prior foreground only while the Agent's last
target still owns focus; takeover does not reclaim focus from the user.

`ComputerActionReceipt` separates effect (`none`, `dispatched`, `partial`, `verified`, `unknown`),
fact-based reason and recovery. OS acceptance is not application completion. Only explicit value
readback confirms `set_value`. Tool text contains the short result and relevant next step, not an
internal trace. Explicit `app_post` text requires a native Edit/RichEdit handle in the selected window;
it cannot silently route browser input through unsupported Win32 edit messages.

The original desktop record's `runtimeVersion:4` stores discriminated work/usage and a short
`physicalControl` marker before input. It identifies the Host control generation, original input
helper and actual assignment or human holder. Malformed or obsolete nonempty runtime metadata remains
an actionable fenced state; desktop configuration and external assets are not migrated or erased.
An empty reservation map, replacement Host/helper, readiness probe or new control epoch cannot prove
old held input released. Confirmation requires the original helper's release acknowledgement plus
callback/process drainage, or the original managed desktop session's actual stop. A failed durable
clear retains the barrier and may retry using that same retained proof. A local-console helper lost
with its Host has no durable cross-restart release acknowledgement, so it remains unconfirmed.

`ComputerActionResult.inputWriterStopped` is separate from both action effect and assignment release.
A lost action response stays unknown even if explicit cancellation later proves its writer drained.
Ordinary tool settlement consumes that original result. The Host does not manufacture success from
an ended callback or repeat unknown input. An input supervisor never respawns a new helper under the
same physical-owner identity; capture helpers may still restart independently.

## Feedback and presentation

Native request decisions and physical changes emit the original family's short projection invalidation,
not a partial state assembled from Pi's ephemeral requests. The shared event parser routes it to the
current work's existing state reader; request-detail errors appear in the overview. In-flight reads
finish and coalesce a trailing refresh, while original Host/selection/control fences reject late
replies. This presentation work never blocks request acceptance or physical Stop. Pi keeps its original
full-state notification path.


Observations keep the native tree on the owning Host and return a display page (100 lines by default,
`textLimit:"max"` to expand). `observationId` plus `offset` reads the same retained tree without capturing
again; its original element indexes and execution ownership remain authoritative. Screenshots are
explicit. Post-action observations use the same paging contract. Native per-field text handling is
independent of public tree pagination.

Native helpers emit optional `target` and `dispatched` NDJSON gesture events after window/element
relocation. The supervisor correlates them with the live request without treating progress as its
final receipt. The Host emits completion/failure/cancellation using that receipt and discards obsolete
generation progress. Gestures contain coordinates/rectangles, operation and shortcut, never typed text.
They do not capture frames, delay input or enter model history. Linux's Page-key scrolling feedback
identifies the window instead of inventing a pointer target.

Existing desktop SSE carries gestures alongside frames/control, including remote and noVNC viewers.
The shared presentation maps physical coordinates, negative origins, scaling and letterboxes into
cursor movement, click ripples, drag updates, target highlights and keyboard/scroll badges. Raw events
are forwarded without React coalescing away a fast dispatch. Stop and takeover clear the visual layer.
Control events update the viewer's imperative input fence before the next gesture in the same SSE
batch. The native overlay paints queued phases in order and starts its hide timer after rendering;
failed actions show a failure marker rather than a successful click ripple.

Electron renders the same presentation in nonfocusable, disabled, click-through Windows windows,
converts physical pixels to per-display DIP, and excludes them from capture with
[Electron content protection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable).
They have no preload, credentials or privileged IPC. Linux/macOS use viewer feedback; their native
capture paths cannot currently exclude a real-desktop overlay reliably.

The overview and small desktop launcher share `useComputerAutomation`: one snapshot plus the existing
UI stream per viewed conversation, no capture or polling. Full/compact overview show the desktop,
operator, current app/operation and pending requests; both offer Cancel computer work. The compact action
does not open the full panel. This state is a Host projection, not a renderer authority.
Native conversations use the same projection and show current work separately from unresolved old
cleanup. Snapshot reads do not probe or capture desktops. Shared protocol parsers serve HTTP and SSE;
late Host/work/Run and control-generation replies cannot erase newer cleanup, including delayed
takeover and handback replies. Errors expose bounded owner/stale/format/release diagnoses and refresh
or recovery actions. Unknown cleanup does not invent a new ban on the original recovery controls.

The Windows native shell adds a nonfocusable bottom control bar with Take control / Return to Varin
and Cancel computer work. Its fixed commands call this same Host. Varin windows are excluded from
automatic app enumeration and capture while work is active; this does not make two applications on
one local desktop independent. Semantic actions highlight the target without inventing pointer motion.
The selected default desktop prewarms its resident input/capture helpers without observing or focusing
an app. Other desktops prepare when selected or used.

## Evidence boundary

Focused tests exercise actual Registry identities, local/peer exclusivity, observer isolation, event
waits, cancellation and epoch fences, real HTTP routing between simulated Hosts, sleeping native Node
REPL revocation, progress correlation, negative-origin feedback mapping and compact overview stopping.
The ordinary-application Node tests drive the original authenticated Router directly (without a
listener), the shipped extension broker over child IPC, and controlled driver/VmExec responses. They
cover peer reservation/re-observation, pre-dispatch rejection, original cancellation/drain, typed media
and unknown effects independently of stopped input.
The Windows targeting fixture invokes production functions with fake controls/input and checks visual
events without desktop access. Those results do not establish real Windows overlay placement or
Linux/macOS desktop input, VM installation, or an installed release's visual acceptance.
