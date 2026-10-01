import { fauxProvider } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";

test("Pi prompt defers its preflight compaction only when the Host owns request admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-pi-preflight-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const faux = fauxProvider();
  const model = faux.getModel();
  const runtime = await ModelRuntime.create({ allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  runtime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple, api: model.api, baseUrl: model.baseUrl, models: [model] });
  await runtime.setRuntimeApiKey(model.provider, "faux-key");
  const manager = SessionManager.inMemory(root);
  manager.appendMessage({ role: "user", content: "earlier", timestamp: 0 });
  manager.appendMessage(fauxAssistantMessage("earlier answer"));
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime,
    model, sessionManager: manager, tools: [] });
  let preflightReached = false;
  let preflightChecks = 0;
  // Observe the real SDK prompt path without starting a paid summary request.
  const instrumented = session as unknown as { _checkCompaction: () => Promise<void> };
  instrumented._checkCompaction = async () => { if (!preflightReached) preflightChecks += 1; };
  try {
    await session.prompt("hello", { skipPrePromptCompaction: true,
      preflightResult: disposition => { assert.equal(disposition, "started"); preflightReached = true; } });
    assert.equal(preflightChecks, 0);
    preflightReached = false;
    await session.prompt("hello again", { preflightResult: () => { preflightReached = true; } });
    assert.equal(preflightChecks, 1, "ordinary Pi consumers retain native preflight compaction");
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
