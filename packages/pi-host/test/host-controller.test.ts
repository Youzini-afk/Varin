import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createRequest,
  type EventEnvelope,
  type HarnessInferenceBindingSnapshot,
  VARIN_PROTOCOL_VERSION,
  ProtocolDecodeError,
  type ResponseEnvelope,
  type SessionSnapshot,
  type WireEnvelope,
} from "@varin/protocol";
import { HostController } from "../src/host-controller.js";
import { MemoryHostTransport } from "../src/transport.js";

function isResponse(envelope: WireEnvelope, id: string): envelope is ResponseEnvelope {
  return envelope.kind === "response" && envelope.id === id;
}

function isEvent(envelope: WireEnvelope, event: string): envelope is EventEnvelope {
  return envelope.kind === "event" && envelope.event === event;
}

describe("HostController", () => {
  it("serves authoritative health reads while a prompt is waiting in an input hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-prompt-preflight-"));
    const cwd = join(root, "workspace");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(join(cwd, ".pi", "extensions", "hold-input.ts"), `
      export default function extension(pi: any) {
        pi.on("input", async (_event: any, ctx: any) => {
          await ctx.ui.confirm("Preflight fixture", "Wait for the test to release input");
          return { action: "handled" };
        });
      }
    `);
    const transport = new MemoryHostTransport();
    const controller = new HostController({ agentDir: join(root, "agent"), transport, projectTrustOverride: true });
    let questionId: string | undefined;
    controller.start();
    try {
      transport.receive(createRequest("hello", "host.handshake", {
        clientName: "preflight-test", clientVersion: "0.0.0", mode: "test", protocolVersions: [VARIN_PROTOCOL_VERSION],
      }));
      await transport.waitFor((entry) => isResponse(entry, "hello"));
      transport.receive(createRequest("create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "create"), 15_000);
      assert.ok(created.kind === "response" && created.ok);
      const { sessionId } = created.result as SessionSnapshot;
      transport.receive(createRequest("held-prompt", "agent.prompt", { sessionId, text: "inspect fixture" }));
      const question = await transport.waitFor((entry) => isEvent(entry, "extension.ui.request"));
      assert.ok(question.kind === "event" && question.event === "extension.ui.request");
      questionId = question.data.id;
      transport.receive(createRequest("probe", "session.snapshot", { sessionId }));
      transport.receive(createRequest("reconcile", "session.reconcile", { sessionId, scopes: ["branch"] }));
      const probe = await transport.waitFor((entry) => isResponse(entry, "probe"), 1000);
      const cut = await transport.waitFor((entry) => isResponse(entry, "reconcile"), 1000);
      assert.ok(probe.kind === "response" && probe.ok);
      assert.ok(cut.kind === "response" && cut.ok);
      // The read must not invent an executing model or repeat the pending prompt.
      assert.equal((probe.result as SessionSnapshot).isStreaming, false);
    } finally {
      if (questionId) {
        transport.receive(createRequest("answer", "extension.ui.respond", { requestId: questionId, value: false }));
        await transport.waitFor((entry) => isResponse(entry, "held-prompt"), 5000).catch(() => undefined);
      }
      await controller.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handshakes, trusts a project, loads an extension, and bridges its UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const extensionLoadLog = join(root, "extension-loads.txt");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extensions", "ui-test.ts"),
      `import { appendFileSync } from "node:fs";
      export default function extension(pi: any) {
        appendFileSync(${JSON.stringify(extensionLoadLog)}, "loaded\\n", "utf8");
        pi.registerProvider("varin-test-provider", {
          name: "Varin Test Provider",
          baseUrl: "https://provider.invalid/v1",
          api: "openai-completions",
          models: [{
            id: "test-model",
            name: "Test Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          }],
        });
        pi.registerCommand("ui-test", {
          description: "Exercise the Varin extension UI bridge",
          handler: async (_args: string, ctx: any) => {
            const confirmed = await ctx.ui.confirm("Proceed?", "Confirm from test");
            await ctx.ui.custom(() => ({
              handleInput() {},
              invalidate() {},
              render(width: number) { return ["Custom extension panel", "width " + width]; },
            }), { overlay: true, overlayOptions: { width: 72 } });
            ctx.ui.notify(confirmed ? "confirmed" : "cancelled", "info");
            ctx.ui.setEditorText("restored by extension");
            pi.appendEntry("varin.test", { confirmed });
          },
        });
      }\n`,
    );

    const transport = new MemoryHostTransport();
    const controller = new HostController({ agentDir, transport });
    controller.start();
    try {
      transport.receive(
        createRequest("handshake", "host.handshake", {
          clientName: "host-test",
          clientVersion: "0.0.0",
          mode: "test",
          protocolVersions: [VARIN_PROTOCOL_VERSION],
        }),
      );
      const handshake = await transport.waitFor((entry) => isResponse(entry, "handshake"));
      assert.ok(handshake.kind === "response" && handshake.ok);

      transport.receive(createRequest("create", "session.create", { cwd }));
      const trustEvent = await transport.waitFor((entry) =>
        isEvent(entry, "project.trust.request"),
      );
      assert.ok(trustEvent.kind === "event" && trustEvent.event === "project.trust.request");
      transport.receive(
        createRequest("trust", "project.trust.respond", {
          remember: false,
          requestId: trustEvent.data.id,
          trusted: true,
        }),
      );
      const created = await transport.waitFor((entry) => isResponse(entry, "create"), 15_000);
      assert.ok(created.kind === "response" && created.ok);
      const snapshot = created.result as SessionSnapshot;
      assert.equal(snapshot.cwd, cwd);
      assert.equal(snapshot.isCompacting, false);
      assert.equal(snapshot.isStreaming, false);
      assert.equal(snapshot.pendingMessageCount, 0);
      assert.deepEqual(snapshot.steering, []);
      assert.deepEqual(snapshot.followUp, []);
      assert.ok(snapshot.sessionFile);

      transport.receive(
        createRequest("commands", "command.list", { sessionId: snapshot.sessionId }),
      );
      const commands = await transport.waitFor((entry) => isResponse(entry, "commands"));
      assert.ok(commands.kind === "response" && commands.ok);
      assert.ok(
        (commands.result as Array<{ name: string }>).some((command) => command.name === "ui-test"),
      );

      transport.receive(createRequest("providers", "provider.list", {}));
      const providers = await transport.waitFor((entry) => isResponse(entry, "providers"));
      assert.ok(providers.kind === "response" && providers.ok);
      const provider = (
        providers.result as Array<{
          auth: { configured: boolean; methods: Array<{ label: string; type: string }> };
          id: string;
          modelCount: number;
        }>
      ).find((entry) => entry.id === "varin-test-provider");
      assert.ok(provider);
      assert.equal(provider.auth.configured, false);
      assert.deepEqual(provider.auth.methods.map((method) => method.type), ["api_key"]);
      assert.equal(provider.modelCount, 1);

      transport.receive(
        createRequest("provider-login", "provider.login", {
          interactionId: "host-login-interaction",
          providerId: "varin-test-provider",
          type: "api_key",
        }),
      );
      const authPrompt = await transport.waitFor(
        (entry) =>
          isEvent(entry, "provider.auth.prompt") &&
          entry.event === "provider.auth.prompt" &&
          entry.data.providerId === "varin-test-provider",
      );
      assert.ok(authPrompt.kind === "event" && authPrompt.event === "provider.auth.prompt");
      assert.equal(authPrompt.data.prompt.type, "secret");
      transport.receive(
        createRequest("provider-auth-response", "provider.auth.respond", {
          requestId: authPrompt.data.prompt.requestId,
          value: "test-api-key",
        }),
      );
      const authResponse = await transport.waitFor((entry) =>
        isResponse(entry, "provider-auth-response"),
      );
      assert.ok(authResponse.kind === "response" && authResponse.ok);
      const loggedIn = await transport.waitFor((entry) => isResponse(entry, "provider-login"));
      assert.ok(loggedIn.kind === "response" && loggedIn.ok);

      transport.receive(createRequest("provider-login-cancelled", "provider.login", {
        interactionId: "host-login-cancelled-interaction",
        providerId: "varin-test-provider",
        type: "api_key",
      }));
      const cancellablePrompt = await transport.waitFor(
        (entry) => isEvent(entry, "provider.auth.prompt")
          && entry.event === "provider.auth.prompt"
          && entry.data.interactionId === "host-login-cancelled-interaction",
      );
      assert.ok(cancellablePrompt.kind === "event" && cancellablePrompt.event === "provider.auth.prompt");
      transport.receive(createRequest("queued-provider-list", "model.list", {}));
      transport.receive(createRequest("provider-login-cancel", "provider.auth.cancel", {
        interactionId: "host-login-cancelled-interaction",
      }));
      const cancelResponse = await transport.waitFor((entry) => isResponse(entry, "provider-login-cancel"));
      assert.ok(cancelResponse.kind === "response" && cancelResponse.ok);
      assert.deepEqual(cancelResponse.result, { cancelled: true });
      const cancelledLogin = await transport.waitFor((entry) => isResponse(entry, "provider-login-cancelled"));
      assert.ok(cancelledLogin.kind === "response" && !cancelledLogin.ok);
      assert.equal(cancelledLogin.error.code, "auth_cancelled");
      const queuedProviderList = await transport.waitFor((entry) => isResponse(entry, "queued-provider-list"));
      assert.ok(queuedProviderList.kind === "response" && queuedProviderList.ok);

      transport.receive(createRequest("models", "model.list", {}));
      const models = await transport.waitFor((entry) => isResponse(entry, "models"));
      assert.ok(models.kind === "response" && models.ok);
      const model = (
        models.result as Array<{
          available: boolean;
          id: string;
          provider: string;
          supportedThinkingLevels: string[];
        }>
      ).find(
        (entry) =>
          entry.provider === "varin-test-provider" && entry.id === "test-model",
      );
      assert.ok(model);
      assert.equal(model.available, true);
      assert.deepEqual(model.supportedThinkingLevels, ["off"]);

      transport.receive(
        createRequest("execute", "command.execute", {
          command: "/ui-test",
          sessionId: snapshot.sessionId,
        }),
      );
      const confirm = await transport.waitFor(
        (entry) =>
          isEvent(entry, "extension.ui.request") &&
          entry.event === "extension.ui.request" &&
          entry.data.method === "confirm",
      );
      assert.ok(confirm.kind === "event" && confirm.event === "extension.ui.request");
      assert.ok(confirm.data.id);
      transport.receive(
        createRequest("confirm", "extension.ui.respond", {
          requestId: confirm.data.id,
          value: true,
        }),
      );
      const customPanel = await transport.waitFor(
        (entry) =>
          isEvent(entry, "extension.ui.request")
          && entry.event === "extension.ui.request"
          && entry.data.method === "custom",
      );
      assert.ok(customPanel.kind === "event" && customPanel.event === "extension.ui.request");
      assert.deepEqual(customPanel.data.payload, {
        lines: ["Custom extension panel", "width 72"],
        title: "Extension panel",
      });
      assert.ok(customPanel.data.id);
      transport.receive(
        createRequest("custom-panel", "extension.ui.respond", {
          requestId: customPanel.data.id,
        }),
      );
      const executed = await transport.waitFor((entry) => isResponse(entry, "execute"));
      assert.ok(executed.kind === "response" && executed.ok);
      assert.ok(
        transport.sent.some(
          (entry) =>
            isEvent(entry, "extension.ui.request") &&
            entry.event === "extension.ui.request" &&
            entry.data.method === "setEditorText",
        ),
      );

      transport.receive(
        createRequest("entries", "session.entries", {
          scope: "all",
          sessionId: snapshot.sessionId,
        }),
      );
      const entries = await transport.waitFor((entry) => isResponse(entry, "entries"));
      assert.ok(entries.kind === "response" && entries.ok);
      assert.match(JSON.stringify(entries.result), /varin\.test/);

      transport.receive(
        createRequest("tree", "session.tree", { sessionId: snapshot.sessionId }),
      );
      const tree = await transport.waitFor((entry) => isResponse(entry, "tree"));
      assert.ok(tree.kind === "response" && tree.ok);
      assert.match(JSON.stringify(tree.result), /varin\.test/);

      transport.receive(
        createRequest("header", "session.header", { sessionId: snapshot.sessionId }),
      );
      const header = await transport.waitFor((entry) => isResponse(entry, "header"));
      assert.ok(header.kind === "response" && header.ok);
      assert.equal((header.result as { id: string }).id, snapshot.sessionId);

      transport.receive(
        createRequest("stats", "session.stats", { sessionId: snapshot.sessionId }),
      );
      const stats = await transport.waitFor((entry) => isResponse(entry, "stats"));
      assert.ok(stats.kind === "response" && stats.ok);
      assert.equal((stats.result as { sessionId: string }).sessionId, snapshot.sessionId);

      transport.receive(createRequest("reconcile", "session.reconcile", {
        scopes: ["branch", "all"], sessionId: snapshot.sessionId,
      }));
      const reconciled = await transport.waitFor((entry) => isResponse(entry, "reconcile"));
      assert.ok(reconciled.kind === "response" && reconciled.ok);
      const cut = reconciled.result as {
        entries: { all: { leafId: string | null }; branch: { leafId: string | null } };
        snapshot: { eventWatermark: number; leafId: string | null; sessionId: string };
        stats: { sessionId: string };
      };
      assert.equal(cut.snapshot.sessionId, snapshot.sessionId);
      assert.equal(cut.stats.sessionId, snapshot.sessionId);
      assert.equal(cut.entries.branch.leafId, cut.snapshot.leafId);
      assert.equal(cut.entries.all.leafId, cut.snapshot.leafId);
      assert.ok(Number.isSafeInteger(cut.snapshot.eventWatermark));

      transport.receive(
        createRequest("rename", "session.rename", {
          name: "Renamed from native Pi",
          sessionId: snapshot.sessionId,
        }),
      );
      const renamed = await transport.waitFor((entry) => isResponse(entry, "rename"));
      assert.ok(renamed.kind === "response" && renamed.ok);
      assert.equal((renamed.result as { name?: string }).name, "Renamed from native Pi");

      transport.receive(
        createRequest("thinking", "thinking.select", {
          level: "off",
          sessionId: snapshot.sessionId,
        }),
      );
      const thinking = await transport.waitFor((entry) => isResponse(entry, "thinking"));
      assert.ok(thinking.kind === "response" && thinking.ok);
      assert.equal((thinking.result as SessionSnapshot).thinkingLevel, "off");

      transport.receive(createRequest("settings-before-update", "settings.get", {}));
      const settingsBeforeUpdate = await transport.waitFor((entry) =>
        isResponse(entry, "settings-before-update"),
      );
      assert.ok(settingsBeforeUpdate.kind === "response" && settingsBeforeUpdate.ok);
      const projectSettingsRevision = (settingsBeforeUpdate.result as {
        projectRevision: string;
      }).projectRevision;
      const globalSettingsRevision = (settingsBeforeUpdate.result as {
        globalRevision: string;
      }).globalRevision;

      transport.receive(
        createRequest("invalid-harness-settings", "settings.update", {
          expectedRevision: globalSettingsRevision,
          remove: [],
          scope: "global",
          set: {
            harness: {
              permissions: {
                mode: "normal",
                rules: [{ tool: "bash", decision: "maybe" }],
              },
            },
          },
        }),
      );
      const invalidHarnessSettings = await transport.waitFor((entry) =>
        isResponse(entry, "invalid-harness-settings"),
      );
      assert.ok(invalidHarnessSettings.kind === "response" && !invalidHarnessSettings.ok);
      assert.match(invalidHarnessSettings.error.message, /invalid decision/);

      transport.receive(
        createRequest("plugin-settings", "settings.update", {
          expectedRevision: projectSettingsRevision,
          remove: [],
          scope: "project",
          set: {
            workspaceHistory: {
              enabled: true,
              maxWorkspaces: 50,
            },
          },
        }),
      );
      const pluginSettings = await transport.waitFor((entry) =>
        isResponse(entry, "plugin-settings"),
      );
      assert.ok(pluginSettings.kind === "response" && pluginSettings.ok);
      assert.deepEqual(
        (pluginSettings.result as {
          project: { workspaceHistory?: unknown };
        }).project.workspaceHistory,
        { enabled: true, maxWorkspaces: 50 },
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8")),
        { workspaceHistory: { enabled: true, maxWorkspaces: 50 } },
      );
      assert.equal(
        (await readFile(extensionLoadLog, "utf8")).trim().split("\n").length,
        1,
        "saving next-run settings does not reload the current session synchronously",
      );

      transport.receive(
        createRequest("wtf-config-get", "config.document.get", {
          path: "wtf.json",
          scope: "global",
        }),
      );
      const emptyWtfConfig = await transport.waitFor((entry) =>
        isResponse(entry, "wtf-config-get"),
      );
      assert.ok(emptyWtfConfig.kind === "response" && emptyWtfConfig.ok);
      assert.deepEqual(emptyWtfConfig.result, {
        document: {},
        exists: false,
        path: "wtf.json",
        projectTrusted: true,
        revision: (emptyWtfConfig.result as { revision: string }).revision,
        scope: "global",
      });
      const wtfRevision = (emptyWtfConfig.result as { revision: string }).revision;
      assert.equal(wtfRevision.length, 64);

      transport.receive(
        createRequest("wtf-config-update", "config.document.update", {
          expectedRevision: wtfRevision,
          path: "wtf.json",
          remove: [],
          scope: "global",
          set: { words: ["oops", "fix"] },
        }),
      );
      const wtfConfig = await transport.waitFor((entry) =>
        isResponse(entry, "wtf-config-update"),
      );
      assert.ok(wtfConfig.kind === "response" && wtfConfig.ok);
      assert.deepEqual(
        (wtfConfig.result as { document: unknown }).document,
        { words: ["oops", "fix"] },
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(agentDir, "wtf.json"), "utf8")),
        { words: ["oops", "fix"] },
      );
      assert.equal(
        (await readFile(extensionLoadLog, "utf8")).trim().split("\n").length,
        2,
        "saving an extension-owned config document reloads extensions",
      );

      transport.receive(
        createRequest("magic-config-get", "config.text.get", {
          format: "jsonc",
          path: ".cortexkit/magic-context.jsonc",
          root: "project",
        }),
      );
      const emptyMagicConfig = await transport.waitFor((entry) =>
        isResponse(entry, "magic-config-get"),
      );
      assert.ok(emptyMagicConfig.kind === "response" && emptyMagicConfig.ok);
      const magicSnapshot = emptyMagicConfig.result as {
        content: string;
        exists: boolean;
        revision: string;
      };
      assert.equal(magicSnapshot.exists, false);

      const magicContent = "{\n  // Kept for the plugin\n  \"todowrite\": { \"enabled\": true, },\n}\n";
      transport.receive(
        createRequest("magic-config-update", "config.text.update", {
          content: magicContent,
          expectedRevision: magicSnapshot.revision,
          format: "jsonc",
          path: ".cortexkit/magic-context.jsonc",
          root: "project",
        }),
      );
      const magicConfig = await transport.waitFor((entry) =>
        isResponse(entry, "magic-config-update"),
      );
      assert.ok(magicConfig.kind === "response" && magicConfig.ok);
      assert.equal(
        await readFile(join(cwd, ".cortexkit", "magic-context.jsonc"), "utf8"),
        magicContent,
      );
      assert.equal(
        (await readFile(extensionLoadLog, "utf8")).trim().split("\n").length,
        3,
        "saving plugin-owned JSONC reloads extensions",
      );

      transport.receive(
        createRequest("home-config-get", "config.text.get", {
          format: "json",
          path: `.varin-host-test-${snapshot.sessionId}.json`,
          root: "home",
        }),
      );
      const homeConfig = await transport.waitFor((entry) =>
        isResponse(entry, "home-config-get"),
      );
      assert.ok(homeConfig.kind === "response" && homeConfig.ok);
      assert.equal((homeConfig.result as { root: string }).root, "home");

      transport.receive(
        createRequest("config-path-escape", "config.document.get", {
          path: "../outside.json",
          scope: "global",
        }),
      );
      const escapedConfig = await transport.waitFor((entry) =>
        isResponse(entry, "config-path-escape"),
      );
      assert.ok(escapedConfig.kind === "response" && !escapedConfig.ok);
      assert.equal(escapedConfig.error.code, "invalid_config_path");

      transport.receive(
        createRequest("config-settings-reserved", "config.document.get", {
          path: "settings.json",
          scope: "global",
        }),
      );
      const reservedSettings = await transport.waitFor((entry) =>
        isResponse(entry, "config-settings-reserved"),
      );
      assert.ok(reservedSettings.kind === "response" && !reservedSettings.ok);
      assert.equal(reservedSettings.error.code, "invalid_config_path");

      transport.receive(
        createRequest("config-text-path-escape", "config.text.get", {
          format: "jsonc",
          path: "../outside.jsonc",
          root: "project",
        }),
      );
      const escapedTextConfig = await transport.waitFor((entry) =>
        isResponse(entry, "config-text-path-escape"),
      );
      assert.ok(escapedTextConfig.kind === "response" && !escapedTextConfig.ok);
      assert.equal(escapedTextConfig.error.code, "invalid_config_path");
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns structured errors for invalid client input", async () => {
    const transport = new MemoryHostTransport();
    const controller = new HostController({ transport });
    controller.start();
    try {
      transport.receive({
        id: "invalid",
        kind: "request",
        method: "session.create",
        params: {},
        v: VARIN_PROTOCOL_VERSION,
      } as WireEnvelope);
      const response = await transport.waitFor((entry) => isResponse(entry, "invalid"));
      assert.ok(response.kind === "response" && !response.ok);
      assert.equal(response.error.code, "invalid_params");
    } finally {
      await controller.dispose();
    }
  });

  it("watches validated configuration authorities across atomic replacement and cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-config-watch-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const transport = new MemoryHostTransport();
    const controller = new HostController({
      agentDir,
      projectTrustOverride: true,
      transport,
    });
    controller.start();
    try {
      transport.receive(createRequest("create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "create"));
      assert.ok(created.kind === "response" && created.ok);

      transport.receive(createRequest("watch-document", "config.watch", {
        target: { kind: "document", path: "watched.json", scope: "global" },
      }));
      const watchedDocument = await transport.waitFor((entry) =>
        isResponse(entry, "watch-document"),
      );
      assert.ok(watchedDocument.kind === "response" && watchedDocument.ok);
      const documentWatchId = (watchedDocument.result as { watchId: string }).watchId;
      const documentTemporary = join(agentDir, "watched.json.atomic");
      await writeFile(documentTemporary, "{\"value\":1}\n", "utf8");
      await rename(documentTemporary, join(agentDir, "watched.json"));
      const documentChanged = await transport.waitFor(
        (entry) => isEvent(entry, "config.changed")
          && entry.event === "config.changed"
          && entry.data.watchId === documentWatchId,
      );
      assert.ok(documentChanged.kind === "event" && documentChanged.event === "config.changed");
      assert.equal(documentChanged.data.reason, "rename");

      transport.receive(createRequest("watch-text", "config.watch", {
        target: {
          format: "jsonc",
          kind: "text",
          path: ".plugin/native.jsonc",
          root: "project",
        },
      }));
      const watchedText = await transport.waitFor((entry) => isResponse(entry, "watch-text"));
      assert.ok(watchedText.kind === "response" && watchedText.ok);
      const textWatchId = (watchedText.result as { watchId: string }).watchId;
      await mkdir(join(cwd, ".plugin"));
      await writeFile(join(cwd, ".plugin", "native.jsonc"), "{\n  // external\n}\n", "utf8");
      const textChanged = await transport.waitFor(
        (entry) => isEvent(entry, "config.changed")
          && entry.event === "config.changed"
          && entry.data.watchId === textWatchId,
      );
      assert.ok(textChanged.kind === "event" && textChanged.event === "config.changed");

      transport.receive(createRequest("watch-settings", "config.watch", {
        target: { kind: "settings", scope: "global" },
      }));
      const watchedSettings = await transport.waitFor((entry) =>
        isResponse(entry, "watch-settings"),
      );
      assert.ok(watchedSettings.kind === "response" && watchedSettings.ok);
      const settingsWatchId = (watchedSettings.result as { watchId: string }).watchId;
      const settingsTemporary = join(agentDir, "settings.json.atomic");
      await writeFile(settingsTemporary, "{\"theme\":\"external\"}\n", "utf8");
      await rename(settingsTemporary, join(agentDir, "settings.json"));
      await transport.waitFor(
        (entry) => isEvent(entry, "config.changed")
          && entry.event === "config.changed"
          && entry.data.watchId === settingsWatchId,
      );
      transport.receive(createRequest("settings-after-external", "settings.get", {}));
      const externallyReloadedSettings = await transport.waitFor((entry) =>
        isResponse(entry, "settings-after-external"),
      );
      assert.ok(externallyReloadedSettings.kind === "response" && externallyReloadedSettings.ok);
      assert.equal(
        (externallyReloadedSettings.result as { global: { theme?: string } }).global.theme,
        "external",
      );

      transport.receive(createRequest("unwatch-document", "config.unwatch", {
        watchId: documentWatchId,
      }));
      const unwatched = await transport.waitFor((entry) => isResponse(entry, "unwatch-document"));
      assert.ok(unwatched.kind === "response" && unwatched.ok);
      assert.deepEqual(unwatched.result, { unwatched: true });
      const documentEventCount = transport.sent.filter(
        (entry) => isEvent(entry, "config.changed")
          && entry.event === "config.changed"
          && entry.data.watchId === documentWatchId,
      ).length;
      const replacement = join(agentDir, "watched.json.replacement");
      await writeFile(replacement, "{\"value\":2}\n", "utf8");
      await rename(replacement, join(agentDir, "watched.json"));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      assert.equal(
        transport.sent.filter(
          (entry) => isEvent(entry, "config.changed")
            && entry.event === "config.changed"
            && entry.data.watchId === documentWatchId,
        ).length,
        documentEventCount,
      );

      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(outside, join(agentDir, "linked"), "junction");
      transport.receive(createRequest("watch-symlink", "config.watch", {
        target: { kind: "document", path: "linked/escaped.json", scope: "global" },
      }));
      const symlinkWatch = await transport.waitFor((entry) =>
        isResponse(entry, "watch-symlink"),
      );
      assert.ok(symlinkWatch.kind === "response" && !symlinkWatch.ok);
      assert.equal(symlinkWatch.error.code, "invalid_config_path");

      transport.receive(createRequest("watch-escape", "config.watch", {
        target: { kind: "document", path: "../escaped.json", scope: "global" },
      }));
      const escapedWatch = await transport.waitFor((entry) => isResponse(entry, "watch-escape"));
      assert.ok(escapedWatch.kind === "response" && !escapedWatch.ok);
      assert.equal(escapedWatch.error.code, "invalid_config_path");

      transport.receive(createRequest("close", "session.close", {
        sessionId: (created.result as SessionSnapshot).sessionId,
      }));
      const closed = await transport.waitFor((entry) => isResponse(entry, "close"));
      assert.ok(closed.kind === "response" && closed.ok);
      const configEventCount = transport.sent.filter((entry) =>
        isEvent(entry, "config.changed"),
      ).length;
      const afterCloseSettings = join(agentDir, "settings.json.after-close");
      await writeFile(afterCloseSettings, "{\"theme\":\"closed\"}\n", "utf8");
      await rename(afterCloseSettings, join(agentDir, "settings.json"));
      await writeFile(join(cwd, ".plugin", "native.jsonc"), "{\"closed\":true}\n", "utf8");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      assert.equal(
        transport.sent.filter((entry) => isEvent(entry, "config.changed")).length,
        configEventCount,
      );
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("denies project configuration watches when the project is not trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-config-watch-trust-"));
    const cwd = join(root, "workspace");
    const transport = new MemoryHostTransport();
    const controller = new HostController({
      agentDir: join(root, "agent"),
      projectTrustOverride: false,
      transport,
    });
    controller.start();
    try {
      await mkdir(cwd, { recursive: true });
      transport.receive(createRequest("create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "create"));
      assert.ok(created.kind === "response" && created.ok);
      transport.receive(createRequest("watch-project-settings", "config.watch", {
        target: { kind: "settings", scope: "project" },
      }));
      const denied = await transport.waitFor((entry) =>
        isResponse(entry, "watch-project-settings"),
      );
      assert.ok(denied.kind === "response" && !denied.ok);
      assert.equal(denied.error.code, "project_not_trusted");
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports a bounded protocol error and closes a malformed connection", async () => {
    const transport = new MemoryHostTransport();
    const controller = new HostController({ transport });
    controller.start();
    transport.fail(new ProtocolDecodeError("frame_too_large", "Protocol frame is too large"));
    const failure = await transport.waitFor((entry) => isEvent(entry, "host.error"));
    assert.ok(failure.kind === "event" && failure.event === "host.error");
    assert.equal(failure.data.code, "frame_too_large");
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(
      () => transport.receive(createRequest("after-close", "host.shutdown", {})),
      /not started/i,
    );
  });

  it("serializes session lifecycle requests while allowing trust responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-queue-"));
    const agentDir = join(root, "agent");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const workspaces = [workspaceA, workspaceB];
    for (const workspace of workspaces) {
      await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
      await writeFile(
        join(workspace, ".pi", "extensions", "noop.ts"),
        "export default function noop() {}\n",
      );
    }
    const transport = new MemoryHostTransport();
    const controller = new HostController({ agentDir, transport });
    controller.start();
    try {
      transport.receive(createRequest("create-a", "session.create", { cwd: workspaceA }));
      transport.receive(createRequest("create-b", "session.create", { cwd: workspaceB }));
      const firstTrust = await transport.waitFor((entry) =>
        isEvent(entry, "project.trust.request"),
      );
      assert.ok(firstTrust.kind === "event" && firstTrust.event === "project.trust.request");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        transport.sent.filter((entry) => isEvent(entry, "project.trust.request")).length,
        1,
      );
      // Out-of-band calls must bypass a queued lifecycle request: during an
      // Agent tool call the queued prompt is likewise waiting for a response.
      transport.receive(createRequest("journal-oob", "agent.abort", { sessionId: "not-active" }));
      const journal = await transport.waitFor((entry) => isResponse(entry, "journal-oob"));
      assert.ok(journal.kind === "response" && !journal.ok);
      transport.receive(
        createRequest("trust-a", "project.trust.respond", {
          remember: false,
          requestId: firstTrust.data.id,
          trusted: true,
        }),
      );
      const createdA = await transport.waitFor((entry) => isResponse(entry, "create-a"));
      assert.ok(createdA.kind === "response" && createdA.ok);

      const secondTrust = await transport.waitFor(
        (entry) =>
          isEvent(entry, "project.trust.request") &&
          entry.event === "project.trust.request" &&
          entry.data.id !== firstTrust.data.id,
      );
      assert.ok(secondTrust.kind === "event" && secondTrust.event === "project.trust.request");
      transport.receive(
        createRequest("trust-b", "project.trust.respond", {
          remember: false,
          requestId: secondTrust.data.id,
          trusted: true,
        }),
      );
      const createdB = await transport.waitFor((entry) => isResponse(entry, "create-b"));
      assert.ok(createdB.kind === "response" && createdB.ok);
      assert.equal((createdB.result as SessionSnapshot).cwd, workspaceB);
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("overlaps embedding network waits while retaining batch cancellation isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-embedding-concurrency-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ harness: {
      embedding: { protocol: "openai-compatible", providerId: "embed-provider", modelId: "embed-1", dimensions: 2 },
    } }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      "embed-provider": { name: "Embed", baseUrl: "https://models.example/v1", api: "openai-completions", apiKey: "test-key", models: [] },
    } }));
    let resolveEntered!: () => void;
    let resolveRelease!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const release = new Promise<void>((resolve) => { resolveRelease = resolve; });
    let calls = 0;
    const transport = new MemoryHostTransport();
    const controller = new HostController({ agentDir, transport, projectTrustOverride: true,
      inferenceFetch: async (_url, init) => {
        calls++;
        if (calls === 2) resolveEntered();
        const signal = init?.signal;
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException("cancelled", "AbortError"));
          if (signal?.aborted) return abort();
          signal?.addEventListener("abort", abort, { once: true });
          void release.then(() => { signal?.removeEventListener("abort", abort); resolve(); });
        });
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    controller.start();
    try {
      transport.receive(createRequest("create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "create"), 15_000);
      assert.ok(created.kind === "response" && created.ok);
      transport.receive(createRequest("describe", "harness.inference.describe", {}));
      const described = await transport.waitFor((entry) => isResponse(entry, "describe"), 15_000);
      assert.ok(described.kind === "response" && described.ok);
      const snapshot = described.result as HarnessInferenceBindingSnapshot;
      assert.equal(snapshot.embedding.status, "ready");
      if (snapshot.embedding.status !== "ready") throw new Error("embedding binding unavailable");
      const binding = snapshot.embedding.binding;
      const params = (batchId: string) => ({ batchId, configurationId: binding.configurationId,
        ...(binding.dimensions !== undefined ? { dimensions: binding.dimensions } : {}), items: [{ id: "q", text: "concurrent" }],
        maxTokens: binding.maxTokens ?? 8192, modelId: binding.modelId,
        protocol: "openai-compatible" as const, providerId: binding.providerId, purpose: "query" as const });
      transport.receive(createRequest("first", "harness.embed", params("first-batch")));
      transport.receive(createRequest("second", "harness.embed", params("second-batch")));
      // Neither fetch is released. The second must enter before the first ends.
      await Promise.race([entered, new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("second embedding remained serialized")), 5_000);
        timer.unref();
      })]);
      transport.receive(createRequest("cancel-first", "harness.inference.cancel", { batchId: "first-batch" }));
      const cancelled = await transport.waitFor((entry) => isResponse(entry, "cancel-first"));
      assert.ok(cancelled.kind === "response" && cancelled.ok);
      const first = await transport.waitFor((entry) => isResponse(entry, "first"));
      assert.ok(first.kind === "response" && !first.ok);
      resolveRelease();
      const second = await transport.waitFor((entry) => isResponse(entry, "second"));
      assert.ok(second.kind === "response" && second.ok);
      assert.equal(calls, 2);
    } finally {
      resolveRelease();
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cancels queued inference and releases rejected or invalid batch reservations", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-inference-queue-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      harness: {
        embedding: {
          protocol: "openai-compatible",
          providerId: "embed-provider",
          modelId: "embed-1",
          dimensions: 2,
        },
      },
    }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "embed-provider": {
          name: "Embed",
          baseUrl: "https://models.example/v1",
          api: "openai-completions",
          models: [],
        },
      },
    }));

    let fetchCalls = 0;
    const transport = new MemoryHostTransport();
    const controller = new HostController({
      agentDir,
      inferenceFetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({
          data: [{ index: 0, embedding: [1, 0] }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      projectTrustOverride: true,
      transport,
    });
    controller.start();
    try {
      transport.receive(createRequest("create", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "create"), 15_000);
      assert.ok(created.kind === "response" && created.ok);

      transport.receive(createRequest("describe-inference", "harness.inference.describe", {}));
      const described = await transport.waitFor(
        (entry) => isResponse(entry, "describe-inference"),
        15_000,
      );
      assert.ok(described.kind === "response" && described.ok);
      const snapshot = described.result as HarnessInferenceBindingSnapshot;
      assert.equal(snapshot.embedding.status, "ready");
      if (snapshot.embedding.status !== "ready") throw new Error("embedding binding unavailable");
      const binding = snapshot.embedding.binding;
      const embedParams = (batchId: string) => ({
        batchId,
        configurationId: binding.configurationId,
        ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }),
        items: [{ id: "q", text: "queued text" }],
        maxTokens: binding.maxTokens ?? 8192,
        modelId: binding.modelId,
        protocol: "openai-compatible" as const,
        providerId: binding.providerId,
        purpose: "query" as const,
      });

      transport.receive(createRequest("provider-login", "provider.login", {
        interactionId: "embed-provider-login-interaction",
        providerId: "embed-provider",
        type: "api_key",
      }));
      const authPrompt = await transport.waitFor(
        (entry) => isEvent(entry, "provider.auth.prompt"),
        15_000,
      );
      assert.ok(authPrompt.kind === "event" && authPrompt.event === "provider.auth.prompt");

      transport.receive(createRequest("queued-embed", "harness.embed", embedParams("same-batch")));
      transport.receive(createRequest(
        "duplicate-embed",
        "harness.embed",
        embedParams("same-batch"),
      ));
      transport.receive(createRequest("cancel-queued", "harness.inference.cancel", {
        batchId: "same-batch",
      }));
      const cancelled = await transport.waitFor((entry) => isResponse(entry, "cancel-queued"));
      assert.ok(cancelled.kind === "response" && cancelled.ok);
      assert.deepEqual(cancelled.result, { cancelled: true });

      transport.receive(createRequest("provider-auth-response", "provider.auth.respond", {
        requestId: authPrompt.data.prompt.requestId,
        value: "test-api-key",
      }));
      const [loggedIn, authResponse] = await Promise.all([
        transport.waitFor((entry) => isResponse(entry, "provider-login"), 15_000),
        transport.waitFor((entry) => isResponse(entry, "provider-auth-response"), 15_000),
      ]);
      assert.ok(loggedIn.kind === "response" && loggedIn.ok);
      assert.ok(authResponse.kind === "response" && authResponse.ok);

      const [queued, duplicate] = await Promise.all([
        transport.waitFor((entry) => isResponse(entry, "queued-embed"), 15_000),
        transport.waitFor((entry) => isResponse(entry, "duplicate-embed"), 15_000),
      ]);
      assert.ok(queued.kind === "response" && !queued.ok);
      assert.ok(duplicate.kind === "response" && !duplicate.ok);
      assert.equal(duplicate.error.code, "inference_batch_conflict");
      assert.equal(fetchCalls, 0);

      transport.receive(createRequest("invalid-embed", "harness.embed", {
        batchId: "reusable-batch",
      } as never));
      const invalid = await transport.waitFor((entry) => isResponse(entry, "invalid-embed"));
      assert.ok(invalid.kind === "response" && !invalid.ok);
      assert.equal(invalid.error.code, "invalid_params");

      transport.receive(createRequest(
        "valid-after-invalid",
        "harness.embed",
        embedParams("reusable-batch"),
      ));
      const valid = await transport.waitFor(
        (entry) => isResponse(entry, "valid-after-invalid"),
        15_000,
      );
      assert.ok(valid.kind === "response" && valid.ok);
      assert.equal(fetchCalls, 1);
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports the selected runtime source and package root in the handshake", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-runtime-"));
    const packageRoot = join(root, "external-pi");
    const transport = new MemoryHostTransport();
    const controller = new HostController({
      agentDir: join(root, "agent"),
      packageRoot,
      runtimeSource: "custom",
      transport,
    });
    controller.start();
    try {
      transport.receive(
        createRequest("handshake", "host.handshake", {
          clientName: "host-test",
          clientVersion: "0.0.0",
          mode: "test",
          protocolVersions: [VARIN_PROTOCOL_VERSION],
        }),
      );
      const handshake = await transport.waitFor((entry) => isResponse(entry, "handshake"));
      assert.ok(handshake.kind === "response" && handshake.ok);
      const runtime = (
        handshake.result as {
          runtime: { packageRoot?: string; source: string };
        }
      ).runtime;
      assert.equal(runtime.source, "custom");
      assert.equal(runtime.packageRoot, packageRoot);
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("enforces catalog and package worker ownership inside the Host", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-role-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });

    const catalogTransport = new MemoryHostTransport();
    const catalog = new HostController({ agentDir, transport: catalogTransport, workerRole: "catalog" });
    catalog.start();
    const packageTransport = new MemoryHostTransport();
    const packageWorker = new HostController({
      agentDir,
      transport: packageTransport,
      workerRole: "package",
    });
    packageWorker.start();
    try {
      catalogTransport.receive(createRequest("catalog-list", "session.list", {}));
      const catalogList = await catalogTransport.waitFor((entry) => isResponse(entry, "catalog-list"));
      assert.ok(catalogList.kind === "response" && catalogList.ok);

      catalogTransport.receive(createRequest("catalog-context", "catalog.context.open", { cwd: root }));
      const catalogDenied = await catalogTransport.waitFor((entry) => isResponse(entry, "catalog-context"));
      assert.ok(catalogDenied.kind === "response" && !catalogDenied.ok);
      assert.equal(catalogDenied.error.code, "worker_role_violation");

      packageTransport.receive(createRequest("package-list", "package.list", {}));
      const packages = await packageTransport.waitFor((entry) => isResponse(entry, "package-list"));
      assert.ok(packages.kind === "response" && packages.ok);
      assert.deepEqual(packages.result, []);

      packageTransport.receive(createRequest("package-session", "session.list", {}));
      const packageDenied = await packageTransport.waitFor((entry) => isResponse(entry, "package-session"));
      assert.ok(packageDenied.kind === "response" && !packageDenied.ok);
      assert.equal(packageDenied.error.code, "worker_role_violation");
    } finally {
      await Promise.all([catalog.dispose(), packageWorker.dispose()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects an unbound Harness request immediately while a session method waits", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-unbound-harness-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    const transport = new MemoryHostTransport();
    const controller = new HostController({ agentDir, transport });
    controller.start();
    try {
      transport.receive(createRequest("handshake-unbound", "host.handshake", {
        clientName: "host-test", clientVersion: "0.0.0", mode: "test",
        protocolVersions: [VARIN_PROTOCOL_VERSION],
      }));
      const handshake = await transport.waitFor((entry) => isResponse(entry, "handshake-unbound"));
      assert.ok(handshake.kind === "response" && handshake.ok);
      transport.receive(createRequest("create-unbound", "session.create", { cwd }));
      const created = await transport.waitFor((entry) => isResponse(entry, "create-unbound"));
      assert.ok(created.kind === "response" && created.ok);
      const sessionId = (created.result as SessionSnapshot).sessionId;
      assert.ok(typeof sessionId === "string" && sessionId.length > 0);

      transport.receive(createRequest("reject-unbound", "harness.rejectUnbound", {
        requestId: "hr_missing",
      }));
      const rejected = await transport.waitFor((entry) => isResponse(entry, "reject-unbound"));
      assert.ok(rejected.kind === "response" && rejected.ok);
      assert.deepEqual(rejected.result, { accepted: false });
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
