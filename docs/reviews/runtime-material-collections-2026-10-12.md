# Native material collections and explicit sharing: scoped acceptance

Date: 2026-10-12. Baseline: `6a633321322aab9cfa8ce9aab52da5b0b9991c9f`.
The production default remains Pi. Catalog 54, Storage 13 and kernel wire 9 are unchanged.
This accepts the ordinary collection/share adapter and original mutation lifecycle, not either complete
runtime design, a default cutover, or new collection UI/public write APIs.

## Ownership and implemented behavior

- The installed ordinary `materials` declaration supplies schema, manifest, decoder and static effect
  contract. The actual invocation supplies Catalog Thread/family and `thread-materials:<rootThreadId>`;
  arguments do not supply an actor or storage workspace. Original per-call permission and accepted Web
  settings still apply. URL members use the original fetch owner without another selected-tool grant.
- `material-collections.ts` is the same explicit domain for native calls and the thin Pi session adapter.
  Private collections, persisted namespace-readable collections and explicit family shares retain their
  original meanings. Writes remain owner-only. A readable recipient can explicitly share again;
  original grant envelopes identify their actual sender, without a recursive grant authority.
- Material ACL interpretation stays in the trusted original material owner. Its private exact-namespace
  Storage grants have no path, process or admin authority. Read grants use read/maintenance; write
  entrances additionally receive write. These clients/grants never reach tools or renderers. Storage
  continues to own record/blob identity and reference integrity rather than duplicating material ACLs.
- Collection and grant references keep both readable body and PDF source. Original sender deletion
  releases that sender's grants, while another live grant can retain the referenced collection and later
  members. Original workspace reconciliation releases orphaned retained records after their last grant.
  Run/Goal completion is not Thread deletion; no new native Thread-delete entrance is implied.
- Network/body/search work is outside the short workspace mutation serializer. Original record CAS and
  deterministic Storage operation identity decide publication. Short invocation/input/member metadata
  supports projection of the immutable operation result; there is no second mutation journal.
- Before publication, cancellation can prevent a mutation. Once an atomic write starts, its original
  result decides the effect. Unknown does not imply a stopped Storage writer. Cleanup errors are
  diagnosed without replacing a confirmed result. Reconciliation reads only original terminal Storage
  receipts, then uses the existing private LateReceipt/ACK, original execution owner and fingerprint.
  It does not fetch URLs again, repeat writes, register an old lease or require today's enabled builtin.

## Confirmed failures repaired

1. Persisted PDF collections kept the empty readable body but lost the source snapshot during original
   cleanup. Body/source references now preserve the actual source; an unrelated PDF with the same empty
   body is not accidentally retained.
2. A → B → C re-sharing returned success while C could not read. The original material owner now accepts
   the already-authorized explicit sender fact. Live downstream grants also retain original collections
   across the first sender's cleanup; no ancestor-chain permission system was added.
3. Collection search collapsed Storage/read errors into successful empty hits. Only actual unavailable
   members are unreadable; infrastructure/corrupt-body failures propagate.
4. URL addition held the workspace serializer across fetching and published after cancellation. Fetching
   now precedes short CAS publication; held-fetch cancellation and concurrent unrelated reads were
   independently reproduced and rechecked.
5. A paper member could attach an unreadable guessed snapshot ID and make it readable through a persisted
   collection. Every final attached snapshot now passes the same original material read proof, regardless
   of member kind. Legitimate paper metadata and previously readable snapshots remain supported.
6. The native URL adapter projected requested URL as final URL after a same-host redirect. It now preserves
   the actual fetch owner's final URL; the independent original redirect probe passes unchanged.
7. A real failed Storage CAS rolled back `operation_owners`, then persisted a failed operation without its
   workspace owner. Even its original grant could not read that no-effect receipt. The same authorized
   workspace is now recorded when rebuilding the failed transaction. Actual same-scope receipt reads
   succeed; foreign-scope reads remain denied. No ACL/table/schema relaxation was introduced.

## Evidence and limits

The no-listener Rust composition uses actual Catalog/RunSupervisor, child admission, installed builtin,
ToolBridge, original PermissionService, original Storage and Host material/PDF owners. It observes:

- Ordinary model mutations and a Policy ToolGraph mutation; a real source-less child Run reads, re-shares
  and is denied modification of its parent's collection. Family membership alone does not allow private
  reading, while an explicit share or persisted collection does. A foreign family remains unavailable.
- Actual application-client → authentication route → original reader uses the recipient's own identity.
  Parent cleanup and Storage GC retain the shared/persisted original PDF text and PNG; an uncollected
  source is unavailable. Catalog content collection also completes.
- After a real `record.put` commits, only its reply is dropped. The original default policy fails on
  Unknown rather than continuing. The Host child process is killed and Catalog/Storage are closed and
  reopened. A new reader-only Host reconciles the original receipt without activating a builtin or old
  lease. The Operation becomes confirmed, another pass leaves its revision unchanged, the collection
  exists once, and already-delivered Unknown history is exactly unchanged.

This is a Host OS-process restart plus Rust owner reopen, not a Rust OS-process crash test. The child
search uses a PDF source snapshot with empty readable text: it proves the original read/authorization
path, not a nonempty PDF keyword hit. Independent original Pi/raw-text probes separately produce hits.

Independent probes were defined from the designs before implementation. They reran the original four
failures, paper/snapshot authorization, live-grant cleanup/reconcile, held commit/cleanup, immutable
operation receipt recovery, redirect and the actual Pi tool → bridge → domain → source projection.
Fourteen production/consumer source hashes were unchanged across final probe execution. The reviewer
also inspected the real Rust composition and accepted this finite scope without remaining blockers.

The focused Host set passed 63 tests; the redirect repair reran its affected 10-test subset. These are
not additive coverage counts. Full Host test types and changed-source lint passed. The previous actual
Web composition and all three PDF source modes passed again after shared-grant/helper changes.
Fresh debug kernel (build identity 0.9.25, wire 9), Host/CLI/Web/PWA builds passed; cloud-layout 12
and production-boundary 7 checks passed. The staged kernel SHA-256 is
`0b45d59f2d0445221eb80dde7fc6062140f71b3641a25c4aab2a6445a4c23e08`. No product socket transport,
external website/account, paid model, real desktop, OCR/font quality or platform performance is claimed.
PDF.js still reports the known standard-font asset warning in this controlled environment.

There is no native collection browser, direct collection-member button or public mutation API here.
The actual material result's snapshot selector reaches the existing public reader. A subsequent
`document_read` produces the real PDF projection recognized by the existing Thread PDF button; the UI
must not guess that every URL, paper or arbitrary snapshot is a PDF. Original Pi source projection was
separately retained and exercised.

## Reproduction

From the repository root with the pinned toolchain and installed dependencies:

```sh
bun run --cwd packages/extension-builtins build
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel \
  material_collection_review::family_collections_share_retain_and_recover_through_original_owners -- --ignored --nocapture
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel web_domain_review:: -- --ignored --nocapture
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel pdf_source_review:: -- --ignored --nocapture
node node_modules/typescript/bin/tsc --noEmit -p packages/web/tsconfig.application-host.tests.json
```

The ignored fixtures explicitly opt into Node subprocess stdio and the built ordinary extension. They
use `node --import tsx`; they do not start the product listener. Focused Host tests are the collection,
retrieval-artifacts, web-materials, material-receipts/storage/tool-owner, ToolBridge, web-runtime and
thread-materials tests under `packages/web/application-host/lib`.

Scholarly/decision services and remaining environment/Bot, source/retrieval/context/provider capabilities
continue under the two designs. Final user acceptance and default-runtime/Pi/asset migration remain
separate from this implementation slice.
