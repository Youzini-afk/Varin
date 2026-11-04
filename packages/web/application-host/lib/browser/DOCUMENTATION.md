# Desktop browser owner

`native-owner.ts` is the shared BrowserOwner for Electron and the CEF desktop shell. It owns page identity, Thread retention, action serialization, AX references and frame freshness, input cancellation, dialogs, transfers and the public BrowserUse contract. React presentation does not own a page's lifetime.

`native-page.ts` is the native boundary. Electron supplies real WebContentsViews and its original `persist:varin-browser` session in `packages/electron/browser-owner.ts`. `native-shell-owner.ts` supplies CEF pages through the inherited private desktop service pipe. Neither adapter creates a second Catalog, conversation loop or public HTTP authority.

`native-page-transport.ts` exposes exactly one native page to Puppeteer. Browser-wide lifecycle commands are synthetic or refused; page CDP commands and child frame sessions reach the original browser. The Electron wrapper and CEF adapter use the same transport. The implementation preserves its upstream Apache attribution.

## Native pipe

- Requests use `browser.create`, page commands/navigation/presentation/close, capture and download operations. Events arrive as `browser.native`; pipe loss is `browser.native.disconnected`.
- Creation must echo the requested context: persistent `interactive` or separate anonymous `web-render`. The `desktop_web_render` command uses only the latter, accepts HTTP(S), and closes the original transient page even on timeout. It never borrows BrowserUse login state.
- Screenshots travel as private files with opaque capture identity, declared dimensions, length and SHA-256. The adapter checks root containment, no-follow open, bytes and PNG dimensions, then releases the original receipt in `finally`. Only the existing UI response is base64.
- Downloads retain their staging directory until `finished()` proves the original native writer terminated. A cancel acknowledgement, page closure, interrupted update or lost pipe is insufficient. CEF emits `terminal: true`; Electron waits for DownloadItem `done`. Release removes the local bytes, then the terminal native receipt. Page close releases downloads before closing the page's native registry.
- Lost native observation leaves earlier effects unknown. It does not synthesize executor stop or successful cleanup. Creation and disposal keep native resources owned through their real close receipt.

`native-shell-owner.test.ts` drives the production shared owner, Puppeteer and CDP transport against a native-device fixture. It exercises identity-preserving remount, stale input rejection, pending and queued cancellation, lost pipes, file capture, terminal download cleanup and separate Web rendering. Installed CEF/session/sandbox behavior requires native desktop acceptance in addition to these tests.

## Viewer clipboard

`native-clipboard.ts` retains one one-use selection ticket per live viewer in the original BrowserOwner.
Capture uses the focused frame's isolated Puppeteer realm; the ticket holds its actual input/DOM nodes,
selection offsets and original page/control generation. Password and non-editable selections are not
captured, and inaccessible frames never fall back to a guessed document.

The viewer writes its local clipboard before redeeming a cut ticket. The original serialized input lane
rechecks the viewer lease, then atomically checks the same selection and invokes Chromium's editing command.
It never writes the device clipboard or replaces input values directly. Changed selections, navigation,
revocation, cancelled/no-op edits and repeated tickets do not report a successful cut. Navigation, viewer
release and page teardown dispose retained handles; uncertain deletion is not automatically replayed.

## Explicit cross-device grants

`registry.ts` selects original owners and admits authenticated Browser device connections. `device-service.ts` runs beside the original native owner and connects only after explicit interactive-profile authorization for the selected Host. HTTP and both WebSocket lanes check the Host identity; grants and one-use identity challenges bind the authenticated principal. The owner signs the challenge with its process-generation Ed25519 key; its public-key fingerprint determines its Browser identity. A different device cannot claim a disconnected owner's pages by copying catalog fields. The Host accepts recovered stop receipts only from that same device, Browser and owner generation, with the original request lease.

Control and binary media use separate sockets. Observer loss leaves the original executor and its lease alive and reports unknown effects without replay. Explicit local or remote revocation aborts and drains every retained connection generation for that Host, not just the newest socket. A terminal receipt remains available until acknowledged; reconnect can confirm actual stop but does not reconstruct the original effect result. An error without a confirmed stop retains its pending lease even if the device cannot provide a completion waiter. These recovery records are process-local, not a durable cross-process execution journal.

`device-service.test.ts` exercises the production HTTP routes, authenticated upgrades and both WebSocket lanes against the native fixture, including impersonation, challenge replay, foreign recovery receipts and revocation after reconnect. `remote-owner.test.ts` covers malformed and unconfirmed execution receipts. These tests do not establish physical-network reliability, installed CEF behavior or recovery after Host/native process replacement.
