# OpenChamber upstream absorption ledger — 2026-08-13

## Reviewed source

- Maintainer fork baseline: `f551150e57de87858383dd62f45462189adf4125`.
- OpenChamber upstream tip: `dea3826f8759e503465a9a9ac5614f4d54caa1b0`.
- Merge base: `ddbc9b536aaa02ed1c1a0e9dc8f2030454cf6854`.
- Reviewed reconciliation: `24379cc84b2818a61f62301fa83c82a24d17986a` on
  `sync/upstream-20260813` in `Youzini-afk/openchamber`.

The reconciliation keeps upstream's current product structure while restoring the fork's custom
providers, workspace/project browsing, cloud and desktop behavior, OpenAgent/orchestration/Magic
surfaces, remote notification listener, directory-selection mode, session routing fallbacks, and
provider/agent refresh behavior. Smart Search and unused worktree parameters were not restored
because the merged application has no real consumer for them.

That merge is not copied wholesale into Varin. Varin reviews the resulting behavior and adopts
it through the native Pi protocol, runtime broker, extension contracts, and product stores.

## Adoption rules

1. Prefer the upstream implementation when it already satisfies the fork behavior and does not
   reintroduce an OpenCode dependency or duplicate owner.
2. Supplement a partial upstream implementation at its real ownership boundary instead of keeping
   two competing implementations.
3. Reimplement engine-dependent behavior against Pi; do not project Pi data into OpenCode types or
   restore OpenCode HTTP routes, stores, lifecycle, MCP ownership, or compatibility aliases.
4. Preserve platform behavior, native configuration authority, project trust, revision conflicts,
   credentials, and current user data during each adoption phase.

## Capability disposition

| Upstream capability | Upstream evidence | Varin disposition |
| --- | --- | --- |
| Raw HTML in assistant Markdown stays inert | `3de9be9f` | Adopted directly. Raw HTML is visible text; `script` and `style` are forbidden again at the sanitization boundary. Composer HTML fragments are not treated as file mentions. |
| Final shell output reflects terminal control sequences | `91d2a546`, `1c27155b` | Adopted in the Pi-native timeline. ANSI styling, carriage-return progress, cursor movement, and line erasure are normalized only for persisted/final output. Synthetic cursor expansion has a dedicated allocation budget; real output remains Pi-owned and is not truncated here. |
| Code line numbers never wrap | `a7db4015` | Adopted directly in shared Markdown CSS. |
| Work Status panel | `f2523d0c`, `222057ab`, `630ac299`, `d7231b6d`, `ee9c9d6f`, `fa1cd279`, `83c4c75f`, `5ef828f3` | Adopted as a Pi-native wide-chat panel. It projects `SessionSnapshot`, `SessionStats`, `PiSessionFeatureState`, current tool executions, Fleet RPC, and MCP public status without introducing a second message-context owner. It does not restore OpenCode todo, goal, MCP, or quota stores. Upstream's later empty-panel recovery is structurally unnecessary here: Varin has no per-section hide preferences, always renders its session section and header, and therefore cannot hide the control needed to restore hidden sections. |
| Guided diff/branch/PR walkthrough | `2ea828b8`, `2444dd2f`, `e815dbb9` and follow-up fixes | Adopted through Varin's Git service, Pi model catalog/auth, server-side generation jobs, and the context-panel surface. The complete reviewable diff must fit the selected model; it is never silently clipped. A host without the walkthrough API is identified from its non-JSON response instead of exposing an HTML parse error, and importance is rendered as reading priority rather than a review finding. Upstream's fixed chapter/stop/hunk caps were removed because they were presentation guesses rather than protocol or resource boundaries. |
| Markdown loops in `.agents/loops` | `0ba330c7`, `8a367382`, `bac56fc7`, `ffef080b`, `d1bb9d3a`, `96c8d477`, `3bbde9af` | Adopted in the Pi-native scheduler. Markdown remains authoritative and uses Pi model, thinking, agent, and goal fields. File-path identity preserves runtime history across frontmatter renames and removes orphan duplicate projections of the same file; revisioned edits prevent agent/UI races; malformed higher-priority loops keep their last-good state without activating a lower duplicate. Varin's UI edits or deletes the authoritative Markdown rather than disabling those actions. Upstream's 80-character name rejection is not imported because it only compensates for an upstream storage truncation that Varin deliberately does not have. No OpenCode owner, permission, or variant field is imported. |
| Relay request-body integrity | `854a0db9`, `aaf397e6`, `d634cd23` | Adopted at Varin's retained relay boundary. Empty body sources emit an explicit frame, ordinary control bodies are forwarded only after completion, missing frames abort as an ambiguous transport failure, and stalled buffers are released. Large uploads retain streaming behavior. |
| Mobile transient reconnect and device diagnostics | `dea3826f`, `f4005982` | Transient reconnect behavior adopted against Varin's endpoint-aware mobile state. Explicit token rejection disconnects immediately; temporary reachability failures get bounded fast/full-budget retries and never replace a later manual connection. The upstream hidden diagnostics UI was not copied. |
| Measured Vite/chunk and lazy-render improvements | `fdcf5c27` | Adopted after a Varin-specific bundle audit. Diff, Files, Git, PR, Plan, Settings, Ghostty, Markdown Shiki, diff workers, and Nerd Fonts now load at their real first consumer. The upstream package-name parser did not recognize Bun's nested `node_modules/.bun/.../node_modules` layout and still produced a 15.8 MB eager `.bun` vendor chunk; Varin resolves the innermost package and isolates Vite's preload helper. Production entry resources fell from 16,411,160 to 838,532 raw bytes (94.9%). Obsolete OpenCode chat tool components were not restored. |
| Provider/OAuth/custom-provider fixes | `70af851b`, `07248a3b`, `0788f43a`, `9101eac3`, `557e867f`, `22d36f83` and follow-ups | Audited against Pi's provider runtime. Varin already projects API-key/OAuth methods on every catalog read, uses one provider-owned login call that waits for browser callback, device polling, or manual completion before persisting credentials, preserves the effective edit scope, resets the edit form, and keeps secrets outside config DTOs. The OpenCode JSON-body route and two-step OAuth callback are not applicable. Varin supplements the upstream behavior by gating `.pi/models.json` on project trust and making form-owned field removal real while preserving comments, credentials, and unknown native keys. It intentionally does not hide every unauthenticated model: Pi supports anonymous/local providers, and model availability remains the runtime-owned signal. |
| OpenCode session sync, question/permission routing, MCP settings/auth | `0f52a9be`, `ee5e45ae`, `d33cf518`, `622b8bb6` | Audited by failure mode rather than copied. OpenCode's directory-store routing, worktree directory guessing, queued-send retry, callback proxy, and Apply-&-Restart state do not exist in Varin. Varin already routes every session action and Extension UI response through the broker's exact `sessionId → worker` binding; MCP authentication remains a `pi-mcp-adapter` command/status contract. One shared failure did reproduce: an unexpected Pi session-worker exit was server-only and left busy/tool/dialog UI stale. A routed terminal event now settles that session and clears its extension UI. |
| Git worktree, identity, symlink, and base-branch fixes | `58e6e704`, `955e7231`, `5fc61373`, `18fefc99`, `c9ab916c` | Adopted and completed across Varin's Web and VS Code Git owners. Managed worktrees populate with `core.longpaths`, run the repository's normal `post-checkout` hook, and keep bootstrap usable when that hook fails. SSH identity writes use the targeted simple-git opt-in and a raw config write. Symlink diffs expose link targets rather than following directory/file targets. Branch workflows use each remote's declared default branch, preserve cached remote refs while offline, avoid self-comparisons, and resolve bases hosted by a non-`origin` remote for both diff and file lists. OpenCode project registration remains absent. |
| CLI worktree creation timeout | `0922ef4f` | Adopted at Varin's own `session create --worktree` call. Only the explicit Git worktree mutation receives a two-minute client window; instant CLI API calls retain their four-second default, and an explicit caller timeout still wins. This prevents a cold Git operation from completing on the server after the CLI has falsely reported failure. |
| Pairing reachability, Android payload parsing, and Relay demand | `9aa98df2`, `24b44f71`, `e04e34a2` | Adopted at Varin's retained pairing and Relay owners. Pairing links keep the public reverse-proxy origin as a fallback after the preferred LAN URL while excluding desktop loopback. Android QR redemption has a URL-API-independent parser with the same v2 validation. A real relayed request repairs legacy client demand, and an unreadable client/pairing store no longer masquerades as zero demand and switches the Relay off. Varin's existing scanner lifecycle, external-access profiles, capabilities, and audit records remain authoritative. |
| File reveal and browser file actions | `6599891d`, `a416e033` | Adopted and completed for Varin's local/remote runtime switching. macOS/Linux reveal waits until the file-browser launcher actually starts and reports launcher failures. Browser clients download files instead of offering to reveal a path on the server. Electron only exposes reveal while connected to its local Varin server; VS Code keeps its host-owned behavior. Download remains available even when it is the row's only menu action. |
| Desktop minimize, Linux terminal discovery, and notification edits | `f2b3c50a`, `b76bbd7a`, `f498fad3` | Adopted at their existing Varin owners. Native taskbar minimize remains native; only Varin's own window control applies the minimize-to-tray preference. The generic Linux terminal target selects a desktop entry declaring `TerminalEmulator` instead of a name collision. Notification template field edits derive from the latest store value so adjacent edits cannot overwrite each other. |
| Shared terminal, context rail, and mobile gesture fixes | `10728dbf`, `a5c413b9`, `16e03d13`, `d7e82eea`, `0b393e5b` | Adopted against Varin's own stores and surfaces. Default terminal labels advance from the highest open default label instead of the tab count; Escape reaches the PTY before the context panel can close; only Git shows repository activity and now exposes the changed-file count; Android session switching starts beyond the system Back strip. Varin keeps its own session ordering and context-surface registry. |
| Android QR scanning without Play Services | `cc40ff9f` | Adopted in Varin's pairing flow. Android uses the ML Kit plugin's bundled CameraX `startScan` path with an in-app preview and explicit cancellation, so scanning no longer waits for the Play Services barcode UI module. iOS retains the native one-shot scanner, and both paths continue through Varin's v2 pairing parser and redemption owner. |
| Embedded chat loading, context focus, and terminal keepalive | `7a04dd5c`, `687cc17d`, `8702c6d5` | Adopted through Varin's context panel and Pi-native chat where ownership matches. Only the active persisted session-chat tab mounts a complete embedded application, and closing the panel mounts none. The context-pin focus patch is no longer applicable because Varin does not own message pinning or context reinjection. Terminal ping cadence is 45 seconds, below Varin Relay's measured 90-second data-socket reaper while avoiding unnecessary wakeups. |
| Terminal startup before emulator readiness | `6eac705b`, `bbbb30b9` | Adopted with Varin's lazy Ghostty owner. Mounting the first terminal estimates its dimensions before the emulator JS/WASM and remote font finish loading; the shell starts immediately at that size or 80×24, then receives the measured size. A per-directory/tab in-flight key prevents React Strict Mode from creating duplicate PTYs, and a late completion is accepted only while the tab still owns it. |
| Model-picker availability and walkthrough capability filters | `ba050be3`, `2d61984b` | The valid selection invariant is adopted: an explicit empty provider allow-list means “show none” while authentication is loading, rather than reopening the full catalog. The upstream model-level filter is not guessed from Pi's `api` identifier: Varin's walkthrough backend already reads the catalog's real `structured_output` capability, blocks models explicitly marked unsupported, and retries unknown-capability providers without a response schema. Treating every `openai-completions` model as unsupported would incorrectly hide OpenAI-compatible chat providers. The upstream sticky-fade implementation is also not partially copied because it depends on a broader visual refactor absent from Varin. |
| Pending interaction visibility and recovery | `e7961c0f`, `1198a11c` | The user-visible part is adopted from Varin's real Extension UI owner: live `select`, `confirm`, `input`, `editor`, and custom requests are counted per Pi session, shown on that session row, and rolled up only while child rows are collapsed. OpenCode's cold-start question query/retry layer is not copied because Pi exposes no queryable pending-request snapshot; replaying it honestly requires a future Pi host protocol rather than inferring a dialog from transcript text. |
| Linux AppImage child environments | `079ccb19`, `f2e6bc11` | Adopted for Varin's in-process server and terminal runtime. AppImage's exported `ARGV0` is removed before login-shell environment merging and is never reintroduced from the shell probe. Terminal child environments remove it too, and Linux PTYs launch through the system `env -u ARGV0` wrapper because `bun-pty` can inherit native environment state beyond the JavaScript object. |
| Electron development connection limits | `313ee22e` | Adopted with Varin's own environment names. The bundled renderer still lifts Chromium's loopback connection cap for concurrent API and preflight traffic; Vite HMR keeps the normal cap so its module-transform pipeline is not flooded during startup. Production behavior is unchanged. |
| VS Code native editor selection | `d1e9aa5f` | Adopted in Varin's VS Code bridge. File opens now use the native `vscode.open` command with the existing line/column selection, allowing registered custom editors such as the Notebook editor to handle `.ipynb` instead of forcing every path through the text editor. |
| Multi-file patch navigation | `911e580e`, `4e9f4510` | Reimplemented for Pi's tool-result schema instead of restoring OpenCode's removed `ToolPart`. Varin reads both the codex-compat `changes` contract and existing `files` metadata, resolves move destinations and workspace-relative paths, and exposes every non-deleted `apply_patch` file as an editor/diff action in the Pi tool card. |
| Active instance service URLs | `8303b3cb` | Adopted at Varin's server owner. `/api/system/info` now reports the listener port and currently active Varin tunnel URL through live runtime getters; About renders only values returned by the connected instance, so parallel worktrees, remote instances, and stopped tunnels do not reuse guessed or stale addresses. |
| Electron 43 desktop runtime | `eb9a2140` | Adopted as the complete native build set, not a version-only bump. Varin uses Electron 43.3 for Linux frameless-window rounding, upgrades `@electron/rebuild`, and adds the matching `node-abi` resolver while retaining its own explicit rebuild and load checks for `better-sqlite3` and `node-pty`. |
| Self-healing Electron installation | `733d44fa` | Adopted with Varin-owned environment names. Install and desktop development verify the Electron package version, runtime path, executable header architecture, and actual binary; an interrupted or skipped postinstall is repaired before the rest of the desktop pipeline starts. The best-effort repository postinstall does not turn a deliberate `ELECTRON_SKIP_BINARY_DOWNLOAD` into an implicit download. |
| Native directory permission recovery | `1a00c1fa` | Adopted across Varin's filesystem service, Web API, and directory explorer. Missing paths, non-directories, malformed responses, and operating-system permission failures remain distinct; a denied macOS folder can request access through the local Electron picker and retry, while remote/browser clients are never offered a native grant. Permission failures no longer masquerade as a missing folder or enable “create and add”. |
| Filesystem listing through workspace symlinks | `9f58b4c9` | Adopted at Varin's filesystem route. Physical real paths are still used for directory reads and Git-ignore checks, but response paths remain under the logical path the client requested. Nested expansion therefore stays inside the selected workspace instead of jumping to the symlink target and being rejected by the file tree. |
| In-progress merge/rebase guidance | `932dbd69` | Adopted in Varin's Git surface. The banner uses Varin's real warning tokens, reports the actual unresolved-conflict count, wraps operation details, and presents one explicit next action: resolve conflicts or continue. Existing Varin Git continuation, abort, persisted conflict state, and AI conflict workflow remain authoritative. |
| Captured session sends and queue races | `1c9ca82b`, `fcf0622e`, `1adeb7b7`, `77d317b8`, `7e883848` | Audited against Pi's transport. Pi follow-up and steering queues are owned inside the exact session worker, so OpenCode's renderer auto-send queue, streaming-status fallback, worktree bootstrap dispatch, and server record-materialization fixes are not copied. One shared race was applicable: a send can spend time rendering prompts before transport dispatch while the user changes runtimes. Varin now pins prompt, steer, follow-up, and armed-goal mutations to the runtime captured with the draft and refuses dispatch after a switch, leaving its existing draft/attachment/goal restoration path intact. |
| Session archive, delete, and restore guards | `83497e06`, `e6b73679`, `ffbd139c` | Already covered through Varin's Pi-native session UI. Sidebar, header, archive view, mobile sheet, worktree removal, and retention cleanup operate on explicit session IDs; destructive user actions use confirmation and include the complete Pi parent/subtask subtree, archived sessions have a native unarchive action, and the broker deletes only the catalog-resolved Pi session file. OpenCode's directory ownership guards and worktree-delete options are absent rather than reintroduced. |
| Bare CLI UI-password generation | `375363ff` | Adopted with Varin's CLI and environment names. An explicit `--ui-password` without a value generates an ambiguity-free password before foreground or daemon startup, persists it with that instance, and prints it once in the selected human, quiet, or JSON output contract. An omitted flag keeps existing behavior, and a caller-supplied password is never echoed. |
| Screenshot dependency lazy loading | `1edf2785` | Adopted at Varin's remaining screenshot owner. `snapDOM` loads only when an iframe annotation capture is requested, and `html-to-image` loads only if the fallback DOM capture is reached; neither remains in the eager UI graph. Upstream's assistant-message image export path no longer exists in Varin and was not restored. |
| Foreground systemd self-update | `e0255cac` | Adopted in Varin's update route. A Linux foreground instance running under systemd queues the package update in a separate transient user unit and explicitly restarts its owning service afterwards; `VARIN_SYSTEMD_UNIT` selects a non-default unit. Other foreground process managers receive an honest service-manager error instead of a false auto-restart response. Container image deployments retain their image-owned update behavior. |
| Skill discovery, ownership, and rename gating | `8d675a55`, `6dd6dfb5`, `35f0a31d`, `fd9d73f8`, `68e0b471`, `be77d926` | Already covered by Varin's Pi-native resource service rather than copied. It discovers agent- and project-scoped `.pi/skills` and `.agents/skills`, marks writability from the actual managed root, keeps package/linked/external resources read-only, copies whole skill directories into a managed scope before editing, and applies project trust plus revisioned writes. The renderer therefore does not guess ownership from paths or revive OpenCode's server rename route. |
| Composer, session-row, message, and scrollbar fixes from the OpenCode UI | `287d6b87`, `721525e6`, `54d24a48`, `294552b0`, `cc6c5db3` | Reviewed, not copied. Varin's active composer is a native textarea, so Shift+Enter and caret visibility do not depend on the removed CodeMirror composer. Its Pi session rows do not carry the upstream rounded clipping wrapper, Pi bash entries already render complete output without a collapsed tool card, and the latest upstream explicitly restores the same auto-hiding overlay-scrollbar behavior Varin already has. |
| Session activity duration | `faa9c243` | Reimplemented from Pi's ordered lifecycle events instead of copying OpenCode's persisted liveness heuristics. The first `agent_start` marks the turn, repeated starts cannot reset it, and `agent_settled` or a worker exit settles the duration. Rows replace the continuously animated spinner with a static state dot and a one-second leaf counter shared by one ticker. If a reconnect reports only `busy` without a known start, Varin shows the state without inventing elapsed time. |
| OpenCode-only sync, restart, todo, worktree registration, agent-frontmatter, and SDK changes | `1a58c2b1`, `906cabf1`, `9e5751f0`, `9bdd2a11`, `edbbd60c`, `0d1a2d9f`, `2725c482`, `2d183a15`, `57bc8227`, `1b22bf21`, `c290ce6a`, `66f35bc2`, `dee6305b`, `b8d18744` | Reviewed and intentionally not copied. These commits repair OpenCode directory caches, restart accumulation, todos, project registration, agent parsing, managed-process rebinding, or the OpenCode SDK. Varin's broker/session-worker routing, Pi package reloads, scheduled loops, plugin-owned agent definitions, and Pi JSONL authority are different owners; no compatibility shim or duplicate cache is introduced. |
| OpenCode provider quotas and credential gating | `7309dc61`, `0284cd61`, `4df7439f`, `9639e9d9` and their follow-ups | Reviewed, not copied. DeepSeek/Kimi/xAI/OpenCode-Go usage endpoints and OpenCode credential files are not Pi provider contracts. Varin continues to use Pi's model/auth catalog and only adds quota integrations when a Pi-native provider exposes a supported public contract; it does not infer availability from missing credentials because local and anonymous Pi providers are valid. |
| Additional OpenChamber UI preferences and shortcuts | `228e5c8b`, `12c14825`, `1dd5e3fa`, `8274dd82`, `d91c2c33`, `01574139`, `2ffb9415` | Reviewed by consumer. Selection-to-chat is adopted against Varin's real draft store and native textarea: `Ctrl/Cmd+L` captures a focused editor, text control, or rendered Markdown selection and appends it to the exact current session/workspace draft; the sidebar moves to `Ctrl/Cmd+Alt+L`. The collapsed-message setting, numbered context-panel switching, and extracted-document attachment cascade depend on removed stores/models and are not imported as dead settings. Pi tool cards already expose complete arguments—including glob patterns—and Pi timeline entries have no replay-on-bootstrap animation to suppress. |
| New-project landing state | `4ef9ce1c` | Adopted through Varin's pending-draft workflow. Adding, creating, cloning, or quick-adding a project activates its real project/directory and opens a Pi-native unsaved chat draft; it does not create an empty Pi session or call an OpenCode directory route. |
| Remaining dependency, locale, theme, tablet, and profiling changes | `108d2c04`, `805d8737`, `d16ad0bf`, `d6848ff7`, `d96e34a1`, `ebb02b43`, `14f6d4d3`, `0415ec8c`, `efe5f680` | Audited rather than merged wholesale. `react-syntax-highlighter` is already absent and `adm-zip` is already 0.6.0. Varin retains `better-sqlite3` because current Web/Electron owners consume it. Adding German is a separate complete-locale product phase, not a partial upstream copy. Varin's current mobile shell owns phone/tablet/foldable layout. Upstream profiling harnesses and trace-only micro-optimizations are development tooling, not runtime capability; measured bundle/runtime improvements were adopted in their owning phases. |
| Git repository discovery independent of server cwd | `8d604397` | Adopted at Varin's Git service boundary. Every `simple-git` repository client now requires an explicit directory, while global identity reads use the user's home directory as their stable base. This removes the last fallback to the server process working directory without changing Varin's existing non-repository status response or its nested-worktree resolution. |
| Model selection restoration after agent messages | `2ea14335` | Reviewed, not copied. The upstream repair restores a manually selected OpenCode model after an agent-generated user message reset it to that agent's default. Varin's main-session model comes from the owning Pi worker snapshot, and subagents/plugins run through separate Pi sessions or plugin contracts; there is no equivalent renderer-side model reset chain to patch. |
| Derived runtime-key hot path | `ff79e918`, `2489c3fb` | Adopted with Varin's injected runtime globals. Before an endpoint is explicitly initialized, repeated store and render reads reuse the derived key without reparsing URLs; changing either the API base URL or local-origin input invalidates it immediately. Explicit runtime keys remain authoritative. |
| Walkthrough output language | `b92456fe`, `4e8fc1d2` | Already adopted in Varin's walkthrough owner. Generation records a supported output language, the prompt requests that language, stored variants are selected by model and language, and the UI reports honest fallback when an older or differently generated walkthrough is shown. Varin supports its complete current locale set and does not import a partial German locale. |
| Lost relay send outcome | `00c19eb9` | Reimplemented at Varin's transport-neutral runtime client rather than copying OpenCode's message refetch loop. If a runtime socket closes while a request is pending, the error now records the exact method and that the already-sent outcome is unknown. Varin never blindly retries prompt, steer, or follow-up requests; the composer keeps the draft and tells the user to inspect the session before resending, avoiding both silent loss and duplicate agent runs. |
| Shared worktree ownership | `7bb9b898` | Adopted only at Varin's affected mobile project browser. Multiple configured checkouts of one repository no longer each render the same sibling topology: the configured primary checkout owns unregistered siblings, or the first configured checkout does when the primary is absent. A checkout already configured as its own project remains visible there and is omitted from the owner's nested list. Desktop Pi sessions already have single ownership through longest matching project paths. |
| Mobile navigation and tablet rework | `fbbbecf4`, `d6848ff7` | Reviewed by user-facing capability, not copied as an OpenCode shell replacement. Varin already has cross-project Pi sessions, instance management and reconnect recovery, session usage metadata, Files/Changes/Terminal/MCP surfaces, native back handling, safe-area handling, and a live phone/tablet/foldable layout tier. The mobile title now opens Varin's existing Pi session switcher, so status, attention, project selection, directory, and session opening retain one owner. Upstream's unified workspace drawer and its unverified 600/1000 device thresholds are not imposed over Varin's current surfaces and measured 700/900 touch tier. |
| Managed runtime bind hostname and provider env aliases | `94a165d3`, `b18ec442` | The bind-host failure mode is adopted at Varin's own server boundary: CLI and direct server startup reject URL/port/path or malformed-IP values before LAN-auth classification, preserve valid DNS and IP hosts, and unwrap bracketed IPv6 for Node's listener. The OpenCode child-process variable and Google key mirroring are not copied: Varin does not manage an OpenCode process, and Pi's ModelRuntime owns provider environment/auth discovery. Credentials are not duplicated into a second inferred environment layer. |

## Phase checkpoints

### Direct rendering and terminal hardening

Scope: Markdown HTML handling, mention classification, code-line layout, and final Pi bash output.
This phase has no protocol or persistence change and does not alter live streaming output.

Acceptance:

- active raw HTML cannot enter application DOM through Markdown;
- ordinary Markdown, generated syntax highlighting, math, and Mermaid keep their current renderer;
- final Pi bash output presents the terminal's visible result rather than raw control bytes;
- huge cursor coordinates cannot allocate output proportional to the coordinate;
- code line-number cells stay on one line.

### Platform transport and mobile lifecycle

Completed against Varin's retained relay and mobile code. The relay uses `hasBody` plus explicit
empty frames to distinguish empty bodies from missing frames, buffers ordinary control requests
until `StreamEnd`, releases stalled buffers at the delivery deadline, and leaves larger uploads on
the previous streaming path. Mobile resume uses a 4-second/10-second retry ladder with a final
full-budget probe; cold launch releases the splash after the fast verdict and retries once in the
background without overriding a manual connection.

### Pi-native product capabilities

Implement Work Status, walkthroughs, and Markdown loops as separate recovery points. Each phase must
name its authoritative Pi data source and remove any temporary duplicate owner before completion.

Work Status is complete for the main chat surface. It appears only when the chat container retains
enough width for both the conversation and a 288px panel; mobile, VS Code, Mini Chat, and embedded
agent-manager conversations do not mount it. Session statistics refresh from the existing Pi stats
method, Fleet uses the existing read-only RPC, and MCP uses `pi-mcp-adapter/status/v1`; the panel does
not introduce another message-context owner.

The guided walkthrough is complete for desktop and web context panels. Working-tree, staged,
unstaged, branch three-dot, and pull-request sources all resolve in the server's existing Git owner;
the renderer receives server-owned content hashes and never recreates merge or hunk identity logic.
Generation is explicit, deduplicated per repository/source, survives a detached client, and can be
cancelled explicitly. Results are content-addressed under the Varin data directory and retain
stale/uncovered hunks instead of presenting an incomplete review as complete. VS Code does not show
the surface because that host still does not serve the Git/model HTTP routes this implementation owns.

### Build graph and first-use loading

Completed against Varin's Bun workspace rather than copying upstream's chunk names. The settings
window does not fetch until its first open; context surfaces keep their state but load their heavy
implementation only when selected; Ghostty JS/WASM and remote Nerd Fonts load only when a terminal
mounts; Markdown creates its Shiki worker only for an actual highlighting request; diff worker pools
and Pierre theme registration stay dormant until a diff consumer requests a pool. CSS syntax variables
remain dependency-free, and the unused `openchamber-md` Pierre registration was removed.

The production `index.html` resource graph is the acceptance measurement: before this phase it eagerly
referenced 16,411,160 bytes, dominated by a 15,780,665-byte `vendor-.bun` chunk. After resolving the
innermost package name and separating Vite's dynamic-import helper, it references 838,532 bytes and no
longer preloads Settings, CodeMirror, Pierre/Shiki, Ghostty, Git, or Files chunks. These are raw emitted
bytes, not a claim about every device's wall-clock startup time.

### Provider configuration and authentication

Completed at Varin's Pi provider boundary. Project-local `.pi/models.json` is now itself a
trust-requiring resource, is neither read nor registered before approval, and cannot be written or
deleted through Provider settings while the project is untrusted. The user and explicit operator
layers remain available. Editing a native provider now replaces the GUI-owned `api`, `authHeader`,
`baseUrl`, `models`, and `name` fields, so clearing one actually removes it; comments, `apiKey`,
headers, compatibility settings, and future unknown keys remain intact.

Pi's OAuth implementation needs no OpenCode callback emulation. `ModelRuntime.login()` owns the
complete browser callback/device-code/manual-code flow and stores the credential only after it
returns. Provider methods are rebuilt from the active Pi provider on every list/reconnect. The UI
continues to show configured anonymous and local providers because absence of a credential is not a
valid reason to hide models in Pi; each model's runtime `available` flag remains authoritative.

### Session and extension interaction convergence

Completed against the Pi worker topology. OpenCode's parent-directory versus worktree routing bugs
are structurally absent: the public runtime accepts a `sessionId`, the broker owns the single active
worker for that id, and Extension UI/provider-auth responses carry the request's emitted session id
back to that exact worker. Varin therefore does not restore directory-resolution indexes, local
question stores, permission stores, or an OpenCode queued-send scheduler.

The applicable interrupted-turn invariant is now explicit. When a Pi session worker exits, the
broker forwards one ordered `session.worker.exited` terminal event to connected surfaces. The session
store closes the live record, clears busy/streaming/compaction/retry state, marks unfinished live
assistant output and running tool executions as interrupted errors, and raises background attention
for an unexpected exit. The interaction store removes dialogs and session chrome owned by that dead
worker. Persisted Pi entries are not rewritten; reopening the session continues to refresh them from
Pi's JSONL authority.
