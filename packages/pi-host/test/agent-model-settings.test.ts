import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { attachAgentModelSettings, resolveAgentModelSettings } from "../src/agent-model-settings.js";

test("admitted model parameters survive branch reload and can be explicitly cleared", () => {
  const manager = SessionManager.inMemory(process.cwd());
  assert.deepEqual(resolveAgentModelSettings(manager, { temperature: 0.35, thinkingLevel: "low" }), { temperature: 0.35, thinkingLevel: "low" });
  assert.deepEqual(resolveAgentModelSettings(manager), { temperature: 0.35, thinkingLevel: "low" });
  const count = manager.getEntries().length;
  resolveAgentModelSettings(manager, { temperature: 0.35, thinkingLevel: "low" });
  assert.equal(manager.getEntries().length, count);
  resolveAgentModelSettings(manager, null);
  assert.deepEqual(resolveAgentModelSettings(manager), {});
});

test("passes the frozen temperature to the native stream without losing request options", () => {
  let received: object | undefined;
  let thinking: string | undefined;
  const result = {};
  const session = { agent: { streamFunction: (_model: unknown, _context: unknown, options: object) => { received = options; return result; } },
    setThinkingLevel: (level: string) => { thinking = level; } } as unknown as AgentSession;
  attachAgentModelSettings(session, { temperature: 0.35, thinkingLevel: "low" });
  const signal = new AbortController().signal;
  const output = session.agent.streamFunction({} as never, {} as never, { temperature: 0.9, maxTokens: 2000, signal });
  assert.equal(output, result);
  assert.deepEqual(received, { temperature: 0.35, maxTokens: 2000, signal });
  assert.equal(thinking, "low");
});
