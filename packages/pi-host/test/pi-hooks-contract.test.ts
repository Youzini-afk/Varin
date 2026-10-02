import { fauxProvider } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type {
  AgentSessionServices,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolResultEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { SessionHost } from "../src/session-host.js";
import { createHarnessEmit, permissionInspectResult } from "./harness-emit.js";
import { persistentProviderMessages, providerRosterMessages } from "./harness/provider-context.js";

// ---------------------------------------------------------------------------
// Compile-time assertions: verify Pi 0.84.3 hook shapes match what the
// agent harness design (design/agent-harness.md §4.1) requires.  These `satisfies`
// checks are erased at runtime but fail compilation when an upstream type
// changes shape.
// ---------------------------------------------------------------------------

void (null as unknown as BeforeAgentStartEvent satisfies {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
});

void (null as unknown as BeforeAgentStartEventResult satisfies {
  message?: unknown;
  systemPrompt?: string;
});

// SessionBeforeCompactResult and ToolResultEventResult are not re-exported
// from the top-level package entry; verify their shapes via the event types
// and the handler result types that ARE exported.
void (null as unknown as SessionBeforeCompactEvent satisfies {
  type: "session_before_compact";
  preparation: unknown;
  branchEntries: unknown[];
  reason: "manual" | "threshold" | "overflow";
});

void (null as unknown as SessionCompactEvent satisfies {
  type: "session_compact";
  compactionEntry: unknown;
});

// ToolResultEvent carries the fields that tool_result handlers can replace.
void (null as unknown as ToolResultEvent satisfies {
  type: "tool_result";
  toolCallId: string;
  content: unknown;
  isError: boolean;
});

void (null as unknown as ToolCallEventResult satisfies {
  block?: boolean;
  reason?: string;
  executionPlan?: unknown;
});

void (null as unknown as TurnEndEvent satisfies {
  type: "turn_end";
  turnIndex: number;
  message: unknown;
  toolResults: unknown[];
});

void (null as unknown as BeforeProviderRequestEvent satisfies {
  type: "before_provider_request";
  payload: unknown;
});

// ToolDefinition: verify the fields the harness relies on exist.  We check
// field presence via a mapped shape rather than full assignability to avoid
// contravariance issues with the `execute` function signature.
type ToolDefinitionShape = Pick<
  ToolDefinition,
  "name" | "label" | "description" | "promptSnippet" | "promptGuidelines" | "parameters" | "prepareExecution" | "executionMode" | "execute"
>;
void (null as unknown as ToolDefinitionShape satisfies {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  prepareExecution?: unknown;
  executionMode?: "parallel" | "sequential";
  execute: unknown;
});

// `customTools` same-name override is a runtime behaviour, not a type
// constraint; verified by the runtime test below and by the existing
// workspace-mutation-journal tests that override `write` / `edit`.

// ---------------------------------------------------------------------------
// Runtime test: `before_agent_start` returning `{ message }` appends a
// custom message to the conversation without changing the system prompt,
// and the system prompt stays byte-identical across steps within the same
// agent loop.
// ---------------------------------------------------------------------------

describe("Pi hooks contract (1.0.0)", () => {
  it("before_agent_start message is appended and system prompt is stable across steps", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-hooks-"));
    const agentDir = join(root, "agent");
    const projectExtensions = join(root, ".pi", "extensions");
    await mkdir(projectExtensions, { recursive: true });

    // Project extension that hooks before_agent_start and returns a message
    // (Zone 2 append) instead of modifying systemPrompt (Zone 0 violation).
    await writeFile(
      join(projectExtensions, "hooks-test.ts"),
      `export default function extension(pi: any) {
        pi.on("before_agent_start", () => {
          return {
            message: {
              customType: "varin-hooks-test",
              content: "hooks-test-zone2-message",
              display: false,
            },
          };
        });
      }\n`,
      "utf8",
    );

    // Create a file for the read tool to succeed in step 1.
    await writeFile(join(root, "test.txt"), "hello world\n", "utf8");

    const faux = fauxProvider();
    const capturedContexts: Context[] = [];

    faux.setResponses([
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "test.txt" }),
        ]);
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage("done");
      },
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
      await host.prompt(snapshot.sessionId, "read test.txt then say done");
      await host.session.waitForIdle();

      assert.equal(capturedContexts.length, 2, "expected exactly two provider calls (two steps)");

      // Zone 0: system prompt must be byte-identical across steps.
      const system1 = capturedContexts[0]!.systemPrompt ?? "";
      const system2 = capturedContexts[1]!.systemPrompt ?? "";
      assert.equal(
        system2,
        system1,
        "system prompt must not change between steps within the same agent loop",
      );

      // Zone 2: the custom message from before_agent_start must appear in
      // the messages of both steps (it was appended before the first call).
      const messages1Text = JSON.stringify(capturedContexts[0]!.messages);
      const messages2Text = JSON.stringify(capturedContexts[1]!.messages);
      assert.match(
        messages1Text,
        /hooks-test-zone2-message/,
        "before_agent_start message must appear in step 1 messages",
      );
      assert.match(
        messages2Text,
        /hooks-test-zone2-message/,
        "before_agent_start message must appear in step 2 messages",
      );

      // Prefix property: step 1 messages must be a prefix of step 2 messages.
      // (Step 2 has the same messages as step 1 plus the assistant response
      //  and tool result from step 1.)
      assert.equal(providerRosterMessages(capturedContexts[0]!).length, 1, "step 1 carries one transient current roster");
      assert.equal(providerRosterMessages(capturedContexts[1]!).length, 1, "step 2 refreshes one transient current roster");
      const msgs1 = persistentProviderMessages(capturedContexts[0]!);
      const msgs2 = persistentProviderMessages(capturedContexts[1]!);
      assert.ok(
        msgs2.length >= msgs1.length,
        "step 2 must have at least as many messages as step 1",
      );
      for (let i = 0; i < msgs1.length; i += 1) {
        assert.deepEqual(
          msgs2[i],
          msgs1[i],
          `message ${i} must be identical between steps (prefix property)`,
        );
      }
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

});
