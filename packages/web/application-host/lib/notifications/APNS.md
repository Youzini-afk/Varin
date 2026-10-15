# APNs remote push

`apns-runtime.ts` delivers native iOS push through an explicitly configured compatible relay or direct
Apple APNs credentials. This document describes the Host implementation; the deployment's relay owns
its own authentication enforcement, APNs key, storage, logging and operational security.

## Registration and routing

The native app registers its device token through authenticated `POST /api/push/apns-token`. The
record belongs to that UI session and retains platform, APNs environment and optional Host key.
Xcode/development tokens normally use `sandbox`; TestFlight/App Store tokens use `production`.
`VARIN_APNS_ENVIRONMENT` can explicitly override the registered environment for delivery.

Before sending, the Host deduplicates tokens and groups them by their registered Host key and
environment. It removes producer-supplied Host routing fields and constructs the native Thread/branch
deep link from the registered Host key. This prevents the notification producer from substituting a
navigation Host. Revoking registration uses authenticated `DELETE /api/push/apns-token`.

## Notification content and visibility

`thread-runtime.ts` projects native completion, failure, permission and question facts. The title is
the actual Thread title, falling back to `Varin` when empty. The body is fixed status text, for example
`Response finished.` or `Your approval is needed.` The Application Host forwards this payload directly;
it does not replace the title with a generic scenario name or include response text.

APNs delivery is not gated on UI visibility, because a suspended WebView cannot reliably update it.
The native shell controls foreground presentation. A successful Host send does not prove that Apple
delivered the alert or that the user saw it.

The transport supports an optional badge value, but the native Thread caller does not compute or
supply one. Catalog read cursors own native unread state. The retained legacy badge entry point is a
no-op; there is no server badge-stack synchronization guarantee.

## Relay mode

Set `VARIN_PUSH_RELAY_URL` to the compatible relay's send endpoint. The registration endpoint is
derived by replacing a trailing `/send` with `/register-token`. Source builds do not inherit another
product's central relay. `VARIN_PUSH_RELAY_DISABLED=true` disables relay selection.

The Host generates and persists its own ECDSA P-256 signing keypair. Registration sends the device
token, public key, timestamp and signature. Sending includes tokens, title, body, collapse tag,
environment and navigation data. The send signature covers the timestamp, sorted token list and
title; it is not encryption and does not cover every payload field. Relay results can identify invalid
tokens to remove. Transport or relay failure is logged without claiming delivery.

Deploy only a relay whose registration binding, signature verification, replay handling, TLS,
APNs credentials and data retention you have reviewed. This repository's client implementation does
not prove a particular external relay's database schema, logging policy or security guarantees.

## Direct mode

Configure `VARIN_APNS_KEY_ID`, `VARIN_APNS_TEAM_ID` and `VARIN_APNS_P8` or `VARIN_APNS_P8_PATH`.
`VARIN_APNS_BUNDLE_ID` overrides the default `dev.varin.mobile`. The existing settings owner can also
supply direct APNs configuration. Environment values take precedence. Use
`VARIN_PUSH_RELAY_DISABLED=true` when a configured relay must not be selected.

The Host signs ES256 APNs authentication tokens and sends over HTTP/2 to Apple's sandbox or production
endpoint. Permanent invalid-token responses remove that registration. Other failures do not establish
successful delivery. Protect the `.p8` key and Host data directory; do not package credentials in a
release archive or image.

The iOS App ID must have Push Notifications enabled and the installed app must have the matching
entitlement, bundle ID and environment. Use the deployment's own Apple configuration and device tokens.

## Confidentiality

The payload is not application-encrypted. Use HTTPS for the relay endpoint; TLS protects transport
but the configured relay and Apple can read the Thread title, fixed status text, device token and navigation metadata they receive. A
Thread title can itself contain private information, so these notifications are not content-free.
Signature verification authenticates selected request fields; it does not hide their content.

End-to-end notification payload encryption and an Android FCM delivery implementation are not provided
by this APNs module. Expo mobile push has its own owner in `../mobile/`.

## Verification

`apns-runtime.test.ts` covers token registration, environment/Host routing and payload construction with
controlled transport. Actual Apple entitlements, installed-device delivery and an external relay's
security and availability require deployment-specific verification.
