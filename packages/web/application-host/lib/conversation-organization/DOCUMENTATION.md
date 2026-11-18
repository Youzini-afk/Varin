# Conversation Organization module

Thin Host adapter bridging authenticated HTTP navigation queries and mutations onto the Rust Catalog's durable conversation tree, containers, placements, and command receipts. Maintains **no** Host-side directory copy or second receipt database. See [docs/runtime.md](../../../../../docs/runtime.md#core-identities--single-writer) and [kernel/DOCUMENTATION.md](../kernel/DOCUMENTATION.md).

## Key files

| File | Responsibility |
| --- | --- |
| [`service.ts`](service.ts) | `ConversationOrganizationService`: Catalog-backed `read`, `entry`, `creationDefaults`, `command`, `project`, and batch `metadata` operations |
| [`routes.ts`](routes.ts) | Authenticated `POST /api/conversation-organization/{read,entry,command,metadata,project}` routes with strict field validation |
| [`labels.ts`](labels.ts) | `readConversationOrganizationLabels`: resolves display names for Bot and project IDs from their actual owners (`available`/`missing`/`unavailable`) |

## Ownership and invariants

- **Single writer in Catalog**: Durable container trees, conversation placements, generation counters, CAS checks, and idempotent command receipts live in Rust Catalog. Settings remains the authority for project registration/removal; `project()` coordinates the two without claiming cross-store atomicity (returning `navigation: "pending"` on partial failure).
- **One-time principal initialization**: On first uninitialized `read()`, the Host loads a validated Settings project list plus current native Threads and external conversations, then calls `runtime.organizationInitialize` (key `visible-project-generation`). An unreadable or malformed Settings file fails with `projects_unavailable` (503) rather than initializing an empty tree.
- **Principal scoping**: `principalId` always comes from authentication (`withRequestPrincipal`), never request JSON. Batch `metadata()` accepts a fixed conversation selection (never a live container query), verifies owner or Host-owner-for-public-native authority per item, hashes `(key, kind, id)` into deterministic receipt keys, and requires deletion (`patch.deleted`) to be a separate action.
- **Frozen creation defaults**: `creationDefaults()` reads previously saved Catalog creation defaults on retry so retries keep original intent; for new threads under a project container, it freezes `freezeProjectSourceSelection(project)` into creation metadata rather than tying execution to mutable navigation nodes.
- **Search & labels**: Text search passes one trusted Settings project-name snapshot per request for cursor binding; ordinary initialized reads do not read Settings or contact remote devices.
