import { fauxProvider } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionHost } from "../src/session-host.js";

it("clearing a Bot override restores Pi's fresh-session choice without an explicit default", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-bot-model-inherit-"));
  const faux = fauxProvider();
  const base = faux.getModel();
  const alternate = { ...base, id: `${base.id}-alternate`, name: "Alternate" };
  const host = new SessionHost({
    agentDir: join(root, "agent"),
    emit: () => {},
    projectTrustOverride: true,
    configureServices: async (services) => {
      services.modelRuntime.registerProvider(base.provider, {
          streamSimple: faux.provider.streamSimple,
        api: base.api,
        baseUrl: base.baseUrl,
        models: [base, alternate],
      });
      await services.modelRuntime.setRuntimeApiKey(base.provider, "faux-key");
      return {};
    },
  });
  try {
    const created = await host.create(root);
    const initial = created.model;
    assert.ok(initial);
    const selected = initial.id === base.id ? alternate : base;
    await host.selectModel(created.sessionId, selected.provider, selected.id);
    assert.equal(host.snapshot().model?.id, selected.id);
    const reset = await host.resetModelToNewSessionDefault(created.sessionId);
    assert.equal(reset.model?.provider, initial.provider);
    assert.equal(reset.model?.id, initial.id);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
