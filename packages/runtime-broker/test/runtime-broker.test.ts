import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { VARIN_PROTOCOL_VERSION } from "@varin/protocol";
import type { PiRuntimeBrokerEvent } from "../src/index.js";
import {
  dispatchRuntimeRequest,
  PiRuntimeBroker,
  RuntimeDispatchError,
} from "../src/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

test("broker owns catalog and per-session Pi workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-runtime-broker-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "broker-smoke.ts"),
    `export default function extension(pi: any) {
      pi.registerCommand("broker-seed", {
        description: "Create a deterministic broker integration entry",
        handler: async () => pi.appendEntry("varin.broker.smoke", {
          agentDir: process.env.PI_CODING_AGENT_DIR,
          ready: true,
        }),
      });
    }\n`,
  );
  const events: PiRuntimeBrokerEvent[] = [];
  const subscribedEvents: PiRuntimeBrokerEvent[] = [];
  const broker = new PiRuntimeBroker({
    agentDir,
    authorityInstanceId: "runtime-broker-test-authority",
    client: {
      clientName: "runtime-broker-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    emit: (event) => {
      events.push(event);
      if (event.kind === "host" && event.envelope.event === "project.trust.request") {
        throw new Error("observer failure must not block trust resolution");
      }
    },
    environment: { HOME: homeDir, PI_CODING_AGENT_DIR: join(root, "wrong-agent") },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    promptForProjectTrust: async () => ({ remember: false, trusted: true }),
  });
  const unsubscribe = broker.subscribe((event) => subscribedEvents.push(event));

  try {
    const handshake = await dispatchRuntimeRequest(broker, "host.handshake", {
      clientName: "surface-test",
      clientVersion: "0.1.0",
      mode: "test",
      protocolVersions: [VARIN_PROTOCOL_VERSION],
    });
    assert.equal(handshake.protocolVersion, VARIN_PROTOCOL_VERSION);
    assert.equal(broker.catalogStarted, true);
    assert.deepEqual(await broker.listSessions(workspace), []);
    const workspaceProvider = await dispatchRuntimeRequest(
      broker,
      "provider.config.upsert",
      {
        config: {
          api: "openai-completions",
          baseUrl: "https://workspace-provider.example.test/v1",
          id: "workspace-provider",
          models: [{ id: "workspace-model", name: "Workspace model" }],
        },
        cwd: workspace,
        scope: "project",
      },
    );
    assert.equal(workspaceProvider.effectiveScope, "project");
    assert.ok(
      (await dispatchRuntimeRequest(broker, "command.list", { cwd: workspace }))
        .some((command) => command.name === "broker-seed"),
    );
    assert.ok(
      (await dispatchRuntimeRequest(broker, "provider.list", { cwd: workspace })).some(
        (provider) => provider.id === "workspace-provider",
      ),
    );
    const agentCatalog = await dispatchRuntimeRequest(broker, "agentProvider.list", {
      cwd: workspace,
    });
    assert.equal(agentCatalog.projectTrusted, true);
    assert.ok(agentCatalog.providers.some((provider) => provider.id === "varin" && provider.available));
    assert.ok(agentCatalog.agents.some((agent) => agent.providerId === "varin" && agent.source.scope === "builtin"));
    const mcpConfig = await dispatchRuntimeRequest(broker, "mcp.config.snapshot", {
      cwd: workspace,
    });
    assert.equal(mcpConfig.provider.owner, "native");
    assert.equal(mcpConfig.provider.state, "active");
    assert.deepEqual(mcpConfig.catalog?.servers, []);
    const packageRoot = join(root, "broker-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "broker-package", pi: { extensions: ["./index.ts"] } })}\n`,
    );
    await writeFile(
      join(packageRoot, "index.ts"),
      `export default function (pi: any) {
        pi.registerCommand("broker-package-command", { description: "Broker package", handler() {} });
      }\n`,
    );
    const installedPackage = await dispatchRuntimeRequest(broker, "package.install", {
      cwd: workspace,
      scope: "project",
      source: packageRoot,
    });
    assert.equal(installedPackage.enabled, true);
    const disabledPackage = await dispatchRuntimeRequest(broker, "package.setEnabled", {
      cwd: workspace,
      enabled: false,
      scope: "project",
      source: installedPackage.source,
    });
    assert.equal(disabledPackage.enabled, false);
    assert.equal(
      (await dispatchRuntimeRequest(broker, "command.list", { cwd: workspace }))
        .some((command) => command.name === "broker-package-command"),
      false,
    );
    const reenabledPackage = await dispatchRuntimeRequest(broker, "package.setEnabled", {
      cwd: workspace,
      enabled: true,
      scope: "project",
      source: installedPackage.source,
    });
    assert.equal(reenabledPackage.enabled, true);
    assert.equal(
      (await dispatchRuntimeRequest(broker, "command.list", { cwd: workspace }))
        .some((command) => command.name === "broker-package-command"),
      true,
    );
    const settingsBeforeUpdate = await dispatchRuntimeRequest(broker, "settings.get", {
      cwd: workspace,
    });
    const updatedSettings = await dispatchRuntimeRequest(broker, "settings.update", {
      cwd: workspace,
      expectedRevision: settingsBeforeUpdate.projectRevision,
      remove: [],
      scope: "project",
      set: {
        workspaceHistory: {
          enabled: true,
          maxSessionsPerWorkspace: 12,
        },
      },
    });
    assert.deepEqual(updatedSettings.project.workspaceHistory, {
      enabled: true,
      maxSessionsPerWorkspace: 12,
    });
    assert.deepEqual(
      (await dispatchRuntimeRequest(broker, "settings.get", { cwd: workspace })).project,
      updatedSettings.project,
    );
    const wtfBeforeUpdate = await dispatchRuntimeRequest(
      broker,
      "config.document.get",
      { cwd: workspace, path: "wtf.json", scope: "global" },
    );
    const updatedWtfConfig = await dispatchRuntimeRequest(
      broker,
      "config.document.update",
      {
        cwd: workspace,
        expectedRevision: wtfBeforeUpdate.revision,
        path: "wtf.json",
        remove: [],
        scope: "global",
        set: { words: ["oops"] },
      },
    );
    assert.deepEqual(updatedWtfConfig.document, { words: ["oops"] });
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "config.document.get", {
        cwd: workspace,
        path: "wtf.json",
        scope: "global",
      }),
      updatedWtfConfig,
    );
    const emptyMagicConfig = await dispatchRuntimeRequest(broker, "config.text.get", {
      cwd: workspace,
      format: "jsonc",
      path: ".cortexkit/magic-context.jsonc",
      root: "project",
    });
    const magicContent = "{\n  // Owned by Magic Context\n  \"enabled\": true,\n}\n";
    const updatedMagicConfig = await dispatchRuntimeRequest(broker, "config.text.update", {
      content: magicContent,
      cwd: workspace,
      expectedRevision: emptyMagicConfig.revision,
      format: "jsonc",
      path: ".cortexkit/magic-context.jsonc",
      root: "project",
    });
    assert.equal(updatedMagicConfig.content, magicContent);
    assert.equal(
      (await dispatchRuntimeRequest(broker, "config.text.get", {
        cwd: workspace,
        format: "jsonc",
        path: ".cortexkit/magic-context.jsonc",
        root: "project",
      })).revision,
      updatedMagicConfig.revision,
    );
    const emptyHomeMcpConfig = await dispatchRuntimeRequest(broker, "config.text.get", {
      cwd: workspace,
      format: "json",
      path: ".config/mcp/mcp.json",
      root: "home",
    });
    const homeMcpContent = "{\n  \"mcpServers\": {}\n}\n";
    const updatedHomeMcpConfig = await dispatchRuntimeRequest(broker, "config.text.update", {
      content: homeMcpContent,
      cwd: workspace,
      expectedRevision: emptyHomeMcpConfig.revision,
      format: "json",
      path: ".config/mcp/mcp.json",
      root: "home",
    });
    assert.equal(updatedHomeMcpConfig.root, "home");
    assert.equal(updatedHomeMcpConfig.content, homeMcpContent);
    assert.equal(
      await readFile(join(homeDir, ".config", "mcp", "mcp.json"), "utf8"),
      homeMcpContent,
    );
    const promptContent = "---\ndescription: Broker-managed prompt\n---\nCheck $1.\n";
    const createdPrompt = await dispatchRuntimeRequest(broker, "resource.create", {
      content: promptContent,
      cwd: workspace,
      kind: "prompt",
      name: "broker-check",
      scope: "project",
    });
    assert.equal(createdPrompt.content, promptContent);
    assert.equal(createdPrompt.descriptor.writable, true);
    assert.ok(
      (await dispatchRuntimeRequest(broker, "resource.list", {
        cwd: workspace,
        kind: "prompt",
      })).resources.some((resource) => resource.id === createdPrompt.descriptor.id),
    );
    assert.equal(
      (await dispatchRuntimeRequest(broker, "resource.get", {
        cwd: workspace,
        id: createdPrompt.descriptor.id,
        kind: "prompt",
      })).revision,
      createdPrompt.revision,
    );
    const updatedPrompt = await dispatchRuntimeRequest(broker, "resource.update", {
      content: `${promptContent}\nFollow repository conventions.\n`,
      cwd: workspace,
      expectedRevision: createdPrompt.revision,
      id: createdPrompt.descriptor.id,
      kind: "prompt",
    });
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "resource.delete", {
        cwd: workspace,
        expectedRevision: updatedPrompt.revision,
        id: updatedPrompt.descriptor.id,
        kind: "prompt",
      }),
      { deleted: true, id: createdPrompt.descriptor.id },
    );
    assert.deepEqual(broker.activeSessionIds, []);
    let stopAuthPromptListener = () => {};
    const authPrompt = new Promise<{ interactionId: string; requestId: string; sessionId: string }>((resolvePrompt) => {
      stopAuthPromptListener = broker.subscribe((event) => {
        if (event.kind !== "host" || event.envelope.event !== "provider.auth.prompt") return;
        if (event.envelope.data.providerId !== "workspace-provider") return;
        resolvePrompt({
          interactionId: event.envelope.data.interactionId,
          requestId: event.envelope.data.prompt.requestId,
          sessionId: event.envelope.data.sessionId,
        });
      });
    });
    const login = dispatchRuntimeRequest(broker, "provider.login", {
      cwd: workspace,
      interactionId: "broker-login-interaction",
      providerId: "workspace-provider",
      type: "api_key",
    });
    const prompt = await authPrompt;
    stopAuthPromptListener();
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "provider.auth.respond", {
        response: { requestId: prompt.requestId, value: "workspace-test-key" },
        sessionId: prompt.sessionId,
      }),
      { accepted: true },
    );
    assert.deepEqual(await login, { authenticated: true });
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "provider.auth.cancel", {
        cwd: workspace,
        interactionId: prompt.interactionId,
      }),
      { cancelled: false },
    );

    const created = await dispatchRuntimeRequest(broker, "session.create", {
      cwd: workspace,
      name: "Broker smoke",
      workspace: { id: "workspace-broker", kind: "workspace" },
    });
    assert.deepEqual(broker.activeSessionIds, [created.sessionId]);
    assert.deepEqual(created.workspace, { id: "workspace-broker", kind: "workspace" });
    assert.deepEqual((await broker.listSessions(workspace))[0]?.workspace, {
      id: "workspace-broker",
      kind: "workspace",
    });
    const rebound = await dispatchRuntimeRequest(broker, "session.open", {
      sessionId: created.sessionId,
      workspace: {
        authorityId: "workspace-canonical",
        id: "workspace-broker",
        kind: "workspace",
      },
    });
    assert.deepEqual(rebound.workspace, {
      authorityId: "workspace-canonical",
      id: "workspace-broker",
      kind: "workspace",
    });
    assert.deepEqual(
      (await broker.requestForSession(created.sessionId, "session.snapshot", {
        sessionId: created.sessionId,
      })).workspace,
      { authorityId: "workspace-canonical", id: "workspace-broker", kind: "workspace" },
    );
    assert.deepEqual(created.features, {
      revision: 0,
      schemaVersion: 1,
    });
    const goalFeatures = await dispatchRuntimeRequest(broker, "session.features.mutate", {
      mutation: {
        objective: "Finish the broker-owned Pi migration",
        tokenBudget: 50_000,
        type: "goal.start",
      },
      sessionId: created.sessionId,
    });
    assert.equal(goalFeatures.goal?.objective, "Finish the broker-owned Pi migration");
    assert.equal(goalFeatures.goal?.tokenBudget, 50_000);
    const trustedSnapshotEvent = events.find((event) => (
      event.kind === "host"
      && event.role === "session"
      && event.sessionId === created.sessionId
      && event.envelope.event === "session.snapshot"
      && event.envelope.data.sessionId === created.sessionId
    ));
    assert.ok(trustedSnapshotEvent?.kind === "host");
    assert.equal(trustedSnapshotEvent.actor?.authorityInstanceId, "runtime-broker-test-authority");
    assert.equal(trustedSnapshotEvent.actor?.sessionId, created.sessionId);
    assert.equal(trustedSnapshotEvent.actor?.workerId, trustedSnapshotEvent.workerId);
    assert.equal(trustedSnapshotEvent.actor?.workerGeneration, 1);
    assert.equal(typeof trustedSnapshotEvent.actor?.runId, "string");
    assert.deepEqual(
      (trustedSnapshotEvent.envelope.data as { workspace?: unknown }).workspace,
      { id: "workspace-broker", kind: "workspace" },
      "the deferred snapshot must be published only after broker workspace metadata is available",
    );
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "session.features.get", {
        sessionId: created.sessionId,
      }),
      goalFeatures,
    );
    const recoveryStatus = await dispatchRuntimeRequest(broker, "recovery.status", {
      sessionId: created.sessionId,
    });
    assert.ok(recoveryStatus.modes.includes("conversation"));
    assert.ok(recoveryStatus.providers.some((provider) => provider.id === "pi-native"));
    const fleetStatus = await dispatchRuntimeRequest(broker, "fleet.status", {
      sessionId: created.sessionId,
    });
    assert.deepEqual(fleetStatus.entries, []);
    const subagents = fleetStatus.providers.find((provider) => provider.id === "pi-subagents");
    const backgroundTasks = fleetStatus.providers.find((provider) => provider.id === "pi-background-tasks");
    assert.equal(subagents?.state, "unavailable");
    assert.ok(backgroundTasks);
    const models = await dispatchRuntimeRequest(broker, "model.list", {
      sessionId: created.sessionId,
    });
    assert.ok(Array.isArray(models));
    const providerDetails = await dispatchRuntimeRequest(broker, "provider.config.upsert", {
      config: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
        id: "broker-provider",
        models: [{ id: "broker-model", name: "Broker model" }],
        name: "Broker provider",
      },
      scope: "user",
      sessionId: created.sessionId,
    });
    assert.equal(providerDetails.effectiveScope, "user");
    assert.ok(
      (await dispatchRuntimeRequest(broker, "provider.list", {
        sessionId: created.sessionId,
      })).some((provider) => provider.id === "broker-provider"),
    );
    await assert.rejects(
      dispatchRuntimeRequest(broker, "provider.config.upsert", {
        config: {
          api: "openai-completions",
          baseUrl: "file:///tmp/provider",
          id: "invalid-provider",
          models: [],
        },
        scope: "user",
        sessionId: created.sessionId,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeDispatchError);
        assert.equal(error.code, "invalid_params");
        return true;
      },
    );
    const commands = await broker.requestForSession(created.sessionId, "command.list", {
      sessionId: created.sessionId,
    });
    assert.ok(commands.some((command) => command.name === "broker-seed"));
    await broker.requestForSession(created.sessionId, "command.execute", {
      command: "/broker-seed",
      sessionId: created.sessionId,
    });
    const entries = await broker.requestForSession(created.sessionId, "session.entries", {
      scope: "branch",
      sessionId: created.sessionId,
    });
    assert.equal(entries.scope, "branch");
    assert.ok(
      entries.entries.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry.type === "custom" &&
          entry.customType === "varin.broker.smoke",
      ),
    );
    assert.ok(
      entries.entries.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry.type === "custom" &&
          entry.customType === "varin.broker.smoke" &&
          typeof entry.data === "object" &&
          entry.data !== null &&
          !Array.isArray(entry.data) &&
          entry.data.agentDir === agentDir,
      ),
    );
    const tree = await dispatchRuntimeRequest(broker, "session.tree", {
      sessionId: created.sessionId,
    });
    assert.equal(tree.sessionId, created.sessionId);
    assert.match(JSON.stringify(tree.tree), /varin\.broker\.smoke/);

    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "session.rename", {
        name: "Broker renamed",
        sessionId: created.sessionId,
      }),
      { name: "Broker renamed", sessionId: created.sessionId },
    );
    assert.equal(
      (await dispatchRuntimeRequest(broker, "session.archive", {
        sessionId: created.sessionId,
      })).id,
      created.sessionId,
    );
    assert.ok((await broker.listSessions(workspace))[0]?.archivedAt);
    const restored = await dispatchRuntimeRequest(broker, "session.unarchive", {
      sessionId: created.sessionId,
    });
    assert.equal(restored.archivedAt, undefined);
    assert.equal((await broker.listSessions(workspace))[0]?.archivedAt, undefined);

    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "session.delete", {
        sessionId: created.sessionId,
      }),
      { deleted: true, sessionId: created.sessionId },
    );
    assert.deepEqual(broker.activeSessionIds, []);
    assert.deepEqual(await broker.listSessions(workspace), []);
    assert.ok(events.some((event) => event.kind === "host"));
    assert.ok(subscribedEvents.some((event) => event.kind === "host"));
    await assert.rejects(
      dispatchRuntimeRequest(broker, "session.open", {}),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeDispatchError);
        assert.equal(error.code, "invalid_params");
        return true;
      },
    );
  } finally {
    unsubscribe();
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    await rm(root, { force: true, recursive: true });
  }
});

test("session deletion retires a worker when an extension shutdown hook never settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-runtime-delete-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "stuck-shutdown.ts"),
    `export default function extension(pi: any) {
      pi.on("session_shutdown", async () => new Promise(() => {}));
    }\n`,
  );
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "runtime-delete-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
    shutdownTimeoutMs: 100,
  });

  try {
    const created = await broker.createSession(workspace, "Delete without hanging");
    const startedAt = Date.now();
    assert.deepEqual(await broker.deleteSession(created.sessionId), {
      deleted: true,
      sessionId: created.sessionId,
    });
    assert.ok(Date.now() - startedAt < 2_000);
    assert.deepEqual(broker.activeSessionIds, []);
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("session preview reads persisted history without activating a session worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-runtime-preview-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const safePath = `--${resolve(workspace).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  const sessionId = "preview-session";
  const sessionFile = join(sessionDir, "preview.jsonl");
  await mkdir(workspace, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, [
    JSON.stringify({
      cwd: workspace,
      id: sessionId,
      timestamp: "2026-08-26T00:00:00.000Z",
      type: "session",
      version: 3,
    }),
    JSON.stringify({
      id: "preview-user",
      message: { content: "hello", role: "user", timestamp: 1 },
      parentId: null,
      timestamp: "2026-08-26T00:00:01.000Z",
      type: "message",
    }),
    "",
  ].join("\n"), "utf8");
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "runtime-preview-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
  });

  try {
    const preview = await dispatchRuntimeRequest(broker, "session.entries.preview", {
      cwd: workspace,
      scope: "branch",
      sessionId,
    });
    assert.equal(preview.sessionId, sessionId);
    assert.equal(preview.entries[0]?.id, "preview-user");
    assert.deepEqual(broker.activeSessionIds, []);
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("surface explicitly resolves project trust without a broker-owned deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-runtime-trust-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "trusted.ts"),
    `export default function extension(pi: any) {
      pi.registerCommand("trusted-command", { handler: async () => undefined });
    }\n`,
  );
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "runtime-trust-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
  });

  try {
    let stop = () => {};
    const trustRequest = new Promise<{ requestId: string; workerId: string }>((resolveRequest) => {
      stop = broker.subscribe((event) => {
        if (event.kind !== "host" || event.envelope.event !== "project.trust.request") return;
        resolveRequest({
          requestId: event.envelope.data.id,
          workerId: event.workerId,
        });
      });
    });
    const creating = broker.createSession(workspace, "Trust from surface");
    const request = await trustRequest;
    stop();

    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "project.trust.respond", {
        remember: false,
        requestId: request.requestId,
        trusted: true,
        workerId: request.workerId,
      }),
      { accepted: true },
    );
    const created = await creating;
    const commands = await broker.requestForSession(created.sessionId, "command.list", {
      sessionId: created.sessionId,
    });
    assert.ok(commands.some((command) => command.name === "trusted-command"));
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "project.trust.respond", {
        remember: false,
        requestId: request.requestId,
        trusted: true,
        workerId: request.workerId,
      }),
      { accepted: false },
    );
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("workspace configuration watches survive catalog context switches and cancel explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-runtime-config-watch-"));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const agentDir = join(root, "agent");
  await mkdir(join(workspaceA, ".pi"), { recursive: true });
  await mkdir(join(workspaceB, ".pi"), { recursive: true });
  const events: PiRuntimeBrokerEvent[] = [];
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "runtime-config-watch-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
  });
  const unsubscribe = broker.subscribe((event) => events.push(event));
  try {
    await assert.rejects(
      dispatchRuntimeRequest(broker, "config.watch", {
        cwd: workspaceA,
        target: { kind: "document", path: "native.json", scope: "project" },
      }),
      (error: unknown) => (
        error instanceof RuntimeDispatchError
        && error.code === "persistent_connection_required"
      ),
    );
    const watch = await broker.watchConfig(
      { cwd: workspaceA },
      { kind: "document", path: "native.json", scope: "project" },
    );
    await dispatchRuntimeRequest(broker, "settings.get", { cwd: workspaceB });

    const temporary = join(workspaceA, ".pi", "native.json.atomic");
    await writeFile(temporary, "{\"external\":true}\n", "utf8");
    await rename(temporary, join(workspaceA, ".pi", "native.json"));
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (events.some((event) =>
        event.kind === "host"
        && event.envelope.event === "config.changed"
        && event.envelope.data.watchId === watch.watchId
      )) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.ok(events.some((event) =>
      event.kind === "host"
      && event.envelope.event === "config.changed"
      && event.envelope.data.watchId === watch.watchId,
    ));

    assert.deepEqual(
      await broker.unwatchConfig(watch.watchId),
      { unwatched: true },
    );
    const eventCount = events.filter((event) =>
      event.kind === "host"
      && event.envelope.event === "config.changed"
      && event.envelope.data.watchId === watch.watchId,
    ).length;
    const replacement = join(workspaceA, ".pi", "native.json.replacement");
    await writeFile(replacement, "{\"external\":false}\n", "utf8");
    await rename(replacement, join(workspaceA, ".pi", "native.json"));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
    assert.equal(
      events.filter((event) =>
        event.kind === "host"
        && event.envelope.event === "config.changed"
        && event.envelope.data.watchId === watch.watchId,
      ).length,
      eventCount,
    );
  } finally {
    unsubscribe();
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
