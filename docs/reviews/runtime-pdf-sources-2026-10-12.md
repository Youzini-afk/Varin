# Native PDF source ingestion: scoped acceptance

Date: 2026-10-12. Baseline: `aaba6c39d2849a28b937cf96ed9d330c85d19212`.
The production default remains Pi. This phase connects original local/Experiment PDF sources and the
native Research reader; it is not complete acceptance of either runtime design or a default cutover.
Catalog 54, kernel wire 9 and the existing material format are unchanged.

## Implemented ownership

- The ordinary installed Web declaration admits one snapshot, local path or Experiment artifact.
  `document_read` is the selected and permission-approved tool; another `file_read` or
  `experiment_artifact` tool need not be selected. No duplicate grant/tool list was introduced.
- `document-sources.ts` reuses the original accepted Run source and source grant. A fixed branch reads
  the exact revision; a live root is validated by its Documents owner; a materialized Run reads its
  current managed work copy rather than the initial branch. Original capture/path semantics remain:
  no leaf-symlink follow, no naked Host filesystem fallback, no implicit rematerialization.
- Capture blobs and source grants remain held until original reads actually settle. Source and
  material bytes page through the original immutable blob owner. The frame budget is not a PDF-size
  restriction. Reference-only PDF checks use zero body bytes but retain record/reference authorization.
- Artifact tool reads use the original Catalog Operation/research scope and ExperimentService.
  Public `ThreadsAPI.materials.readArtifact` carries the explicit retained source Run. Both ingest
  under the actual reading Thread, not the artifact creator's material authority. Family artifact
  access does not grant access to that family's unrelated material snapshots.
- Native Research's actual ArtifactRow opens the shared PDF reader, then uses the returned snapshot.
  Region questions reuse the original Thread composer callback with Thread/Host/source-selection
  lifetime checks. Pi keeps its original adapter and authorization. No second draft or material store.

The original research contract still requires a source Run: source-less artifact selection is explicitly
unavailable. This phase does not open arbitrary local paths through the public user API; there is no
native Workbench source selector consumer for such an API yet. These are delivery boundaries, not
silent fallback or a fabricated source.

## Confirmed failures and repairs

1. A legitimate PDF larger than 12,581,888 bytes passed new source paging and committed, then failed
   its first overview because WebMaterialStore reread the source without a range. Independent
   reproduction used a 13,632,171-byte binary PDF and the real Host reader chain. The original material
   owner now pages both body and source using the same record/slot proof. The unchanged probe reaches
   actual PDF.js overview and text; the lead's actual Rust Storage composition also reads a 13 MiB PDF.
2. Research's new PDF entry omitted the existing region-to-draft action, permanently disabling
   “Ask about selection.” It now forwards the existing guarded ThreadMaterials callback. Actual
   ArtifactRow pointer selection appends a citation and PNG to the original composer and submits with
   the correct Thread identity; late responses after Thread/Host replacement do not write either draft.
   This full consumer also exposed Research/Followups sibling key collisions; only Research's key was
   given its own prefix.

A suggested transport-disconnect concern was traced through original epoch fencing, Storage's
exclusive lock and Kernel worker joins and was not confirmed. No speculative error-code classification,
second settlement flag or transport workaround was added. Integration setup failures were fixture
mistakes (capture scopes, record attribution/schema, file permission mode, snapshot request framing
and materialization worker dispatch); production checks were not weakened to make them pass.

## Verified behavior

- Actual Rust Catalog/RunSupervisor → installed builtin/ToolBridge → original per-call PermissionService
  → original source/Storage → shared PDF/material owners. Only `document_read` is selected. Model calls
  and ordinary Policy ToolGraph calls read both paths and artifacts under their real origins.
- Live, fixed and materialized sources produce distinct actual content. The fixed PDF exceeds the
  single-frame threshold. Materialization uses the original worker, then changes the managed file;
  reading returns that current copy, not the baseline. The source adapters read binary pages, not text.
- Existing completed/released Experiment records and blob references are seeded as test input. The
  actual ExperimentService reads them; no new compute submission, remote collection or backend execution
  is claimed. The real application client/authenticated route opens their retained text and PNG.
- Public wrong source Run, wrong Thread and foreign material access are rejected. Changing the physical
  source does not change the retained PDF. Catalog content GC, complete Host/Storage close/reopen and
  public reread pass for all three source modes. Family artifact → caller-material authority was also
  independently source-traced; cross-family ingestion was not separately executed by this fixture.
- Independent held artifact iterator and cleanup gates prevent completion/receipt until real drain.
  Original KernelClient held capture/getBlob tests keep the source grant until settlement. The material
  owner tests cover held-page cancellation, no next page after cancellation and truncated-page failure.
- Original Web engine/search/HTML/PDF/typed-output/public-reader/GC/reopen composition passed again after
  sharing its finite test transport. The transport is subprocess stdio; outbound Web bytes are controlled.
- Focused core tests: 25 passed; post-paging material/DocumentReader/source tests: 39 passed (overlapping,
  not additive). UI: 113 passed. Client/authenticated-route controlled-port tests: 4 passed. Independent
  original UI failure repros passed separately. Full Host test types, UI types, application-client build,
  changed-source lint and diff checks passed. Fresh Host/CLI/Web/PWA builds passed; the production
  Host excludes test fixtures. Cloud-layout 12 and production-boundary 7 checks passed. These are
  build/layout evidence, not a launched product transport or cross-platform smoke.

## Reproduction

Locked dependencies and the installed builtin build are required. Use the repository's existing build
commands; do not substitute an older package output for changed shared sources.

```sh
bun run --cwd packages/application-client build
bun run --cwd packages/extension-builtins build
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  document_only_native_sources_and_artifacts_reach_public_pdf_reader_and_reopen -- --ignored --nocapture
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  original_web_search_fixed_pdf_and_public_reader_share_native_identity_and_storage -- --ignored --nocapture
cd packages/web
node ../../node_modules/vitest/vitest.mjs run \
  application-host/lib/harness/web-materials.test.ts \
  application-host/lib/harness/document-reading.test.ts \
  application-host/lib/harness/material-read-service.test.ts \
  application-host/lib/kernel/document-sources.test.ts \
  application-host/lib/kernel/thread-materials.test.ts --maxWorkers=2
cd ../ui
node ../../node_modules/vitest/vitest.mjs run \
  src/components/thread/ThreadMaterials.behavior.test.tsx \
  src/components/thread/ThreadConversation.behavior.test.tsx \
  src/components/pi-session/PdfMaterialReader.behavior.test.tsx \
  src/workbenches/research/ResearchFactsPanel.behavior.test.tsx --maxWorkers=2
```

The finite Rust fixtures exercise original owners while replacing only request delivery with stdio.
They do not start product socket/UnixIPC, use real external accounts, a paid model, browser or desktop.
PDF.js emitted the known standard-font warning; actual text/PNG signatures pass, but font/OCR/Docling
quality and cross-platform rendering are not established. New child/nested PDF-source permutations,
full external Experiment production, product performance and platform acceptance remain separate.
Collections/sharing, scholarly/decision and the remaining designs continue afterward; the user owns
final acceptance, default-runtime change, Pi removal and asset migration.
