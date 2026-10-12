# Reviewed Web tools and fixed PDF materials

Date: 2026-10-12 (UTC). Baseline: `51eb61bb2de2f830f8746ad610a6fc9ffe0a1e7e`.
Status: finite URL/fixed-snapshot implementation and independent review accepted.
The complete designs and product/platform acceptance remain open.

## Capability and authority

The enabled-by-default ordinary `varin.builtin.web` extension exposes `websearch`, `webfetch` and
`document_read` from one declaration. The original extension service, schema, permission and
ToolBridge owners execute the call. Search providers, outbound policy, HTML extraction, PDF engine,
WebMaterialStore and Rust Storage retain their existing responsibilities. No Pi AgentSession,
physical source, parallel material database or tool-name grant list is created.

This slice supports original search batches, URLs and retained snapshots; PDF overview/text/page
images/structure use the existing reader. Local PDF paths, experiment artifact ingestion, native
collections/sharing, scholarly/decision services and extra reader-model prompts remain subsequent
work. Unsupported local/artifact/prompt fields are rejected, not silently ignored. Existing Pi
features remain available through their original adapters.

A trusted Catalog family lookup determines `thread-materials:<rootThreadId>`. The actual caller
Thread owns its record and narrow storage read/write grant; neither a guessed namespace nor family
membership authorizes a foreign record. There is no synthetic session/Run lifetime or file/maintenance
grant. Completed Runs retain their materials, and these scopes are not fed to Pi orphan reconciliation.
Formal domain-record references protect body/source blobs; revoking a completed grant cleans only
uncommitted temporary ownership. Changing a file source does not rename the logical material scope.

Tool bindings freeze accepted Web/domain/render/document settings; configured credentials resolve
from the original live owner. The keyless default search does not read an unrelated auth file.
Public reads use current domain/document settings, a real Thread and a branch belonging to it.
Configuration capture failure is reported only when a Web declaration is selected, without breaking
unrelated tool preparation.

Shared HTTP/HTML/PDF work retains raw content or analysis only. Each surviving caller publishes its
own snapshot. Cancelling one waiter does not terminate another; the final waiter waits for actual
producer settlement. Started material commits also settle before their caller releases. HTML pin
failure preserves the fetched body with explicit `snapshotError`, never a fabricated snapshot.
Only the original PDF image fields become typed media; full metadata and text remain external tool
data, including in the next real provider serialization. Settled results are not refetched on recovery.

## Real public consumer

`ThreadsAPI.materials.read` reaches authenticated `POST /api/threads/materials/read`, then the original
Thread/domain/material owner. The route validates identity/framing; the shared domain declaration
validates the request. The single shared PDF reader core has a native Thread port and the retained Pi
adapter. Real tool results and Thread-local citations open the current readable snapshot. Thread,
API, Host or material changes and closing the reader cancel observations and reject late images;
no global Pi event selects the native reader.

## Confirmed seams and repairs

Independent probes reproduced three normal user paths:

1. The direct native Web path accepted plain-page `find` but bypassed the old Pi projection. The
   original pure selector is now shared by Pi and the Web owner. Matching context/no-match messages
   preserve the immutable full body. A combined position/find request retains original line numbers.
2. A reversed line range returned successful empty text and an inverted range. The owning Web
   service now rejects it before fetch/read. The PDF reader already had its own entry validation;
   no extra defensive branch was added there.
3. Default keyless search unnecessarily read auth; malformed unrelated credentials disabled it.
   The adapter now preserves the original provider's actual credential dependency.

The lead also checked current `position-not-found` failure semantics and isolated Web configuration
errors from other owners. Early integration failures were fixture assumptions: sorted activation
schemas, explicitly answering original call permissions, Markdown escaping/view projection, the
material `body` field and Rust's explicit foreign-actor rejection. They were corrected as fixture
plumbing, not counted as product defects or used to weaken production checks.

## Verification and reproduction

Final accepted-source evidence:

- One real Rust engine/installed-builtin/Host/domain/Storage composition: source-less model calls,
  search batch, HTML/PDF parsing, fixed rereads/refresh, original per-call permission, typed PDF image
  into the next Responses request, then ordinary Policy ToolGraph reads. Actual application client,
  authenticated route and reader render the retained PDF; wrong branch and foreign namespace/Thread
  reads are rejected. Catalog GC, complete Host/Storage close/reopen and reread require no new fetch.
- Independent original failure probes above, plus four held-producer cases: sole HTTP-body drain,
  one-of-two shared waiter cancellation, started snapshot commit and sole PDF-probe drain. These
  use original domain owners and controlled in-memory ports.
- Original Web/search/material/configuration tests: 77 passed. Old Pi webfetch: 13 passed; original
  Computer: 23 passed; extension-owner routing: 2 passed; builtin packaging: 1 passed.
- UI five-file run: 98 passed; added close/missing-material cases then native/Pi reader run: 10 passed.
  Real application client/authenticated route with controlled domain port: 2 passed. These counts are
  separate evidence, not additive coverage or a design completion percentage.
- Application-client build, full Host test types, UI types and changed-source lint passed. Protocol,
  Pi and builtin artifacts were refreshed. Fresh Host, CLI and Web/PWA builds passed. Cloud-layout
  tests: 12 passed; production-boundary tests: 7 passed. The built Host excludes the test rendezvous.

The final non-documentation input manifest contains 5,440 files, SHA-256
`d72df2365693dd03716f47e8b4abda2f139a13927e474bf5d3ecbb6c9970cd2c`.
After the earlier frozen build, the test helper corrected its foreign-actor rejection assertion and
two new source files lost trailing empty lines. The final real composition and Host test types use
the corrected helper; no production behavior changed during that cleanup.

Representative repository commands (locked dependencies and built builtin artifacts are required):

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  original_web_search_fixed_pdf_and_public_reader_share_native_identity_and_storage -- --ignored --nocapture
node --import tsx --test packages/pi-host/test/harness/webfetch-tool.test.ts
cd packages/web
node ../../node_modules/vitest/vitest.mjs run \
  application-host/lib/harness/web-fetch.test.ts application-host/lib/harness/web-search.test.ts \
  application-host/lib/harness/material-read-service.test.ts application-host/lib/harness/web-materials.test.ts \
  application-host/lib/kernel/material-tool-owner.test.ts application-host/lib/kernel/web-runtime.test.ts \
  application-host/lib/kernel/thread-materials.test.ts --maxWorkers=2
cd ../ui
node ../../node_modules/vitest/vitest.mjs run \
  src/components/thread/ThreadMaterials.behavior.test.tsx \
  src/components/pi-session/PdfMaterialReader.behavior.test.tsx --maxWorkers=2
```

The native fixture substitutes only transport delivery via subprocess stdio and external HTTP bytes
via in-memory fetch. It does not start the product socket transport or use a paid model, live account,
real browser/desktop or external search service. PDF.js reports an unavailable standard-font file in
this environment; actual fixture text and PNG signatures pass, but font/OCR/Docling quality and
cross-platform rendering are not established. This phase does not claim a new complete child/nested
Web execution test, product latency/resource benchmarks or a runtime default migration. Those remain
separate from the implemented ordinary-tool path and the user's final acceptance/migration.
