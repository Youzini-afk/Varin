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
