import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";
import { createObservers, determineWriteSource, determineTerminalSource } from "./observers.js";

// Scratch stores live in the OS temp dir; see harness/recall-tool.test.ts.
const TEST_DIR = mkdtempSync(join(tmpdir(), "varin-test-observers-"));

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

let store: KnowledgeStore;
let storeCounter = 0;

async function openStore() {
  storeCounter++;
  const dir = join(TEST_DIR, `store-${storeCounter}`);
  mkdirSync(dir, { recursive: true });
  return openWorkspaceKnowledge({
    dataDir: dir,
    hostId: "test-host",
    workspaceId: "ws-test",
    embedding: null,
  });
}

describe("source determination", () => {
  it("agent writer active → agent source", () => {
    expect(determineWriteSource(true)).toBe("agent");
  });

  it("no agent writer → user source", () => {
    expect(determineWriteSource(false)).toBe("user");
  });

  it("harness terminal → agent source", () => {
    expect(determineTerminalSource("harness")).toBe("agent");
  });

  it("user terminal → user source", () => {
    expect(determineTerminalSource("user")).toBe("user");
  });
});

describe("createObservers", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });

  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("onDocumentWrite writes edit event with correct source", async () => {
    // Spy on putEvent
    let captured: { kind: string; source: string; text: string } | null = null;
    const origPutEvent = store.putEvent.bind(store);
    store.putEvent = async (e) => {
      captured = { kind: e.kind, source: e.source, text: e.text };
      return origPutEvent(e);
    };

    const observers = createObservers({ store, sessionId: "s1" });
    await observers.onDocumentWrite({
      workspaceId: "ws",
      path: "src/index.ts",
      kind: "modified",
      agentWriterActive: false,
    });

    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe("edit");
    expect(captured!.source).toBe("user");
    expect(captured!.text).toContain("modified src/index.ts");
  });

  it("onDocumentWrite marks agent source when writer active", async () => {
    let captured: { source: string } | null = null;
    const origPutEvent = store.putEvent.bind(store);
    store.putEvent = async (e) => {
      captured = { source: e.source };
      return origPutEvent(e);
    };

    const observers = createObservers({ store, sessionId: "s1" });
    await observers.onDocumentWrite({
      workspaceId: "ws",
      path: "src/generated.ts",
      kind: "created",
      agentWriterActive: true,
    });

    expect(captured).not.toBeNull();
    expect(captured!.source).toBe("agent");
  });

  it("onTerminalExit writes command event", async () => {
    let captured: { kind: string; source: string; text: string } | null = null;
    const origPutEvent = store.putEvent.bind(store);
    store.putEvent = async (e) => {
      captured = { kind: e.kind, source: e.source, text: e.text };
      return origPutEvent(e);
    };

    const observers = createObservers({ store, sessionId: "s1" });
    await observers.onTerminalExit({
      workspaceId: "ws",
      sessionId: "sh1",
      command: "bun test",
      exitCode: 0,
      source: "user",
    });

    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe("command");
    expect(captured!.source).toBe("user");
    expect(captured!.text).toContain("exit 0");
    expect(captured!.text).toContain("bun test");
  });

  it("records commandId and cwd on user terminal observations", async () => {
    let captured: Record<string, unknown> | null = null;
    const origPutEvent = store.putEvent.bind(store);
    store.putEvent = async (e) => {
      captured = { text: e.text, data: e.data ?? null, dedupeKey: e.dedupeKey ?? null };
      return origPutEvent(e);
    };
    const observers = createObservers({ store, sessionId: "s1" });
    await observers.onTerminalExit({
      workspaceId: "ws",
      sessionId: "term-1",
      command: "echo hi",
      commandId: "term-1:1:1",
      cwd: "/workspace",
      exitCode: 0,
      source: "user",
      integration: "osc-633",
    });
    expect(captured).toMatchObject({
      text: expect.stringContaining("(/workspace)"),
      data: {
        command: "echo hi",
        commandId: "term-1:1:1",
        cwd: "/workspace",
        origin: "user",
      },
      dedupeKey: 'terminal-command:["s1","term-1:1:1"]',
    });
  });

  it("onTerminalExit marks harness as agent", async () => {
    let captured: { source: string } | null = null;
    const origPutEvent = store.putEvent.bind(store);
    store.putEvent = async (e) => {
      captured = { source: e.source };
      return origPutEvent(e);
    };

    const observers = createObservers({ store, sessionId: "s1" });
    await observers.onTerminalExit({
      workspaceId: "ws",
      sessionId: "sh1",
      command: "npm build",
      exitCode: 1,
      source: "harness",
    });

    expect(captured!.source).toBe("agent");
  });

  it("onDiagnostics writes diagnostic event", async () => {
    let captured: { kind: string; text: string } | null = null;
    const origPutEvent = store.putEvent.bind(store);
    store.putEvent = async (e) => {
      captured = { kind: e.kind, text: e.text };
      return origPutEvent(e);
    };

    const observers = createObservers({ store, sessionId: "s1" });
    await observers.onDiagnostics({
      workspaceId: "ws",
      sessionId: "s1",
      path: "src/a.ts",
      count: 2,
      worst: "error",
    });

    expect(captured!.kind).toBe("diagnostic");
    expect(captured!.text).toContain("src/a.ts");
    expect(captured!.text).toContain("2 errors");
  });

  it("onGitStatus writes git event", async () => {
    let captured: { kind: string; text: string } | null = null;
    const origPutEvent = store.putEvent.bind(store);
    store.putEvent = async (e) => {
      captured = { kind: e.kind, text: e.text };
      return origPutEvent(e);
    };

    const observers = createObservers({ store, sessionId: "s1" });
    await observers.onGitStatus({
      workspaceId: "ws",
      branch: "main",
      changed: 5,
    });

    expect(captured!.text).toContain("git");
    expect(captured!.text).toContain("branch main");
    expect(captured!.text).toContain("5 files changed");
  });
});
