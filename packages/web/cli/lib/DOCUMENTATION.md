# Varin CLI Module Map

`packages/web/bin/cli.js` is the generated, published `varin` entrypoint. Its TypeScript source is `packages/web/cli/cli.ts`; command behavior belongs in this directory and `bin/` is never edited directly.

## Commands

- `commands-serve.ts`: starts the Varin Web server in foreground or daemon mode and owns port selection, logs, and the PID/instance registry.
- `commands-lifecycle.ts`, `commands-status.ts`, `commands-logs.ts`: stop, restart, discover, inspect, and read logs from Varin server instances.
- `commands-thread.ts`: uses the native Threads API for list/create/status/history/send/fork, exact Thread/branch identities, source preparation and original-Run terminal waiting. Mutation keys are generated once and printed before submission; explicit retry keys retain the original expected head.
- `commands-schedule.ts`: manages project scheduled tasks through Varin REST routes. Run-now sends a stable idempotency key and returns the original native occurrence receipt.
- `commands-models.ts`, `commands-projects.ts`: read native configured models and Varin project settings.
- `commands-startup.ts`: manages native per-user startup integration.
- `commands-connect-url.ts`: creates pairing-v2 `varin://` links backed by the shared pairing store.
- `commands-tunnel.ts`: manages tunnel providers, profiles, diagnostics, lifecycle, and completion scripts.
- `commands-update.ts`: updates the installed `@varin/web` package and coordinates restart behavior.

## Shared Runtime

- `cli-runtime.ts`: authenticated JSON access to `/api/threads/*` and Varin REST routes, plus original Run terminal waiting.
- `cli-api-target.ts`: selects an explicit, desktop, or discovered Varin runtime.
- `cli-args.ts`: argument parsing, help, completion scripts, defaults, and typo suggestions.
- `cli-paths.ts`: Varin data, settings, log, run, and tunnel-state paths.
- `cli-process.ts`, `cli-lifecycle.ts`: process identity, PID files, instance metadata, health probes, discovery, and termination.
- `cli-http.ts`: authenticated local HTTP, health, shutdown, tunnel-provider, and system-info requests.
- `cli-network.ts`, `cli-ports.ts`: bind hosts, LAN safety, URLs, browser-safe ports, and port selection.
- `cli-startup.ts`: platform-specific startup service definitions and installation.
- `cli-goal.ts`: validates the optional goal token budget.
- `cli-tunnel-profiles.ts`, `cli-tunnel-utils.ts`, `cli-tunnel-capabilities.ts`: tunnel profile storage and tunnel-specific helpers.

## Boundaries

- The CLI talks to the shared Application Host. It does not launch another conversation runtime.
- `--json` emits JSON only; `--quiet` emits concise essential output.
- Conversation methods use native Thread/branch and original Run identities. Product REST routes are reserved for Varin-owned services such as settings, worktrees, schedules, pairing, and tunnels.
- Cross-command dependencies are injected from `cli.ts`; modules in this directory must not import `cli.ts`.

## Interaction modes

`@clack/prompts` is the human presentation layer; it is not where command policy lives. Required input,
validation, authorization, and failure exit codes apply equally to interactive, fully flagged,
non-TTY, quiet, and JSON use. `cli-output.ts` centralizes the mode decisions, prompt gate, JSON output,
status lines, and progress helpers so commands do not invent their own terminal mode detection.

Prompts are an optional way to collect missing input when `canPrompt(options)` says the current output
mode and terminal support them. In non-interactive modes, missing required input becomes a deterministic
error that names the needed flag. JSON results include machine-readable warnings/errors without human
framing; quiet results retain the essential value rather than becoming silent success.

## Verification

From `packages/web`:

```sh
bun x vitest run cli --config vitest.config.ts
```

Release-wide verification is selected from the root release and CI scripts rather than repeated here.
