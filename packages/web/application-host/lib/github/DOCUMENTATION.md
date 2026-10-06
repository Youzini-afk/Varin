# GitHub Module Documentation

## Purpose

- This module owns GitHub auth, Octokit access, repo resolution, and Pull Request status resolution for Varin.
- From user perspective, this is the layer that lets the app know which PR belongs to a local branch and keeps that UI feeling current.

## Entrypoints and structure

- `packages/web/application-host/lib/github/index.ts`: public server entrypoint.
- `packages/web/application-host/lib/github/routes.ts`: Express route registration for `/api/github/*` endpoints.
- `packages/web/application-host/lib/github/auth.ts`: auth storage, multi-account support, client id, scope config.
- `packages/web/application-host/lib/github/device-flow.ts`: OAuth device flow.
- `packages/web/application-host/lib/github/octokit.ts`: Octokit factory for the current auth.
- `packages/web/application-host/lib/github/repo/index.ts`: remote URL parsing and directory-to-repo resolution.
- `packages/web/application-host/lib/github/pr-status.ts`: PR lookup across remotes, forks, and upstreams.
- `packages/web/application-host/index.ts`: API route layer that calls this module.
- `packages/web/src/api/github.ts`: web client wrapper for GitHub endpoints.

## Public exports

### Auth

- `getGitHubAuth()`: current auth entry.
- `getGitHubAuthAccounts()`: all configured accounts.
- `setGitHubAuth({ accessToken, scope, tokenType, user, accountId })`: save or update account.
- `activateGitHubAuth(accountId)`: switch active account.
- `clearGitHubAuth()`: clear current account.
- `getGitHubClientId()`: resolve client id.
- `getGitHubScopes()`: resolve scopes.
- `GITHUB_AUTH_FILE`: auth file path.

### Device flow

- `startDeviceFlow({ clientId, scope })`: request device code.
- `exchangeDeviceCode({ clientId, deviceCode })`: poll for access token.

### Octokit

- `getOctokitOrNull()`: current Octokit or `null`.

### Repo

- `parseGitHubRemoteUrl(raw)`: parse SSH or HTTPS remote URL into `{ owner, repo, url }`.
- `resolveGitHubRepoFromDirectory(directory, remoteName)`: resolve GitHub repo from a local git remote.

## Auth storage and config

- Auth storage: the platform Varin data directory (`~/.config/varin/github-auth.json` on Linux)
- Writes are atomic and file mode is `0o600`.
- Client ID resolution order: `VARIN_GITHUB_CLIENT_ID` -> `settings.json` -> default.
- Scope resolution order: `VARIN_GITHUB_SCOPES` -> `settings.json` -> default.
- Account id resolution order: explicit `accountId` -> user login -> user id -> token prefix.

## PR integration overview

- The UI asks `github.prStatus(directory, branch, remote?)` from `packages/web/src/api/github.ts`.
- That hits `GET /api/github/pr/status` in this module’s `routes.ts`.
- The route calls `resolveGitHubPrStatus(...)` in `packages/web/application-host/lib/github/pr-status.ts`.
- The resolver finds the most likely repo and PR for a local branch.
- The route then enriches that result with checks, mergeability, and permission-related fields.
- The shared client store caches the result for its current visible consumers.

## Client ownership

`packages/web/src/api/github.ts` is the typed HTTP adapter. The shared
`useGitHubPrStatusStore.ts` cache is consumed by `GitView`, `PullRequestSection`, and
`WalkthroughView`. It keys entries by runtime, directory, branch and requested remote, so one
server or fork cannot supply another target's PR state.

Cache lifecycle, refresh ownership and selector rules are documented in
[UI Stores](../../../../ui/src/stores/DOCUMENTATION.md#usegithubprstatusstorets).
Keep those rules there rather than maintaining a second polling specification in this Host module.
Visible consumers start and stop watchers; there is no global background repository scanner or
legacy session-sidebar PR aggregator to restore.

## How PR resolution works

- It reads local git status and remotes first.
- It ranks remotes in this order: explicit remote, tracking remote, `origin`, `upstream`, then the rest.
- It resolves those remotes into GitHub repos.
- It expands each repo through `parent` and `source` so PRs in upstream repos can still be found.
- It skips PR lookup when the current branch matches that repo's default branch.
- It first searches for PRs by likely source owner plus exact head branch.
- If that fails, it falls back to broader GitHub search for the branch name.
- `403` and `404` during repo lookups are treated as expected gaps, not hard errors.

## Failure handling and changes

Disconnected GitHub accounts are reported as `connected: false`. A missing or inaccessible PR is
distinct from a successful mutation; the Git view presents actionable failures. Preserve remote
ranking and fork/upstream lookup instead of assuming `origin` is always the correct repository.

Device flow handles GitHub `authorization_pending` at the caller. Repository parsing supports
`git@github.com:`, `ssh://git@github.com/`, and `https://github.com/` URLs. Credential writes remain
Host-owned; never copy tokens into UI caches or diagnostics.
