# Shared vector storage and inference

Automatic code-semantic indexing and the old Explore decision/selection loop are retired.
Quick retrieval executes ordinary native Agent tools; it does not open a code vector reader,
embed a query, install a local model, or scan the repository in the background.
See [retrieval](../../../../../../docs/retrieval.md).

This directory retains storage and inference primitives consumed by Bot knowledge vectors
and other explicit inference domains. Their presence does not restart code indexing.

## Retained inference

`runtime-inference.ts` and `inference-requests.ts` bind actual model requests to their original
native Catalog admission, credential owner, egress, ordinal and receipt. Provider usage remains
original data. Cancellation detaches observation separately from actual request stop; an
unknown dispatched result is not automatically replayed. Embedding tokenization, context
headroom and batching remain shared consumers' contracts.
`vectors/embedding-owner.ts` owns Bot knowledge embedding selection.

Decision and rerank adapters remain for explicit supported consumers. Quick code retrieval
does not use them; invalid ordinary-model configuration does not fall back to these paths.
The retired local semantic component is no longer downloaded, prepared or started.

## Shared storage

The generation/store engine, immutable publication readers, vector cache, plain-text packing
and lifecycle receipts continue to serve knowledge vectors. Storage identity includes actual
model/vector space, recipe and content generation. Original reader leases outlive their
observers; checkpoint/publication success is required before old generations can be released.
Current-format corruption remains an error and cannot be converted to empty data.

The database worker remains the storage writer. Host facades do not reopen its database as
a concurrent fallback. Process disconnect, mutation outcome and confirmed close are distinct.

## Embedding request settings

`vectors/request-settings.ts` owns Host-wide concurrency and background request spacing for
memory and Bot knowledge vectors. The selected model remains in the existing Harness settings.
Unconfigured recall stays text-only. Scheduler changes take effect at the next Host startup.
The settings page does not scan source directories or manage retired code indexes.
