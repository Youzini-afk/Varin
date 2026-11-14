# Varin Browser Connector

Manifest V3 extension connecting a user's Chrome/Edge tabs directly to an
Application Host. It runs independently of the Varin frontend, Harness,
workspace and desktop. No native helper, browser debugging port, copied profile
or separate credential service is required.

## Connect

1. In Varin **Settings → Browser → Connect Chrome or Edge**, download and extract
   the extension. Open `chrome://extensions` or `edge://extensions`, enable
   Developer mode and load the extracted directory. Store delivery is pending.
2. In the same settings dialog, name the browser and create a device pairing
   link. Use this Host's address reachable from the browser device. The existing
   device-pairing owner issues the one-time link.
3. Paste it into the extension, select an address and click **Connect to Varin**.
   Chrome asks for access to that service origin. The extension redeems the link
   through the same `/api/client-auth/pairing/redeem` used by other clients and
   stores the resulting device credential in trusted extension storage. Existing
   `varin://connect?v=1` device links also work without issuing a replacement.
4. Open the intended tab and choose **Share current tab**. Its real sign-in state
   stays in the browser. Repeat for other tabs. The popup can pause a task,
   stop sharing, or disconnect the service; the device can be revoked through
   Varin's existing **Devices and access** settings.

Only the selected Varin service origin receives optional host permission. Page
interaction uses `chrome.debugger`, which requires its installation permission;
installing the extension alone does not share a tab. No content scripts or
external-message entry points are installed. The popup does not receive the
stored bearer credential. HTTP(S) direct connections, including LAN and mounted
services, are supported; a relay-only link reports that its transport is not
available in this extension.

See Chrome's [network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests),
[optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
and [debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).
Active debugger sessions keep an MV3 worker alive from Chrome 118; the declared
minimum remains 125. See the [worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

## Resource and execution identity

The installation's `browserId` is persistent. A new worker connection uses a new
`instanceId`; each tab attachment has an opaque `pageId`. Closing, detaching or
replacing a page invalidates its observations. Ending sharing does not close a
user tab. Restarted connections do not restore previous tab scopes automatically.

`extension/transport.mjs` exchanges resource announcements, events, commands and
receipts with `/api/browser-resources/connector/exchange` using the existing
device bearer. The Host binds the resource to its authenticated source and owns
task routing and page coordination. Commands are consumed once. Transport loss
ends the connection rather than replaying commands or uncertain results. An
intentional disconnect releases local scopes, then makes one terminal exchange.
Announcements, events and receipts are acknowledged immediately; only an idle
exchange waits for a new command. The popup receives actual state-change events.

The workbench and popup share the provider's pause state; either can hand control
back. Pause rejects new input; an action already sent may still settle. Resume
requires a fresh observation. Chrome's debugging banner, DevTools detach and policy
restrictions remain visible. The actual operation list is `CAPABILITIES` in
`extension/connector.mjs`: shared-tab reads, screenshots, navigation, element
clicks, typing, named keys and activation. This provider currently does not offer
new-tab creation, arbitrary evaluation, subframe interaction or file transfer.
Use a CDP provider when those capabilities are needed.

## Development

```sh
node packages/browser-connector/scripts/package.mjs
node packages/browser-connector/scripts/check.mjs
node --test packages/browser-connector/test/*.test.mjs
```

Host builds include the extension as a small cross-platform asset; settings
downloads an archive from the running Host. No browser-native binary is built.
The popup and connection messages use Chrome's native `_locales` catalogs and
follow the browser's UI language independently of the Varin frontend language.
Tests cover the connector state machine, original device pairing over HTTP and
the actual background module's share/command/receipt path without native
messaging. An opt-in Chromium integration uses `VARIN_BROWSER_EXECUTABLE` in
`test/chromium.test.mjs`; real Chrome/Edge installation and browser policies
still need platform acceptance.
