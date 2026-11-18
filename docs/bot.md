# Long-Lived Assistant (Varin Bot)

A **Bot** is a persistent assistant that coordinates work across conversations and devices. Execution still belongs to the native Rust Agent runtime, external harnesses, and existing resource owners — there is no separate Bot executor.

New configs open in the `varin.bot` shell ("Varin") and auto-create a default general assistant when none exists; multiple Bots remain supported with separate identities, home dirs, memory, schedules, and appearances ([bot-appearances.md](bot-appearances.md)).

## Profile, Model Resolution & Sessions

- **Model & thinking precedence** for a new Bot conversation:
  1. Bot profile's dedicated model/thinking (if set; omitted thinking falls back to conversation default → model's first supported level).
  2. Current Workbench/IDE selection on the same Host.
  3. Shared conversation default → first enabled chat-capable model.
- Updating a Bot's model/thinking updates active direct sessions at the next model-request boundary; in-flight requests and dispatched tasks keep their frozen configs. Idle wake/resume re-reads the current Bot profile when the last exchange is closed.
- **Sessions & branches**: A Bot owns multiple independent native Threads (`thread:bot:<botId>:<uuid>`, created via `POST /api/harness/bots/:botId/sessions` while awake) sharing identity, profile, home dir, memory, and schedules. `POST /api/harness/bots/:botId/entry` resolves the actual active entry Thread atomically in Catalog.
- **Sidebar organization**: Bot folders live in Rust Storage (`bot.organization:sidebar`, CAS-checked, pushed via `varin:bot-organization-changed`), separate from shared conversation organization (`organization` tool / Catalog).
- **Direct follow-up default**: Bot direct sessions use `botFollowUpBehavior` (default `steer`), determined by `bot_id` + parent relation (shell-independent). `Alt+Enter` / button action queues after the current turn.

## Schedules, Event Watches & Follow-Ups

Aggregated under **Schedules & Watches** (`follow_up` tool: `sources`, `arrange`, `route`, `backlog`, plus existing read/control actions). Watches can be created even before a Bot session has its first Run.

- **Event watch**: Stores name, intent, plugin connection + account, exact-subset attribute filter (semantic judgment stays in intent for the model), target (native Thread/branch or external conversation), and delivery timing:
  - **Immediate**: Appends at next admissible boundary (wakes idle/fresh Bot session).
  - **Batch window**: Timer starts on first pending event (no infinite pushback).
  - **Scheduled**: Bound to a Bot Calendar definition on the same Thread/branch.
  - **Passive**: Queues until next normal turn (or manual "Process now", which still respects Bot sleep).
- **State snapshots & routing**: Plugins may mark events replaceable by state group (collapsing unread updates into latest body + state transition summary while keeping raw occurrences readable). Source objects can map explicitly to an existing native/external task, or opt into creating a new Bot session on first contact.
- **Trust boundary**: External events enter as environment input by default. Only an explicit authenticated user mapping for `(sourceObject, exactSender)` promotes messages to user-input semantics — plugin text/names never self-grant user identity.
- **Bot Calendar**: Assets live in the Bot's home dir under namespace `bot:<id>`, executed by the shared native Calendar (no Bot-specific timer).
- See [runtime.md](runtime.md#long-lived-event-watches) and [extensions.md](extensions.md).

## Task Inactivity Watchdog

- Running tasks with no new model request or tool dispatch for **20 min** (configurable/disableable in Chat settings) emit a deduplicated work event to the owning Bot session with actual status and idle duration.
- Scans conversational branch Runs only (excludes auxiliary runs like title/knowledge inference). Shared native clock wakes watchdogs, Waits, follow-ups, and schedules independently so one failure never stalls others.

## Reports, User Intervention & Silent Background Turns

- **Report routing**: Terminal child reports route back to the actual requester Thread/branch (first dispatch → dispatcher; re-delegation → `MessageRequest` requester). User-created threads that receive a work request also reply back on completion/failure/cancel without duplicating notifications if already followed. Active reports and `wait_child` share the same consumption identity.
- **Live intervention events**: User messages in child tasks, workbench file edits, finished user terminal commands, Git branch switches, history recovery, follow changes, or external reports append incremental events to the Bot's work queue (deduplicated per Bot in shared dirs; progress % stays UI-only).
- **Silent handling**: Background turns may update memory or delegate without producing a public reply; empty results create no chat bubble, unread badge, or completion toast. Real failures, questions, and permission prompts still surface.

## Sleep, Wake & Archive

- **Sleep** (`bot-lifecycle-runtime.ts`) is distinct from closing the UI or putting the desktop companion to sleep: it closes new admission first, then stops and drains native Runs, remote work, memory jobs, scripts, forwards, and Computer Use (`sleeping` / `asleep` / `sleep-failed` / `waking`). Unknown side effects remain visible and are never auto-replayed on wake.
- Only VMs verified as exclusive to that Bot shut down on sleep; shared or coordinator Hosts stay running.
- **Archive** sleeps the Bot to `asleep` first; unarchiving restores entry without waking.
- Entrypoints: [bot-service.ts](../packages/web/application-host/lib/bots/bot-service.ts) · [bot-lifecycle-runtime.ts](../packages/web/application-host/lib/bots/bot-lifecycle-runtime.ts).

## Matters, Cross-Session Access & Projects

- **`matters`**: Free-form descriptions + Thread/branch links (CAS-updated). Holds understanding/association only — live Run/file/process state is always read from authoritative owners.
- **Cross-session visibility**: Bot direct sessions can discover and read all product conversations belonging to the same authenticated principal (`threads` / `read_thread`), and message them via `send` (subject to sleep/pause/model gates; never expands memory-write or child-cancel authority). Regular child agents do not inherit Bot-wide visibility.
- **Task reuse**: `send` (`afterCurrent: true` for sequential next work), `dispatch.background` (pinned `read_thread` head + item IDs; strips system prompts/thinking/file grants), or fresh `dispatch` (`inheritContext` for dispatcher context, `sourceAgent` for file source).
- **Projects**: `dispatch.projectId` freezes the project ID; actual Source, workspace MCP, skills, and instructions resolve on the target project's real Host/trust boundary (never copying the Bot's home dir grants or local `.varin/settings.json`).

## Continuous Context & Memory

- **Recall**: Driven by recent conversation, incoming reports/events, linked matters, and project metadata — as retrieval cues only (no file/thread grants). Stable recall IDs avoid reshuffling the memory prefix when unchanged.
- **Incremental organization**: Advances per-branch from the last processed position within model budget (skips model calls when nothing new arrived). User edits, active saves, and background organizer share KnowledgeStore CAS receipts (`MemoryWork` preserves frozen sources/results so lost responses resume commit without regenerating).
- **Derived overviews & forgetting**: Overviews pin exact source memory revisions; edits/obsolescence drop stale overviews from default recall. **Forgetting** additionally excludes source spans from future requests/citations and rebuilds context checkpoints that absorbed them while leaving visible chat history intact.
- **Active maintenance**: Local background maintenance triggers on related writes; `memory.organize` / `rewrite` atomically merge, split, revise, or summarize memories in KnowledgeStore. Turning off embeddings falls back cleanly to text search.
- Details: [memory/DOCUMENTATION.md](../packages/web/application-host/lib/memory/DOCUMENTATION.md) · [knowledge/DOCUMENTATION.md](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md).

## UI Projections & Companion

- Shell: `packages/ui/src/workbenches/bot/` (left: Bots → sessions → branches; center: chat; right: stage + Overview / Activity / Memory / Schedules / Profile). Side tabs handle work details, files, and computers while keeping chat mounted.
- **Activity**: `GET /api/harness/bots/:botId/activity` proxies Catalog `runtime.bot.activity.read` (cursor-paged, 30/page).
- **Presence**: `GET /api/harness/bots/:botId/presence` projects pending questions/permissions, running delegated work, and active replies, debounced ~250ms and pushed via `varin:bot-presence`.
- **Desktop Companion**: Reads the same Catalog attention snapshot; which Bot it accompanies is chosen in the companion menu independently of the active workbench shell.
