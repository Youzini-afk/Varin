# Mobile Module Documentation

## Purpose

The mobile module owns the server-side contract for a single-server Varin mobile WebView shell. It manages device pairing, device-token authentication, Expo push-token registration, test notifications, and one-time mobile login URLs for WebView sessions.

## Entrypoints and structure

- `packages/web/application-host/lib/mobile/routes.ts`: Express routes for pairing, mobile devices, push-token registration, test push, and `/mobile-login`.
- `packages/web/application-host/lib/mobile/device-store.ts`: JSON-backed mobile device registry under the Varin data directory.
- `packages/web/application-host/lib/mobile/pairing-runtime.ts`: short-lived pairing tokens and one-time mobile login tokens.
- `packages/web/application-host/lib/mobile/push-runtime.ts`: Expo push delivery channel for registered mobile devices.

## Route contracts

- `POST /api/mobile/pair/start` — authenticated browser route that creates a 5-minute pairing token and QR payload.
- `POST /api/mobile/pair/complete` — mobile app route that exchanges a pairing token for `{ deviceId, deviceToken }`.
- `GET /api/mobile/devices` — authenticated browser route listing registered devices without secrets.
- `DELETE /api/mobile/devices/:id` — authenticated browser route revoking a device.
- `POST /api/mobile/devices/register-push` — mobile app route authenticated by `x-varin-device-id` + `Authorization: Bearer <deviceToken>`.
- `POST /api/mobile/session` — mobile app route that creates a short-lived `/mobile-login?t=...` URL.
- `GET /mobile-login?t=...` — consumes the one-time login token, sets a trusted UI session cookie, and redirects to `/`.
- `POST /api/mobile/devices/:id/test-push` — authenticated browser route that sends a test notification to one device.

## Security notes

- Pairing tokens are short-lived and one-time use.
- Device tokens are opaque random secrets. Only SHA-256 hashes are persisted.
- `/mobile-login` tokens are short-lived and one-time use, and responses are marked `Cache-Control: no-store`.
- Push payloads should stay conservative by default because APNs/FCM/Expo transport may be third-party infrastructure.

## Notification integration

`packages/web/application-host/index.ts` consumes Pi runtime broker events and fans session
completion notifications out through `sendMobilePushToAllDevices` together with
desktop, UI SSE, Web Push, and APNs channels.
