import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";

test("Pi prompt can defer automatic compaction until after input acceptance", async () => {
  let checks = 0;
  let accepted: boolean | undefined;
  let submitted = 0;
  const fake = {
    _compactionAbortController: undefined,
    _extensionRunner: {
      hasHandlers: () => false,
      emitBeforeAgentStart: async () => undefined,
    },
    isStreaming: false,
    _flushPendingBashMessages: () => undefined,
    _flushPendingCustomMessages: () => undefined,
    model: { provider: "faux" },
    _modelRuntime: { hasConfiguredAuth: () => true },
    _findLastAssistantMessage: () => ({ role: "assistant" }),
    _checkCompaction: async () => { checks += 1; return false; },
    _pendingNextTurnMessages: [],
    _baseSystemPrompt: "test",
    _baseSystemPromptOptions: {},
    agent: { state: {} },
    _runAgentPrompt: async () => { submitted += 1; },
  } as unknown as AgentSession;
  await AgentSession.prototype.prompt.call(fake, "hello", {
    expandPromptTemplates: false,
    skipPrePromptCompaction: true,
    preflightResult: (value) => { accepted = value; },
  });
  assert.equal(accepted, true);
  assert.equal(submitted, 1);
  assert.equal(checks, 0);

  await AgentSession.prototype.prompt.call(fake, "hello", { expandPromptTemplates: false });
  assert.equal(checks, 1, "the SDK default remains available outside Varin's request boundary");
});
