# CDP browser owner

`createCdpBrowserOwner` attaches to an owner-configured browser-level HTTP(S) or
WebSocket endpoint. It does not launch a profile, turn on debugging in an existing
user profile, choose a desktop, or acquire input authority. The browser resource
registry supplies resource routing, task assignment and takeover admission.

The HTTP discovery response must retain the configured origin. WebSocket URL
credentials and optional authentication headers stay in the provider; status and
events expose neither. A standard CDP browser token identifies the instance. A
service that exposes only a generic gateway URL cannot prove that reconnecting
reaches the same process, so each connection has a new instance identity. Actual
CDP target IDs identify pages within an instance.

The owner keeps a lane per page. It does not replay requests after transport loss;
a dispatched action without a response has an unknown effect and no remote-stop
receipt. Script cancellation asks CDP to terminate execution, but an unresolved
page Promise keeps its original completion and lane. Native navigation, target
closure, debugger detach, crashes and transport interruptions invalidate observed
references. Coordinate input additionally verifies the observed viewport and scroll.
A native dialog event allows the caller to answer a dialog even when Chromium has
not acknowledged the input that opened it.

An HTTP/CDP connection alone does not provide file transport. `scratchDirectory`
explicitly asserts that the browser process and this provider share a filesystem;
it enables private upload staging and Chromium download capture. Remote services
must instead run the owner beside the browser and use the existing Host byte
transfer path. Workspace paths never become browser paths. Releasing a Thread
only closes unretained pages that this owner actually created, not the user's
pre-existing tabs. Disposing the connection never closes the user's browser.

The provider reports unattached frame execution contexts as unavailable. It does
not claim support for out-of-process frames that have not been attached. The
extension provider and Electron owner have their own actual frame capabilities.

`cdp-owner.test.ts` runs the real HTTP/WebSocket transport against a protocol peer,
covering identity, events, stale observations, per-page ordering, transport loss,
unresolved cancellation and device-owned file bytes. These tests do not establish
live Chromium, visible desktop takeover or a multi-device deployment. The isolated
headless Chromium smoke needs native Unix sockets; an executor that denies those
sockets cannot qualify live-browser behavior.
