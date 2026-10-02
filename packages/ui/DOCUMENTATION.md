# Shared UI architecture and conventions

`@varin/ui` is the React surface shared by Web, Electron, and mobile. It owns
presentation and client-side kernels, not privileged filesystem, credential, shell, or process work.
Surface-specific packages provide `RuntimeAPIs` and host bridges; shared components consume those
contracts without hardcoding an origin, port, desktop IPC channel, or local path.

## Module map

- `src/lib/documents/DOCUMENTATION.md`: revisioned client buffers and conflict behavior.
- `src/lib/workbench/editors/DOCUMENTATION.md`: editor groups, providers, panels, and layout state.
- `src/lib/monaco/DOCUMENTATION.md`: desktop/Web editor projection and language integration.
- `src/lib/codemirror/DOCUMENTATION.md`: mobile and embedded document adapters.
- `src/lib/api/DOCUMENTATION.md`: shared runtime capability and browser-URL boundaries.
- `src/stores/DOCUMENTATION.md`: store ownership, synchronization, cache identity, and visible-demand
  refresh behavior.
- `src/components/sections/shared/DOCUMENTATION.md`: Settings layout, controls, save feedback, and
  search integration.
- `src/workbenches`: official Workbench/IDE/Research/Bot shells and Settings React composition. Lower `lib` modules do
  not import this layer.
- `src/features`: narrow React/store integrations, such as adapting the active-editor Store to the
  framework-neutral Agent/editor kernel.

Runtime API types and auth/fetch/URL/switch primitives are imported directly from
`@varin/application-client`; UI-owned forwarding modules are not part of the boundary.

The provider picker reads the active Pi runtime catalog; it does not maintain a second built-in
provider list. Login and model discovery use separate interaction identities even for the same
provider. The shared authentication UI renders Pi's secret/text/select/manual-code questions and
events for both API keys and OAuth. Prompt withdrawal clears the corresponding input, and closing
or changing the target cancels the native operation. Custom model configuration stays in `models.json`;
credentials stay in Pi auth storage and are never persisted in renderer settings. Configuration save
and subsequent authentication are separate outcomes, so cancelled login must not be reported as
successful credential setup.

Custom providers configure their common connection first, then independently enable generation,
embedding, reranking and fast decisions. Generation exposes Chat Completions, Responses, Anthropic
Messages, Gemini and an editable extension API identifier. Inference connections expose their actual
adapter protocols and allow address/path/credential-owner overrides. Credentials stay in Pi auth;
pure inference providers do not need a chat API or fabricated chat model.
All four capability sections offer model discovery and a shared selection/import dialog. Inference
discovery uses its own connection overrides, imports only into that section, and leaves selection
explicit for mixed catalogs. Changing the connection or leaving the editor cancels pending discovery.

Capability model suggestions appear in their corresponding Harness pickers, alongside manual ID entry.
Provider counts include those declarations, while the ordinary chat picker still uses only native Pi
chat models. Disabling retains configuration and model definitions. A declared-model selection retires
the old manual input generation so its unmount auto-save cannot overwrite the new selection.
See [provider ownership and format](../pi-host/src/PROVIDERS.md).

## Theme and component system

`varin-mark.ts` owns the approved fold logo as two centered polygons, including the extended tips and
small diagonal separation. `VarinLogo` uses that flat mark in the surrounding foreground color, with
two-tone shading at larger sizes and solid ink for small controls. The splash keeps its existing cube
and camera; `varin-splash-cube.ts` places the same polygons on its top face. `branding:generate` emits
desktop/Web/mobile/Widget assets, and `splash:emit` updates the pre-paint HTML. Keep shape edits at this
shared source rather than drawing independent versions for individual surfaces.

Research uses `MainLayout` for shared window controls, navigation, permissions, settings and resource
panels. Its conversation composition shows the real research-root Thread/Run and an expandable branch
and materials area. `HarnessThreadStateProvider` owns this read-only projection; branches remain
available from the ordinary Agent/IDE thread panel too. Rendering a shell never creates a Run.

`PiWorkFocusControl` selects execution focus independently of the shell. New drafts can use a project
default or an explicit override; the broker captures the choice when creating the session. Existing
sessions show selected and applied focus separately. A change applies before the next new Run, while
the current Run and its follow-up queue retain their configuration. Session metadata, not the active
project or UI profile, owns the durable choice. Project defaults use the existing settings/autosave path.

The session sidebar places “Scheduled & follow-ups” directly below New session. Its existing page slot
(`ScheduledTasksDialog`) contains separate schedule and follow-up sections on desktop and mobile.
Schedules keep project selection and their existing editors. `FollowUpTasksPanel` reads an authenticated
Host-wide overview, separates active waits from history, and exposes source checks, explicit invocation,
cancellation and navigation back to the target conversation. Mutations reuse the original session-scoped
routes and revisions. Overview reads do not invoke models or install another scheduler. The panel loads
only while visible, follows existing follow-up events, and aborts stale reads on unmount/runtime changes;
load failures stay distinguishable from an empty list. `followUpsApi` is shared with the conversation strip.
Both sections use a centered page heading, rounded search field, status filters and compact expandable
`TaskListRow` entries; full instructions and actions are disclosed on expansion. There is no suggestions
section. The Create menu offers either task kind. `FollowUpEditorDialog` creates a continuation on an
existing project-bound conversation through the same Host service as the Agent tool; common conditions
are time, workspace file state, a listed experiment's completion, GitHub PR state and manual invocation.
Creation does not pause the current conversation. Conditions already met may invoke it immediately.
Editing only the instruction retains advanced sources, and editing a supported source retains its
unexposed options (such as fallback deadlines). Calendar task creation keeps its existing editor.

`WorkbenchProfileSwitcher` exposes one icon-labelled mode menu: Workbench, IDE and Varin bot.
General/Research (plus installed custom profiles) remain a separate workspace menu visible only in
Workbench mode. `useUIStore.agentWorkbenchProfileByHost` remembers the Workbench return destination
per Host across shell remounts and app restarts. The Host profile document remains the sole active-shell
authority; committed Workbench profiles refresh the return preference, while failed switches preserve
it. Both controls leave work focus alone and shell changes use the existing staged transition.

`varin.bot` selects the built-in Bot shell. It uses shared window/settings/resource chrome with its own
Bot identity and work navigator, rather than a shortcut in the ordinary session sidebar. The shell
opens the selected Bot's durable entry through the existing Host API and shows only that Bot's entry
or work conversations. An empty catalog offers explicit creation; failed reads stay errors. Candidate
shell staging never creates Bots or navigates sessions. Unmount/runtime changes cancel stale reads and
entry resolution. Ordinary Workbench and IDE navigation exclude sessions owned by Bot entry or Run
records, and returning from Bot restores the prior ordinary session and location. Mobile exposes the
same mode control in its navigation drawer (IDE remains desktop/Web).

Bot rows expose the same actions through right-click and their visible-on-hover `…` button:
pin/unpin, rename, the targeted Bot profile, scoped memory, sleep/wake, and archive.
Opening another Bot's profile or memory never selects its conversation. The memory panel uses the
Host's existing MemoryService to show source excerpts, supersede a corrected memory, or forget it;
revision checks prevent overwriting concurrent organizer/user edits. Archived Bots have a separate
list with restore; restoration keeps them asleep until explicitly woken.

The Host owns durable Bot sleep progress. The shell subscribes to `varin:bot-changed` and refreshes
on event-stream reconnection; it does not drive background lifecycle work. Sleeping and archived
conversations are read-only. Their banner distinguishes stopping, asleep, waking and partial failures,
exposes explicit retry, and displays the observed remote computer states. Opening history never wakes
a Bot. Archive requests first finish the same sleep operation, so unfinished work remains visible if
stopping or remote shutdown fails.

Varin themes expose semantic surface, interactive, status, primary, syntax, and feature tokens.
Components use those roles rather than embedding palette colors: selection describes current state,
primary describes an action, status colors describe feedback, and syntax colors remain code-specific.
When a third-party renderer needs resolved colors, `useThemeSystem()` is the adapter; ordinary React
chrome uses CSS variables and semantic utility classes.

Built-in themes share neutral work surfaces and plain text; their identity appears in primary actions,
localized selection fills, links, focus and code/status colors. Do not tint an entire panel or change
the interface font when choosing a built-in palette. Custom themes may still supply explicit surface
and font overrides. Default buttons are solid actions; secondary/outline/ghost variants stay quiet,
and selected chips use the theme's selection color. Menus use one border
and a restrained shadow, inputs keep a visible border on hover, and keyboard focus must remain visible.
UI labels use 14px, metadata 13px and small badges 12px at the default scale; Markdown body text uses 16px.

The desktop Agent shell separates two titlebar controls in `ContextPanelControls`: double chevrons
show/hide the right icon rail, and the panel icon toggles the last workspace panel directly. Rail
visibility is a persisted UI preference and never changes panel visibility. The existing per-workspace
panel state retains tabs, widths, expanded layout and the active tab across close/reopen; only a workspace
without retained tabs starts with the file view. The rail switches surfaces and displays Git change
counts. Explicit file/terminal/review actions still open the panel directly. Extension slots remain available.

Default desktop navigation is 256px wide (manual widths are retained). New session and search stay
visible; project/session management and display choices share one labeled menu. The titlebar is 40px except
where native macOS or window-control-overlay insets require more. Composer attachment/fullscreen
actions share a menu; model, permission and send controls stay directly available. Activity traces
are expandable rows rather than another enclosing card. Keep readable content spacious while making
tool chrome compact, and let narrow composer footers wrap rather than clip their actions.

Agent/Research use a full-width desktop header above the sidebar and work area. `TitlebarLeftControls`
and the project/session title are ordinary flex siblings; opening or resizing the sidebar does not
reposition them. There is no floating titlebar overlay, measured-width spacer, or sidebar title strip.
Project runs live in each project's context menu and the header's project-name menu; IDE uses the same
workspace-name menu. Header actions retain the active conversation's working directory, while the sidebar
project menu targets that project's root.
“Start preview” identifies the former “Auto discover” action. The preview surface can open empty with
a launch button, then replaces its placeholder with the detected URL. Project action controllers stay
mounted when their menus close and load configuration on first open. Output observation is directory
scoped and claims automatic URL opening on the shared terminal tab so multiple controls do not open it twice.

Common controls live under `src/components/ui`. `Button`, `dropdownTriggerVariants`, and the Settings
primitives carry shared interaction chrome, sizes, focus behavior, and theme semantics. Extending a
shared primitive is preferable when several callers genuinely need the same missing shape; a local
layout exception does not automatically justify another wrapper component.

Icons use the sprite-backed `Icon`/`IconName` contract documented in
[src/components/icon/README.md](src/components/icon/README.md). The generator is
`bun run scripts/generate-icon-sprite.mjs`; `sprite.ts` is generated output. User theme format and
authoritative data locations are documented in [docs/ops/CUSTOM_THEMES.md](../../docs/ops/CUSTOM_THEMES.md).

## User-facing text

Visible text and accessibility labels are resolved through `@/lib/i18n` inside React render or hook
scope. The message catalogs under `src/lib/i18n/messages` ship together, and
`i18nParity.test.ts` checks their key shape. New semantic keys therefore need real translations in
every shipped catalog rather than an English placeholder. Product names, protocol acronyms, paths,
commands, environment variables, model/provider names, and user-generated content remain literal.

Message parameters carry values, not pieces of grammar. Count-dependent or optional clauses use
complete messages where languages cannot share one sentence. Locale state stays inside the i18n
module so changing language re-renders the surface without remounting the application.

## Interaction and performance precedents

Interaction choices follow the layout and input model rather than one global recipe. Existing sortable
precedents are `DraftPresetChips.tsx` for wrapping variable-width chips and
`components/ui/sortable-tabs-strip.tsx` for a single horizontal row. They use stable item identities;
wrapping and single-row layouts intentionally choose different sorting strategies. Sensor distances,
long-press timing, virtualization thresholds, and cache bounds are implementation decisions to verify
against the actual interaction and scale, not repository-wide magic numbers.

High-frequency state should remain close to its owner and preserve unrelated references. Visible
surfaces drive refresh and subscriptions; hidden surfaces should not keep language, Git, PR, terminal,
or extension work alive. The concrete store and editor lifetimes are documented by their owning
modules rather than repeated here.

Agent Harness has a dedicated Settings navigation group: tools/execution, permissions, model roles,
context, code retrieval, Web access, and the existing knowledge catalog. Its pages share the native Pi
settings authority through a serial, revision-bound autosave controller. UI changes are optimistic;
later edits remain queued while an earlier write completes. Failed writes retain the edits and retry
against a refreshed snapshot. Text commits on a typing pause, blur, or Enter; related inference fields
are submitted together once complete. A successful write never resets another field's in-progress text.
Web credentials use their existing authenticated credential endpoint, outside the settings payload.

`HarnessThreadResultHistory` opens on demand inside a Thread card and uses the application-client
history DTOs. It shows retained versions and Host-provided protection reasons, freezes branch/revision
selection before confirmation, and refreshes the existing Thread/space projection after release.
Version sizes include shared objects; only the Host cleanup response reports removed bytes. Interrupted
cleanup keeps the same retry request across panel refreshes. Target changes discard old responses and
selection; this feature adds no polling or persistent browser-side history authority.
