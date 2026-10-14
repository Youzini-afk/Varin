import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionStorageRevisionConflictError } from "../src/errors.js";
import { ServiceRoutingStore } from "../src/service-routing-store.js";
import { ExtensionStorageStore } from "../src/storage-store.js";

const hostId = "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a";

test("obsolete session routing is rejected without rewriting the user's stored rules", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-obsolete-routing-"));
  try {
    const storage = new ExtensionStorageStore(dataDir);
    const address = { extensionId: "varin.core.service-routing", key: "rules", scope: "application" } as const;
    const original = await storage.update(address, 0, 1, { rules: [{ allowFallback: false,
      providerKeys: ["dev.example.provider:host:dev.example.echo@1"], scope: { sessionId: "personal-session" },
      serviceId: "dev.example.echo", version: 1 }] });
    const routes = new ServiceRoutingStore({ hostId, storage });
    const read = await routes.read();
    assert.equal(read.authoritative, false);
    assert.equal(read.storageState, "stale");
    assert.match(read.diagnostics[0]!.message, /Unknown service routing context field: sessionId/);
    await assert.rejects(routes.upsertRule({ expectedRevision: original.document.revision,
      rule: { allowFallback: false, providerKeys: ["replacement"], scope: { threadId: "native-thread" },
        serviceId: "dev.example.echo", version: 1 } }), /Cannot update stale/);
    assert.deepEqual((await storage.read(address)).document, original.document);
  } finally { await rm(dataDir, { force: true, recursive: true }); }
});

test("service routing persists stable provider selections and rejects stale revisions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-service-routing-"));
  try {
    const storage = new ExtensionStorageStore(dataDir);
    const routes = new ServiceRoutingStore({ hostId, storage });
    const initial = await routes.read();
    assert.equal(initial.authoritative, true);
    assert.equal(initial.storageState, "missing");
    const saved = await routes.upsertRule({
      expectedRevision: 0,
      rule: {
        allowFallback: false,
        providerKeys: ["dev.example.provider:host:dev.example.echo@1"],
        scope: { workspaceId: "/workspace" },
        serviceId: "dev.example.echo",
        version: 1,
      },
    });
    assert.equal(saved.document.revision, 1);
    assert.deepEqual(saved.document.rules[0]?.providerKeys, ["dev.example.provider:host:dev.example.echo@1"]);
    const reloaded = await new ServiceRoutingStore({ hostId, storage }).read();
    assert.deepEqual(reloaded.document, saved.document);
    await assert.rejects(
      routes.removeRule({ expectedRevision: 0, scope: { workspaceId: "/workspace" }, serviceId: "dev.example.echo", version: 1 }),
      ExtensionStorageRevisionConflictError,
    );
    const removed = await routes.removeRule({
      expectedRevision: 1,
      scope: { workspaceId: "/workspace" },
      serviceId: "dev.example.echo",
      version: 1,
    });
    assert.deepEqual(removed.document.rules, []);
    const ordered = await routes.upsertRule({ expectedRevision: removed.document.revision,
      rule: { allowFallback: false, providerKeys: ["second", "first"], scope: { userId: "default" }, serviceId: "varin.context.fragments", version: 1 } });
    const reopened = new ServiceRoutingStore({ hostId, storage: new ExtensionStorageStore(dataDir) });
    assert.deepEqual((await reopened.read()).document, ordered.document);
    const empty = await reopened.upsertRule({ expectedRevision: ordered.document.revision,
      rule: { allowFallback: true, providerKeys: [], scope: { userId: "default" }, serviceId: "varin.context.fragments", version: 1 } });
    assert.deepEqual(empty.document.rules[0]?.providerKeys, []);
    assert.throws(() => reopened.upsertRule({ expectedRevision: empty.document.revision,
      rule: { allowFallback: false, providerKeys: ["repeat", "repeat"], scope: { userId: "default" }, serviceId: "varin.context.fragments", version: 1 } }));
    // The storage envelope's marker is authoritative even when its rule data is otherwise valid.
    const address = { extensionId: "varin.core.service-routing", key: "rules", scope: "application" } as const;
    await storage.update(address, empty.document.revision, 2, { rules: JSON.parse(JSON.stringify(empty.document.rules)) });
    const stale = await reopened.read();
    assert.equal(stale.authoritative, false);
    assert.equal(stale.storageState, "stale");
    assert.deepEqual(stale.document, empty.document);
    assert.match(stale.diagnostics[0]!.message, /schemaVersion is unsupported/);
    const cold = await new ServiceRoutingStore({ hostId, storage: new ExtensionStorageStore(dataDir) }).read();
    assert.equal(cold.authoritative, false);
    assert.equal(cold.storageState, "stale");
    await assert.rejects(reopened.removeRule({ expectedRevision: empty.document.revision, scope: { userId: "default" },
      serviceId: "varin.context.fragments", version: 1 }), /Cannot update stale/);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
