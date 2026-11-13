# Varin Browser Connector

Opt-in Manifest V3 connector for a user's existing Chrome/Edge tabs. This is a
separate, explicitly installed browser extension, not a Varin extension loaded
into the application renderer. It never launches a browser, opens a debugging
port, reads a profile directory, or exports website cookies/passwords.

The extension declares `debugger` at installation because Chrome does not allow
that permission to be optional. Installing it does **not** share any tabs. Only
**Share current tab** in its own popup admits a real tab. The connected Host
cannot request attachment to another tab. No content scripts, website host
permissions, external messaging, cookies API or arbitrary CDP endpoint exist.
[Chrome debugger documentation](https://developer.chrome.com/docs/extensions/reference/api/debugger)
and [permission restrictions](https://developer.chrome.com/docs/extensions/reference/api/permissions).

## Build and explicit setup

```sh
node packages/browser-connector/scripts/package.mjs
node --test packages/browser-connector/test/*.test.mjs
```

1. In Chrome `chrome://extensions` or Edge `edge://extensions`, explicitly enable
   developer mode and load `dist/extension` as an unpacked extension. Review its
   debugger warning and copy its actual extension ID. This is developer delivery;
   store publishing and installation-policy changes are not automatic.
2. Use the device connection's **already approved** Varin client credential.
   The native helper reads an explicitly selected JSON file containing
   `{"clientToken":"<existing approved varin_client_… bearer>"}`. It never redeems
   a pairing link, issues a token, changes the client's profile, or logs the
   token. On Unix the selected credential file must have owner-only permissions.
   Do not use website credentials or grant a client full control just to make
   this connector work. Host admission remains responsible for its existing
   authenticated principal/device authorization.
3. Create local configuration, with the exact installed extension origin:

   ```json
   {
     "hostUrl": "http://127.0.0.1:3902",
     "credentialFile": "/absolute/path/to/approved-varin-client.json",
     "allowedOrigins": ["chrome-extension://<actual-32-character-extension-id>/"]
   }
   ```

   `hostUrl` must be the Application Host origin, HTTPS or loopback HTTP.
   The helper never accepts URLs or file paths from extension messages. It
   rejects redirects, embedded URL credentials and arbitrary plaintext hosts.
   The local device's Host owns any subsequent managed-host routing. This is not
   a new pairing, relay or file-transfer owner.
4. Prepare a native messaging registration. This creates files only in the
   specified output directory and does not modify Chrome, Edge, or the registry:

   ```sh
   node packages/browser-connector/scripts/registration.mjs \
     --extension-id ACTUAL_EXTENSION_ID \
     --config /absolute/path/to/browser-connector.json \
     --output /absolute/path/to/native-registration
   ```

   On Unix this generates a launcher using the current Node executable. Keep
   both the checkout and that executable available. For a standalone Windows,
   macOS or Linux executable, run `package.mjs --compile windows-x64` (or the
   matching `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
   `windows-arm64` target) with the repository-pinned Bun available at build
   time. Put `browser-connector.json` beside that executable and pass its
   absolute path with `--native-executable` to `registration.mjs`.
5. Review and explicitly register the generated manifest with the chosen
   browser. Chrome's user-level locations are
   `~/.config/google-chrome/NativeMessagingHosts/` on Linux and
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` on macOS.
   Edge uses `~/.config/microsoft-edge/NativeMessagingHosts/` or
   `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`.
   On Windows, set the default value of
   `HKCU\Software\Google\Chrome\NativeMessagingHosts\org.varin.browser_connector`
   or `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\org.varin.browser_connector`
   to the absolute manifest path. Registration is a user-approved installation
   step, not something the extension performs.
6. Open a normal HTTP(S) tab, click the extension and **Share current tab**.
   Its popup displays shared pages and pause/stop controls. Native-host or
   credential failure leaves no task-connected tab. Existing webpage sign-in
   state stays inside the real browser tab.

See the official [native messaging protocol and registration](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
and [Edge native messaging guidance](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging).
Signing/store delivery and real Chrome/Edge native process behavior still need
platform acceptance; portable tests do not establish those claims.

## Ownership and wire contract

The extension's local `browserId` identifies this installation. A fresh service
worker creates a new `instanceId`; each attach creates a new opaque `pageId`
containing the real tab ID and an attachment nonce. Restart, reconnect, detach,
replacement or close never resurrects an earlier page identity. Scopes are not
persisted, and the user must explicitly share tabs again. Disconnect does not
close the user's tabs. Intentional disconnect revokes local scope first, then
makes one terminal exchange if the native transport is healthy. Network failure
uses the Host's existing connection timeout; it does not retry the terminal exchange. Stopping sharing, closing a tab and Chrome's debugger
detach event revoke admission before notifying the Host.

The native helper posts to `/api/browser-resources/connector/exchange` using
`Authorization: Bearer` and the existing client credential:

```ts
{
  browserId, instanceId, label, capabilities, disconnected?: true,
  events: BrowserEvent[],
  results: { id, ok, value?, error?, effect?: 'none' | 'unknown' }[]
}
// Host response
{ commands: { id, sequence, method: 'list' | 'read' | 'act' | 'activate', args: unknown[] }[] }
```

The Host binds identity to the authenticated source, never merely the submitted
browser ID; it owns task leases, forwarding, authorization and unknown-outcome
receipts. A connector command is consumed once. The Host assigns a strictly increasing
sequence per connection owner; extension admission retains a high-water mark.
Duplicates return the original in-flight/recent receipt or are rejected after
receipt-cache eviction, never executed again. Cache eviction does not end a session. A lost exchange ends the
connection rather than retrying it. The Host must mark any dispatched effect
without a receipt as unknown, not failed/unsent. A user reconnect is a new
instance and never an instruction to replay previous commands.

`read` accepts one `BrowserReadRequest`. `act` accepts `[pageId, BrowserAction]`;
`activate` accepts `[pageId]`. `list` uses `[]`. `page` events carry real browser
state plus `instanceId` and navigation `generation`; `closed` also carries a
reason. Pausing is explicit in the popup and invalidates observations. Already
issued browser calls may settle after pause; the original task must retain its
lease until they do. Resume requires fresh element references.

## Deliberate capability limits

The exact list is exported as `CAPABILITIES` in `extension/connector.mjs`.

- Shared-tab listing, top-frame AX structure/text/overview, viewport screenshot,
  activation and HTTP(S) navigation/history/reload/close.
- Element-reference click, text insertion without replacement, and named keys
  without modifiers. Every target must come from this tab's current observation.
  Coordinate input, arbitrary JavaScript, query/find, OOPIF interaction and
  browser-wide tab creation are not advertised.
- Subframes are reported as unavailable rather than silently reading a different
  tab or claiming complete frame support. Navigation invalidates old references.
- No file uploads/downloads or file paths are exposed. The existing file owners
  must provide an authorized transfer path before those capabilities can be added.
- Chrome's own debugging banner, policy restrictions and DevTools detach remain
  intact; this extension never suppresses them or silently reattaches.

## Verification boundary

`VARIN_BROWSER_EXECUTABLE=/path/to/chromium node --test test/chromium.test.mjs`
also provides opt-in real extension/CDP testing in a disposable profile. It is
skipped unless that variable is set and never uses a user's default profile.

Tests execute the real connector state machine against a browser-API fixture,
exercise native message fragmentation, and run the actual native process over
stdin/stdout against an authenticated HTTP fixture. They prove scoped dispatch,
framing, queue and no-replay behavior, not OS browser permissions or real browser
CDP semantics. Real acceptance must cover each supported OS/browser's install,
share, page navigation, DevTools detach, user pause, native disconnect and an
input whose response is lost. Do not claim unsupported upload/download or a
physical multi-device session from these tests.
