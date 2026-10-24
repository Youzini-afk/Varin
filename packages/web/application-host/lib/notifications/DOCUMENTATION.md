# Notifications module

Notifications project committed native Catalog facts. They do not admit, resume or cancel work,
and OS delivery is separate from Catalog read cursors and unread state.

## Runtime flow

1. `thread-runtime.ts` observes native durable events. Completed/failed root Runs and open
   permission/question Operations produce notifications; completion/failure in child Threads (including
   later Runs), deleted/archived Threads and terminal permission/question Operations are excluded.
   Child questions and permission requests still notify because they require a user decision.
2. Startup and kernel reconnection begin at the current durable cursor. The live observer reads later
   facts rather than replaying all historical notifications.
3. `application-host/index.ts` applies notification settings and fans the payload out to desktop,
   authenticated UI SSE, Web Push, Expo mobile push and APNs through their existing owners.
4. `routes.ts` owns `GET /api/notifications/stream`, push registrations and UI visibility endpoints.
   The old session-attention and badge-projection owner is gone.

The title is the actual Thread title, falling back to `Varin` when empty. Bodies are fixed status text
for completion, failure, permission or a question; response bodies are not copied into notifications.
Payloads retain Thread, branch and Run identity and a navigation target. Thread titles can themselves
contain private information; push transports can read them.

`createGlobalUiEventBroadcaster()` is SSE-only. Native Thread observation uses its authenticated
HTTP/SSE routes; terminal and dictation WebSockets retain their own transport owners. Closing a
notification stream does not stop native work.

APNs always uses its own delivery path rather than the UI visibility gate. Web Push can require no
active SSE client; Expo push is suppressed while an interactive client is visible. These delivery
policies do not establish successful notification display or read acknowledgement. APNs deployment
and confidentiality details are in [APNS.md](APNS.md).

## Verification

Focused `thread-runtime`, emitter, push, APNs and SSE route tests cover their own adapters. Actual
browser subscriptions, iOS delivery and desktop presentation require their target environment.
Use the Web package scripts and [development guide](../../../../../docs/development.md) for commands.
