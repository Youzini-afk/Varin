# Varin contributor guide

[docs/architecture.md](docs/architecture.md), [docs/development.md](docs/development.md) and the module
README/DOCUMENTATION files describe the system. Code, types, schemas, tests and package scripts are the
executable truth; docs explain responsibility and intent, and Git holds history. When prose and code
disagree, the code is current and the prose needs fixing.

This guide covers what changes rarely: what the system is, which boundaries actually matter, and where
costs come from. Current contracts and support limits live in the domain docs under [docs/](docs/README.md);
exact values live in code. How to get a given change done is your call.

## The system

Varin is an independent workspace and agent harness. Work happens in this repository; checkouts of other
projects beside it are read-only references.

- The Rust Agent runtime owns native conversation execution: Thread, branch, Run, request and Operation live
  in its Catalog. [External harnesses](docs/external-agents.md) keep their own loops; Varin records their
  bindings and observations in the same Catalog without inventing native Runs. The embedded Pi runtime and
  the old worker transport are retired.
- `web` is the Application Host and the only backend. Electron embeds it and adds the native shell; mobile
  and remote clients connect to it. `application-client` holds framework-neutral APIs and DTOs; `ui` holds
  React, projections, the Document Registry and editor groups.
- Rust also owns storage, files, materialization, processes and compute. KnowledgeStore is a separate domain.
  Each piece of state has one writer; a second TS writer or fallback authority would split the truth.
- DocumentsAPI carries text content, FilesAPI browsing/binary/CRUD, WorkspaceAPI project/tree/Git/upload.
  Shell selection, work focus, source identity, execution placement and navigation project are independent
  concepts that are easy to conflate; [resources](docs/resources.md) describes what each currently supports.
- Trust differs by source. Renderers, remote clients, extensions, model tool arguments, project content and
  network responses are untrusted to varying degrees. The Host and the Rust kernel are one trusted build
  talking over an authenticated private channel whose types are generated from
  [the kernel protocol schema](kernel/protocol/schema.json).

## Boundaries that matter

- **Security.** Privileged work stays in trusted owners, never in renderers. Untrusted input is checked where
  it enters. Holding someone else's Thread or Run ID is not authority to act on it. Credentials, prompt
  bodies, bearer/pairing data and file contents stay out of logs.
- **User data.** Workspaces, Git, conversation history and external config are the user's assets. Storage
  owners upgrade older formats in place, committing converted records together with the format marker,
  and leave unknown or newer stores untouched. A crash may lose the last commits; it should not corrupt
  data or leave a reference to content that was never written. A prepared candidate becomes visible only
  when it commits; a failed or superseded preparation leaves the previous valid generation in place.
- **Execution.** A cancel request, an observer going away and an executor actually stopping are different
  events. Resources stay owned until really released, and an effect with unknown outcome is not replayed
  automatically, since that could repeat something the user did not ask for twice.
- **Capabilities.** Moving code between owners should not quietly drop provider/auth, remote/pairing/relay,
  allowed-directory, audit, queue or platform behavior. LICENSE and THIRD_PARTY_NOTICES obligations stand
  regardless of doc cleanup.

## Costs and tendencies

What users experience (streaming, responsiveness, correctness, consistency across devices, recovery after a
disconnect) is the measure of a change. The rest is engineering judgment.

Some costs in this system are easy to underestimate. A Host-to-Rust call is a cross-process round trip.
File locks, fsync and rewrites cost milliseconds, more on Windows. A single SQLite connection or actor
thread serializes everything behind it. An event that fans out to many observers multiplies whatever each
observer does in response.

Defensive layers tend to accumulate: the same value validated at several layers, authorization that reads
files on every request, generic scans of request bodies, observers that refetch everything whenever
anything changes. Each looks harmless alone, and together they make a system slow without making it safer.
A check that protects against no real input or failure is usually better deleted than kept; a check at a
real trust boundary is worth keeping. Hard limits likewise need a concrete protocol, platform, safety or
resource reason; defaults, warnings and budgets are often the better tool.
[docs/performance.md](docs/performance.md) has more on costs and how to measure them.

## Working here

- Main engineering docs are in Chinese; source-adjacent docs keep their existing language. Docs describe the
  current system and age at different speeds: this guide rarely changes, domain and module docs change with
  their features, and numbers, method lists and constants are best linked to the code rather than copied.
  The doc nearest the changed code is the natural one to update in the same change. Finished design plans
  fold into the domain docs and are deleted. Parallel bilingual copies, permanent cleanup logs and doc
  governance add weight without value.
- Name modules and APIs after their responsibility, not after the migration that produced them.
- Pick verification that could actually change your conclusion, and report what ran and what did not.
  Tests are most useful when they observe product behavior, not source text or DTOs built inside the test.
- Leave unrelated user edits alone and avoid destructive Git operations. Commit and push when authorized;
  publishing, deployment and credential changes need their own explicit authority.
