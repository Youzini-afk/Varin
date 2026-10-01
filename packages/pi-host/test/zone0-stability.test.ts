import { fauxProvider, getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { SessionHost } from "../src/session-host.js";
import { createHarnessEmit, permissionInspectResult } from "./harness-emit.js";
import { persistentProviderMessages, providerRosterMessages, providerSystemPrompt } from "./harness/provider-context.js";

export interface CapturedPayload {
  system: string;
  tools: unknown;
  messages: unknown[];
}

/**
 * Capture provider payloads by intercepting the faux provider's response
 * callbacks. Each callback receives the full provider `Context` which
 * carries prompt and tool changes as native system messages.
 *
 * Usage: call `fauxProvider()`, set responses via `faux.setResponses()`
 * with callbacks that push to `capturedContexts`, then run the session.
 * After the session, call `extractPayloads(capturedContexts)` to get
 * the normalized payloads.
 */
export function extractPayloads(contexts: Context[]): CapturedPayload[] {
  return contexts.map((ctx) => ({
    system: providerSystemPrompt(ctx),
    tools: getCurrentTools(normalizeContext(ctx).messages),
    messages: ctx.messages,
  }));
}

describe("Zone 0 stability contract (1.2)", () => {
  it("system and tools are byte-identical across 5 steps; messages are prefix-growing; goal activation does not change Zone 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-zone0-"));
    const agentDir = join(root, "agent");
    const projectExtensions = join(root, ".pi", "extensions");
    await mkdir(projectExtensions, { recursive: true });

    // Goal extension: uses message (Zone 2), NOT systemPrompt (Zone 0 violation)
    await writeFile(
      join(projectExtensions, "goal-ext.ts"),
      `export default function extension(pi: any) {
        pi.on("before_agent_start", (_event: any, ctx: any) => {
          const branch = ctx.sessionManager.getBranch();
          for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (entry && entry.type === "custom" && entry.customType === "varin.session-features/v1" && entry.data?.goal?.status === "active") {
              return {
                message: {
                  customType: "varin-goal",
                  content: "<varin-active-goal>test goal</varin-active-goal>",
                  display: false,
                },
              };
            }
          }
          return undefined;
        });
      }\n`,
      "utf8",
    );

    // Create a file for the read tool to succeed in tool-call steps
    await writeFile(join(root, "test.txt"), "hello world\n", "utf8");

    const faux = fauxProvider();
    const capturedContexts: Context[] = [];
    const capture = (reply: Parameters<typeof fauxAssistantMessage>[0]) => (context: Context) => {
      capturedContexts.push(context);
      return fauxAssistantMessage(reply);
    };

    // 7 provider calls for 5 prompts: the tool-call steps (2 and 4) each
    // consume a second response for the post-tool continuation. An empty
    // queue surfaces as a provider error, so the fixture must cover every
    // call the flow makes.
    faux.setResponses([
      capture("step 1 done"),
      capture([fauxToolCall("read", { path: "test.txt" })]),
      capture("step 2 done"),
      capture("step 3 done"),
      capture([fauxToolCall("read", { path: "test.txt" })]),
      capture("step 4 done"),
      capture("step 5 done"),
    ]);

    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple,
        api: model.api,
        baseUrl: model.baseUrl,
        models: [
          {
            api: model.api,
            baseUrl: model.baseUrl,
            contextWindow: model.contextWindow,
            cost: model.cost,
            id: model.id,
            input: model.input,
            maxTokens: model.maxTokens,
            name: model.name,
            reasoning: model.reasoning,
          },
        ],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };

    const harness = createHarnessEmit({
      "permission.inspect": permissionInspectResult,
      "permission.audit": () => ({}),
    });
    const host = new SessionHost({
      agentDir,
      configureServices,
      emit: harness.emit,
      projectTrustOverride: true,
    });
    harness.bind(host);

    try {
      const snapshot = await host.create(root);

      // Step 1: plain prompt
      await host.prompt(snapshot.sessionId, "step 1");
      await host.session.waitForIdle();

      // Step 2: tool call
      await host.prompt(snapshot.sessionId, "step 2");
      await host.session.waitForIdle();

      // Activate goal before step 3
      host.mutateFeatures(snapshot.sessionId, {
        type: "goal.start",
        objective: "Zone 0 stability test goal",
      });

      // Step 3: after goal activation
      await host.prompt(snapshot.sessionId, "step 3");
      await host.session.waitForIdle();

      // Step 4: tool call
      await host.prompt(snapshot.sessionId, "step 4");
      await host.session.waitForIdle();

      // Step 5: plain
      await host.prompt(snapshot.sessionId, "step 5");
      await host.session.waitForIdle();

      // 7 provider calls for 5 prompts (tool-call steps 2 and 4 make a
      // continuation call). Exactly 7 means no retry and no exhausted queue.
      assert.equal(capturedContexts.length, 7, "7 provider calls expected");
      assert.equal(faux.state.callCount, 7, "no provider retries expected");
      assert.equal(faux.getPendingResponseCount(), 0, "response queue fully consumed");
      const payloads = extractPayloads(capturedContexts);

      // Zone 0: system prompt must be byte-identical across all calls
      const system0 = payloads[0]!.system;
      for (let i = 1; i < payloads.length; i++) {
        assert.equal(payloads[i]!.system, system0, `system prompt must be byte-identical at call ${i + 1}`);
      }

      // Zone 0: tools must be byte-identical across all calls
      const tools0 = JSON.stringify(payloads[0]!.tools);
      for (let i = 1; i < payloads.length; i++) {
        assert.equal(JSON.stringify(payloads[i]!.tools), tools0, `tools must be byte-identical at call ${i + 1}`);
      }

      // Durable history stays prefix-growing. The complete current roster is a
      // request-scoped tail and is refreshed independently on every call.
      for (let i = 0; i < payloads.length - 1; i++) {
        const current = capturedContexts[i]!;
        const next = capturedContexts[i + 1]!;
        assert.equal(providerRosterMessages(current).length, 1, `call ${i + 1} carries one transient roster`);
        assert.equal(providerRosterMessages(next).length, 1, `call ${i + 2} carries one transient roster`);
        const msgs1 = persistentProviderMessages(current);
        const msgs2 = persistentProviderMessages(next);
        assert.ok(msgs2.length >= msgs1.length, `call ${i + 2} must have >= messages than call ${i + 1}`);
        for (let j = 0; j < msgs1.length; j++) {
          assert.deepEqual(msgs2[j], msgs1[j], `call ${i + 2} message ${j} must equal call ${i + 1} message ${j}`);
        }
      }
    } finally {
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
