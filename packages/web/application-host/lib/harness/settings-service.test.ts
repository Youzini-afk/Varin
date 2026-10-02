import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { VarinSettingsDocument } from "@varin/settings-store";
import type { PiSettingsSnapshot } from "@varin/protocol";
import { createSettingsService, settingsDocumentRevision, type ClientSurfaceBridge, type SettingsActionOperationStore, type SettingsServiceDeps } from "./settings-service.js";
import type { SettingsActionRegistry } from "./settings-actions.js";
import { HarnessServiceError } from "./service-error.js";

/**
 * Focused contract tests for the shared-catalog settings service (D-306).
 * The point under test is authority routing: app-document CAS, pi-settings
 * scope rules, honest read-only/action surfaces — not the catalog text.
 */

const caller = { workspaceId: "ws-1", sessionId: "session-1" };

interface PiFixture {
  global: Record<string, unknown>;
  project: Record<string, unknown>;
  projectTrusted: boolean;
  updates: { scope: string; expectedRevision: string; set: Record<string, unknown>; remove: string[] }[];
}

function makePiSnapshot(fixture: PiFixture): PiSettingsSnapshot {
  return {
    global: fixture.global as PiSettingsSnapshot["global"],
    globalRevision: settingsDocumentRevision(fixture.global as VarinSettingsDocument),
    project: fixture.project as PiSettingsSnapshot["project"],
    projectRevision: settingsDocumentRevision(fixture.project as VarinSettingsDocument),
    projectTrusted: fixture.projectTrusted,
  };
}

function basePersistFactory(getApp: () => VarinSettingsDocument, setApp: (doc: VarinSettingsDocument) => void) {
  return async (changes: Record<string, unknown>, removals: readonly string[], expectedRevision: string | undefined) => {
    const appDocument = getApp();
    const revision = settingsDocumentRevision(appDocument);
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return { conflict: true, revision, document: appDocument };
    }
    const next: VarinSettingsDocument = structuredClone(appDocument);
    for (const [key, value] of Object.entries(changes)) {
      next[key] = value;
    }
    for (const key of removals) {
      delete next[key];
    }
    setApp(next);
    return { conflict: false, revision: settingsDocumentRevision(next), document: next };
  };
}

function baseDeps() {
  let appDocument: VarinSettingsDocument = {};
  const pi: PiFixture = { global: {}, project: {}, projectTrusted: true, updates: [] };
  const deps: SettingsServiceDeps = {
    readAppSettings: async () => structuredClone(appDocument),
    persistAppSettings: basePersistFactory(() => appDocument, (doc) => { appDocument = doc; }),
    requestPi: async (_cwd, method, params) => {
      if (method === "settings.get") return makePiSnapshot(pi);
      const update = params as PiFixture["updates"][number];
      pi.updates.push(update);
      const layer = update.scope === "project" ? pi.project : pi.global;
      for (const [key, value] of Object.entries(update.set)) layer[key] = value;
      for (const key of update.remove) delete layer[key];
      return makePiSnapshot(pi);
    },
    resolveWorkspaceRoot: async () => "/repo/workspace",
  };
  return { deps, pi, getApp: () => appDocument };
}

function fixture(overrides: {
  app?: VarinSettingsDocument;
  pi?: Partial<PiFixture>;
  onChanged?: SettingsServiceDeps["onChanged"];
  clientSurfaces?: ClientSurfaceBridge;
  actions?: SettingsActionRegistry;
  actionOperations?: SettingsActionOperationStore;
} = {}) {
  const base = baseDeps();
  let appDocument: VarinSettingsDocument = overrides.app ?? base.getApp();
  const pi: PiFixture = {
    global: overrides.pi?.global ?? base.pi.global,
    project: overrides.pi?.project ?? base.pi.project,
    projectTrusted: overrides.pi?.projectTrusted ?? true,
    updates: [],
  };
  const deps: SettingsServiceDeps = {
    ...base.deps,
    readAppSettings: async () => structuredClone(appDocument),
    persistAppSettings: basePersistFactory(() => appDocument, (doc) => { appDocument = doc; }),
    requestPi: async (_cwd, method, params) => {
      if (method === "settings.get") {
        return makePiSnapshot(pi);
      }
      const update = params as PiFixture["updates"][number];
      pi.updates.push(update);
      const layer = update.scope === "project" ? pi.project : pi.global;
      for (const [key, value] of Object.entries(update.set)) {
        layer[key] = value;
      }
      for (const key of update.remove) {
        delete layer[key];
      }
      return makePiSnapshot(pi);
    },
    ...(overrides.onChanged ? { onChanged: overrides.onChanged } : {}),
    ...(overrides.clientSurfaces ? { clientSurfaces: overrides.clientSurfaces } : {}),
    ...(overrides.actions ? { actions: overrides.actions } : {}),
    ...(overrides.actionOperations ? { actionOperations: overrides.actionOperations } : {}),
  };
  return { service: createSettingsService(deps), pi, getApp: () => appDocument };
}

/** Minimal real-adapter registry wired to the same fake Pi channel. */
function depsWithActions(
  calls: { method: string; params: unknown }[],
  opts: { fail?: boolean } = {},
): SettingsServiceDeps {
  const base = baseDeps();
  return {
    ...base.deps,
    actions: {
      adapterFor: (domain) => domain === "runtime:extensions" ? {
        verbs: ["list", "install", "remove"],
        describe: async () => ({ summary: "packages", verbs: ["list", "install", "remove"] }),
        invoke: async (_ctx, _entry, verb, _args) => {
          if (opts.fail) return { status: "unavailable", detail: "owner offline" };
          if (verb === "list") {
            calls.push({ method: "package.list", params: {} });
            return { status: "applied", data: [] };
          }
          return { status: "unavailable", detail: `verb ${verb} not wired` };
        },
      } : null,
    } as SettingsActionRegistry,
  };
}

/** Surface bridge stub: applies like a connected surface would. */
function fakeBridge(
  calls: unknown[],
  surfaces: { id: string; kind: string }[],
): ClientSurfaceBridge {
  return {
    listForSession: () => surfaces,
    request: async (op) => {
      if (surfaces.length === 0) {
        throw new HarnessServiceError("unavailable", "no client surface is connected to this host");
      }
      if (surfaces.length > 1) {
        throw new HarnessServiceError("ambiguous", "several authenticated surfaces are connected");
      }
      const surface = surfaces[0]!;
      calls.push(op);
      return {
        surface,
        results: op.entries.map((entry) => ({
          id: entry.id,
          status: "applied" as const,
          values: entry.values ?? { enabled: false },
        })),
      };
    },
  };
}

describe("settings service catalog search", () => {
  it("matches free text against ids, paths, and keywords", async () => {
    const { service } = fixture();
    const result = await service.search(caller, { query: "theme dark" });
    assert.ok(result.total >= 1);
    assert.ok(result.items.some((item) => item.id === "appearance.dark-theme"));
  });

  it("browses by category and paginates", async () => {
    const { service } = fixture();
    const all = await service.search(caller, { category: "chat", limit: 100 });
    assert.ok(all.items.every((item) => item.category === "chat"));
    const page = await service.search(caller, { category: "chat", limit: 3, offset: 0 });
    assert.equal(page.items.length, 3);
    assert.ok(page.total > 3);
  });

  it("locates a stable id exactly", async () => {
    const { service } = fixture();
    const result = await service.search(caller, { id: "harness.shell" });
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.owner, "pi-settings");
  });

  it("discovers document-reading settings and reports their resolved user defaults", async () => {
    const { service } = fixture();
    const search = await service.search(caller, { id: "harness.document-reading" });
    assert.equal(search.total, 1);
    assert.equal(search.items[0]?.writable, true);
    assert.deepEqual(search.items[0]?.paths, ["harness.documentReading"]);

    const read = await service.read(caller, { id: "harness.document-reading" });
    assert.equal(read.fields?.[0]?.isSet, false);
    assert.deepEqual(read.effective, {
      value: { doclingCommand: "docling", tesseractCommand: "tesseract", ocrLanguage: "eng" },
      source: "default",
    });
  });

  it("does not expose a trusted project document parser override as effective or saved user state", async () => {
    const { service } = fixture({ pi: {
      project: { harness: { documentReading: { doclingCommand: "project-docling" } } },
    } });
    const search = await service.search(caller, { id: "harness.document-reading" });
    assert.equal(search.items[0]?.summary?.source, "default");
    assert.deepEqual(search.items[0]?.summary?.value, {
      doclingCommand: "docling", tesseractCommand: "tesseract", ocrLanguage: "eng",
    });

    const read = await service.read(caller, { id: "harness.document-reading" });
    assert.equal(read.fields?.[0]?.isSet, false);
    assert.equal(read.effective?.source, "default");
    assert.deepEqual(read.effective?.value, {
      doclingCommand: "docling", tesseractCommand: "tesseract", ocrLanguage: "eng",
    });
  });

  it("summarizes simple entries without advertising verbs from an unwired owner", async () => {
    const { service } = fixture({
      app: { timeFormatPreference: "24h" },
      clientSurfaces: fakeBridge([], [{ id: "surf-1", kind: "desktop" }]),
    });
    const result = await service.search(caller, { id: "appearance.time-format" });
    const summary = result.items[0]?.summary;
    assert.equal(summary?.value, "24h");
    assert.equal(summary?.source, "user");
    assert.equal(summary?.fieldKind, "enum");
    assert.ok(summary?.options?.some((option) => option.value === "12h"));

    const actions = await service.search(caller, { id: "plugins.packages" });
    assert.deepEqual(actions.items[0]?.summary?.verbs, []);

    const client = await service.search(caller, { id: "chat.persist-drafts" });
    assert.equal(client.items[0]?.summary?.surfaces, 1);
  });
});

describe("settings read", () => {
  it("reads an app field with saved value and document revision", async () => {
    const { service } = fixture({ app: { themeVariant: "dark" } });
    const result = await service.read(caller, { id: "appearance.dark-theme" });
    assert.equal(result.state, "ok");
    const variant = result.fields?.find((field) => field.path === "themeVariant");
    assert.equal(variant?.saved, "dark");
    assert.equal(variant?.isSet, true);
    assert.ok(result.revision);
  });

  it("reports the real fresh-install auto-save default", async () => {
    const { service } = fixture();
    const result = await service.read(caller, { id: "appearance.auto-save-enabled" });
    assert.deepEqual(result.effective, { value: true, source: "default" });
  });

  it("masks secret fields to set/unset status", async () => {
    const { service } = fixture({ app: { desktopUiPassword: "hunter2" } });
    const result = await service.read(caller, { id: "sessions.desktop-ui-password" });
    const field = result.fields?.[0];
    assert.equal(field?.isSet, true);
    assert.equal(field?.saved, undefined);
  });

  it("resolves pi-settings effective value through project-over-global merge", async () => {
    const { service } = fixture({
      pi: {
        global: { harness: { shell: "powershell" } },
        project: { harness: { shell: "wsl" } },
      },
    });
    const result = await service.read(caller, { id: "harness.shell" });
    const shell = result.fields?.find((field) => field.path === "harness.shell");
    assert.equal(shell?.saved, "powershell");
    // effective read for multi-field entries comes through fields; single-field
    // entries populate `effective` — check domains (single-field json).
    const domains = await service.read(caller, { id: "harness.web.domains" });
    assert.equal(domains.effective?.source, "none");
  });

  it("reports denied project scope when the project file is untrusted", async () => {
    const { service } = fixture({ pi: { projectTrusted: false } });
    const result = await service.read(caller, { id: "harness.shell", scope: "project" });
    assert.equal(result.state, "denied");
    assert.ok(result.reason?.includes("trusted"));
    assert.equal(result.revisions?.project, undefined);
  });

  it("never applies an untrusted project layer to the effective value", async () => {
    const { service } = fixture({
      pi: {
        global: { harness: { web: { domains: { block: ["global.test"] } } } },
        project: { harness: { web: { domains: { block: ["untrusted.test"] } } } },
        projectTrusted: false,
      },
    });
    const result = await service.read(caller, { id: "harness.web.domains" });
    assert.deepEqual(result.effective?.value, { block: ["global.test"] });
    assert.notEqual(result.effective?.source, "project");
  });

  it("reports device-local rows honestly instead of inventing a value", async () => {
    const { service } = fixture();
    const result = await service.read(caller, { id: "appearance.language" });
    assert.equal(result.state, "unavailable");
    assert.equal(result.entry.writable, false);
  });

  it("returns the real action target for domain-managed rows", async () => {
    const { service } = fixture();
    const result = await service.read(caller, { id: "extensions.workbench.extensionSet" });
    assert.equal(result.state, "action");
    assert.equal(result.action?.domain, "service:extensions");
  });

  it("rejects unknown ids instead of returning an empty success", async () => {
    const { service } = fixture();
    await assert.rejects(service.read(caller, { id: "does.not.exist" }), /unknown settings id/);
  });
});

describe("settings update", () => {
  it("applies validated fields and returns the new revision", async () => {
    const changes: { ids: string[] }[] = [];
    const { service, getApp } = fixture({
      onChanged: (change) => changes.push({ ids: change.ids }),
    });
    const result = await service.update(caller, {
      id: "appearance.time-format",
      set: { timeFormatPreference: "24h" },
    });
    assert.equal(result.status, "applied");
    assert.equal(getApp().timeFormatPreference, "24h");
    assert.ok(result.revision);
    assert.deepEqual(changes[0]?.ids, ["appearance.time-format"]);
  });

  it("rejects enum violations loudly instead of coercing", async () => {
    const { service, getApp } = fixture();
    const result = await service.update(caller, {
      id: "appearance.time-format",
      set: { timeFormatPreference: "stardate" },
    });
    assert.equal(result.status, "failed");
    assert.equal(getApp().timeFormatPreference, undefined);
    assert.match(result.fields[0]?.error ?? "", /expected one of/);
  });

  it("honours expectedRevision CAS and reports the current revision on conflict", async () => {
    const { service } = fixture({ app: { themeVariant: "dark" } });
    const read = await service.read(caller, { id: "appearance.dark-theme" });
    const conflict = await service.update(caller, {
      id: "appearance.dark-theme",
      set: { themeVariant: "light" },
      expectedRevision: "stale-revision",
    });
    assert.equal(conflict.status, "failed");
    assert.equal(conflict.revision, read.revision);
    assert.match(conflict.fields[0]?.error ?? "", /revision conflict/);
  });

  it("removes overrides on reset and preserves sibling fields", async () => {
    const { service, getApp } = fixture({ app: { fontSize: 15, uiFont: "Inter" } });
    const result = await service.update(caller, {
      id: "appearance.interface-font-size",
      reset: ["fontSize"],
    });
    assert.equal(result.status, "applied");
    assert.equal(getApp().fontSize, undefined);
    assert.equal(getApp().uiFont, "Inter");
  });

  it("rejects pi scopes for app-owned entries and rejects secret resets", async () => {
    const { service, getApp } = fixture({ app: { desktopUiPassword: "stored" } });
    await assert.rejects(
      service.update(caller, {
        id: "appearance.time-format",
        scope: "global",
        set: { timeFormatPreference: "24h" },
      }),
      /host-owned/,
    );
    const reset = await service.update(caller, {
      id: "sessions.desktop-ui-password",
      reset: ["desktopUiPassword"],
    });
    assert.equal(reset.status, "failed");
    assert.equal(getApp().desktopUiPassword, "stored");
    assert.match(reset.fields[0]?.error ?? "", /cannot be reset/);
  });

  it("fails unknown field paths instead of silently dropping them", async () => {
    const { service } = fixture();
    const result = await service.update(caller, {
      id: "appearance.time-format",
      set: { timeFormatPreference: "24h", madeUpField: true },
    });
    assert.equal(result.status, "partial");
    assert.equal(result.fields.find((f) => f.path === "madeUpField")?.status, "failed");
    assert.equal(result.fields.find((f) => f.path === "timeFormatPreference")?.status, "applied");
  });

  it("enforces pi-settings scope ownership", async () => {
    const { service } = fixture();
    const result = await service.update(caller, {
      id: "harness.models.explore",
      scope: "project",
      set: { "harness.models.explore": { providerId: "p", modelId: "m" } },
    });
    assert.equal(result.status, "failed");
    assert.match(result.fields[0]?.error ?? "", /user-owned/);
  });

  it("keeps document parser executables user-owned", async () => {
    const { service, pi } = fixture();
    const userWrite = await service.update(caller, {
      id: "harness.document-reading",
      scope: "global",
      set: { "harness.documentReading": {
        doclingCommand: "C:/tools/docling.exe", tesseractCommand: "tesseract", ocrLanguage: "fra",
      } },
    });
    assert.equal(userWrite.status, "applied");
    assert.deepEqual((pi.global.harness as Record<string, unknown>).documentReading, {
      doclingCommand: "C:/tools/docling.exe", tesseractCommand: "tesseract", ocrLanguage: "fra",
    });

    const result = await service.update(caller, {
      id: "harness.document-reading",
      scope: "project",
      set: { "harness.documentReading": { doclingCommand: "project-command" } },
    });
    assert.equal(result.status, "failed");
    assert.match(result.fields[0]?.error ?? "", /user-owned/);
    assert.equal(pi.updates.length, 1);
  });

  it("writes pi-settings through the owner protocol with CAS", async () => {
    const { service, pi } = fixture({ pi: { global: { harness: { shell: "auto" } } } });
    const result = await service.update(caller, {
      id: "harness.shell",
      scope: "global",
      set: { "harness.shell": "wsl" },
    });
    assert.equal(result.status, "applied");
    assert.equal(pi.updates.length, 1);
    assert.equal(pi.updates[0]?.scope, "global");
    assert.ok(pi.updates[0]?.expectedRevision);
    assert.equal((pi.global.harness as Record<string, unknown>).shell, "wsl");
  });

  it("keeps client and action entries honest when their channel is missing", async () => {
    const { service } = fixture();
    await assert.rejects(
      service.update(caller, { id: "appearance.language", set: { locale: "fr" } }),
      /device-local.*surface channel|surface channel/,
    );
    await assert.rejects(
      service.update(caller, { id: "plugins.packages", set: { anything: true } }),
      /settings\.action/,
    );
  });
});

describe("settings actions (D-309)", () => {
  it("routes a declared verb to the domain adapter and returns owner state", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const withActions = createSettingsService(depsWithActions(calls));
    const result = await withActions.action(caller, {
      id: "plugins.packages",
      verb: "list",
    });
    assert.equal(result.status, "applied");
    assert.deepEqual(calls.map((call) => call.method), ["package.list"]);
  });

  it("denies undeclared verbs without touching the owner", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const withActions = createSettingsService(depsWithActions(calls));
    const result = await withActions.action(caller, {
      id: "plugins.packages",
      verb: "obliterate",
    });
    assert.equal(result.status, "denied");
    assert.equal(calls.length, 0);
  });

  it("reports unavailable when the owner adapter cannot reach its service", async () => {
    const withActions = createSettingsService(depsWithActions([], { fail: true }));
    const result = await withActions.action(caller, {
      id: "plugins.packages",
      verb: "list",
    });
    assert.equal(result.status, "unavailable");
  });

  it("read surfaces the live verb list and owner summary", async () => {
    const withActions = createSettingsService(depsWithActions([]));
    const result = await withActions.read(caller, { id: "plugins.packages", detail: true });
    assert.equal(result.state, "action");
    assert.ok(result.action?.verbs?.includes("list"));
  });

  it("persists a real owner operation and queries its terminal state", async () => {
    const records = new Map<string, { id: string; entryId: string; verb: string; state: "running" | "succeeded" | "failed" | "cancelled" | "unavailable"; detail?: string }>();
    const actionOperations: SettingsActionOperationStore = {
      get: async (_caller, _entryId, id) => records.get(id) ?? null,
      available: async () => true,
      put: async (_caller, operation) => { records.set(operation.id, { ...operation }); },
    };
    const actions: SettingsActionRegistry = {
      adapterFor: (domain) => domain === "runtime:extensions" ? {
        verbs: ["install", "status"],
        describe: async () => ({ verbs: ["install", "status"] }),
        invoke: async () => ({
          status: "pending" as const,
          operation: { id: "owner-op-1", state: "running" as const },
        }),
        capabilities: () => ({ execution: "async" as const, operation: { query: true } }),
        getOperation: async () => ({
          status: "applied" as const,
          detail: "owner reports completion",
          operation: { id: "owner-op-1", state: "succeeded" as const },
        }),
      } : null,
    };
    const { service } = fixture({ actions, actionOperations });
    const started = await service.action(caller, { id: "plugins.packages", verb: "install" });
    assert.equal(started.status, "pending");
    assert.equal(started.operation?.id, "owner-op-1");
    const finished = await service.action(caller, {
      id: "plugins.packages",
      verb: "status",
      operationId: "owner-op-1",
    });
    assert.equal(finished.status, "applied");
    assert.equal(finished.operation?.state, "succeeded");
  });
});

describe("client surface bridge (D-309)", () => {
  it("applies a client-owned field on the single connected surface", async () => {
    const applied: { entries: { id: string; values?: Record<string, unknown> }[] }[] = [];
    const { service } = fixture({
      clientSurfaces: fakeBridge(applied, [{ id: "surf-1", kind: "desktop" }]),
    });
    const result = await service.update(caller, {
      id: "chat.persist-drafts",
      set: { enabled: false },
    });
    assert.equal(result.status, "applied");
    assert.equal(applied[0]?.entries[0]?.id, "chat.persist-drafts");
    assert.deepEqual(applied[0]?.entries[0]?.values, { enabled: false });
    assert.equal(result.surface?.id, "surf-1");
  });

  it("reports unavailable when no surface is connected", async () => {
    const { service } = fixture({ clientSurfaces: fakeBridge([], []) });
    await assert.rejects(
      service.update(caller, { id: "chat.persist-drafts", set: { enabled: false } }),
      /no client surface/,
    );
  });

  it("refuses to guess when several surfaces are connected", async () => {
    const { service } = fixture({
      clientSurfaces: fakeBridge([], [
        { id: "surf-1", kind: "desktop" },
        { id: "surf-2", kind: "web" },
      ]),
    });
    await assert.rejects(
      service.update(caller, { id: "chat.persist-drafts", set: { enabled: false } }),
      /surfaces are connected|surface to choose/,
    );
    await assert.rejects(
      service.update(caller, {
        id: "chat.persist-drafts",
        set: { enabled: false },
        surface: "surf-2",
      }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "denied",
    );
  });

  it("reads client-owned values back from the surface, not a store", async () => {
    const { service } = fixture({
      clientSurfaces: fakeBridge([], [{ id: "surf-1", kind: "web" }]),
    });
    const result = await service.read(caller, { id: "chat.persist-drafts" });
    assert.equal(result.state, "ok");
    assert.equal(result.revision, "surface:surf-1");
  });
});

describe("compound settings.update (D-309)", () => {
  it("commits same-owner app items in one CAS write", async () => {
    let persistCalls = 0;
    const base = baseDeps();
    const inner = base.deps.persistAppSettings;
    const withCounting = createSettingsService({
      ...base.deps,
      persistAppSettings: (changes, removals, expectedRevision) => {
        persistCalls += 1;
        return inner(changes, removals, expectedRevision);
      },
    });
    const result = await withCounting.update(caller, {
      id: "appearance.time-format",
      items: [
        { id: "appearance.time-format", set: { timeFormatPreference: "24h" } },
        { id: "appearance.week-start", set: { weekStartPreference: "monday" } },
      ],
    });
    assert.equal(result.status, "applied");
    assert.equal(persistCalls, 1);
    assert.equal(result.items?.length, 2);
    assert.ok(result.items?.every((item) => item.status === "applied"));
  });

  it("uses each item's owner revision instead of sharing the compound guard", async () => {
    const base = baseDeps();
    const current = settingsDocumentRevision(await base.deps.readAppSettings());
    const service = createSettingsService(base.deps);
    const result = await service.update(caller, {
      id: "appearance.time-format",
      expectedRevision: "unrelated-top-level-revision",
      items: [
        { id: "appearance.time-format", expectedRevision: "stale", set: { timeFormatPreference: "24h" } },
        { id: "appearance.week-start", expectedRevision: current, set: { weekStartPreference: "monday" } },
      ],
    });
    assert.equal(result.status, "partial");
    assert.equal(result.items?.find((item) => item.id === "appearance.time-format")?.status, "failed");
    assert.equal(result.items?.find((item) => item.id === "appearance.week-start")?.status, "applied");
  });

  it("reports per-item status across owners — one failure does not roll back the rest", async () => {
    const applied: unknown[] = [];
    const { service, pi } = fixture({ clientSurfaces: fakeBridge(applied, [{ id: "s1", kind: "web" }]) });
    const result = await service.update(caller, {
      id: "appearance.time-format",
      items: [
        { id: "appearance.time-format", set: { timeFormatPreference: "12h" } },
        { id: "harness.shell", scope: "global", set: { "harness.shell": "wsl" } },
        { id: "chat.persist-drafts", set: { enabled: true } },
        { id: "appearance.time-format", set: { timeFormatPreference: "stardate" } },
      ],
    });
    assert.equal(result.status, "partial");
    const byId = result.items ?? [];
    assert.equal(byId.filter((item) => item.status === "applied").length, 2);
    assert.equal(byId.filter((item) => item.status === "failed").length, 2);
    assert.equal((pi.global.harness as Record<string, unknown>).shell, "wsl");
    assert.equal(pi.updates.length, 1);
  });
});
