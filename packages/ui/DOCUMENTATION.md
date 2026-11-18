# Shared UI

`@varin/ui` is the React presentation shared by Web, Electron, and mobile. It owns client-side projections and workbench kernels, not privileged filesystem, credential, shell, or process work. Surface packages supply `RuntimeAPIs`; shared code imports contracts and transport primitives from `@varin/application-client` without hardcoding origins, IPC channels, credentials, or local paths.

Cross-cutting architecture docs:
- [Workbench and presentation](../../docs/workbench.md) — cross-feature invariants
- [Extensions](../../docs/extensions.md) — contribution and service ownership
- [Runtime](../../docs/runtime.md) — native Thread/branch, Catalog, and Application Host boundary

**Layer boundary**: framework-neutral `src/lib` kernels never import official `src/workbenches`. Narrow `features` adapters connect React/stores to those kernels. Extensions must use the SDK mount/controller seams rather than importing product UI internals.

## Module navigation

| Area | Owner and local reference |
| --- | --- |
| Official shells | `src/workbenches` — Varin, Agent workbench, IDE, Bot, and Settings composition |
| Extension integration | `src/lib/extensions` — catalog, loader, mounts, slot consumers, owner-bound services |
| Profile handoff | `src/lib/workbench/profile-transition.ts`, `src/lib/extensions/workbench-shell-transition.ts` |
| Text state | [Document Registry](src/lib/documents/DOCUMENTATION.md) |
| Groups, tabs, providers, restore | [Editor Workbench Kernel](src/lib/workbench/editors/DOCUMENTATION.md) |
| Desktop/Web file editor | [Monaco](src/lib/monaco/DOCUMENTATION.md) |
| Mobile and embedded editors | [CodeMirror](src/lib/codemirror/DOCUMENTATION.md) |
| Agent/editor attachments & patches | [Agent/editor bridge](src/lib/agent-editor/DOCUMENTATION.md) |
| HTTP, browser URLs, switching | [Application client](../application-client/README.md) |
| Shared projections & preferences | [Store ownership](src/stores/DOCUMENTATION.md) |
| Agent resource-panel navigation | [Context surfaces](src/lib/surfaces/DOCUMENTATION.md) |
| Settings primitives & save feedback | [Settings components](src/components/sections/shared/DOCUMENTATION.md) |
| Conversation controls & runtime | `src/components/thread`, `src/lib/agent-runtime`, `ThreadsAPI` |
| Conversation presentation | `src/components/conversation` — virtual timeline, message/tool cards, menus, sidebar |
| Purpose-specific tools | `ChatDelegation`, `ChatResourceTools`, `ChatSourceTools`, `ChatProcessTool`, `ChatWorkTools`, `ChatMaterialsTool`, `ChatEnvironmentTools`, `ChatComputerTools`, `ChatFollowupTool`, `ChatMcpTool` (`toolInvocation` preserves gateway/native ownership) |
| Interactive content | `src/lib/interactive-ui`, `src/components/interactive-ui` ([contract](../../docs/interactive-content.md)) |
| Connected browser resources | `src/components/workbench/BrowserResourceView.tsx`, `src/components/workbench/ConnectedBrowserPane.tsx` |
| Theme and shared chrome | `src/lib/theme`, `src/styles`, `src/components/ui` |
| Motion tokens & preference | `src/lib/motion`, `src/styles/motion.css`, `src/components/providers/MotionProvider.tsx` ([Motion](#motion)) |
| Icons | [Sprite-backed Icon contract](src/components/icon/README.md) |

## State, fencing, and lifecycle invariants

### Ownership & fencing
- **Shell vs. owner boundary**: Shells own presentation only. Documents, open editor groups, terminals, runtime identity, and domain facts stay with their shared or Host owner. Profile switches must never recreate text models, accepted executions, or terminal processes.
- **Host/identity fencing**: Every async read or mutation captures Host/API epoch plus its exact Thread, branch, resource, or contribution identity. Changing targets aborts in-flight snapshot reads and event observations and invalidates stale completions.
- **Directory resolution**: Same-Host directory resolution may keep the rendered shell mounted, but never supplies the previous workspace ID as the new target. Failed resolution, Host replacement, or revoked contributions cannot keep a stale authority alive.
- **Connected workbench mounts**: Participate in the Surface preparation lease. Hidden mounts validate before publication; closure, replacement, and render failure fence the lease. Once the Host confirms durable selection, local mount cleanup cannot claim rollback.

### Cache, failure, and storage semantics
- **Snapshot vs. failure**: Cached views preserve visual continuity without turning missing, loading, failed, or inaccessible state into success. Complete snapshots and partial save responses have separate merge semantics.
- **Conversation load & render errors**: Initial conversation load failure replaces the prior painted scene with retry UI while preserving drafts. Chat render failures scope to Host + full conversation identity, retain JS and component stacks for copying (including production builds), and clear on navigation without losing drafts or replaying work.
- **Narrow subscriptions & storage**: High-frequency document text, cursor motion, streaming output, and animation frames stay close to owners with narrow subscriptions. Zustand holds navigation, preference, and keyed query state — never dirty editor text, and dirty text never enters Local Storage.

### Connected browser resources
- `src/components/workbench/BrowserResourceView.tsx` and `src/components/workbench/ConnectedBrowserPane.tsx` present an owner observation (structure or screenshot), not an iframe at a copied URL; iframe and Electron previews remain a separately labelled choice.
- Resource/instance/page bindings survive context-panel restore and IDE handoff independently of URL. A changed instance stays unavailable until explicitly re-selected.
- Reconnect or closing the view never replays input or releases a task. Takeover/resume/activation use the authenticated resource route with no local `openExternalUrl` fallback.

## Streaming, timeline, and conversation projection

### Host observation & streaming
- **`ThreadProjection`** (`src/lib/agent-runtime/thread-projection.ts`):
  - Subscribes via the application client's Host observation bus to its branch and known child Threads, ignores `thread.read`, and coalesces durable changes into at most one in-flight read plus one trailing read.
  - Validated `afterHeadId` responses append history; navigation and resync replace it.
  - Structural sharing (`src/lib/agent-runtime/structural-sharing.ts`) preserves unchanged JSON subtrees (including reordered array entities); late usage receipts invalidate only their loaded history window.
- **`ThreadStreamingStore`** (`src/lib/agent-runtime/thread-streaming-store.ts`):
  - Owns transient provider text, tool arguments, progress, and activity for a mounted Thread. Ingests every delta in order and publishes at most once per animation frame via `useSyncExternalStore`.
  - Controller/composer observes only the empty/nonempty boundary. Row-scoped props keep historical rows from rerendering on a live tail; sidebar/overview disclosure and input editing stay independent of streaming.
  - Opt-in dev counters: `globalThis.__VARIN_UI_PERFORMANCE__ = {}` (counts work without recording content).

### History, virtual timeline, and context
- **Body cache & blocks**: `src/lib/agent-runtime/thread-history.ts` caches read-only bodies by Host epoch, Thread, and branch, merges tails and prefetched pages via native parent IDs, and aborts reads on owner departure. `src/components/conversation/historyPresentation.ts` and `src/components/conversation/chatTimelineBlocks.ts` preserve native IDs and separate logical turns from measured rows; `src/components/conversation/timelineViewStore.ts` stores scroll positions only.
- **Independent metadata reads**: Whole-Run usage, the navigation rail's Run index, and anchored context inspection (`src/components/context`, `src/lib/contextPresentation.ts`, `src/components/context/useContextJobHistory.ts`) run alongside body reads without blocking rendering. Compaction clears the old footprint until a new request reports usage.
- **LegendList patches**: `bun-patches/@legendapp%2Flist@3.7.2.patch` skips deferred 1-frame shrink inside lists marked `data-legend-immediate-shrink` (`src/components/conversation/ChatTimeline.tsx`) and skips `0x0` hidden-ancestor collapses while microtask-coalescing container measurements to avoid nested layout-depth overflows (tested in `src/components/conversation/LegendListMeasurement.behavior.test.tsx`; re-check on LegendList upgrades).

### Chat modes, tools, and composer
- **Layout modes**: Chronological, grouped-answer, and conversation-first (`dialogue`, default for unset/reset). Conversation-first keeps every spoken message in arrival order and folds multi-tool/public-thinking runs between messages into one initially collapsed activity row, while keeping dispatches, questions, context notices, agent messages (`src/components/conversation/ChatAgentMessageBubble.tsx`), and usable UI/image outputs independent in all modes. Redacted thinking never enters preview text.
- **Tool cards, links & media**:
  - Tool cards require an Operation ID before exposing read/cancel actions; an absent Operation is never an identity match.
  - File links resolve the history item's original source through the Host before opening Documents; native open/reveal applies only on the local desktop Host.
  - Computer activity projects each observe/query/action/wait as one Host-owned event without inventing pointer motion.
  - `ThreadContent` / `ThreadMedia` consume declared typed holders only (never raw JSON heuristics), revoke view-owned object URLs on unmount/target change, and surface tool-viewed images in a collapsed "Images viewed" receipt.
  - Model marks resolve request ID -> saved ID -> display name independently of channel brand.
- **Composer, drafts & attachments**:
  - New conversations open a local composer only; the first explicit send creates the Thread while keeping the composer key intact for attachments and message handoff. Creation and uncertain-send retries reuse their original command keys.
  - `src/components/thread/useThreadModelSelection.ts` separates the active Run's desired/sampling model from the idle next-input draft and never rewrites accepted Runs.
  - `src/components/thread/useThreadNextStep.ts` fences Host-owned ghost suggestions by Host, branch, Run, and head; ghost text is a CodeMirror placeholder (`Tab` accepts via normal transaction, `Escape` dismisses for that head, open completion menus retain `Tab`).
  - File/PDF attachments (`src/components/materials/PdfMaterialReader.tsx`) hold Blobs in memory until the authenticated Host returns fixed typed refs (file bytes never enter JSON model input) and route selections strictly to the enclosing conversation's guarded composer.

### Work overview, collaboration, interactions, and processes
- **Work overview** (`src/components/thread/WorkOverviewControl.tsx`): Non-overlapping quick/full cards in a reserved column (stacked on narrow panes) outside streaming subscriptions, with its own disposable history reader for saved file changes/HTML outputs and native-owner plan/task/child actions.
- **Collaboration room** (`src/components/thread/collaborationFeed.ts`): Reads native dispatches, peer messages, and final reports in one event-cursor feed; reading never publishes or invokes a model, and file cards read immutable Integration journal versions (never live working copies).
- **Questions & permissions**: `src/components/thread/ThreadQuestions.tsx` (`ask_user` v2) retains memory-only drafts per Host/Thread/branch/Operation; `src/components/thread/ThreadPermission.tsx` (allow-once/always/deny) stays separate and persists an "always" rule through Host config before deciding the permission.
- **Attached process terminals** (`src/lib/attachProcessTerminal.ts`): Closing an attached tab detaches without stopping its Job; remote cwd/resource identity never grants local shell creation; attached Jobs are never persisted as restartable local shells.
- **External drafts**: Read their source Host's saved settings (never falling back to the coordinating Host on failure) and retain their preparation key until prior-binding cleanup is confirmed.

## Shared conversation organization

- **`src/stores/useConversationOrganizationStore.ts`**: Holds the active Host's Catalog navigation projection and one independent cursor observation. Uses `pageNodes: true` (`items` = mixed page membership; `containers` = metadata + ancestor context that do not consume page slots). Continuations are explicit, refreshes rebuild only loaded windows, and failed pages retain their last good projection.
- **`src/components/conversation/ConversationOrganizationTree.tsx`**: Shared by the workbench sidebar, IDE compact picker, archive, and Bot navigator. Recent views query `kind: 'conversations', sort: 'recent', conversationTree: {}` and lazily expand task trees; destination pickers query `kind: 'containers'`. Workbench and IDE set `excludeBotConversations` before pagination (excluding direct Bot chats while keeping delegated work).
- **Placement, drag-and-drop & undo**: Catalog owns container identity, order, and placement; local sorting, pin segments, and collapse never rewrite them. Drop targets exclude self and descendants; moves keep original rows until acceptance, preserve ambiguous acceptance keys, and derive atomic revisioned undo from the receipt so later edits from other clients cannot be overwritten.

## Motion

### Tokens, layers, and preference
One set of tokens in `src/lib/motion/tokens.ts` drives Motion (`springTransition`), WAAPI (`springTiming`), and generated CSS `linear()` curves in `src/styles/motion.css` (`--motion-ease-*`, `--motion-dur-*`, parity-checked by `src/lib/motion/tokens.test.ts`; Tailwind defaults bound in `src/styles/design-system.css`). Animate explicit properties rather than `transition-all`.

| Token | Kind | Intended use |
| --- | --- | --- |
| `snap` | Spring | Hover pills, menus, press feedback, chevrons |
| `glide` | Spring | Default: arrivals, selection, size changes, progress |
| `travel` | Spring | Cross-region movement (composer dock/expand, dialog origin, turn scroll) |
| `settle` | Spring | Arrival moments with overshoot only |
| `TWEENS.fade` / `TWEENS.exit` | Tween | `160ms` fade / `110ms` exit |

- **Preference & reduced motion** (`src/components/providers/MotionProvider.tsx`, `src/lib/motion/preference.ts`):
  - `motionPreference` is `full`, `reduced`, or `off` (OS reduced-motion resolves `full` -> `reduced`), written to `:root[data-motion]` and `MotionConfig`.
  - Under `reduced`, CSS preserves opacity/color transitions and ends movement; under `off`, CSS ends all transitions and animations.
  - `usePrefersReducedMotion()` returns `true` for both `reduced` and `off`; `useMotionLevel()` exposes all three.
  - Reading pauses (e.g., tray linger) and text pacing keep their timing at every level because they are reading rhythm, not animation.
- **Offscreen & hidden loop pausing** (`src/lib/motion/loops.ts`, `src/styles/motion.css`): `MotionProvider` sets `:root[data-page-hidden]` when hidden (important in Electron), and `pauseLoopsOffscreen` sets `data-offscreen` on rows >64px outside the viewport. Register every new infinite CSS loop class in `src/styles/motion.css`.

### Frame drivers, streaming pace, and UI choreography
- **Shared RAF & scroll springs**:
  - `src/lib/motion/frame.ts` shares one animation frame across `SpringDriver` instances (`src/lib/motion/spring.ts`), with `requestAfterFrame` for post-spring geometry followers (e.g., `MessageHandoff`, external chat scrollbar thumb).
  - Timeline auto-follow uses a critically damped spring (ω = 14) that yields immediately to wheel/touch/key/selection/disclosure intent and carries external scroll shifts.
  - `src/lib/motion/scroll.ts` smooths discrete line/page/detent wheel input while keeping touch, continuous trackpad gestures, editors, and terminals native.
  - `src/components/conversation/chatReadingAnchor.ts` keeps a visible text Range or disclosure pinned across intra-row reflow.
- **Paced streaming, Markdown & file-change motion**:
  - `src/lib/motion/pace.ts`: `usePacedText` (`max(26/s, backlog / 0.24s)`, 0.16s drain) for prose; `usePacedLength` + `CODE_PACE` (`max(140/s, backlog / 0.22s)`, 0.12s drain) for streaming file-change cards. History and windowless environments render in full immediately.
  - `src/components/chat/markdown/markdownBlocks.ts` (`MarkdownBlockStream`) keeps stable root blocks immutable; `src/components/chat/markdown/liveFence.ts` highlights completed fence lines in the Shiki worker (90ms debounce, plain >400 lines or Mermaid until closed); `src/components/chat/markdownInk.ts` removes ink spans in `prepare()` before `morphdom`.
  - `ChatFileChangePreview` preserves row DOM by source identity (sliding only LIS order-preserving rows on `snap`), and conversation-first folded process rows batch active file changes in `src/components/conversation/fileChangeTray.ts` (700ms reading linger, held on hover/expand/paused follow).
- **Shared transitions & scenes**:
  - `src/lib/motion/slidingPill.ts` drives single sliding indicators (rail bar, settings nav pill, `MenuHighlight`, sidebar selection/hover in `src/components/conversation/sidebarHighlights.ts`, tab underlines).
  - `src/components/motion/SwapText.tsx` holds quick label changes for 260ms; `src/components/motion/Departure.tsx` runs inert paint-only exits; `src/components/conversation/FlipList.tsx` runs DOM FLIP for sidebar, Git changes, and member chips.
  - `src/components/layout/railMotion.ts` (`useMainColumnGlide`) moves docked context panels and the main canvas under one shared width lock; `src/components/thread/workOverviewMotion.ts` glides overview layout without remounting viewports; `src/lib/motion/dialogOrigin.ts` launches Settings/Shortcuts from the clicked trigger; `src/lib/motion/themeInk.ts` runs View Transition circle/fade theme switches.
  - **Workbench profile lattice** (`src/components/ui/WorkbenchLatticeScene.tsx`, `src/components/ui/workbench-lattice.ts`, `src/components/ui/workbench-lattice-stage.ts`, `src/components/ui/workbench-lattice-canvas.ts`): WebGL cell wave (with DOM WAAPI fallback) covers the window before Core commits; prepared keyed Shell slots promote in place with inactive context so staged shells cannot trigger recursive switches.
  - **Startup, mobile & file drop**: `src/lib/splash.ts` + `src/lib/motion/startupEntrance.ts` run the once-per-page boot choreography (re-run `bun run splash:emit` after splash changes); `src/apps/useEdgeSwipeSessionSwitch.ts` owns passive mobile edge swipes; `src/components/conversation/useFileDropField.ts` owns external file-drop canvas feedback; `src/lib/motion/haptics.ts` fires only at commit points.

### Motion Lab
`packages/web/motion-lab` mounts real conversation and layout components on simulated streams. Start with `bunx vite --config motion-lab/vite.config.ts` in `packages/web`. Headless Playwright checks live in `packages/web/motion-lab/checks/`:

- Conversation & streaming: `follow.cjs`, `stream.cjs`, `process.cjs`, `file-card.cjs`, `tray.cjs`, `layout.cjs`, `send.cjs`, `composer-expand.cjs`, `drop.cjs`, `loops.cjs`
- Chrome, navigation & scenes: `popover.cjs`, `sidebar.cjs`, `rail.cjs`, `switch.cjs`, `settings.cjs`, `theme.cjs`, `workbench.cjs`, `mobile.cjs`, `startup.cjs`

Set `PLAYWRIGHT_PATH` and `LAB_BROWSER` when Playwright and its browser are not installed in the workspace.

## Theme, authoring, settings, and plugin center

- **Theme, Markdown & brand assets**:
  - Use semantic CSS tokens (`src/lib/theme`, `src/styles/markdown.css`, [theme guide](../../docs/ops/CUSTOM_THEMES.md)); theme changes update projections without rebuilding editor models.
  - Chat prose uses an 800px measure at default text size while code, tables, and figures span the full chat column; built-in themes derive Markdown link/inline-code/quote/selection tokens with 4.5:1 contrast; prose/inline-code color swatches paint via pseudo-elements so copy/export preserves raw text.
  - Fold logo source: `src/components/ui/varin-mark.ts`. Agent avatars: `src/components/ui/agent-avatar-art.ts` (frozen legacy identity palette in `@varin/protocol`).
- **i18n** (`src/lib/i18n`): Resolve visible and accessibility copy during render or hook execution. Every shipped locale receives real translations for new keys (`test:i18n` checks parity); pass values rather than grammar fragments; keep product names, paths, commands, and model IDs literal; locale switches must not remount the app.
- **Settings & providers**: See [settings composition](src/components/sections/shared/DOCUMENTATION.md), [provider authority](../web/application-host/lib/models/DOCUMENTATION.md), and [memory authority](../web/application-host/lib/memory/DOCUMENTATION.md).
  - Device-local entries use `src/lib/client-settings-bridge.ts`; forms preserve unsaved drafts and opened revisions across refresh.
  - Project trust is managed per canonical folder in project settings (not duplicated in Skills/MCP).
  - Model services separate guarded connection drafts from serially-queued immediate model edits and separate config, discovery, and authentication (credentials never enter renderer settings).
  - `src/components/sections/agents` uses `AgentProfilesAPI` (omitted tools, empty selection, and reset stay distinct).
- **Plugin center** (`src/components/sections/extensions/ExtensionsPage.tsx`): Searches cached catalog metadata locally, starts release preparation only on selection, trusts Host-supplied source-matched installed flags, fences Host/catalog revision changes across the trust dialog, and keeps source management and archive upload available when discovery fails.

## Verification and performance

- **Commands** (`packages/ui/package.json`): `type-check`, `test` (`vitest run`), `test:i18n`, and `lint`. Run colocated behavior/unit tests beside the changed owner and relevant Motion Lab checks for motion changes.
- **Behavioral test bar**: Exercise real transitions — interrupted/repeated actions, stale target completions, draft retention, connected mounts, queue identity, cleanup, and provider failures — not copied layout constants or literal enums.
- **Performance & platform checks**:
  - Visible demand owns subscriptions and refreshes; hidden views release DOM observers, language requests, Git/PR refresh work, and presentation timers without cancelling backend jobs.
  - Preserve unrelated object identities across deltas; never treat a virtualized viewport size as a history limit.
  - Verify reduced motion, keyboard navigation, focus return, narrow layouts, and touch through real interaction paths.
