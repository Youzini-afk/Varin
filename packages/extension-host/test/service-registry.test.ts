import assert from "node:assert/strict";
import test from "node:test";
import { HostServiceRegistry, type HostServiceOwnerIdentity } from "../src/index.js";

const hostId = "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a";
const owner = (extensionId: string, generation: number): HostServiceOwnerIdentity => ({
  entrypointId: "host",
  instanceKey: "registry-fixture",
  extensionId,
  extensionVersion: `${generation}.0.0`,
  generation,
});

test("service replacement exposes the new generation while the old invocation drains", async () => {
  const services = new HostServiceRegistry(hostId);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await services.replaceOwner(owner("dev.example.provider", 1), [{
    descriptor: { id: "dev.example.echo", version: 1 },
    handler: async () => { await blocked; return "old"; },
  }]);
  const firstProviderKey = services.getSnapshot().providers[0]?.providerKey;
  const oldInvocation = services.invoke({ args: [], method: "read", serviceId: "dev.example.echo", version: 1 });
  const replacement = services.prepareOwnerReplacement(owner("dev.example.provider", 2), [{
    descriptor: { id: "dev.example.echo", version: 1 },
    handler: () => "new",
  }]);
  replacement.commit();
  assert.deepEqual(services.getSnapshot().providers.map((provider) => provider.status).sort(), ["active", "draining"]);
  assert.deepEqual(new Set(services.getSnapshot().providers.map((provider) => provider.providerKey)), new Set([firstProviderKey]));
  assert.equal(await services.invoke({ args: [], method: "read", serviceId: "dev.example.echo", version: 1 }), "new");
  let finalized = false;
  const finalizing = replacement.finalize().then(() => { finalized = true; });
  await Promise.resolve();
  assert.equal(finalized, false);
  release();
  assert.equal(await oldInvocation, "old");
  await finalizing;
  assert.equal(services.getSnapshot().providers.length, 1);
});

test("multi-provider services require an exact identity and reject a removed provider", async () => {
  const services = new HostServiceRegistry(hostId);
  for (const [extensionId, value] of [["dev.example.one", "one"], ["dev.example.two", "two"]] as const) {
    await services.replaceOwner(owner(extensionId, 1), [{
      descriptor: { id: "dev.example.multi", multiple: true, version: 1 },
      handler: () => value,
    }]);
  }
  await assert.rejects(
    services.invoke({ args: [], method: "read", serviceId: "dev.example.multi", version: 1 }),
    /ambiguous/,
  );
  const selected = services.getSnapshot().providers.find((provider) => provider.extensionId === "dev.example.two");
  assert.ok(selected);
  assert.equal(await services.invoke({ providerId: selected.providerId, args: [], method: "read", serviceId: "dev.example.multi", version: 1 }), "two");
  services.removeOwner(owner("dev.example.two", 1));
  await assert.rejects(services.invoke({ providerId: selected.providerId, args: [], method: "read", serviceId: "dev.example.multi", version: 1 }), /unavailable/);
});
