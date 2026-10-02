import { describe, expect, it, vi } from "vitest";
import { getSettingsCatalogEntry } from "@varin/application-client";
import { createSettingsActionRegistry, type SettingsActionDeps } from "./settings-actions.js";

describe("agent management through the settings owner", () => {
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
