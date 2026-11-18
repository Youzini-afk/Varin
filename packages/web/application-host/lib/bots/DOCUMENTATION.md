# Bots module

Host owner for the durable Bot catalog, lifecycle (active/sleep/wake/archive/delete), entry & bound sessions, appearances, presence, and Bot-scoped memory/organization routes. Bots are Host-level identities that outlive any single Thread or workspace. See [docs/bot.md](../../../../../docs/bot.md) and [docs/bot-appearances.md](../../../../../docs/bot-appearances.md).

## Key files

| File(s) | Responsibility |
| --- | --- |
| [`bot-service.ts`](bot-service.ts) | Durable `bot.profile` catalog under kernel workspace `__varin_bots__`, CAS revisions, execution-gate publication, and lifecycle orchestration |
| [`bot-routes.ts`](bot-routes.ts), [`bot-appearance-routes.ts`](bot-appearance-routes.ts) | Authenticated `/api/harness/bots/*` and `/api/harness/bot-appearances/*` routes |
| [`bot-sessions.ts`](bot-sessions.ts), [`bot-model.ts`](bot-model.ts) | Native entry/bound-session resolution and unified Bot model/thinking resolution |
| [`bot-lifecycle-runtime.ts`](bot-lifecycle-runtime.ts), [`bot-computer-drain.ts`](bot-computer-drain.ts), [`bot-data-cleanup.ts`](bot-data-cleanup.ts) | Sleep/wake work & machine planning, Computer execution drainage, and post-sleep deletion cleanup |
| [`bot-appearances.ts`](bot-appearances.ts) | Pure image decoding/validation and appearance asset library management |
| [`bot-organization.ts`](bot-organization.ts), [`bot-presence.ts`](bot-presence.ts), [`bot-public-profile.ts`](bot-public-profile.ts) | Bot grouping with conflict detection, live presence projection (`varin:bot-presence`), and principal-scoped profile projection |

## Ownership and invariants

- **Catalog & CAS**: `bot.profile` records live in Rust kernel storage under `__varin_bots__`; updates enforce revision CAS (`BotProfileConflictError` -> 409). If persistence succeeds but live execution-gate or profile propagation fails, `BotProfileMutationError` (503) returns the saved revision (`saved: true`) so callers never report a no-op.
- **Principal scoping**: Shared Bot configuration is visible across authorized callers, while execution activity, matters, and presence are projected through the caller's Catalog scope (`bot-public-profile.ts`, `currentRequestPrincipal()`).
- **Sleep, drain & deletion**: Sleep publishes the durable execution gate first, stops/drains active native work and Computer executions (`bot-computer-drain.ts`), and reconciles machines before cleanup. `bot-data-cleanup.ts` runs only after durable admission closes and sleep completes; it removes the Bot's dedicated KnowledgeStore and data without deleting shared user plan history (see [knowledge/DOCUMENTATION.md](../knowledge/DOCUMENTATION.md)).
- **Appearances**: `prepareBotAppearance` decodes and validates all image payloads before touching durable storage; in-use assets reject deletion (`BotAppearanceInUseError`).
- **Memory & background work**: Bot long-term memory routes delegate to [`../memory/memory-service.ts`](../memory/memory-service.ts) and [`../memory/memory-organizer.ts`](../memory/memory-organizer.ts) using hashed filename-safe Bot scopes (`../harness/owner-scope.ts`); see [memory/DOCUMENTATION.md](../memory/DOCUMENTATION.md#bot-background-inference).
