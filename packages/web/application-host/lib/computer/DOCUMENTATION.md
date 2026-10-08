# Computer Use admission and feedback

`ComputerService` owns the existing catalog, native drivers, ordered input lane, human control,
remote routing and viewer stream. `computer-automation.ts` adds ephemeral assignments over that same
lane. It does not create another scheduler or another desktop backend.

## Thread identity and desktop assignments

`computer-actor.ts` resolves the broker's session through the actual Registry Thread/Run and its durable
ancestors. Attached Agent, research and Bot roots retain their main-agent role even though their Thread
kind is `discussion`. Retrieval presets and ordinary discussion children receive observation only.
The caller cannot supply a parent, Run or role to the model-facing API.

Workers and retrieval threads have the `computer` tool when Computer Use is enabled. A child calls
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

The overview cancels the current task family's computer work through `automation/stop`. A desktop
control bar scopes cancellation to that desktop. The Host invalidates old admission tickets, denies
matching pending requests, cancels exact-Run Computer REPL evaluations, drains native/external work,
releases held input and ends those assignments. Other desktop assignments remain independent.
Permissions are unchanged: fresh work in the same Run can acquire an assignment after release.
Old scripts and observation bindings cannot resume through that new assignment.

The Agent receives a passive user-cancellation notification. The operation reports any known partial
effects. `cancelling` lasts through release; success returns to `enabled` and removes the work banner.
`cancel-unconfirmed` preserves a real release failure for recovery. There is no stopped-round state.

Human takeover requires an explicit action. It suspends the assignment, interrupts its active script,
invalidates queued input and releases managed keys/buttons; physical mouse motion does not transfer
ownership. Target/focus changes interrupt the affected action and retain Agent ownership. Handback
keeps the assignment, invalidates old observations and delivers a durable continuation to the actor
captured at takeover, with its root informed. Ended or replaced Runs do not receive that continuation.
The latest observer/usage record never selects the recipient. Remote control assignments subscribe
to the owning Host's control stream without frames, even when no viewer is open.

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

## Feedback and presentation

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
The Windows targeting fixture invokes production functions with fake controls/input and checks visual
events without desktop access. Those results do not establish real Windows overlay placement or
Linux/macOS desktop input, VM installation, or an installed release's visual acceptance.
