import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@varin/protocol";
import { HostError } from "../src/errors.js";
import { SessionHost } from "../src/session-host.js";

function createHost(agentDir: string, projectTrusted: boolean): SessionHost {
  return new SessionHost({
    agentDir,
    emit: <E extends HostEvent>(_event: E, _data: HostEventData<E>) => undefined,
    projectTrustOverride: projectTrusted,
  });
}

describe("SessionHost Pi resources", () => {
  it("creates, discovers, updates, and deletes native skills with revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-resources-prompt-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    await mkdir(cwd, { recursive: true });
    const host = createHost(agentDir, true);
    try {
      const snapshot = await host.openCatalogContext(cwd);
      const content = "---\nname: review\ndescription: Review a change\n---\nReview $1 carefully.\n";
      const created = await host.createResource("skill", "user", "review", content);
      assert.equal(created.content, content);
      assert.equal(created.descriptor.active, true);
      assert.equal(created.descriptor.sourceInfo.scope, "user");
      assert.equal(created.descriptor.writable, true);
      const command = host.listCommands(snapshot.sessionId).find((entry) => entry.name === "skill:review");
      assert.equal(command?.source, "skill");
      assert.equal(command?.sourceInfo?.path, created.descriptor.filePath);
      assert.equal(
        await readFile(join(agentDir, "skills", "review", "SKILL.md"), "utf8"),
        content,
      );

      const listed = await host.listResources("skill");
      assert.equal(listed.projectTrusted, true);
      assert.ok(listed.resources.some((resource) => resource.id === created.descriptor.id));

      const updatedContent = `${content}\nUse the project conventions.\n`;
      const updated = await host.updateResource(
        "skill",
        created.descriptor.id,
        updatedContent,
        created.revision,
      );
      assert.equal(updated.content, updatedContent);
      await assert.rejects(
        host.updateResource("skill", created.descriptor.id, content, created.revision),
        (error: unknown) => error instanceof HostError && error.code === "resource_conflict",
      );

      assert.deepEqual(
        await host.deleteResource(
          "skill",
          created.descriptor.id,
          updated.revision,
        ),
        { deleted: true, id: created.descriptor.id },
      );
      assert.equal(
        (await host.listResources("skill")).resources.some(
          (resource) => resource.id === created.descriptor.id,
        ),
        false,
      );
      assert.equal(host.listCommands(snapshot.sessionId).some((entry) => entry.name === "skill:review"), false);
    } finally {
      await host.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("copies complete skill directories and keeps invalid editable skills visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-resources-skill-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    await mkdir(cwd, { recursive: true });
    const host = createHost(agentDir, true);
    try {
      await host.openCatalogContext(cwd);
      const content = "---\nname: workspace-check\ndescription: Check the active workspace\n---\nInspect the workspace.\n";
      const projectSkill = await host.createResource(
        "skill",
        "project",
        "workspace-check",
        content,
      );
      const projectSkillDirectory = join(cwd, ".pi", "skills", "workspace-check");
      await mkdir(join(projectSkillDirectory, "scripts"), { recursive: true });
      await writeFile(join(projectSkillDirectory, "scripts", "check.ts"), "export {};\n", "utf8");
      await host.session.reload();

      const copied = await host.copyResource(
        "skill",
        projectSkill.descriptor.id,
        "user",
        "workspace-check-copy",
      );
      assert.equal(copied.descriptor.writable, true);
      assert.equal(
        await readFile(
          join(agentDir, "skills", "workspace-check-copy", "scripts", "check.ts"),
          "utf8",
        ),
        "export {};\n",
      );

      const invalidContent = "---\nname: workspace-check-copy\n---\nMissing a description for now.\n";
      const invalid = await host.updateResource(
        "skill",
        copied.descriptor.id,
        invalidContent,
        copied.revision,
      );
      assert.equal(invalid.content, invalidContent);
      assert.equal(invalid.descriptor.active, false);
      assert.equal(invalid.descriptor.valid, false);
      assert.equal(invalid.descriptor.writable, true);
      assert.ok(
        (await host.listResources("skill")).diagnostics.some(
          (diagnostic) => diagnostic.path === invalid.descriptor.filePath,
        ),
      );

      await host.deleteResource("skill", invalid.descriptor.id, invalid.revision);
      await assert.rejects(readFile(invalid.descriptor.filePath, "utf8"), /ENOENT/);
      await assert.rejects(
        readFile(join(dirname(invalid.descriptor.filePath), "scripts", "check.ts"), "utf8"),
        /ENOENT/,
      );
    } finally {
      await host.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps external resources read-only and enforces project trust on writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-resources-trust-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const externalSkill = join(root, "external", "shared.md");
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, "external"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(externalSkill, "---\nname: shared\ndescription: Shared skill\n---\nShared skill.\n", "utf8");
    await writeFile(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ skills: [externalSkill] }, null, 2)}\n`,
      "utf8",
    );
    const host = createHost(agentDir, false);
    try {
      await host.openCatalogContext(cwd);
      const external = (await host.listResources("skill")).resources.find(
        (resource) => resource.filePath === externalSkill,
      );
      assert.ok(external);
      assert.equal(external.writable, false);
      const externalDocument = await host.getResource("skill", external.id);
      await assert.rejects(
        host.updateResource("skill", external.id, "Changed.\n", externalDocument.revision),
        (error: unknown) => error instanceof HostError && error.code === "resource_read_only",
      );
      await assert.rejects(
        host.createResource("skill", "project", "blocked", "---\ndescription: no\n---\n"),
        (error: unknown) => error instanceof HostError && error.code === "project_not_trusted",
      );
      const copied = await host.copyResource("skill", external.id, "user", "shared-copy");
      assert.equal(copied.descriptor.writable, true);
      assert.match(copied.content, /Shared skill/);
      await assert.rejects(
        host.createResource("skill", "user", "../escape", "No escape.\n"),
        (error: unknown) => error instanceof HostError && error.code === "invalid_resource_name",
      );
    } finally {
      await host.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(root, { force: true, recursive: true });
    }
  });
});
