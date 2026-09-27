/**
 * Harness e2e integration test — exercises the full link:
 *   tool function → HostServicesBridge → HarnessRouter → service → response → tool content text
 *
 * This tests the real wiring that pi-host uses: the same tool functions
 * (createBashTool, createGrepTool, etc.) call bridge.request(), which
 * emits harness.request events. The router dispatches to real services
 * (ShellSupervisor, OutputStore, etc.) and responds via harness.respond.
 * The bridge resolves the promise and the tool returns content text.
 *
 * Run: bunx tsx --test test/harness/harness-e2e.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";

// Host side — these are in the web/application-host package.
// We import via relative path to the web package source.
import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";

// pi-host side
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createBashTool } from "../../src/harness/bash-tool.js";
import { createGrepTool } from "../../src/harness/grep-tool.js";
import { createDiagnosticsTool, createGetOutputTool, createWriteToProcessTool } from "../../src/harness/output-tools.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DiagnosticItem } from "@varin/protocol";
import type { DiagnosticsProvider } from "../../../web/application-host/lib/harness/diagnostics-service.js";
import { createIsolatedTerminalSessionApi } from "../../../web/application-host/lib/terminal/isolated-session-api.test-helper.js";

const SESSION_ID = "e2e-session";
const WORKSPACE_ID = "e2e-workspace";
const ACTOR = { authorityInstanceId: "test-authority", sessionId: SESSION_ID, workerId: "test-worker", workerGeneration: 1 } as const;
const CAPABILITIES = ["context.session", "process.shell", "read.lsp", "read.output", "read.search", "read.web", "write.document"] as const;

async function setupE2E(options: { diagnosticsProvider?: DiagnosticsProvider } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "harness-e2e-"));

  // Create test files
  writeFileSync(join(workspaceRoot, "searchable.ts"), [
    "function hello() {",
    "  return 'world';",
    "}",
    "function goodbye() {",
    "  return 'farewell';",
    "}",
  ].join("\n"));

  // Host side: create service host with mock search (real shell + output store)
  const terminal = createIsolatedTerminalSessionApi();
  const harnessServiceHost = createHarnessServiceHost({
    // This suite tests bridge delivery. Search matching belongs to the search
    // service tests; the boundary supplies a hit or a miss without another engine.
    search: async (request) => request.query === "hello"
      ? { status: "ready" as const, generation: undefined, hits: [{
          column: 0, line: 1, preview: "function hello() {",
          resource: { resourceId: "searchable.ts", workspaceId: request.workspaceId },
        }] }
      : { status: "empty" as const, generation: undefined },
    resolveWorkspaceRoot: async () => workspaceRoot,
    ...(options.diagnosticsProvider ? { diagnosticsProvider: options.diagnosticsProvider } : {}),
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
      ...(process.platform === "win32" ? { gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe" } : {}),
    },
    createTerminalSession: (input) => terminal.createTerminalSession(input),
  });
  harnessServiceHost.registerSession({ actor: ACTOR, grantedCapabilities: CAPABILITIES, workspaceId: WORKSPACE_ID, workspaceRoot });

  // Router with respond callback that feeds back to bridge
  const router = createHarnessRouter({
    respond: async (identity, requestId, outcome) => {
      bridge.respond(identity.sessionId, requestId, outcome);
    },
    resolveActor: (identity) => harnessServiceHost.resolveActor(identity),
    authorizeWorkspacePath: async (actor, inputPath) => {
      const canonical = resolve(workspaceRoot, inputPath);
      return {
        authorityId: "test-host",
        workspaceId: actor.workspaceId!,
        canonicalResourceId: canonical,
        inputPath,
        resourceId: relative(workspaceRoot, canonical).split(sep).join("/"),
      };
    },
  });
  registerHarnessServices(router, harnessServiceHost);

  // pi-host side: bridge — emits events that the router processes
  const bridge = new HostServicesBridge({
    emit: (_event, data) => {
      void router.processEvent({
        actor: ACTOR,
        kind: "host",
        envelope: { kind: "event", event: "harness.request", data },
      });
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: 30000,
  });

  return {
    workspaceRoot,
    harnessServiceHost,
    router,
    bridge,
    dispose: async () => {
      bridge.dispose();
      router.dispose();
      try {
        await harnessServiceHost.dispose();
      } finally {
        await terminal.shutdown();
      }
    },
  };
}

async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute(`test-call-${++toolCallSequence}`, params as never, undefined, undefined, undefined as never) as { content: Array<{ type: string; text: string }>; details?: unknown };
  return result.content.map((c) => c.text).join("\n");
}

let toolCallSequence = 0;

describe("harness e2e integration", () => {
  it("bash starts at the workspace and retains cwd across calls", async () => {
    const { workspaceRoot, bridge, dispose } = await setupE2E();
    try {
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      const text = await executeTool(bashTool, { command: "pwd" });
      const dirName = workspaceRoot.split(/[\\/]/).pop();
      assert.ok(text.includes(dirName!), `bash pwd output should contain workspace dir name "${dirName}": got "${text}"`);
      mkdirSync(join(workspaceRoot, "packages"));
      // First call: cd packages
      await executeTool(bashTool, { command: "cd packages" });
      // Second call: pwd — output should contain the packages path
      const afterCd = await executeTool(bashTool, { command: "pwd" });
      // The output includes the path plus [exit N] suffix; extract the path line
      const pwdLine = afterCd.split("\n").find((l) => l.includes("packages"));
      assert.ok(pwdLine, `pwd output should contain a line with "packages": got "${afterCd}"`);
      assert.ok(pwdLine!.trim().endsWith("packages"), `pwd path should end with "packages": got "${pwdLine!.trim()}"`);
    } finally {
      await dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("RR3: heredoc without trailing newline, syntax error recovery, and lost-receipt output recovery", { timeout: 60_000 }, async () => {
    const { workspaceRoot, bridge, dispose } = await setupE2E();
    try {
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      const getOutputTool = createGetOutputTool(bridge, SESSION_ID);

      // E02: a heredoc whose delimiter is the last line with no trailing
      // newline must terminate — the payload is a quoted unit, not inline
      // text merged with the epilogue.
      const heredoc = await executeTool(bashTool, {
        command: "cat <<'EOF'\nline one\nline two\nEOF",
        waitMs: 15_000,
      });
      assert.match(heredoc, /line one[\s\S]*line two/, `heredoc output: ${heredoc}`);
      assert.match(heredoc, /\[exit 0\]/, `heredoc must complete: ${heredoc}`);

      // E03: a syntax error reports its real code and does not poison the
      // next command.
      const broken = await executeTool(bashTool, {
        command: "if true; then echo unterminated",
        waitMs: 15_000,
      });
      assert.match(broken, /\[exit (1|2)\]/, `syntax error reports a non-zero exit: ${broken}`);
      const healthy = await executeTool(bashTool, { command: "echo still-alive", waitMs: 15_000 });
      assert.match(healthy, /still-alive/, `shell survives a syntax error: ${healthy}`);
      assert.match(healthy, /\[exit 0\]/);

      // Tail comment and quoting do not leak into the epilogue.
      const comment = await executeTool(bashTool, { command: "echo kept # trailing comment", waitMs: 15_000 });
      assert.match(comment, /kept/);
      assert.match(comment, /\[exit 0\]/);

      // E04/7.2: simulate a lost receipt — a command accepted under its
      // toolCallId can still be read back with the real exit code.
      const callId = `test-call-lost-${++toolCallSequence}`;
      const execResult = await bashTool.execute(callId, { command: "echo recovered-output", waitMs: 15_000 } as never, undefined, undefined, undefined as never);
      const execText = (execResult as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
      assert.match(execText, /\[exit 0\]/, `accepted command completes: ${execText}`);
      const recovered = await executeTool(getOutputTool, { handle: callId });
      assert.match(recovered, /recovered-output/, `the toolCallId re-reads real output: ${recovered}`);
      assert.match(recovered, /exited 0/, `the toolCallId carries the real exit state: ${recovered}`);

      // stdin still reaches the payload: the command blocks on `read`, goes
      // background, then write_to_process delivers the line it consumes.
      const writeTool = createWriteToProcessTool(bridge, SESSION_ID);
      const waiting = await executeTool(bashTool, {
        command: "read -r answer; echo got-$answer",
        waitMs: 500,
      });
      const stdinShell = waiting.match(/sh_\w+/)?.[0];
      assert.ok(stdinShell, `read should go background with an sh_ id: ${waiting}`);
      const wrote = await executeTool(writeTool, { shellId: stdinShell, text: "hello-stdin\n" });
      assert.match(wrote, /wrote \d+ bytes/, `stdin write must be accepted: ${wrote}`);
      const stdinReads: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const observation = await executeTool(getOutputTool, { handle: stdinShell, waitMs: 1000 });
        stdinReads.push(observation);
        if (/exited/.test(observation)) break;
      }
      // Incremental reads consume output as it arrives — assert on the
      // accumulated transcript, and fall back to an authoritative full read
      // (offset 0) so a cursor nuance cannot masquerade as lost output.
      const stdinTranscript = [waiting, ...stdinReads].join("\n");
      if (!/got-hello-stdin/.test(stdinTranscript)) {
        const full = await executeTool(getOutputTool, { handle: stdinShell, offset: 0, length: 65536 });
        assert.match(full, /got-hello-stdin/, `stdin output absent even in a full read: ${stdinTranscript}\nFULL:${full}`);
      }
      assert.match(stdinTranscript, /exited 0/, `read exits 0 after input: ${stdinTranscript}`);
    } finally {
      await dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("background command + get_output retrieves output", { timeout: 30_000 }, async () => {
    const { workspaceRoot, bridge, dispose } = await setupE2E();
    try {
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      const getOutputTool = createGetOutputTool(bridge, SESSION_ID);
      // Node is part of every supported Varin runtime and keeps this test on
      // the selected interpreter instead of nesting PowerShell inside Git Bash.
      const sleepCmd = "node -e \"setTimeout(() => console.log('done'), 2000)\"";
      const callStartedAt = Date.now();
      const bashResponse = await bashTool.execute(
        `test-call-${++toolCallSequence}`,
        { command: sleepCmd, waitMs: 0 } as never,
        undefined,
        undefined,
        undefined as never,
      ) as {
        content: Array<{ text: string }>;
        details?: {
          kind?: string;
          id?: string;
          waitedMs?: number;
          timing?: { acceptedAt?: number; respondedAt?: number };
        };
      };
      const callReturnedAt = Date.now();
      const bgText = bashResponse.content.map((content) => content.text).join("\n");
      const accepted = bashResponse.details;
      assert.ok(accepted && (accepted.kind === "preparing" || accepted.kind === "background"),
        `waitMs=0 should return an accepted execution, not a failed command: ${bgText}`);
      assert.ok(accepted.id, `accepted execution should have a queryable reference: ${bgText}`);
      const acceptedHandle = accepted.id;
      if (accepted.kind === "preparing") {
        assert.match(acceptedHandle, /^exec_[0-9a-f]{32}$/u, `preparing reference must identify the accepted execution: ${bgText}`);
      } else {
        assert.match(acceptedHandle, /^sh_\d+$/u, `background result must identify a real shell: ${bgText}`);
      }

      // waitMs applies from ShellSupervisor acceptance to its response. The
      // end-to-end bridge call also includes actor admission and transport;
      // keep those measurements separate so a slow admission is not mistaken
      // for shell work exceeding the requested observation window.
      const timing = accepted.timing;
      assert.ok(timing?.acceptedAt !== undefined && timing.respondedAt !== undefined,
        `accepted result should expose its Host observation timing: ${JSON.stringify(accepted)}`);
      const supervisorWaitMs = timing.respondedAt - timing.acceptedAt;
      assert.ok(supervisorWaitMs >= 0 && callReturnedAt - callStartedAt >= supervisorWaitMs,
        `end-to-end latency ${callReturnedAt - callStartedAt}ms must include the ${supervisorWaitMs}ms Host observation window`);

      const reads: string[] = [];
      let outputText = "";
      do {
        await new Promise((resolve) => setTimeout(resolve, 100));
        outputText = await executeTool(getOutputTool, { handle: acceptedHandle, waitMs: 250 });
        reads.push(outputText);
      } while (!/exited 0/.test(outputText));

      const transcript = [bgText, ...reads].join("\n");
      const runtimeShellMatch = transcript.match(/recovered runtime shell: (sh_\d+)/);
      const shellId = accepted.kind === "background" ? acceptedHandle : runtimeShellMatch?.[1];
      assert.ok(shellId && /^sh_\d+$/u.test(shellId), `get_output should expose the final runtime shell identity: ${transcript}`);
      // The echoed command contains the word "done" before Node prints it.
      // Match the actual output line, not the submitted command text.
      const completedLine = /(?:^|\r?\n)done(?:\r?\n|$)/;
      assert.match(transcript, completedLine, "the initial snapshot or incremental reads must contain the completed output");
      const completedReadIndex = reads.findIndex((read) => completedLine.test(read));
      if (completedReadIndex >= 0) {
        const completedRead = reads[completedReadIndex]!;
        assert.match(completedRead, completedReadIndex === 0
          ? /initial read|\+\d+ bytes since last read/s
          : /\+\d+ bytes since last read/s,
        `the completed output must use the correct read baseline: got "${completedRead}"`);
      } else {
        assert.match(bgText, completedLine, "output absent from incremental reads must already be in the background snapshot");
      }
      assert.match(outputText, /exited 0/s, `the final observation must report the real exit state: got "${outputText}"`);
      const runtimeBaseline = await executeTool(getOutputTool, { handle: shellId });
      assert.match(runtimeBaseline, completedLine, `the recovered runtime shell must yield its full output: ${runtimeBaseline}`);
      assert.match(runtimeBaseline, /exited 0/s, `the recovered runtime shell must report the actual exit: ${runtimeBaseline}`);
      const unchanged = await executeTool(getOutputTool, { handle: acceptedHandle });
      assert.match(unchanged, /no new output since last read.*exited 0/s, `a repeated read should not duplicate shell output: got "${unchanged}"`);
      await bridge.request("context.retained", { retainedObservationRefs: [], retainedGit: false });
      const reset = await executeTool(getOutputTool, { handle: acceptedHandle });
      assert.match(reset, /initial read.*exited 0/s, `compaction should restore a full shell baseline with its exit state: got "${reset}"`);
      assert.match(reset, completedLine, `the reset baseline should contain the complete shell output: got "${reset}"`);
    } finally {
      await dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("grep hit finds text and miss returns 0 hits", async () => {
    const { workspaceRoot, bridge, dispose } = await setupE2E();
    try {
      const grepTool = createGrepTool(bridge, SESSION_ID);
      const hitText = await executeTool(grepTool, { pattern: "hello", path: workspaceRoot });
      assert.ok(hitText.includes("hello"), `grep hit should find 'hello': got "${hitText}"`);

      const missText = await executeTool(grepTool, { pattern: "nonexistent_xyz123", path: workspaceRoot });
      assert.match(missText, /0 hits — no matches in the requested scope/, `grep miss should report an honest empty scope: got "${missText}"`);
    } finally {
      await dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("read 5000-line file returns truncated text with get_output handle", async () => {
    const { workspaceRoot, bridge, dispose } = await setupE2E();
    try {
      writeFileSync(join(workspaceRoot, "big.txt"), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      const getOutputTool = createGetOutputTool(bridge, SESSION_ID);
      // Read the big file via bash cat — the truncation extension should kick in
      const text = await executeTool(bashTool, { command: "cat big.txt" });
      // The output must contain an out_ handle (truncation kicks in at 32KB)
      const handleMatch = text.match(/out_\w+/);
      assert.ok(handleMatch, `read big file should contain out_ handle: got "${text.slice(0, 120)}..."`);
      const handle = handleMatch![0];
      // Page 1 must contain "line 1"
      const page1 = await executeTool(getOutputTool, { handle, offset: 0, length: 1024 });
      assert.ok(page1.includes("line 1"), `get_output page 1 should contain 'line 1': got "${page1.slice(0, 120)}..."`);
      // Page 2 must be non-empty
      const page2 = await executeTool(getOutputTool, { handle, offset: 1024, length: 1024 });
      assert.ok(page2.length > 0, `get_output page 2 should have content: got "${page2.slice(0, 120)}..."`);
    } finally {
      await dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("grep disabled in settings → selectHarnessTools omits grep; default includes it", async () => {
    const { mergeHarnessSettings, DEFAULT_HARNESS_SETTINGS } = await import("@varin/protocol");
    const { selectHarnessTools } = await import("../../src/harness/select-tools.js");

    // Build a minimal fake bridge + deps for selectHarnessTools
    const fakeBridge = {
      request: async () => { throw new Error("not used"); },
      respond: () => undefined,
      dispose: () => undefined,
    } as unknown as import("../../src/harness/host-services-bridge.js").HostServicesBridge;
    const deps = {
      bridge: fakeBridge,
      sessionId: "test",
      cwd: "/tmp",
      workspaceMutationJournal: undefined,
      isOpenAIFamily: false,
    };

    // grep disabled → no grep tool
    const grepOffSettings = mergeHarnessSettings({ tools: { grep: false } }, {});
    const grepOffTools = selectHarnessTools(grepOffSettings, deps);
    assert.ok(!grepOffTools.some((t) => t.name === "grep"), "grep=false should omit grep tool");

    // default settings → grep present
    const defaultTools = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, deps);
    assert.ok(defaultTools.some((t) => t.name === "grep"), "default settings should include grep tool");
  });

  it("diagnostics returns added and resolved changes through the complete bridge", async () => {
    const issue: DiagnosticItem = {
      line: 2,
      character: 4,
      severity: "error",
      code: "TS1000",
      message: "broken",
      source: "ts",
    };
    let diagnostics = [issue];
    const provider: DiagnosticsProvider = {
      getDiagnostics: async () => diagnostics,
      getDiagnosticsForRevision: async () => diagnostics,
      bindDocument: async () => ({ status: "bound", revision: "disk-r1", source: "disk" }),
      getSnapshot: async () => "1",
      isAvailable: async () => true,
    };
    const { workspaceRoot, bridge, dispose } = await setupE2E({ diagnosticsProvider: provider });
    try {
      const tool = createDiagnosticsTool(bridge, SESSION_ID);
      const first = await executeTool(tool, { path: join(workspaceRoot, "searchable.ts") });
      assert.match(first, /broken/);
      diagnostics = [];
      const second = await executeTool(tool, { path: join(workspaceRoot, "searchable.ts") });
      assert.match(second, /\+0 −1 since last check/);
      assert.match(second, /resolved error.*broken/);
      const third = await executeTool(tool, { path: join(workspaceRoot, "searchable.ts") });
      assert.match(third, /no diagnostic changes/);
    } finally {
      await dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });
});
