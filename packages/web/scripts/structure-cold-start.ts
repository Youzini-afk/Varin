/**
 * Repeatable cold-start measurement for the agent language view.
 *
 * Not part of the default test suite: it starts the real TypeScript language
 * server and the time depends on the machine. Run with:
 *
 *   bun run --cwd packages/web structure:cold-start
 *
 * Prints one JSON object to stdout. Does not claim a speedup.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS,
} from "@varin/extension-builtins/host";
import {
  VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
} from "@varin/extension-builtins";
import { createDocumentAuthorityHarness } from "../application-host/lib/documents/contract-fixtures.js";
import { AGENT_LANGUAGE_VIEW, createLanguageSupervisor } from "../application-host/lib/lsp/supervisor.js";
import { createLanguageViewBinder } from "../application-host/lib/lsp/language-view.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const subjectSource = path.join(here, "../application-host/lib/harness/explore.ts");

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const main = async (): Promise<void> => {
  const packageRoot = VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS.get(
    VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
  );
  if (!packageRoot) {
    throw new Error("TypeScript language extension package root is unavailable");
  }
  const subject = await fs.readFile(subjectSource, "utf8");
  const harness = await createDocumentAuthorityHarness();
  const language = createLanguageSupervisor({
    documents: harness.authority,
    spawn,
    pathModule: path,
    isTrusted: async () => true,
  });
  const binder = createLanguageViewBinder({ documents: harness.authority, supervisor: language });
  try {
    await fs.writeFile(path.join(harness.workspaceRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
      include: ["*.ts"],
    }));
    await fs.writeFile(path.join(harness.workspaceRoot, "explore.ts"), subject, "utf8");
    language.registerProvider({
      providerId: "varin.typescript-language",
      command: process.execPath,
      args: [path.join(packageRoot, "runtime", "typescript-language-server.mjs"), "--stdio"],
      initializationOptions: {
        tsserver: { fallbackPath: path.join(packageRoot, "runtime", "typescript", "lib", "tsserver.js") },
      },
      languageIds: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
      source: "builtin",
    });
    const snapshot = await harness.authority.read(harness.resource("explore.ts"));
    if (snapshot.status !== "ready") {
      throw new Error(`Subject file unread (${snapshot.status})`);
    }
    const started = performance.now();
    const bound = await binder.bind({
      workspaceId: harness.identity.workspaceId,
      resourceId: "explore.ts",
      languageId: "typescript",
      text: "disk",
    });
    const boundAt = performance.now();
    if (bound.status !== "bound") {
      throw new Error(bound.message);
    }
    const symbols = recordOf(await language.documentSymbols({
      view: AGENT_LANGUAGE_VIEW,
      resource: harness.resource("explore.ts"),
      languageId: "typescript",
      expectedRevision: bound.revision,
    }));
    const readyAt = performance.now();
    const views = language.inspectViews();
    const report = {
      ok: symbols.status === "ready",
      status: symbols.status,
      symbolCount: Array.isArray(symbols.value) ? symbols.value.length : 0,
      bindMs: Math.round(boundAt - started),
      documentSymbolMs: Math.round(readyAt - boundAt),
      coldStartToDocumentSymbolMs: Math.round(readyAt - started),
      method: {
        description: "Agent-view cold start: first bind (saved disk) plus first documentSymbols on a copy of packages/web/application-host/lib/harness/explore.ts in a one-file temp workspace with a minimal tsconfig. The language server process is not started until bind. Times are performance.now() in this process.",
        subjectFile: "explore.ts (copy of application-host/lib/harness/explore.ts)",
        subjectBytes: Buffer.byteLength(subject, "utf8"),
        languageId: "typescript",
        view: AGENT_LANGUAGE_VIEW,
        provider: "varin.typescript-language",
      },
      machine: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpus: os.cpus().length,
        totalMemMiB: Math.round(os.totalmem() / (1024 * 1024)),
        node: process.version,
        bun: process.versions.bun ?? null,
      },
      views,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (symbols.status !== "ready") process.exitCode = 1;
  } finally {
    await language.dispose();
    await harness.cleanup();
  }
};

await main();
