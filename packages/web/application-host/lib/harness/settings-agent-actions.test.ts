import { describe, expect, it, vi } from "vitest";
import { getSettingsCatalogEntry } from "@varin/application-client";
import { createSettingsActionRegistry, type SettingsActionDeps } from "./settings-actions.js";

describe("agent management through the settings owner", () => {
  it("reads MCP status and configuration from the caller's native session, including sessions without projects", async () => {
    const snapshot = { provider: { state: "active" }, catalog: { version: 1, servers: [{ name: "fixture", transport: { kind: "stdio", command: "node" } }],
      sources: [{ id: "user", target: { root: "user", path: "mcp.json", format: "json" } }] } };
    const requestSession = vi.fn(async (_id: string, method: string) => method === "mcp.config.snapshot" ? snapshot : { exists: true, revision: "r1", content: "secret config" });
    const requestWorkspace = vi.fn(async () => { throw new Error("metadata worker has no live MCP owner"); });
    const adapter = createSettingsActionRegistry({ requestSession, requestWorkspace } as unknown as SettingsActionDeps).adapterFor("runtime:mcp")!;
    const ctx = { caller: { sessionId: "active-session", workspaceId: null }, workspaceRoot: null };
    const entry = getSettingsCatalogEntry("mcp.runtime")!;
    expect(await adapter.describe(ctx, entry)).toMatchObject({ summary: "provider active, 1 configured servers" });
    expect(await adapter.invoke(ctx, entry, "status", {})).toMatchObject({ status: "applied", data: { provider: { state: "active" } } });
    const read = await adapter.invoke(ctx, entry, "read", { sourceId: "user" });
    expect(read.status).toBe("applied");
    expect(JSON.stringify(read)).not.toContain("secret config");
    expect(requestSession).toHaveBeenLastCalledWith("active-session", "config.text.get", snapshot.catalog.sources[0]!.target);
    expect(requestWorkspace).not.toHaveBeenCalled();
  });

  it("supports workspace-less callers and forwards revisioned mutations only to an advertised owner action", async () => {
    const catalog = { providers: [{ id: "varin", actions: [{ id: "create-agent" }] }],
      agents: [{ id: "varin:custom:reader", providerId: "varin", actions: [{ id: "disable" }] }] };
    const requestSession = vi.fn(async (_sessionId: string, method: string, _params: Record<string, unknown>) => method === "agentProvider.list"
      ? catalog : { success: true, providerId: "varin", message: "Saved" });
    const adapter = createSettingsActionRegistry({ requestSession } as unknown as SettingsActionDeps).adapterFor("service:agents")!;
    const ctx = { caller: { sessionId: "without-project", workspaceId: null }, workspaceRoot: null };
    const entry = getSettingsCatalogEntry("agents.catalog")!;
    expect((await adapter.describe(ctx, entry)).unavailable).toBeUndefined();
    const input = { expectedRevision: "read-revision", config: { name: "reader" } };
    expect((await adapter.invoke(ctx, entry, "create", { providerId: "varin", input })).status).toBe("applied");
    expect(requestSession).toHaveBeenLastCalledWith("without-project", "agentProvider.action", { providerId: "varin", action: "create-agent", input });
    const before = requestSession.mock.calls.filter(call => call[1] === "agentProvider.action").length;
    expect((await adapter.invoke(ctx, entry, "delete", { providerId: "varin", agentId: "varin:custom:reader", input: { expectedRevision: "r" } })).status).toBe("unavailable");
    expect(requestSession.mock.calls.filter(call => call[1] === "agentProvider.action").length).toBe(before);
    expect((await adapter.invoke(ctx, entry, "disable", { providerId: "varin", agentId: "varin:custom:reader", input: { expectedRevision: "r" } })).status).toBe("applied");
  });
});
