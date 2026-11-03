# Desktop companion owner

The original desktop policies have one shared implementation here:

- `window.ts`: placement, drag anchoring, display clamping, presentation readiness and passthrough policy.
- `scene.ts`: descriptor validation, revisions, layout, mount gates, coalescing, retirement and renderer recovery.
- `stool.ts`: captured world-space stool positions, lift/landing lifetime and readiness.
- `portfolio.ts`: inert scene drawing and HTML inputs.
- `assets.ts`: optional pack catalog, resumable download, SHA-256 verification and atomic generation publication.

Electron's corresponding modules re-export these owners. Its shell still supplies BrowserWindow operations. `native-shell-owner.ts` injects private CEF operations into the same policies, with the original cross-process settings store. It runs in the existing lightweight desktop service and does not import Host/Catalog startup.

The private native boundary is `companion.snapshot/create/update/close/ready/publish/stoolVisible`, plus the `companion.native` event. Snapshots contain monotonically revised native window state, actual cursor and display geometry. Renderer-supplied cursor coordinates do not control global placement. Scene/stool readiness is a fixed CDP query, while the companion itself reports its first painted artwork frame through the existing application command.

The native CEF module owns transparent OSR/GPU windows, multi-DPI conversion and actual close receipts. Decoration surfaces have no Tauri initialization scripts, IPC or Host bootstrap. Only the character's trusted application window has its normal role-scoped bridge. Scene windows follow their owner; stools deliberately retain world coordinates. CEF `on_before_close` proves lifetime termination. Shutdown fences new creation, drains already-started creation and closes all original surfaces even if Node exited.

Artwork uses `http://varin-companion.localhost` on every CEF platform. Requests are bound to an actual native surface and its pinned pack/version. The shared owner and native server both verify catalog file identity, length and digest. Browserless protocol requests cannot borrow another window's authority. Opening a companion never implicitly downloads a pack.

`CompanionAssets.importInstalled` is the one-time old-shell handoff. While both desktop roots are exclusively owned, it reads only installed catalog-declared PNG/JSON assets, verifies every byte and publishes a new target pack with an atomic rename. Existing target generations are retained; source files remain untouched. It does not copy profiles, cookies, partial downloads or arbitrary files and never uses the network. The old Electron export entry supplies its actual `userData` location, including its distinct development profile.

The original Electron policy tests continue to exercise these shared modules. `native-shell-owner.test.ts` adds consumer tests for real settings and pack files, first paint, sender isolation, native cursor placement, captured stool origin, scene mount and true close, including shutdown while a decorative mount is still pending. OS compositor, IME and multi-monitor acceptance still require native execution.
