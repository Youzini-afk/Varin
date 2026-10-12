import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionStorageRevisionConflictError } from "../src/errors.js";
import { ServiceRoutingStore } from "../src/service-routing-store.js";
import { ExtensionStorageStore } from "../src/storage-store.js";

const hostId = "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a";

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
        providerKey: "dev.example.provider:host:dev.example.echo@1",
        scope: { workspaceId: "/workspace" },
        serviceId: "dev.example.echo",
        version: 1,
      },
    });
    assert.equal(saved.document.revision, 1);
    assert.equal(saved.document.rules[0]?.providerKey, "dev.example.provider:host:dev.example.echo@1");
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
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
