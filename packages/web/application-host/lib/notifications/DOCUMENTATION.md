# Notifications module

Varin notifications are driven by the Pi runtime broker. The web server does not
subscribe to OpenCode session or event endpoints.

## Runtime flow

1. `pi-session-runtime.ts` consumes `session.snapshot` and `agent.event` envelopes
   from the in-process Pi runtime broker.
2. `emitter-runtime.ts` projects notification payloads to the desktop callback and
   the authenticated UI SSE stream.
3. `routes.ts` owns `GET /api/notifications/stream` plus push-registration,
   visibility, session activity, and attention endpoints.
4. `push-runtime.ts` handles Web Push; `apns-runtime.ts` handles native iOS push.

`createGlobalUiEventBroadcaster()` is deliberately SSE-only. Pi runtime WebSocket
traffic uses `/api/varin/runtime/ws` and must not be mixed with notification
delivery.

APNs operational setup is documented in [APNS.md](APNS.md).

## Tests

Run the focused notification and SSE tests with:

```sh
bun run --cwd packages/web test application-host/lib/notifications application-host/sse-routes.test.ts
```

Before release, also run the full Web tests, typecheck, lint, and production build.
