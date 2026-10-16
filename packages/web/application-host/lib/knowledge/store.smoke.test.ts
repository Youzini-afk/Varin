/**
 * Node smoke test — verifies that the built server artifact can be
 * imported under pure Node (not vite-node/vitest), catching CJS/ESM
 * interop issues that vitest masks.
 *
 * Run: node --test packages/web/application-host/lib/knowledge/store.smoke.test.ts
 *   or: bun test --node --timeout 10000 store.smoke.test.ts
 *
 * This file uses node:test (not vitest) deliberately.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import from the BUILT server artifact (not the source).
// This is what catches CJS/ESM interop issues.
const serverRoot = new URL("../../../server/lib/knowledge/store.js", import.meta.url);
const { openWorkspaceKnowledge } = await import(serverRoot.href) as typeof import("./store.js");

describe("knowledge store — Node smoke (built artifact)", () => {
  it("opens a store, puts and recalls a knowledge node", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ksmoke-"));
    let store: Awaited<ReturnType<typeof openWorkspaceKnowledge>> | undefined;
    try {
      store = await openWorkspaceKnowledge({
        dataDir,
        hostId: "smoke-host",
        workspaceId: "smoke-ws",
        embedding: null,
      });
      const id = await store.putKnowledge({
        scope: "workspace",
        status: "accepted",
        content: "Always use typebox for schemas",
        trigger: "schema typebox",
      });
      assert.ok(typeof id === "number", "putKnowledge should return a numeric NodeId");

      const results = await store.recall("schema typebox", 5);
      assert.ok(results.length > 0, "recall should find the seeded node");
      assert.equal(results[0]!.node.id, id);

    } finally {
      try { await store?.close(); }
      finally { rmSync(dataDir, { recursive: true, force: true }); }
    }
  });

});
