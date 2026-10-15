# Varin contributor guide

Start with [docs/architecture.md](docs/architecture.md), [docs/development.md](docs/development.md)
and the nearest module README/DOCUMENTATION. Code, types, schemas, tests and package scripts define
executable behavior; docs explain responsibility and intent. Git retains historical designs and delivery
records. Correct stale prose rather than appending another contradictory update.

Keep long-lived docs focused on the current system, its constraints and non-obvious rationale. Active
designs and plans may remain while work is underway; distinguish proposals from implemented behavior.
When they have served their purpose, fold useful rationale into current docs and remove the process
documents. Git preserves their history.

## Product and ownership

- Varin is an independent workspace and harness originating from the maintainer's OpenChamber fork.
  All changes happen in this repository; external OpenChamber checkouts remain read-only.
- The Rust Agent runtime is the conversation execution owner, using native Thread/branch identities
  and Catalog. Pi runtime packages, worker transport and product adapters are retired. Do not reintroduce
  a parallel conversation owner or automatically migrate user assets.
- Preserve existing provider/auth, remote/pairing/relay, allowed-directory, external-access audit,
  session/history/queue and platform capabilities when changing their owner. Preserve LICENSE and
  THIRD_PARTY_NOTICES obligations independently of documentation cleanup.
- `application-client` owns framework-neutral RuntimeAPIs/DTOs/failures; `ui` owns React, projections,
  Document Registry and editor groups. Privileged work belongs to trusted owners, never renderers.
- `web` owns the Application Host. Electron embeds it and adds the native shell; mobile connects to it.
  Do not introduce a second Electron backend. Runtime, protocol and extension packages retain their
  named process/contract boundaries in [architecture](docs/architecture.md).
- Rust is the production authority for transferred storage, file, materialization, process and compute
  resources. The Agent Catalog additionally owns native execution. No parallel TS writer or fallback
  authority may be reintroduced. KnowledgeStore retains its separate documented domain.

## Invariants

- Workbench shell selection and work focus are independent. Presentation does not own runtime identity,
  documents, terminals or durable execution. Publish a prepared candidate only at its actual commit boundary.
- DocumentsAPI is the text-content path; FilesAPI is browse/binary/CRUD; WorkspaceAPI is project/tree/Git/upload.
  Desktop/Web use the shared Monaco path; mobile/embedded CodeMirror adapters share the same content/save owner.
- Source identity, execution placement and navigation project are distinct. FixedBranch currently has no
  writable/MCP execution cwd; ManagedSources do not imply arbitrary multi-parent automatic merging.
  These are current support boundaries, not speculative permanent restrictions.
- Cancellation intent, effect outcome and actual executor stop are different. HTTP abort or rejected
  observation does not release original readers, writers, assignments or source cleanup responsibility.
- Missing, empty, invalid, stale, unavailable, failed, conflicting and unknown states stay distinct.
  Failed or superseded preparation leaves the previous valid generation authoritative.
- There is no compatibility requirement for obsolete internal formats. Reject unsupported/malformed stores
  without overwriting assets; do not add automatic internal-format upgrade/import paths. Current-format
  durability/recovery still applies. Workspace files, Git, historical conversation data and external config remain assets.
- Do not invent hard limits without a concrete protocol/platform/safety/data/resource reason. Defaults,
  warnings, budgets and hard rejection are different contracts.
- Keep filesystem, network, credential, shell and process behavior in the proper trusted owner. Validate
  process/network input. Never log credentials, prompt bodies, bearer/pairing data or file contents.

## Changes and verification

Inspect the implementation, actual consumers and focused tests before changing behavior. Use the nearest
package.json for commands. Select checks by the failure class: local behavior, shared consumers, native
resources, target packaging or actual performance. Do not repeat broad checks that cannot change the decision.

Tests should exercise product behavior, not source text, CSS classes, enum copies or DTOs constructed in the
test itself. New tests are not mandatory for every prose/presentation/type edit. Remove obsolete/redundant
checks without one-for-one replacement. Installed-product smoke stays focused on working startup/capabilities;
detailed failure combinations belong with their owner.

Name modules and APIs for responsibility, not migration labels. Keep current main engineering docs in Chinese
and existing source-adjacent/package documentation in its established language. Do not create a parallel
bilingual copy, permanent cleanup log, complex documentation governance or project-local workflow Skill.

Preserve unrelated user edits and avoid destructive Git operations. Keep coherent phases reviewable, commit
and push authorized completed work, and report exactly what did and did not run. Publication, deployment,
and credential changes need their own authority.
