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
