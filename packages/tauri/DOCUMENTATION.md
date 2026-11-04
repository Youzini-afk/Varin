# Native desktop adapter

The public desktop contract remains in `@varin/application-client/desktop`. `src/bridge.ts` adapts that catalog to the native dispatcher without exposing Tauri APIs to React. `src/native.ts` is the only renderer module importing the Tauri API. Normal Web/mobile and embedded frames do not load it.

Every trusted top-level window independently obtains `varin_bootstrap` before RuntimeAPIs or persisted React stores initialize. Native role, application origin and per-window Host selection are authoritative. Unknown remote documents and decorative scene/stool surfaces receive neither the bridge nor Host credentials. Native errors remain errors, including unavailable capabilities and unobserved effects.

The private local-Host restart event contains only the previous origin. The adapter re-reads the authorized bootstrap and uses the existing guarded runtime switch, preserving document/draft guards and editor surfaces. It checks identity both before queued preparation and at commit. A window already switched to a remote Host retains that endpoint and its credentials. This event is not exposed through the public desktop event catalog and does not reload a renderer.

## Window presentation

The first application document is constructed after the existing settings/native migration phase, so its blocking prepaint script can use an allowlisted, non-secret mode and splash-color projection. Existing frontend theme storage takes precedence. The projection never writes localStorage or acknowledges migration; the original importer remains the only frontend handoff owner. The window is still shown before Application Host readiness, without adding a renderer acknowledgment or timeout gate. A temporary migration window closing during this phase is not a quit request; explicit shutdown retains its original drain path. Runtime/settings failures create the normal startup-error surface and release the existing failure signals. This is a source-level first-paint contract, not measured CEF paint timing or GUI evidence. Native resource admission is closed before shutdown snapshots windows/services; already-admitted construction or migration cleanup must publish or settle before that snapshot. Host/renderer readiness is outside admission. Quit interrupts private migration-reader waits while retaining original page/process cleanup, and a cancelled or failed guarded shutdown reopens admission.

Mini Chat's Open in main action selects a workbench on the same Host, including relay identity. Draft handoff retains its directory and project; an incomplete Thread/branch identity is rejected. Native focus and event admission must succeed before Mini Chat closes. New workbenches always receive the main role rather than inheriting the caller's Mini Chat role. Navigation and update-menu intents wait for the target document's readiness; Mini Chat is not an update-dialog consumer.

Windows and Linux attach the hidden application menu only to conversation windows, including later windows, while macOS retains its global menu. macOS transparency keeps the shared Save and Restart contract: persist the preference, honor the existing guarded shutdown, then relaunch with matching native and renderer backing.

Companion pin changes pass through the surface's original Host owner and refresh its scene after the native receipt. While that owner has surfaces, native topology is sampled once a second because Tauri has no global display-change notification. Membership, primary display, work area, position and scale changes notify the original placement owner; enumeration order alone does not. Same-DPI hotplug and physical platform composition still require desktop verification.

## Computer Use presentation

Each native service owns its original Host control holder and an owner-specific control window. The inert control links return only to that captured service channel. Native presentation does not own input execution or transfer the Host's human-input lease.

On Windows, one app-lifetime capture registry protects all application windows while any Computer Use owner is active. A newly built workbench or companion stays hidden until it inherits those active leases. The registry preserves each original capture affinity across overlapping owners and restores it only after the last owner releases. Failed or unknown writes/restores retain the original obligation. Window labels and HWNDs can both be reused, so restoration also requires the original native generation marker; the original Destroyed callback retires only its own generation. Overlay shutdown requires the original CEF close receipt, not a close request or renderer termination.

Renderer readiness, evaluation admission and terminal receipt draining share one synchronized state. A close or crash between observing readiness and registering an evaluation rejects that evaluation instead of leaving an unresolved promise; a late page-load event cannot revive a terminal renderer. Pure registry tests cover these ownership interleavings, but actual Win32 affinity changes and multi-display overlays still require Windows native validation.

## OS links

The shared `web/application-host/lib/platform/desktop-deep-links.ts` owns the original desktop `varin://host`, `varin://thread` and v2 `varin://connect` vocabulary. Both shells use it. The on-demand native coordinator parses external activation privately; the renderer never receives raw pairing URLs or secrets. A native consent dialog lists the candidate servers before any probe, redeem request or host write. Decline, expiry and shutdown cannot silently connect later. An atomic update through the existing settings owner retains a matched host id and an existing default selection. SSH configuration import remains with the existing connection manager; external URLs do not become arbitrary SSH commands.

## Frontend state handoff

`packages/electron/bootstrap.mjs --varin-export-frontend-state` selects a standalone old-engine exporter before `main.ts`. It takes the existing Electron instance lock, opens an inert page at the original `varin-ui://app` origin and reads localStorage through main-process DOMStorage CDP. It starts no Application Host or Catalog and does not execute renderer export code. It obtains the same cross-language desktop data-root lease used by normal startup, or verifies the inherited native parent lease before reading any old profile.

Managed Host/exporter processes enter their OS scope before their private input becomes
available. On Windows 10+, an independent native guardian creates the original service
with `PROC_THREAD_ATTRIBUTE_JOB_LIST` and an explicit inherited-handle list, then records
its active receipt before resuming the exact initial thread. The service's stdin/stdout
remain separate from guardian control; a shell crash cannot keep the service outside the
Job or kill the only scope observer. The guardian retains the original process and Job
objects, terminates the tree on shell loss, and commits `ended` only after observing every
original member stopped. Its pending receipt is published while the original lease
directory is pinned against replacement. A guardian crash remains unconfirmed, rather
than treating a vanished PID, exit code, timeout, or Job name as termination.

Linux's guardian is a subreaper and waits for adopted descendants, including detached
sessions. macOS cannot prove arbitrary escaped descendants are gone after an abnormal
termination, so those scope receipts remain unresolved rather than permitting another
writer. macOS leases bind the original owner to the OS host UUID and boot-session UUID.
Windows records a separate SMBIOS system UUID and the documented OS BootId counter; only
a strictly later counter on the same machine permits retirement of an unresolved lease.
Unavailable firmware/boot evidence gives no reboot privilege. Foreign-host, unreadable,
malformed, rolled-back or absent proofs retain original ownership. Recovery also validates
all original scope schemas and preserves their unchanged records; a reboot does not turn
unknown business effects into successful completion. Windows crash/admission tests run
real shell, guardian, service and descendant processes and pin their original handles.
Cross-compilation does not replace execution of those tests on Windows.

Windows lifetime contracts: [atomic Job assignment](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
[object names are not object lifetime](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/life-cycle-of-an-object),
[BootId](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/oem-hvci-enablement),
[SMBIOS system UUID](https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/smbios).

`application-client/src/desktop-frontend-migration.ts` enumerates persisted product stores and their allowed fields. It covers UI/voice preferences, projects, explorer/editor snapshots, durable document owner identity, session presentation and review drafts. Disposable caches, PWA-only choices, transient surface identity, connection grants and unknown fields are excluded. There is no production IndexedDB owner in these UI modules, so the receipt records `no-product-owner`, not a fabricated database copy.

The original settings transaction stores the staged payload, canonical SHA-256, stable export identity and source version. Restaging preserves a pending generation so a partial target import cannot mix generations. Main-window bootstrap verifies the payload again, imports only absent destination keys and verifies writes before acknowledging every imported or retained key. Quota/write/validation failure leaves staging available for retry. The settings owner drops the temporary payload only after a complete matching receipt; old-origin storage is never deleted.

Queued messages do not enter the live auto-send queue. They become separately stored recovered drafts. The workbench recovery UI shows their original target, text and attachment metadata. A user may copy them or insert text into the current draft; this never submits a message or reuses attachment grants. Dismissal is explicit and persisted.

### Credentials and BrowserUse reset

The old frontend credential slots are localStorage `openaiApiKey`, `openaiCompatibleApiKey`, `sttApiKey`, and those same three fields under JSON `config-store.state`. The UI exporter records slot names only. Native settings and secure-store credentials remain with their existing owners. The transition package's manifest-fixed private reader transfers the allowed application credential values over inherited, bounded pipes, never through a renderer export, a plaintext transfer file or logs. Existing target values win, and JSON credentials merge with staged non-secret preferences rather than replacing them. A complete receipt requires real target readback, ordered acknowledgements, reader process-scope termination and native page closure.

The structural desktop upgrade intentionally does **not** migrate old BrowserUse data. The native browser uses its separate `cef/browser` context; the old Electron `Partitions/varin-browser` profile is not opened by the migration reader, merged, copied or deleted. Website cookies, login sessions, localStorage, IndexedDB, Service Workers and site permissions do not carry across. Users need to sign into websites again. This does not reset chats, project registrations, application settings, UI preferences or non-browser credentials, and anonymous Web rendering remains isolated from the interactive browser.

The native receipt records `browserStatus: not-migrated`, `browserRequiresLogin: true` and `sourceRetained: true`. This is an explicit upgrade boundary, not a claim of failed cookie recovery or complete website-session transfer. The installed-product fixture retains only a minimal old cookie/localStorage sentinel: it verifies that the new context did not import those values and that the original source still reads back after uninstall. It does not maintain a cross-generation site-database compatibility layer.

Installed companion packs are handed off by the original asset owner using the old process's actual `userData`, verified files and atomic publication. Linux's original `Varin` profile and the lowercase default Host data directory are not assumed to be the same path. The source cache is retained and an incomplete pack handoff is recorded separately, with per-pack failure categories. It does not block an otherwise confirmed application migration. Recovery offers an explicit retry through the original companion-download owner and opens its actual progress UI; accepting a download is never reported as completion. Malformed individual voice credentials retain explicit recovery outcomes, distinct from protocol, lock, integrity and unknown target-write failures that prevent transaction completion.

A later single-engine package must not silently skip unhandled application preferences or credentials. The transition runtime contains the manifest-fixed reader for those application-owned values, not a second production desktop or a browser-profile migration service. Removing old website compatibility does not authorize deleting old data or weakening cross-shell writer locks.

## Verification boundaries

`test/bridge.test.ts`, `test/frontend-migration.test.ts` and `test/local-host-restart.test.ts` exercise the real adapters, storage receipts and runtime-switch consumers. The shared native Browser/companion owner tests live beside their implementation in the Application Host; Electron policy tests consume the same source. Private-pipe fragmentation/UTF-8 tests, old native-reader consumers and real settings receipts additionally cover application-migration refusal, cleanup, metadata-only persistence and explicit recovery. Type checks cover both shell adapters and shared React consumers. These tests do not replace installed CEF validation of platform transparency, input, session storage, sandboxing or installer migration orchestration.
