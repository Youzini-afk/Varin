import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessActorIdentity, PiSettingsSnapshot } from "@varin/protocol";
import { createHarnessServiceHost, type HarnessSessionContext } from "./service-host.js";
import { createHarnessSessionRegistration } from "./session-registration.js";
import { createHarnessRouter } from "./router.js";
import { registerHarnessServices } from "./harness-services.js";
import { createWebFetch } from "./web-fetch.js";

const actor: HarnessActorIdentity = { authorityInstanceId: "host", sessionId: "session", workerId: "worker", workerGeneration: 1 };
const snapshot: PiSettingsSnapshot = { global: {}, globalRevision: "g1", project: {}, projectRevision: "p1", projectTrusted: false };
const context = (identity = actor): HarnessSessionContext => ({ actor: identity, workspaceId: "workspace", workspaceRoot: "D:/workspace", grantedCapabilities: ["read.output", "process.shell"] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(readSettings: (ctx: HarnessSessionContext) => Promise<PiSettingsSnapshot>) {
  const dropInputContexts = vi.fn();
  const host = createHarnessServiceHost({
    search: async () => ({ status: "empty", generation: undefined }), resolveWorkspaceRoot: async () => "D:/workspace",
    discoveredShells: {}, dropAgentInputContexts: dropInputContexts,
  });
  cleanup.push(() => host.dispose());
  const registrations = createHarnessSessionRegistration({ host, readSettings });
  cleanup.push(() => registrations.dispose());
  return { host, registrations, dropInputContexts };
}

describe("asynchronous Harness registration", () => {
  it("uses current tool grants during and after registration without retiring the same worker", async () => {
    const settings = deferred<PiSettingsSnapshot>();
    const readSettings = vi.fn(async () => settings.promise);
    const { registrations, dropInputContexts } = fixture(readSettings);
    const initial = context();
    const registered = registrations.register(initial);
    const research: HarnessSessionContext = { ...initial, grantedCapabilities: ["read.output", "process.shell", "read.experiment"] };
    const updated = registrations.register(research);
    settings.resolve(snapshot);
    await Promise.all([registered, updated]);
    expect((await registrations.resolveActor(actor))?.grantedCapabilities).toContain("read.experiment");

    await registrations.register(initial);
    expect((await registrations.resolveActor(actor))?.grantedCapabilities).toEqual(initial.grantedCapabilities);
    await registrations.register(research);
    expect((await registrations.resolveActor(actor))?.grantedCapabilities).toContain("read.experiment");
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(dropInputContexts).not.toHaveBeenCalled();
  });

  it("lets the first public request wait for its exact actor registration", async () => {
    const settings = deferred<PiSettingsSnapshot>();
    const { host, registrations, dropInputContexts } = fixture(async () => settings.promise);
    const responses: unknown[] = [];
    const router = createHarnessRouter({ respond: async (_sessionId, _requestId, result) => { responses.push(result); }, resolveActor: registrations.resolveActor });
    cleanup.push(() => router.dispose());
    registerHarnessServices(router, host);
    const registered = registrations.register(context());
    const request = router.processEvent({ actor, kind: "host", envelope: { kind: "event", event: "harness.request", data: { requestId: "first", method: "output.store", params: { text: "hello" } } } });
    await Promise.resolve();
    expect(responses).toHaveLength(0);
    settings.resolve(snapshot);
    await Promise.all([registered, request]);
    expect(responses).toEqual([expect.objectContaining({ ok: true, result: expect.objectContaining({ total: 5 }) })]);
    // A prompt may already have captured its draft before the first snapshot.
    expect(dropInputContexts).not.toHaveBeenCalled();
  });

  it("does not register a dropped actor when its settings arrive late", async () => {
    const settings = deferred<PiSettingsSnapshot>();
    const { host, registrations } = fixture(async () => settings.promise);
    const registered = registrations.register(context());
    registrations.dropSession(actor.sessionId, actor);
    await registered;
    settings.resolve(snapshot);
    await Promise.resolve();
    expect(host.hasActor(actor)).toBe(false);
    expect(await registrations.resolveActor(actor)).toBeNull();
  });

  it("does not coalesce settings across worker generations or drop the new actor on an old exit", async () => {
    const oldSettings = deferred<PiSettingsSnapshot>();
    const newSettings = deferred<PiSettingsSnapshot>();
    const { host, registrations } = fixture(async (ctx) => ctx.actor.workerGeneration === 1 ? oldSettings.promise : newSettings.promise);
    const oldRegistered = registrations.register(context());
    const next = { ...actor, workerGeneration: 2 };
    const newRegistered = registrations.register(context(next));
    registrations.dropSession(actor.sessionId, actor);
    oldSettings.resolve(snapshot);
    await oldRegistered;
    expect(await registrations.resolveActor(actor)).toBeNull();
    newSettings.resolve(snapshot);
    await newRegistered;
    expect(host.hasActor(next)).toBe(true);
    expect((await registrations.resolveActor(next))?.workerGeneration).toBe(2);
  });

  it("reports unavailable shell settings without inventing the auto configuration", async () => {
    const { host, registrations } = fixture(async () => { throw new Error("settings unavailable"); });
    await registrations.register(context());
    expect(host.hasActor(actor)).toBe(true);
    expect(host.getInterpreter(actor.sessionId)).toEqual({ unavailable: expect.objectContaining({ reason: "Shell settings are unavailable" }) });
  });

  it("keeps unrelated session services available when a project directory is offline", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: {},
    });
    cleanup.push(() => host.dispose());
    const registrations = createHarnessSessionRegistration({
      host,
      readSettings: async () => snapshot,
      resolveWorkspaceRoot: async () => null,
    });
    cleanup.push(() => registrations.dispose());

    await registrations.register(context());
    expect(host.hasActor(actor)).toBe(true);
    expect(await registrations.resolveActor(actor)).toMatchObject({
      workspaceId: "workspace",
      cwd: "D:/workspace",
    });
  });

  it("cancels a caller's wait without cancelling another request's initialization", async () => {
    const settings = deferred<PiSettingsSnapshot>();
    const { registrations } = fixture(async () => settings.promise);
    const registered = registrations.register(context());
    const controller = new AbortController();
    const waiting = registrations.resolveActor(actor, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    settings.resolve(snapshot);
    await registered;
    expect(await registrations.resolveActor(actor)).not.toBeNull();
  });

  it("freezes credential-free web provider/policy identity per worker generation", async () => {
    let current: PiSettingsSnapshot = {
      global: {
        harness: {
          web: {
            render: true,
            search: { provider: "brave", credentialRef: "search-v1" },
            domains: { allow: ["example.com"], block: ["ads.example.com"] },
          },
        },
      },
      globalRevision: "g1",
      project: {
        harness: {
          web: {
            render: false,
            search: { provider: "searxng", endpoint: "https://workspace.invalid" },
            domains: { allow: ["docs.example.com", "outside.test"], block: ["tracker.example.com"] },
          },
        },
      },
      projectRevision: "p1",
      projectTrusted: true,
    };
    const { host, registrations } = fixture(async () => current);
    await registrations.register(context());
    expect(host.getWebBinding(actor.sessionId)).toEqual({
      generation: "g1:p1",
      settings: {
        render: true,
        search: { provider: "brave", credentialRef: "search-v1" },
        domains: {
          allow: ["docs.example.com"],
          block: ["ads.example.com", "tracker.example.com"],
        },
      },
    });

    current = {
      global: { harness: { web: { search: { provider: "tavily", credentialRef: "search-v2" } } } },
      globalRevision: "g2",
      project: {},
      projectRevision: "p2",
      projectTrusted: false,
    };
    await registrations.register(context());
    expect(host.getWebBinding(actor.sessionId)?.settings?.search).toEqual({
      provider: "brave",
      credentialRef: "search-v1",
    });

    const next = { ...actor, workerGeneration: 2 };
    await registrations.register(context(next));
    expect(host.getWebBinding(actor.sessionId)).toEqual({
      generation: "g2:untrusted",
      settings: {
        search: { provider: "tavily", credentialRef: "search-v2" },
        domains: { block: [] },
      },
    });
  });

  it("preserves a malformed explicit search selection instead of silently choosing the default", async () => {
    const { host, registrations } = fixture(async () => ({
      ...snapshot,
      global: { harness: { web: { search: { provider: "misspelled-provider" } } } },
    } as PiSettingsSnapshot));
    await registrations.register(context());
    expect(host.getWebBinding(actor.sessionId)?.searchError).toMatch(/Invalid web search/);
  });

  it("web binding ignores malformed unrelated harness sections", async () => {
    const { host, registrations } = fixture(async () => ({
      global: {
        harness: {
          memory: false,
          web: { search: { provider: "searxng", endpoint: "https://search.example" } },
        },
      },
      globalRevision: "g-web",
      project: {},
      projectRevision: "p-web",
      projectTrusted: false,
    } as PiSettingsSnapshot));
    await registrations.register(context());
    expect(host.hasActor(actor)).toBe(true);
    expect(host.getWebBinding(actor.sessionId)?.settings?.search).toEqual({
      provider: "searxng",
      endpoint: "https://search.example",
    });
  });

  it("enforces the frozen renderer switch and domain policy before web.fetch execution", async () => {
    const renderer = vi.fn(async () => '<html><body><p>Rendered app content</p></body></html>');
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      '<html><head><script src="app.js"></script></head><body><div id="root"></div></body></html>',
      { headers: { "content-type": "text/html" } },
    ));
    cleanup.push(() => network.mockRestore());
    const webFetchService = createWebFetch({
      ssrf: { check: async () => ({ blocked: false }), isSameHost: () => true },
      renderer,
    });
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: {},
      webFetchService,
    });
    cleanup.push(() => host.dispose());
    const responses: Array<{ ok: boolean; result?: unknown }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => { responses.push(outcome); },
      resolveActor: (identity) => host.resolveActor(identity),
    });
    cleanup.push(() => router.dispose());
    registerHarnessServices(router, host);

    host.registerSession({
      ...context(),
      grantedCapabilities: ["read.web"],
      webBinding: {
        generation: "g1:untrusted",
        settings: { render: false, domains: { allow: ["example.com"], block: ["ads.example.com"] } },
      },
    });
    await router.processEvent({
      actor,
      kind: "host",
      envelope: {
        kind: "event",
        event: "harness.request",
        data: { requestId: "render-off", method: "web.fetch", params: { url: "https://example.com", render: true } },
      },
    });
    expect(network).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
    expect(responses.at(-1)).toMatchObject({ ok: true, result: { status: "renderer-unavailable", reason: "disabled" } });

    const next = { ...actor, workerGeneration: 2 };
    host.registerSession({
      ...context(next),
      grantedCapabilities: ["read.web"],
      webBinding: {
        generation: "g2:untrusted",
        settings: { render: true, domains: { allow: ["example.com"], block: ["ads.example.com"] } },
      },
    });
    await router.processEvent({
      actor: next,
      kind: "host",
      envelope: {
        kind: "event",
        event: "harness.request",
        data: { requestId: "render-on", method: "web.fetch", params: { url: "https://example.com", render: true } },
      },
    });
    expect(renderer).toHaveBeenCalledWith("https://example.com", expect.any(AbortSignal));
    expect(responses.at(-1)).toMatchObject({ ok: true, result: { status: "ok", rendered: true, markdown: "Rendered app content" } });
    await router.processEvent({
      actor: next, kind: "host",
      envelope: { kind: "event", event: "harness.request", data: { requestId: "blocked", method: "web.fetch", params: { url: "https://ads.example.com", render: true } } },
    });
    expect(responses.at(-1)).toMatchObject({ ok: true, result: { status: "blocked", reason: "domain-blocked" } });
    expect(renderer).toHaveBeenCalledTimes(1);
  });
});
