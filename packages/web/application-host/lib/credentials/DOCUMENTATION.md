# Credentials module

Model-neutral Host secret storage, account identity/generation tracking, and single-flight OAuth token refresh shared by credential-owning domains (such as Models and MCP). See [models/DOCUMENTATION.md](../models/DOCUMENTATION.md) and [docs/security.md](../../../../../docs/security.md).

## Key files

| File | Responsibility |
| --- | --- |
| [`service.ts`](service.ts) | `HostCredentialService`, `fileSecretStore`, `AccountCredential` validation, `sameAccount`, and `HostCredentialError` |

## Ownership and invariants

- **Atomic file storage**: `fileSecretStore(path)` backs credentials with `@varin/settings-store` locking and atomic file replacement (`read`, `modify`, and namespace `removePrefix`). Unchanged mutations skip disk writes; malformed records fail explicitly (`credential-invalid`) rather than returning empty credentials.
- **Account identity & generation**: Each `AccountCredential` (`version: 1`) carries a UUID `account` and integer `generation` alongside either `{ kind: "api-key", key }` or `{ kind: "oauth", accessToken, refreshToken?, expiresAt?, provider, accountId? }`. Explicit replacement (`put`, `replace`, `linkOAuth`) mints a new `account` UUID so an in-flight refresh can never overwrite a newly linked account.
- **CAS sign-in & removal**: `replace()` and `acceptOAuth()` verify `expectedAccount` and run an optional `assertCommit()` hook **inside** the store transaction lock so a cancelled sign-in cannot publish after abort (while already-admitted writes are never rolled back). `removeIfCurrent()` enforces the same `expectedAccount` check.
- **Single-flight OAuth refresh**: `#fresh()` coalesces concurrent refreshes per `(reference, account, generation)` key, validates that the refreshed provider and `accountId` did not change, and rechecks `sameAccount` inside the write transaction before persisting. Calling `resolveValue()` with an `AbortSignal` detaches only the caller's wait without aborting the shared refresh or losing a rotated refresh token.
- **Provider lifecycle & Host-only visibility**: `prepareOAuthReplacement()` atomically swaps OAuth providers owned by a given extension/owner without colliding with other owners; `captureValue()` retains a provider capture lease alongside the account snapshot. Secrets are resolved only for trusted Host callers and must never be returned to renderers.
