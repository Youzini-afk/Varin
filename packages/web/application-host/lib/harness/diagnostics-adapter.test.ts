import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { AGENT_LANGUAGE_VIEW, SURFACE_LANGUAGE_VIEW, createLanguageSupervisor } from "../lsp/supervisor.js";
import { VARIN_LSP_FIXTURE_SERVER_ARGS } from "../lsp/servers.js";
import { createLanguageSupervisorDiagnosticsProvider } from "./diagnostics-adapter.js";
import { createLspDiagnosticsService, type DiagnosticsProvider } from "./diagnostics-service.js";
import type { HarnessServiceContext } from "./router.js";

const contextFor = (workspaceId: string): HarnessServiceContext => ({
  actor: {
    authorityInstanceId: "host-1",
    sessionId: "session-1",
    workerId: "worker-1",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.lsp"],
  },
  authorizedPaths: [],
  sessionId: "session-1",
  workspaceId,
  signal: new AbortController().signal,
});

describe("LanguageSupervisor diagnostics adapter", () => {
  it("binds the file's disk text and reports the revision its diagnostics describe", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      const resourceId = "fixture.ts";
      const absolute = path.join(harness.workspaceRoot, resourceId);
      await fs.promises.writeFile(absolute, "export const fixture = true;\n");
      language.registerProvider({
        providerId: "fixture",
        command: process.execPath,
        args: VARIN_LSP_FIXTURE_SERVER_ARGS,
        languageIds: ["typescript"],
        source: "host",
      });
      const provider = createLanguageSupervisorDiagnosticsProvider(language, {
        documents: harness.authority,
      });
      const service = createLspDiagnosticsService(provider);

      const clean = await service.handle({ path: resourceId, waitMs: 2_000 }, contextFor(harness.identity.workspaceId));
      expect(clean).toMatchObject({ status: "ready", diagnostics: [], source: "disk" });
      const cleanRevision = (clean as { revision?: string }).revision;
      expect(cleanRevision).toBeTruthy();

      // An agent write changes disk; the answer must describe the new text.
      await fs.promises.writeFile(absolute, "// first line\n\n  FIXTURE_ERROR\n");
      const broken = await service.handle({ path: resourceId, waitMs: 2_000 }, contextFor(harness.identity.workspaceId));
      expect(broken).toMatchObject({
        status: "ready",
        source: "disk",
        diagnostics: [expect.objectContaining({ message: "fixture error", severity: "error", line: 3, character: 3 })],
      });
      expect((broken as { revision?: string }).revision).not.toBe(cleanRevision);

      await fs.promises.writeFile(absolute, "export const fixture = true;\n");
      const fixed = await service.handle({ path: resourceId, waitMs: 2_000 }, contextFor(harness.identity.workspaceId));
      expect(fixed).toMatchObject({ status: "ready", diagnostics: [] });
      // Diagnostics ran entirely in the Host view; the editor view is untouched.
      expect(language.getStatus(harness.identity.workspaceId, "typescript", SURFACE_LANGUAGE_VIEW).status).toBe("absent");
      expect(language.getStatus(harness.identity.workspaceId, "typescript", AGENT_LANGUAGE_VIEW).status).toBe("ready");
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it("does not answer with another file's diagnostics for a shared path suffix", async () => {
    const items = [{ line: 1, character: 0, severity: "error", message: "nested", source: "fixture" }];
    const suffixed: DiagnosticsProvider = {
      getDiagnosticsForRevision: async (_workspaceId, pathValue) => (pathValue === "src/lib/a.ts" ? items : []),
      bindDocument: async () => ({ status: "bound", revision: "r1", source: "disk" }),
      getSnapshot: async () => "0:1",
    };
    const service = createLspDiagnosticsService(suffixed);
    await expect(service.handle({ path: "a.ts", waitMs: 10 }, contextFor("workspace")))
      .resolves.toMatchObject({ status: "ready", diagnostics: [] });
  });

  it("keeps an available server with no publication distinct from an unavailable file type", async () => {
    const silent: DiagnosticsProvider = {
      getDiagnosticsForRevision: async () => null,
      bindDocument: async (_workspaceId, pathValue) => (pathValue.endsWith(".ts")
        ? { status: "bound", revision: "r1", source: "disk" }
        : { status: "unsupported" }),
      getSnapshot: async () => null,
    };
    const service = createLspDiagnosticsService(silent);
    await expect(service.handle({ path: "slow.ts", waitMs: 10 }, contextFor("workspace")))
      .resolves.toMatchObject({ status: "pending", revision: "r1" });
    await expect(service.handle({ path: "README.unknown" }, contextFor("workspace")))
      .resolves.toMatchObject({ status: "unavailable" });
  });
});
