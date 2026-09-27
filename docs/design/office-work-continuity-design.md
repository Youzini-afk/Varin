# Varin 办公与日常工作连续性设计

Status: accepted design / not implemented

Last updated: 2026-09-24

This document defines the product direction for the future office and daily-work
profile. It is a design boundary, not a delivery claim. Current implementation
status remains in [status.md](../status.md), and the
shared workbench contract remains in [architecture.md](../architecture.md) and
[composable-workbench.md](composable-workbench.md).

## 1. Product thesis

Varin should not become another mail client, calendar, document editor, or
project-management database. Those products already own their respective
systems of record. Varin's opportunity is to keep one piece of work coherent
while its materials, decisions, deliverables, actions, and waiting conditions
move through several systems.

The product unit is therefore **a piece of work**, not a model response. A
piece of work may be small enough to finish in one message, or it may continue
for days across files, conversations, meetings, and external actions.

The intended chain is:

```text
capture material
  -> understand the goal and relevant evidence
  -> produce a usable, editable result
  -> review and change the result
  -> approve an external action
  -> verify what actually happened
  -> wait for the next reliable event and continue
```

The first product claim to test is:

> Varin can reduce material moving, repeated explanation, result repair, and
> lost follow-up for a person who moves between coding, research, and ordinary
> knowledge work.

This is a hypothesis. It is not a proven moat, and no efficiency claim should
be made before real task comparison.

## 2. What the market establishes and what it leaves open

The current product landscape already covers most isolated AI features:

| Product family | Established pattern | Design consequence for Varin |
| --- | --- | --- |
| Microsoft 365 Copilot and Google Workspace Gemini | The assistant can work inside mail, documents, calendars, chats, and meetings; newer flows can create or change artifacts and schedule actions. | A generic “agent that calls office tools” is not a sufficient position. The source system, execution location, approval, and result verification must be visible. |
| Notion AI and Atlassian Rovo | A workspace can combine documents, tasks, knowledge, connected-app search, and agents. | A database of pages and tasks is not the missing idea. Varin should keep existing file and Thread authorities and present a projection over them. |
| Shortwave and Superhuman | Email-native assistants triage, search, draft, schedule, and remind in the inbox context. | Mail is one source of commitments, not the universal work model. |
| Motion and Reclaim | Tasks, routines, focus time, and meetings can be placed on a changing calendar; preview-before-apply is a useful interaction. | Scheduling should be a proposed allocation of time, with hard events separated from flexible work. It should not silently rewrite a user's day. |
| Granola and Notion Meeting Notes | Meeting capture can be private, transparent, and detached from a bot or long-lived audio recording. | Meeting notes matter only when confirmed decisions and follow-ups enter the same work chain. |
| Zapier Agents and similar automation platforms | Broad connectors and configurable actions make cross-app execution possible. | Connectors are an execution surface, not the product model. The system still needs identity, approval, idempotency, receipts, and recovery. |

Official references used for this comparison include [Microsoft Copilot
Cowork](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/),
[Google Workspace Studio](https://workspace.google.com/studio/), [Notion
AI](https://www.notion.com/help/notion-ai-faqs), [Rovo](https://support.atlassian.com/rovo/docs/what-is-rovo/),
[Reclaim 2.0](https://help.reclaim.ai/en/articles/14846468-reclaim-2-0-overview),
[Granola security](https://www.granola.ai/security), and [Zapier
Agents](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents).

The comparison gives Varin four useful negative requirements:

1. Do not make the user select an Agent type before a simple request can be
   completed.
2. Do not turn every capture into a task or every conversation into a project.
3. Do not treat a generated draft, an accepted action, and an externally
   confirmed result as the same state.
4. Do not copy external sources into a second opaque database merely to make
   search convenient.

## 3. First-principles model

### 3.1 The scarce resources

Daily work is constrained by four resources:

- **attention**: what the user must decide or review now;
- **time**: hard appointments, flexible work windows, and waiting periods;
- **working memory**: the facts and choices that must survive across days;
- **commitment**: promises made to the user or to another person.

The product is valuable when it protects these resources. A longer answer,
more automation, or more background agents is not automatically an improvement.

For any feature, use this test:

```text
net value
= saved execution effort
  - material preparation
  - review and repair
  - interruptions and supervision
  - cost of an incorrect external action
```

### 3.2 A work item is a graph of facts, not a giant prompt

The useful identity of a piece of work consists of linked facts:

```text
goal
  ├─ authorized materials and their revisions
  ├─ decisions and unresolved questions
  ├─ deliverables and their revisions
  ├─ proposed or completed actions
  ├─ waiting conditions and observations
  └─ Thread / Run / workspace references
```

The model may interpret these facts and propose changes. It must not become the
fact authority. Files, Thread/Run state, receipts, artifacts, external
connector records, and the Rust kernel remain authoritative in their existing
domains.

### 3.3 Execution state and work state are orthogonal

Do not collapse all progress into one `status` field. At minimum, the product
must distinguish:

| Axis | Example states | Meaning |
| --- | --- | --- |
| Agent execution | queued, running, settled, failed, cancelled | What the current Run actually did |
| Deliverable | absent, draft, under review, accepted, published | Whether a usable result exists and who accepted it |
| External action | proposed, approved, submitted, confirmed, unknown, failed | What is known about an action outside Varin |
| Waiting | none, waiting, triggered, unavailable | Whether a future event can resume the work |

“The model stopped” is therefore never sufficient to show “the matter is
done”. A mail draft is not a sent message; a `202 Accepted` API response is not
proof that a recipient received the message; a generated spreadsheet is not
proof that formulas recalculate correctly.

### 3.4 The human controls commitment and irreversible effects

The Agent should gather, explain, draft, compare, and prepare. The user should
decide the commitments that carry external consequences.

Actions can use three practical levels:

1. **Private and reversible**: create a draft, add a private note, group
   materials, or prepare a local reminder. These can become automatically
   applicable after the user enables the relevant preference.
2. **Shared but reversible**: edit a shared document, create a calendar hold,
   or change a label. Show the exact patch and affected object before apply.
3. **External or consequential**: send mail, invite people, publish a file,
   delete data, submit a form, or spend money. Require approval bound to the
   account, recipients, payload, attachments, and source revisions.

Approval is not the end of the lifecycle. The system must record the request,
the service acknowledgement, the observed external state, and any uncertainty.
After a timeout it must reconcile before retrying; it must not blindly send the
same action again.

## 4. The “正在办” concept

The user-facing concept can be called **正在办**. The internal design name is
`Matter` only as a discussion term; the name is not yet a protocol commitment.

It is a lightweight continuity projection over existing authorities, not a new
project manager and not a second execution runtime.

A Matter view may contain:

- a short goal and the user's current wording;
- linked Thread and Run identities;
- authorized material and source references;
- current deliverables and revisions;
- decisions made and decisions still needed;
- next actions and waiting definitions;
- current execution, deliverable, external-action, and waiting states;
- freshness and unavailable-source information.

The first implementation should derive as much as possible from existing
Thread/Run, Knowledge, material, Artifact, WorkingState, and follow-up records.
Only metadata that cannot be reconstructed from those authorities should become
new durable state. The projection may be persisted for navigation and user
labels, but it must never duplicate file bodies, transcripts, credentials,
receipts, or execution ownership.

Simple requests must not require a Matter. “Translate this sentence”, “make a
private note”, and “remind me to bring the adapter” can finish directly. A
Matter forms when the user or Agent has a real continuing goal, a deliverable,
an unresolved decision, or a future trigger.

## 5. Product surface

The future office experience follows the existing separation between UI shell
and execution focus:

```text
[ Agent | IDE ]    [ Workbench: General | Research | Office ]
```

The Office profile, when implemented, must not change the model, permissions,
or current Run. Work focus remains an independent session setting, as already
defined for Research. The same Matter can be opened from Agent, IDE, Research,
or Office surfaces.

The first desktop surface should expose four projections of the same facts:

### Today

Shows what needs attention, what is close to a deadline, what changed while
the user was away, and what is waiting for a decision. It is not a statistics
dashboard or a feed of unsolicited recommendations.

### 正在办

Shows Matters with goal, current deliverable, blocking item, and next action.
Thread topology, tool logs, and worker details remain available on demand.

### 资料

Shows authorized source collections and their revisions. Materials remain in
their original authority: local files, PDF snapshots, web sources, experiment
artifacts, and future connectors are references, not silently copied bodies.

### 成果

Shows deliverables that can be opened, edited, exported, validated, and
reopened. Each result displays its source set, revision, validation state, and
whether it is still a draft or has been accepted.

On mobile, the first-class operations are capture, inspect, decide, and
continue. It should not be a compressed copy of the desktop three-column
layout.

## 6. First vertical slice: materials to a reliable deliverable

The first complete office slice should be:

> Multiple materials → a traceable comparison table and recommendation → local
> edits → save and reopen → continue from the same evidence.

Example input:

> Compare these supplier proposals. Keep tax-inclusive cost separate from risk,
> make a comparison table and a two-page recommendation, and mark missing
> information instead of guessing.

The experience is:

1. **Capture and bind materials.** Store the actual files or snapshots, their
   identity, revision, access scope, and content type. Do not ask the user to
   create a project before reading them.
2. **Clarify only decision-changing ambiguity.** Ask whether prices include tax
   or whether two currencies should be normalized, rather than presenting a
   generic questionnaire.
3. **Read and compare.** Reuse PDF/page/region citations, web snapshots,
   structured tables, and existing retrieval. Unknown or conflicting fields
   remain explicit.
4. **Produce an editable result.** The comparison table and recommendation are
   artifacts with source links and revisions, not only a chat paragraph.
5. **Validate.** Check arithmetic, units, dates, required sections, source
   locations, file opening, and export integrity. Human judgment remains
   necessary for trade-offs and tone.
6. **Support local changes.** “Make this section more conservative” should
   produce a local change proposal. It must not regenerate the whole artifact
   and erase accepted edits.
7. **Reopen and continue.** Reopening after a day must recover the current
   deliverable, source revisions, unresolved questions, and next action without
   replaying the entire conversation.

The acceptance bar is the second and third edit, not the first attractive
draft. An external file changed outside Varin must be detected and reconciled;
Varin must not overwrite it based on an old generation.

## 7. File and artifact boundary

PDF reading is now a reusable source and visual-reading capability. Office
formats need adapters; they must not be treated as arbitrary text buffers.

An adapter should eventually expose four independent operations:

| Operation | Purpose |
| --- | --- |
| Inspect | Read structure, metadata, formulas, styles, relationships, and source locations |
| Propose patch | Describe a local, reviewable change against a known revision |
| Render/preview | Produce a visual or native preview for user review |
| Validate/export | Check that the resulting file opens, preserves required structure, and can be delivered |

DOCX, XLSX, and PPTX are different products hidden behind one file extension
family:

- DOCX needs paragraphs, styles, tables, comments, tracked changes, and stable
  local edits.
- XLSX needs formulas, references, number formats, recalculation, and cell
  provenance. A generated value cannot silently replace a formula.
- PPTX needs slide structure, theme/layout inheritance, speaker notes, and
  visual rendering. A syntactically valid package can still be unusable.

The existing DocumentsAPI remains the text-content authority. Binary package
editing, WorkspaceAPI upload, editor previews, and Rust object/file revisions
must use their existing owners. No Office editor may become a second save or
dirty-state authority.

## 8. Model and runtime roles

The office profile should consume the existing Harness rather than introduce an
office-specific loop:

| Role | Responsibility |
| --- | --- |
| Fast Decision Model | Classify a capture, identify likely work type, select a small set of next actions, and flag ambiguity. It is a proposal mechanism, not a mandatory output schema for every turn. |
| Retrieval and material readers | Find authorized evidence and preserve source/revision/location identity. |
| Main model | Compare, reason, draft, revise, and explain trade-offs. |
| Deterministic validators | Check arithmetic, dates, file structure, citations, required fields, and external response state. |
| Host and Rust kernel | Own paths, files, revisions, records, processes, credentials, permissions, and durable lifecycle. |
| Follow-up/scheduler | Observe reliable events and deliver a continuation only when the definition says it should. |

Background work must not call a model merely because a conversation changed. A
model runs when the user asks, when a confirmed workflow reaches a model step,
or when a real event delivers a continuation that requires interpretation.

The Agent can return an ordinary explanation. Typed records are required only
when a real action, durable wait, external approval, or Host validation needs
one. This keeps the interaction natural without losing durable authority.

## 9. External connector strategy

Mail, calendar, chat, meeting, and cloud-drive connectors should enter through
the existing capability and permission boundary. They must not create an
Office-only trust model.

Every connector needs separate contracts for:

1. account and tenant identity;
2. read scope and source freshness;
3. draft or private mutation;
4. shared/external action;
5. receipt and result reconciliation;
6. revocation, token expiry, and unavailable state.

The first connector should be selected from observed user work, not API
convenience. One ecosystem should be completed end to end before three
ecosystems receive shallow search-only integrations. A complete loop means
read → draft → approve → execute → reconcile → follow up.

Calendar must distinguish hard events, flexible work blocks, routines, buffers,
and proposed changes. A planner may show a preview and explain trade-offs; it
must not silently move another person's meeting or imply free/busy knowledge
when the account is unavailable.

Meeting capture must be explicit and transparent. Raw audio retention,
transcription provider, participant notice, note visibility, and retention are
separate settings. Confirmed action items can enter a Matter; an unconfirmed
model summary cannot silently create commitments for other people.

## 10. Authority and failure rules

The following rules are product invariants:

- A source revision is not a current fact after its freshness or authorization
  expires.
- Read access does not grant external-send access.
- A generated file is not an accepted deliverable.
- A service acknowledgement is not an externally confirmed result.
- A timeout is not proof of failure; reconcile before retrying.
- A failed optional connector does not erase local material or create a blank
  successful state.
- A late model result cannot overwrite a newer user edit or a newer source
  revision.
- A new Run may rebuild context, but it cannot delete the Matter's prior
  accepted deliverables or evidence.
- A user changing the Workbench does not change the current Run, model, scope,
  or permissions.

## 11. Delivery stages

The office stage should be delivered as complete user outcomes rather than a
catalog of unconnected tools.

| Stage | Outcome | Gate |
| --- | --- | --- |
| O0: task research and prototype | Validate two or three real knowledge-work journeys and choose the first file/ecosystem focus | Compare current manual work, a competitor, and a Varin prototype; record preparation, repair, and resume costs |
| O1: file knowledge-work loop | Materials, editable deliverables, citations, local edits, save/reopen, and revision conflict handling | A second and third edit preserve accepted changes; final files open and validate |
| O2: work continuity | Today, 正在办, 资料, 成果, capture, reminders, and cross-day continuation | A user can resume without repeating the full context; waiting and unavailable states remain truthful |
| O3: one external ecosystem | Read, draft, approve, execute, reconcile, and follow up for one mail/calendar/meeting ecosystem | Wrong account, stale data, timeout, duplicate action, and revoked access are handled explicitly |
| O4: expansion | Additional formats, connectors, browser actions, and long-running routines | Each addition closes a measured user gap and reuses the same authority/approval contracts |

O1 should include a light capture and continuity entry so the result can be
reopened, but O2 is where those capabilities become a coherent daily surface.

## 12. Evidence and open questions

Before committing to a format or connector, collect real tasks from people who
move between development, research, product, operations, or consulting. A
useful study asks for recent work, not imagined feature wishes:

- Where were the materials and how many times were they moved or re-explained?
- What was delivered, to whom, and in which editable format?
- Which decisions could the user delegate, and which could not?
- Where did the work break when a file changed, a reply was late, or a day
  passed?
- How much time went into checking and repairing an AI result?

Compare the current manual path, the existing tools, and a Varin prototype on
the same task. The primary measure should be accepted deliverables or closed
commitments per week, with preparation time, repair time, interruptions, cost,
and incorrect-action risk recorded alongside it. Message count, tool-call
count, and number of agents are not product outcomes.

The following remain open until that evidence exists:

- whether the first high-value artifact is a report, spreadsheet, presentation,
  or a different format;
- whether the first external ecosystem is Google, Microsoft, a domestic suite,
  or no connector at all;
- how much offline/local execution matters for the first users;
- whether meeting capture is a frequent need or only an attractive demo;
- which Matter fields users actually maintain versus which should be derived;
- which private actions users are comfortable authorizing automatically.

Until these are answered, the design is accepted as a boundary and direction,
not as a promise to build every surface listed above.
