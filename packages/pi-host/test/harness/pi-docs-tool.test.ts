import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createPiDocsTool } from "../../src/harness/pi-docs-tool.js";
import { buildPermissionInspection } from "../../src/harness/permission-target.js";

test("runtime references page independently of workspace access and reject paths outside the SDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-pi-reference-"));
  try {
    const docs = join(root, "docs"); await mkdir(docs);
    await writeFile(join(docs, "codemode.md"), "First\nClassifiers\nGenerate images\nLast\n");
    await writeFile(join(root, "private.txt"), "workspace-only bytes");
    const tool = createPiDocsTool(docs);
    const ctx = { cwd: "/unreachable/remote/workspace" } as ExtensionToolContext;
    const list = await tool.execute("list", {}, undefined, undefined, ctx);
    assert.match(JSON.stringify(list.content), /codemode.md/);
    const page = await tool.execute("read", { document: "codemode.md", offset: 2, limit: 2 }, undefined, undefined, ctx);
    assert.match(JSON.stringify(page.content), /Classifiers\\nGenerate images/);
    assert.doesNotMatch(JSON.stringify(page.content), /First/);
    assert.equal((page.details as { document: string }).document, "codemode.md");
    for (const document of ["../private.txt", join(root, "private.txt")]) {
      await assert.rejects(tool.execute("outside", { document }, undefined, undefined, ctx), /SDK docs directory only/);
    }
    // A junction works on Windows without symlink privileges and checks the real target.
    await symlink(root, join(docs, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(tool.execute("alias", { document: "escape/private.txt" }, undefined, undefined, ctx), /SDK docs directory only/);
    const inspection = buildPermissionInspection({ cwd: ctx.cwd, toolName: tool.name,
      params: { document: "codemode.md" }, tool: { name: tool.name,
        sourceInfo: { path: "<sdk:pi_docs>", source: "sdk", scope: "runtime", origin: "sdk" } } });
    assert.equal(inspection.action, "read");
    assert.deepEqual(inspection.paths, [], "runtime reference names are not remote workspace paths");
    assert.equal(inspection.evidenceComplete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
