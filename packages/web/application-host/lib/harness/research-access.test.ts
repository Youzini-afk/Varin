import { describe, expect, it } from "vitest";
import type { Thread, ThreadSessionBinding } from "@varin/protocol";
import { resolveResearchCaller } from "./research-access.js";

const thread = (id: string, parent: Thread["parent"], purpose = "delegated"): Thread => ({ id, parent, purpose } as Thread);
const tree = [
  thread("root", { kind: "session", id: "s-root" }, "research-root"),
  thread("a", { kind: "thread", id: "root" }),
  thread("b", { kind: "thread", id: "root" }),
  thread("a-child", { kind: "thread", id: "a" }),
  thread("b-child", { kind: "thread", id: "b" }),
  thread("unrelated", { kind: "session", id: "s-other" }, "research-root"),
];
const registry = (binding: ThreadSessionBinding | null) => ({
  getSessionBinding: async () => binding,
  resolveSessionOwner: async () => binding,
  getThreadById: async (_workspace: string, id: string) => tree.find((item) => item.id === id) ?? null,
  listThreads: async (_workspace: string, parent: Thread["parent"]) => tree.filter((item) => item.parent.kind === parent.kind && item.parent.id === parent.id),
});

describe("research relationship access", () => {
  it("includes the branch's real parent, siblings and children, without unrelated roots or nieces", async () => {
    const binding = { sessionId: "s-a", owningScopeId: "owning", threadId: "a", runId: "run-a" } as ThreadSessionBinding;
    const caller = await resolveResearchCaller(registry(binding), { sessionId: "s-a", workspaceId: "execution" });
    expect(caller.workspaceId).toBe("owning");
    expect(caller.executionWorkspaceId).toBe("execution");
    expect(caller.rootSessionId).toBe("s-root");
    expect(new Set(caller.allowedThreadIds)).toEqual(new Set(["root", "a", "b", "a-child"]));
  });

  it("lets the user's research root inspect its complete tree, including after the live binding disappears", async () => {
    const caller = await resolveResearchCaller(registry(null), { sessionId: "s-root", workspaceId: "owning", user: true });
    expect(new Set(caller.allowedThreadIds)).toEqual(new Set(["root", "a", "b", "a-child", "b-child"]));
    const other = await resolveResearchCaller(registry(null), { sessionId: "s-other", workspaceId: "owning", user: true });
    expect(other.allowedThreadIds).toEqual(["unrelated"]);
  });
});
