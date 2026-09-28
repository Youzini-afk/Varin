# Delivery roadmap

Status: core workbench/harness, stage Q and companion retirement delivered; AI4S execution/collaboration delivered through D-305; Stage S/W delivered through D-311; Stage B source/repository rebrand implemented at D-313; Stage F (D-312) and Stage C (D-314) wired; Stage L (D-315) in progress; Office stage O design accepted at D-327 and not implemented

Last updated: 2026-09-28

Each phase is a separately tested, committed, and pushed recovery point. This file is the delivery
ledger, not a specification: it records what shipped and what remains. The Git history is the
authoritative record of delivery, and each phase names the design document that owns its contract.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Foundation: contracts, workspaces, bounded JSONL protocol | Complete |
| 1 | Pi host: runtime discovery, SDK worker lifecycle, sessions | Complete |
| 2 | Desktop integration prototype | Superseded by Phase 4 |
| 3 | Recovery semantics prototype | Superseded by Phase 6 |
| 4 | OpenChamber fork product base | Complete |
| 5 | Direct Pi-native engine migration | Complete |
| 6 | Recovery UX and ecosystem integrations | Complete |
| 7 | Windows release | Complete |
| 8 | OpenChamber upstream capability absorption | Complete |
| 9 | Varin extension platform | Complete |
| 10 | Composable workbench, IDE Workbench, and unified editor | Complete |
| R | Rust system kernel and Host separation | Complete (D-282); delivery evidence in [harness status](status.md) |
| Q | Repository-wide testing and CI redesign | Implemented and accepted (D-292–D-295); locally verified |
| D-296 | Former VS Code companion retirement | Implemented and locally verified; AI4S follows |
| 11 | AI4S heterogeneous research cluster | 7A–7I main slices delivered at D-298/D-303/D-305 (Partial); D-300's revised 7C–7E (remote execution / resource management) not yet delivered as product code; Slurm deferred |
| S | Conversational settings and Agent administration | Complete (D-306–D-311): owner-backed catalog/actions, session-bound authenticated Surfaces, typed operations, per-owner compound updates and product Skills |
| W | Session waiting, triggers and continuation | Complete (D-307–D-311): durable source facts, ordinary-shell observation, composite/shared observation, unified delivery, recovery and calendar Agent management |
| B | Varin product-wide rebrand | Source, product assets, build/distribution configuration and GitHub repository switched (D-313); first new-brand publication pending; no old-name compatibility |
| F | Fast Decision Models and progressive retrieval | Implemented/wired (D-312): shared capability/binding, first Jev adapter and iterative `explore`; evidence and untested quality/latency in harness status |
| C | Background compaction Agent and semantic continuation | Implemented/wired (D-314): dedicated `compaction` worker process, scoped read-only history/output/record queries, S0/A/B frozen material with pagination, capacity waiting on the in-flight task and session-owned native commit |
| L | Web and scholarly search, reading and material reuse | Implemented/wired (D-315): L0–L6 all wired; evidence and boundaries in harness status |
| O | Office and daily work continuity | Design accepted (D-327); O0–O4 are planned and not implemented. The design starts with a materials-to-editable-deliverable loop and reuses existing authorities. |
| BC | Bot identity, active/background memory, Computer Use, and persistent computers | Planned, not started. [BC0–BC9](plan/bot-computer-use-plan.md) extends shared production owners; office work consumes this foundation. No separate prototype runtime. |
| HR | Task/resource Harness: workspace decoupling, resource identity, continuous retrieval | Implemented (D-337, HR0–HR5 wired): scope-owned threads/knowledge, session-cwd path anchoring, per-request multi-root scopes, resource/version-driven indexes, mutable work-context removed; per-scenario evidence in harness status |

Stage R completed the [Rust kernel design](design/rust-kernel-design.md) and R0–R6 in the
[harness implementation plan](plan/agent-harness-plan.md): protocol/runtime, working-state and recovery
storage, Documents/file operations, materialization, processes/terminals, file/structure computation,
and production/performance/release acceptance. Rust owns those system resources through one private
Application Host child; TypeScript retains product/Agent policy and the bundled Pi runtime remains the
Agent loop/provider/session authority. Current evidence and platform-specific limits are recorded only in
[harness status](status.md).

Stage Q is specified in [testing-ci-design.md](design/testing-ci-design.md), with Q0–Q3 in the
[harness implementation plan](plan/agent-harness-plan.md). It covers test value and ownership, fixtures,
portable discovery, duplicated execution/builds, platform and release checks, and actionable failures.
The goal is trustworthy feedback with less maintenance, not a target test count or green checks achieved
by hiding failures. Q is accepted and locally verified. Existing repairs and authorized releases
continue on their own applicable evidence.

Phase 11 follows D-296 and is specified in [research-cluster-design.md](design/research-cluster-design.md).
D-297 separates the research workbench's complete UIUX from Agent work focus. The workbench entry sits
alongside the existing Agent/IDE switching area and reuses the transition animation; projects supply new
conversation defaults, and conversations can override their focus without switching the shell. Navigating
projects or conversations keeps the user's chosen workbench. The later office experience uses the same
separation. Research execution builds on the existing Pi runtime, Thread/Run, Host scheduler, retrieval,
context, permissions and Rust kernel, and remains available in the IDE. The first vertical slice is an
open research question explored by heterogeneous model branches, fast execution workers and deliberate
discussion and synthesis. The 7A entry, focus and real principal-run attachment, plus the first 7B
capability-routing slice, are implemented. D-303 closes local execution, dynamic upgrades, collaboration
and research facts access; D-305 adds managed remote and multi-machine execution.
Verification boundaries are recorded in harness status.

D-300 defined shared message/source and resource facts, durable experiments and multi-machine allocation;
D-303 accepted the local slice, while D-304 moves managed remote follow-up to 7I and defers native scheduler adapters.
7E extends general Agent communication with optional reply waits and a continuously refreshed compact
roster derived from existing visible output. No mandatory research handoff schema, extra status reports
or event classifier that automatically invokes a frontier model. Operations Agents are optional and may
divide responsibility as scale grows; actual resource confirmation remains in the execution backend.
Research evaluation remains a follow-up observation, not a prerequisite to shipping complete functionality.
Implementation and delivery boundaries belong to the harness plan, research design and status.

D-301 defined **7G**, delivered at D-305. Each Agent
receives a complete current scoped roster as a transient request-tail snapshot, with stable collaboration
guidance in the system prompt. Traditional environment facts are checked before every model request
and appended to replayable history when delivered. The two use one preparation boundary but different
retention rules; old rosters do not accumulate in history or invalidate the growing history prefix.
The snapshot's input cost is included in capacity planning. This does not interrupt or retroactively
expand the task already given to the executing Agent. No cache-benefit claim is made without provider evidence.

D-302 defined **7H: general Harness tool concurrency and background command delivery**, delivered at D-305.
It replaces whole-batch serialization with resource/dependency coordination, makes long commands
yield a usable execution handle promptly, and extends output retrieval with cancellable event waits.
Completion facts join 7G's environment deltas; logs stay available on demand. Explicit waits or chosen
continuations can resume an idle Agent, while ordinary output growth cannot. Shared shell state,
permission checks and actual process/writer release remain authoritative. RPC observation and process lifetime
are now separate, removing the former 30-second bridge versus 60-second shell-yield mismatch;
ordinary shell execution does not acquire the durable recovery guarantees of research experiments.

D-304 adds **7I after 7G and 7H**: managed remote execution, multi-machine resource confirmation,
code/data/environment reuse and convenient operations on several existing experiments. Research branches
and experiments grow through ordinary discussion and execution; there is no required matrix object,
parameter grid, search language or research workflow. Existing connections and Rust execution services
provide the remote worksite, with explicit coordinator location and continued supervision of accepted jobs.
Operations work can stay with current threads at small scale or be divided among several ordinary threads
responsible for machine groups, environments or data. They use existing tools, messages and current-state
context, without a mandatory hierarchy or model call for every sample. Slurm and other native cluster
adapters are deferred until there is an actual deployment need. The managed-remote production slice shipped at D-305.

Stage S follows the D-305 delivery and is specified in [agent-settings-design.md](design/agent-settings-design.md).
It makes the settings UI and conversation two clients of the same owner-backed configuration services,
covering the existing main settings categories and related management actions. Stable query/update tools
provide live values, supported scopes, effective state and on-demand details; Skills teach compound uses.
The implementation sequence is coverage/shared definitions, discovery, mutation/action adapters,
UI/runtime synchronization, and Skill/coverage closure. Existing APIs alone do not satisfy this stage;
saved versus applied state, concurrent edits and local-client versus remote-Host identity remain explicit.
See [plan S0–S4](plan/agent-harness-plan.md#阶段-s对话式设置与-agent-管理d-306); current production delivery and remaining boundaries are recorded in harness status.

Stage W follows S and is specified in [agent-follow-up-design.md](design/agent-follow-up-design.md).
Agents naturally register what to wait for and what to do afterwards. Time, authoritative events and
deterministic checks handle observation without idle model polling; explicit waiting also suppresses
Goal auto-continuation. Active/idle targets reuse existing context delivery and session/Thread admission,
with durable trigger identity, cancellation and recovery. Calendar tasks still support new work, while
their results must follow actual execution rather than merely dispatch acceptance. See
[plan W0–W4](plan/agent-harness-plan.md#阶段-w会话等待触发与续接d-307); harness status separates the delivered durable source/continuation slice from ordinary-shell durability, composite/shared observation and remaining recovery limits.

Stage B follows S/W and is specified in [varin-rebrand-design.md](design/varin-rebrand-design.md).
B0–B4 cover the naming map, package/runtime/storage cutover, product identity and assets, distribution/docs,
and focused closure. The new brand is Varin; there are no existing-user compatibility requirements, so
old aliases, fallback paths, dual writes and migration helpers are excluded. Actual Pi dependencies,
developer assets and historical attribution remain intact. The repository is now `Youzini-afk/Varin`;
new npm packages and release assets have not been published. Source/build/startup evidence and these
distribution boundaries are recorded in harness status. Stages F and C are delivered; Stage L is the next implementation stage.

Stage F follows B and is specified in [fast-decision-model-design.md](design/fast-decision-model-design.md).
F0–F4 cover capability/configuration, provider inference, source selection, dynamic exploration actions and
delivery closure. Fast Decision Model is the shared product category; Jev is the first adapter target.
The existing explore query keeps its scope, source identity and execution authority. Fast decisions assess
what to return and what to investigate next; generative models still supply new search expressions when needed.
Future Computer Use and other consumers can reuse the capability, but are outside this implementation phase.
F0–F4 are delivered and wired for the `explore` consumer; real paid-provider calls, cross-platform checks,
and retrieval-quality evidence are recorded as untested in harness status.

Stage C follows F and is specified in [context-compaction-agent-design.md](design/context-compaction-agent-design.md).
C0–C4 are delivered and wired: the broker spawns a dedicated `compaction` pi-host worker pinned to the parent
session; frozen S0/A/B material ships verbatim retained text with an explicit elision notice when paginated;
the worker runs a real Agent loop with scoped read-only queries over history, outputs and records; capacity-bound
requests wait on the same in-flight task; commit stays session-owned through the native Pi compaction writer.
Paid-model quality and full platform observations are recorded as untested in harness status.

Stage L follows C and is specified in [web-research-search-design.md](design/web-research-search-design.md).
L0–L1 improve the existing generic retrieval report, capability discovery, Web search and fixed source reading;
L2–L3 add scholarly identities/relations, scoped passage retrieval and structured reading; L4–L6 connect
shared materials, existing Thread communication, Web/scholarly fast-decision consumers and product surfaces.
The generic `retrieval` preset already supports local and Web fact finding; research `investigation` and
ordinary dispatch also exist. Stage L extends these rather than adding another Agent runtime. Its proposed
natural-language report path makes `submit_facts` optional while preserving Host source checks and Run-bound
receipt authority. Search is available independently of workbench selection. All L slices remain planned;
model training and global literature indexing are outside this stage.

Phases 2 and 3 are retained as prototype provenance. Their acceptance evidence informed the
retained contracts, but their implementations were deliberately removed rather than maintained in
parallel; do not treat them as live design authority.

## 历史阶段明细

Phase 0–10、Stage Q、D-296 与 agent-harness Phase 2/3/3b 的逐段交付叙述已归档至
[archive/roadmap-history.md](archive/roadmap-history.md)，不再更新；与上表冲突时以本表为准。
