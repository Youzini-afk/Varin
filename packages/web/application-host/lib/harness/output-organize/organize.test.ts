import { describe, expect, it } from "vitest";
import { createOutputStore } from "../output-store.js";
import { createObservationCursorStore } from "../observation-cursors.js";
import { createShellExecService, createShellReadService } from "../harness-services.js";
import type { HarnessServiceHost } from "../service-host.js";
import type { HarnessServiceContext } from "../router.js";
import { identifyFromCommand, organizeShellOutput, utf8Bytes } from "./index.js";
import { fitBlocks, normalizeShellText, SHELL_DISPLAY_BUDGET } from "./text.js";

const VITEST_FAIL = [
  " RUN  v4.1.11",
  "",
  "✓ src/ok.test.ts (2)",
  "RERUN  src/mid.test.ts x1",
  "FAIL src/mid.test.ts",
  "  × math > adds 1ms",
  "    AssertionError: expected 2 to be 1",
  "    - Expected",
  "    + Received",
  "",
  "    - 1",
  "    + 2",
  "",
  "    ❯ src/mid.test.ts:4:10",
  "",
  "✓ src/other.test.ts (8)",
  "",
  " Test Files  1 failed | 2 passed (3)",
  "      Tests  1 failed | 10 passed (11)",
  "   Start at  02:14:18",
  "   Duration  3.42s",
].join("\n");

const VITEST_PASS = [
  " RUN  v4.1.11",
  "✓ a.test.ts (4)",
  "✓ b.test.ts (6)",
  " Test Files  2 passed (2)",
  "      Tests  10 passed (10)",
  "   Duration  1.10s",
].join("\n");

const TSC_FAIL = [
  "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.",
  "Found 2 errors in 2 files.",
].join("\n");

const ESLINT_FAIL = [
  "src/a.ts",
  "  4:9  error  Unexpected any  @typescript-eslint/no-explicit-any",
  "  8:1  warning  Missing return  consistent-return",
  "",
  "✖ 2 problems (1 error, 1 warning)",
].join("\n");

const GIT_STATUS = [
  "On branch main",
  "Changes not staged for commit:",
  "  modified:   packages/web/src/a.ts",
  "Untracked files:",
  "  docs/new.md",
].join("\n");

const GIT_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " export const x = 1;",
  "+export const y = 2;",
  " export const z = 3;",
].join("\n");

describe("command identification", () => {
  it("recognizes wrappers and combinations without executing them", () => {
    expect(identifyFromCommand("bunx vitest run")?.kind).toBe("vitest");
    expect(identifyFromCommand("npx tsc --noEmit")?.kind).toBe("tsc");
    expect(identifyFromCommand("bun run lint && npx eslint src")?.kind).toBe("generic");
    expect(identifyFromCommand("git -C repo status")?.gitSubcommand).toBe("status");
    expect(identifyFromCommand("bun run test")?.kind).toBe("package-manager");
  });

  it("classifies package-manager heads and binary-exec forms separately", () => {
    // Script-runner and builtin forms: the manager is the execution position.
    for (const command of [
      "npm test", "npm run build", "npm install", "npm run lint -- --fix",
      "pnpm test", "pnpm run vitest", "pnpm vitest", "pnpm install",
      "yarn test", "yarn add leftpad", "yarn vitest",
      "bun test", "bun run build", "bun install",
    ]) {
      expect(identifyFromCommand(command)?.kind, command).toBe("package-manager");
    }
    // exec/dlx/x forms resolve a binary directly — the binary is the tool.
    for (const [command, kind] of [
      ["npm exec vitest run", "vitest"],
      ["pnpm dlx tsc --noEmit", "tsc"],
      ["pnpm exec eslint src", "eslint"],
      ["bun x vitest", "vitest"],
      ["yarn dlx tsc", "tsc"],
      ["npx --package typescript tsc --noEmit", "tsc"],
    ] as const) {
      expect(identifyFromCommand(command)?.kind, command).toBe(kind);
    }
    // Unresolvable binaries behind exec wrappers are not package-manager
    // context — the tool's own output is all there is.
    expect(identifyFromCommand("npx prettier --check src")?.kind).toBeUndefined();
    expect(identifyFromCommand("node ./scripts/check.js")?.kind).toBeUndefined();
    // Mixed kinds stay generic rather than misattributing output.
    expect(identifyFromCommand("npm test && git status")?.kind).toBe("generic");
  });

  it("does not infer a tool from arguments or mix incompatible command segments", () => {
    expect(identifyFromCommand("echo vitest run")?.kind).toBe("generic");
    expect(identifyFromCommand("cd packages && bunx vitest run")?.kind).toBe("vitest");
    expect(identifyFromCommand("git status && git diff")?.kind).toBe("generic");
    expect(identifyFromCommand("npx tsc; npx eslint")?.kind).toBe("generic");
  });

  it("does not classify vitest-shaped text printed by echo as a test run", () => {
    const organized = organizeShellOutput({
      command: "printf 'vitest output'",
      output: " Test Files  1 passed (1)\n   Duration  1s",
      complete: true,
      exitCode: 0,
    });
    expect(organized.kind).toBe("generic");
    expect(organized.text).toContain("Test Files  1 passed");
  });
});

describe("vitest organizer", () => {
  it("keeps a failure block buried in successful logs and real stats", () => {
    const noise = `${"ok line\n".repeat(80)}${VITEST_FAIL}`;
    const organized = organizeShellOutput({ command: "bunx vitest run", output: noise, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("vitest");
    expect(organized.text).toContain("FAIL src/mid.test.ts");
    expect(organized.text).toContain("AssertionError: expected 2 to be 1");
    expect(organized.text).toContain("Tests  1 failed | 10 passed (11)");
    expect(organized.text).not.toContain("RERUN");
    expect(organized.text).not.toMatch(/^✓ /m);
  });

  it("folds success logs and does not invent a pass from exit code", () => {
    const organized = organizeShellOutput({ command: "bun run test", output: VITEST_PASS, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("vitest");
    expect(organized.text).toContain("Test Files  2 passed (2)");
    expect(organized.text).not.toContain("✓ a.test.ts");
  });

  it("does not delete unrecognized vitest-invoked output", () => {
    const organized = organizeShellOutput({
      command: "vitest run",
      output: "downloading browser binaries...\nstill working",
      complete: true,
      exitCode: 0,
    });
    expect(organized.kind).toBe("generic");
    expect(organized.text).toContain("downloading browser binaries");
  });

  it("keeps failed test names, locations, and watch instructions", () => {
    const organized = organizeShellOutput({
      command: "vitest run --watch",
      output: [
        "FAIL src/mid.test.ts",
        "  × math > adds",
        "    AssertionError: expected 2 to be 1",
        "    ❯ src/mid.test.ts:4:10",
        "press h to show help, press q to quit",
        " Test Files  1 failed (1)",
        "   Duration  3s",
      ].join("\n"),
      complete: true,
      exitCode: 1,
    });
    expect(organized.text).toContain("× math > adds");
    expect(organized.text).toContain("❯ src/mid.test.ts:4:10");
    expect(organized.text).toContain("press h to show help");
  });
});

describe("tsc organizer", () => {
  it("keeps file, code, message, and summary", () => {
    const organized = organizeShellOutput({ command: "npx tsc --noEmit", output: TSC_FAIL, complete: true, exitCode: 2 });
    expect(organized.kind).toBe("tsc");
    expect(organized.text).toContain("src/a.ts(12,5): error TS2322");
    expect(organized.text).toContain("Found 2 errors in 2 files.");
  });

  it("keeps pretty diagnostics, code frames, and unrecognized context", () => {
    const output = [
      "src/a.ts:1:1 - error TS2322: bad",
      "",
      "> 1 | const value: number = 'bad'",
      "    |       ~~~~~",
      "plugin context: compiler wrapper emitted this line",
      "Found 1 error in src/a.ts:1",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npx tsc --pretty", output, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("tsc");
    expect(organized.text).toContain("src/a.ts:1:1 - error TS2322: bad");
    expect(organized.text).toContain("> 1 | const value");
    expect(organized.text).toContain("plugin context");
    expect(organized.text).toContain("Found 1 error in src/a.ts:1");
  });

  it("does not claim success when exit is non-zero and no errors parsed", () => {
    const organized = organizeShellOutput({
      command: "tsc",
      output: "tsc: something unexpected happened",
      complete: true,
      exitCode: 2,
    });
    expect(organized.kind).toBe("generic");
    expect(organized.text).toContain("something unexpected happened");
    expect(organized.text).not.toMatch(/all passed|no errors/i);
  });
});

describe("eslint organizer", () => {
  it("keeps file, position, rule, severity, and summary", () => {
    const organized = organizeShellOutput({ command: "npx eslint src", output: ESLINT_FAIL, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("eslint");
    expect(organized.text).toContain("src/a.ts:4:9 error Unexpected any @typescript-eslint/no-explicit-any");
    expect(organized.text).toContain("✖ 2 problems (1 error, 1 warning)");
  });
});

describe("git organizer", () => {
  it("keeps status paths and diff hunks instead of treating them as log noise", () => {
    const status = organizeShellOutput({ command: "git status", output: GIT_STATUS, complete: true, exitCode: 0 });
    expect(status.text).toContain("modified:   packages/web/src/a.ts");
    expect(status.text).toContain("docs/new.md");
    const diff = organizeShellOutput({ command: "git diff", output: GIT_DIFF, complete: true, exitCode: 0 });
    expect(diff.text).toContain("+export const y = 2;");
    const unknown = organizeShellOutput({ command: "git stash list", output: "stash@{0}: WIP", complete: true, exitCode: 0 });
    expect(unknown.kind).toBe("generic");
    expect(unknown.text).toContain("stash@{0}: WIP");
  });
});

describe("package-manager organizer", () => {
  it("runs the inner organizer on npm's script echo and keeps the PM framing", () => {
    const output = [
      "> app@1.2.3 test",
      "> vitest run",
      "",
      VITEST_FAIL,
      "",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npm test", output, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("vitest");
    expect(organized.text).toContain("> vitest run");
    expect(organized.text).toContain("FAIL src/mid.test.ts");
    expect(organized.text).toContain("Tests  1 failed | 10 passed (11)");
    expect(organized.text).not.toContain("RERUN");
  });

  it("identifies the inner tool through yarn's `$` echo and bun's echo", () => {
    const yarnOutput = ["yarn run v1.22.22", "$ tsc --noEmit", TSC_FAIL, "error Command failed with exit code 2.", ""].join("\n");
    const yarn = organizeShellOutput({ command: "yarn test", output: yarnOutput, complete: true, exitCode: 2 });
    expect(yarn.kind).toBe("tsc");
    expect(yarn.text).toContain("src/a.ts(12,5): error TS2322");
    expect(yarn.text).toContain("error Command failed with exit code 2.");
    const bunOutput = ["$ vitest run", VITEST_PASS].join("\n");
    const bun = organizeShellOutput({ command: "bun run test", output: bunOutput, complete: true, exitCode: 0 });
    expect(bun.kind).toBe("vitest");
    expect(bun.text).toContain("Test Files  2 passed (2)");
  });

  it("falls back to the body shape when the echo names an unorganized tool", () => {
    const output = [
      "> app@1.0.0 test",
      "> node ./scripts/run-tests.mjs",
      "",
      VITEST_PASS,
    ].join("\n");
    const organized = organizeShellOutput({ command: "pnpm run test", output, complete: true, exitCode: 0 });
    expect(organized.kind).toBe("vitest");
    expect(organized.text).toContain("> node ./scripts/run-tests.mjs");
  });

  it("keeps install summaries and unique warnings while collapsing only duplicate noise", () => {
    const warns = Array.from({ length: 6 }, (_, index) => `npm warn deprecated dep-${index}@1.0.0`);
    const output = [
      ...warns,
      "npm warn exec ok to proceed",
      "Progress: resolved 12, reused 10",
      "Downloading registry.example/pkg-1.0.0.tgz",
      "added 234 packages in 12s",
      "found 0 vulnerabilities",
      "",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npm install", output, complete: true, exitCode: 0 });
    expect(organized.kind).toBe("package-manager");
    expect(organized.text).toContain("added 234 packages in 12s");
    expect(organized.text).toContain("found 0 vulnerabilities");
    // Unique warnings are preserved (D-241 rework): each deprecation warning
    // is distinct and carries independent information.
    expect(organized.text).toContain("npm warn deprecated dep-0@1.0.0");
    expect(organized.text).toContain("npm warn deprecated dep-5@1.0.0");
    expect(organized.text).toContain("npm warn exec ok to proceed");
    // Only truly duplicate/no-independent-info noise (download progress) is folded.
    expect(organized.text).not.toMatch(/^Downloading /m);
    expect(organized.text).toContain("collapsed 1 package-manager noise line(s)");
    expect(organized.omitted).toBe(true);
  });

  it("folds repeated identical warnings but keeps the first occurrence", () => {
    const output = [
      "npm warn deprecated foo@1.0.0",
      "npm warn deprecated foo@1.0.0",
      "npm warn deprecated foo@1.0.0",
      "added 1 package in 1s",
      "",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npm install", output, complete: true, exitCode: 0 });
    expect(organized.kind).toBe("package-manager");
    // First occurrence is kept; duplicates are folded.
    expect(organized.text).toContain("npm warn deprecated foo@1.0.0");
    expect(organized.text).toContain("collapsed 2 package-manager noise line(s)");
    expect(organized.text).toContain("added 1 package in 1s");
  });

  it("keeps a failed script's error block without an echo", () => {
    const output = [
      "npm error Missing script: \"test\"",
      "npm error",
      "npm error To see a list of scripts, run:",
      "npm error   npm run",
      "",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npm test", output, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("package-manager");
    expect(organized.text).toContain("npm error Missing script");
    expect(organized.text).toContain("npm error   npm run");
  });

  it("preserves unrecognizable inner output rather than claiming a tool ran", () => {
    const output = [
      "> app@1.0.0 build",
      "> node ./scripts/build.mjs",
      "compiling assets...",
      "assets ready in 2.1s",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npm run build", output, complete: true, exitCode: 0 });
    expect(organized.kind).toBe("package-manager");
    expect(organized.text).toContain("compiling assets...");
    expect(organized.text).toContain("assets ready in 2.1s");
  });

  it("still organizes an exec-form command as its tool, not the manager", () => {
    const organized = organizeShellOutput({ command: "pnpm exec vitest run", output: VITEST_FAIL, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("vitest");
    expect(organized.text).toContain("FAIL src/mid.test.ts");
  });

  it("routes an unknown binary behind pnpm dlx to generic, not package-manager (D-241 rework)", () => {
    // pnpm dlx custom-tool: the inner binary is not a supported tool, so the
    // output goes through generic organization — PM noise folding must not
    // hide the tool's own output.
    expect(identifyFromCommand("pnpm dlx custom-tool")?.kind).toBeUndefined();
    const output = [
      "custom-tool: processing files...",
      "custom-tool: found 3 issues",
      "Done.",
    ].join("\n");
    const organized = organizeShellOutput({ command: "pnpm dlx custom-tool", output, complete: true, exitCode: 0 });
    expect(organized.kind).toBe("generic");
    expect(organized.text).toContain("custom-tool: processing files...");
    expect(organized.text).toContain("custom-tool: found 3 issues");
  });

  it("keeps a checksum failure in a download progress line (D-241 rework)", () => {
    // A progress line mentioning checksum failure is failure-relevant noise —
    // it must NOT be folded as duplicate noise.
    const output = [
      "Downloading registry.example/pkg-1.0.0.tgz",
      "npm warn download failed: checksum mismatch for pkg-1.0.0.tgz",
      "npm error code EINTEGRITY",
      "npm error sha512 integrity verification failed",
      "",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npm install", output, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("package-manager");
    // The checksum warning is failure-relevant and must be kept.
    expect(organized.text).toContain("checksum mismatch");
    expect(organized.text).toContain("EINTEGRITY");
    expect(organized.text).toContain("integrity verification failed");
  });

  it("keeps a unique EBADENGINE warning on non-zero exit as required content (D-241 rework)", () => {
    const output = [
      "npm warn EBADENGINE Unsupported engine: wanted node >= 20",
      "npm warn EBADENGINE Not compatible with your version of node",
      "npm error code 1",
      "npm error Command failed with exit code 1",
      "",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npm install", output, complete: true, exitCode: 1 });
    expect(organized.kind).toBe("package-manager");
    // Both EBADENGINE warnings are unique (different text) and failure-relevant.
    expect(organized.text).toContain("EBADENGINE Unsupported engine");
    expect(organized.text).toContain("Not compatible with your version");
    expect(organized.text).toContain("Command failed with exit code 1");
  });

  it("preserves watch/interactive prompts in package-manager output (D-241 rework)", () => {
    const output = [
      "> app@1.0.0 test",
      "> vitest run --watch",
      "",
      "FAIL src/mid.test.ts",
      "  × math > adds",
      "press h to show help, press q to quit",
      " Test Files  1 failed (1)",
      "   Duration  3s",
    ].join("\n");
    const organized = organizeShellOutput({ command: "npm test", output, complete: false, exitCode: 1 });
    expect(organized.kind).toBe("vitest");
    expect(organized.partial).toBe(true);
    expect(organized.text).toContain("press h to show help");
    expect(organized.text).toContain("FAIL src/mid.test.ts");
  });

  it("preserves sharded output with explicit pagination on raw bytes (D-241 rework)", () => {
    // Sharded output: each shard's content must survive organization. The
    // original stdout, UTF-8 byte cursor, and OutputRef remain as-is —
    // organization only affects the display text.
    const shard1 = Array.from({ length: 200 }, (_, i) => `shard1 line ${i}`).join("\n");
    const shard2 = Array.from({ length: 200 }, (_, i) => `shard2 line ${i}`).join("\n");
    const output = `${shard1}\n${shard2}`;
    const organized = organizeShellOutput({ command: "npm run big", output, complete: true, exitCode: 0 });
    expect(organized.kind).toBe("package-manager");
    // First and last lines from each shard should be present or the omission
    // note should explain what was cut.
    expect(organized.text).toContain("shard1 line 0");
    expect(organized.text).toContain("shard2 line 199");
    expect(utf8Bytes(organized.text)).toBeLessThanOrEqual(SHELL_DISPLAY_BUDGET);
  });
});

describe("normalization and budget", () => {
  it("retains the current text before a trailing carriage return", () => {
    expect(normalizeShellText("working\rError: failed\r")).toBe("Error: failed");
  });

  it("bounds a long prompt stream and preserves its first and last text", () => {
    const output = Array.from({ length: 4_000 }, (_, i) => `? prompt ${i} ${"你".repeat(12)}`).join("\n");
    const result = organizeShellOutput({ command: "unknown", output, complete: false });
    expect(result.text).toContain("? prompt 0");
    expect(result.text).toContain("? prompt 3999");
    expect(result.text).not.toContain("\uFFFD");
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(SHELL_DISPLAY_BUDGET);
  });

  it("keeps text when block separators alone exceed the available budget", () => {
    const required = Array.from({ length: 4_000 }, (_, i) => `error ${i}`);
    const result = fitBlocks({ required, budget: 1_000 });
    expect(result.text).toContain("error 0");
    expect(result.text).toContain("error 3999");
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(1_000);
    expect(result.omitted).toBeGreaterThan(0);
  });

  it("handles ANSI, CRLF, and a dangling fragment as a current observation", () => {
    const organized = organizeShellOutput({
      command: "npx tsc --noEmit",
      output: "src/a.ts(1,1): error TS1234: broken\r\n\x1b[31msrc/b.ts(2,2): error TS1111: more\x1b[0m",
      complete: false,
    });
    expect(organized.partial).toBe(true);
    expect(organized.text).toContain("src/a.ts(1,1): error TS1234");
    expect(organized.text).toContain("src/b.ts(2,2): error TS1111");
    expect(organized.text).not.toContain("\x1b");
    const completed = organizeShellOutput({ command: 'printf result', output: 'result', complete: true, exitCode: 42 });
    expect(completed.partial).toBe(false);
    expect(completed.text).toContain('result');
  });

  it("states omission when failures exceed the existing display budget", () => {
    const failures = Array.from({ length: 80 }, (_, index) => (
      `FAIL src/f${index}.test.ts\n  AssertionError: case ${index}\n  Expected: ${"x".repeat(400)}\n`
    )).join("");
    const output = `${failures} Test Files  80 failed (80)\n      Tests  80 failed (80)\n   Duration  9s`;
    const organized = organizeShellOutput({ command: "vitest run", output, complete: true, exitCode: 1 });
    expect(organized.omitted).toBe(true);
    expect(organized.text).toContain("FAIL src/f0.test.ts");
    expect(organized.text).toContain("Test Files  80 failed (80)");
    expect(organized.text).toContain("omitted");
    expect(utf8Bytes(organized.text)).toBeLessThanOrEqual(SHELL_DISPLAY_BUDGET);
  });

  it("reports representative before/after display sizes", () => {
    const padded = `${"PASS src/ok.test.ts\n".repeat(40)}${VITEST_FAIL}`;
    const organized = organizeShellOutput({ command: "vitest run", output: padded, complete: true, exitCode: 1 });
    expect(utf8Bytes(padded)).toBe(1166);
    expect(utf8Bytes(organized.text)).toBeLessThan(350);
    expect(organized.text).toContain("AssertionError");
    expect(organized.text).toContain("Tests  1 failed | 10 passed (11)");
  });

  it("uses generic head and tail output for an unknown long command", () => {
    const output = ["first line", ...Array.from({ length: 4000 }, (_, index) => `important line ${index}`), "last line"].join("\n");
    const organized = organizeShellOutput({ command: "some-tool", output, complete: true });
    expect(organized.kind).toBe("generic");
    expect(organized.text).toContain("first line");
    expect(organized.text).toContain("last line");
    expect(organized.text).toContain("omitted");
    expect(utf8Bytes(organized.text)).toBeLessThanOrEqual(SHELL_DISPLAY_BUDGET);
  });
});

describe("public bash and get_output chain", () => {
  const context = (): HarnessServiceContext => ({
    actor: {
      authorityInstanceId: "authority",
      sessionId: "s",
      workerId: "w",
      workerGeneration: 1,
      workspaceId: "ws",
      grantedCapabilities: ["process.shell"],
    },
    authorizedPaths: [],
    sessionId: "s",
    workspaceId: "ws",
    signal: new AbortController().signal,
  });

  it("returns organized display from shell.exec while stdout stays raw", async () => {
    const store = createOutputStore();
    const supervisor = {
      exec: async () => ({
        kind: "completed" as const,
        exitCode: 1,
        durationMs: 10,
        cwd: ".",
        stdout: `${"noise\n".repeat(20)}${VITEST_FAIL}`,
        stderr: "",
        handle: null,
        shown: null,
      }),
    };
    const host = {
      outputStore: store,
      observationCursors: createObservationCursorStore(),
      getInterpreter: () => ({ kind: "bash", command: "bash", args: [], env: {} }),
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    const result = await createShellExecService(host).handle({ command: "bunx vitest run" }, context());
    if (result.kind !== "completed") throw new Error("expected completed");
    expect(result.stdout).toContain("RERUN");
    expect(result.display).toContain("FAIL src/mid.test.ts");
    expect(result.display).not.toContain("RERUN");
    expect(result.organized?.kind).toBe("vitest");
  });

  it("organizes an npm-wrapped vitest run through shell.exec", async () => {
    const store = createOutputStore();
    const supervisor = {
      exec: async () => ({
        kind: "completed" as const,
        exitCode: 1,
        durationMs: 10,
        cwd: ".",
        stdout: `> app@1.0.0 test\n> vitest run\n\n${VITEST_FAIL}`,
        stderr: "",
        handle: null,
        shown: null,
      }),
    };
    const host = {
      outputStore: store,
      observationCursors: createObservationCursorStore(),
      getInterpreter: () => ({ kind: "bash", command: "bash", args: [], env: {} }),
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    const result = await createShellExecService(host).handle({ command: "npm test" }, context());
    if (result.kind !== "completed") throw new Error("expected completed");
    expect(result.organized?.kind).toBe("vitest");
    expect(result.display).toContain("> vitest run");
    expect(result.display).toContain("FAIL src/mid.test.ts");
  });

  it("organizes incremental get_output and keeps explicit paging on raw bytes", async () => {
    const output = `${"ok\n".repeat(5)}${VITEST_FAIL}`;
    const cursors = createObservationCursorStore();
    const supervisor = {
      exec: async () => ({
        kind: "background" as const,
        id: "sh_1",
        waitedMs: 10,
        cwd: ".",
        outputSoFar: "ok\n",
        command: "bunx vitest run",
      }),
      read: async (_id: string, offset = 0, length = 32_768) => {
        const bytes = Buffer.from(output, "utf8");
        const end = Math.min(bytes.length, offset + length);
        return {
          text: bytes.subarray(offset, end).toString("utf8"),
          offset,
          length: end - offset,
          nextOffset: end,
          total: bytes.length,
          eof: end >= bytes.length,
          running: false,
          exitCode: 1,
          command: "bunx vitest run",
        };
      },
    };
    const host = {
      outputStore: createOutputStore(),
      observationCursors: cursors,
      getInterpreter: () => ({ kind: "bash", command: "bash", args: [], env: {} }),
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    await createShellExecService(host).handle({ command: "bunx vitest run", waitMs: 10 }, context());
    const incremental = await createShellReadService(host).handle({ id: "sh_1" }, context());
    expect(incremental.text).toContain("RERUN");
    expect(incremental.display).toContain("FAIL src/mid.test.ts");
    expect(incremental.display).not.toContain("RERUN");
    expect(incremental.organized?.kind).toBe("vitest");
    const rawPage = await createShellReadService(host).handle({ id: "sh_1", offset: 0, length: 20 }, context());
    expect(rawPage.text.startsWith("ok\n")).toBe(true);
    expect(rawPage.display).toBeUndefined();
    cursors.dispose();
  });

  it("keeps an error that arrives in a later shell.read slice", async () => {
    const cursors = createObservationCursorStore();
    const supervisor = {
      exec: async () => ({
        kind: "background" as const,
        id: "sh_2",
        waitedMs: 10,
        cwd: ".",
        outputSoFar: "FAIL src/mid.test.ts\n",
        command: "bunx vitest run",
      }),
      read: async (_id: string, offset = 0) => ({
        text: offset === Buffer.byteLength("FAIL src/mid.test.ts\n", "utf8")
          ? "Error: expected 2 to be 1\n Test Files  1 failed (1)\n   Duration  3s\n"
          : "FAIL src/mid.test.ts\n",
        offset,
        length: offset === Buffer.byteLength("FAIL src/mid.test.ts\n", "utf8") ? 78 : Buffer.byteLength("FAIL src/mid.test.ts\n", "utf8"),
        nextOffset: offset === Buffer.byteLength("FAIL src/mid.test.ts\n", "utf8") ? 100 : Buffer.byteLength("FAIL src/mid.test.ts\n", "utf8"),
        total: 100,
        eof: true,
        running: false,
        exitCode: 1,
        command: "bunx vitest run",
      }),
    };
    const host = {
      outputStore: createOutputStore(),
      observationCursors: cursors,
      getInterpreter: () => ({ kind: "bash", command: "bash", args: [], env: {} }),
      getShellSupervisor: () => supervisor,
    } as unknown as HarnessServiceHost;
    await createShellExecService(host).handle({ command: "bunx vitest run", waitMs: 10 }, context());
    const result = await createShellReadService(host).handle({ id: "sh_2" }, context());
    expect(result.display).toContain("Error: expected 2 to be 1");
    expect(result.organized?.partial).toBe(true);
    cursors.dispose();
  });
});
