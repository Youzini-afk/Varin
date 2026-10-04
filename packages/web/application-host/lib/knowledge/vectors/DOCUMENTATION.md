# Knowledge vectors

Derived semantic index for accepted knowledge (plan 2.8 / D-196).
Host-only writer. Not the authoritative workspace or user `.tdb`.

- Authority content, status, source, and supersedes stay in `store.ts`.
- Vectors share the semantic generation store under `knowledge/{hostId}/semantic/knowledge-{scope}/{scopeKey}/{spaceId}/`.
  Bot scope keys use the filename-safe hashed knowledge store key; `bot:` never becomes a Windows path.
- `releaseScope` retires a deleted owner, cancels/drains its builds and searches and closes its vector
  stores before file cleanup. It prevents late work from reopening or republishing that scope while
  leaving other owners running.
- Embedding uses the same user-owned `harness.embedding` → `harness.embed` path as code semantic. Unconfigured knowledge recall stays text-only and never claims `via:vector` or falls back to MiniLM.
- Search builds Top-K inside the accepted, valid, in-scope id set, then re-checks authority revision. Text and vector ranks merge with RRF.
- `searchDocumentScores` validates expected document revisions and computes each document's exact
  best block score in one admitted semantic-owner operation. Document Top-K is applied after all
  eligible documents have been scored; a many-block memory cannot crowd other memories out of
  a prematurely truncated block Top-K. Equal scores retain numeric knowledge-ID order. Only compact
  document scores cross IPC, without source bodies or per-document revision requests. Final delivery
  still re-reads accepted knowledge through its authoritative store.
- Full background reconciliation loads one `listDocumentStates` catalog snapshot per pass. It keeps
  the existing authority rechecks, publish tokens and post-publication invalidation; no stale catalog
  snapshot may acknowledge an obsolete authority revision.
- `packages/web/scripts/perf-knowledge-recall.ts` compares the replaced Host-side algorithm and the
  current owner operation against generated temporary TriviumDB stores. Its `engine` mode separates
  native computation from IPC; `ipc` measures actual private-worker request counts and serialized
  result bytes. Results are checked for equality. It opens neither user databases nor paid providers.
