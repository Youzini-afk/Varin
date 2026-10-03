import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, it as vitestIt } from "vitest";
import { createKernelClient, type KernelClient } from "../kernel/kernel-client.js";
import {
  materializeExperimentAttempt,
  prepareExperimentInput,
  type ExperimentWorkspaceCaller,
} from "./experiment-workspace.js";
import { canonicalizePathIdentity, isPathWithinRoot } from "../workspace/path-safety.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH
  ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")) as { version: string };
const hasReleaseKernel = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1" && !hasReleaseKernel) {
  throw new Error("Experiment workspace acceptance requires a built release kernel");
}
const it = vitestIt.skipIf(!hasReleaseKernel);

const clients: KernelClient[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-experiment-workspace-"));
  roots.push(root);
  const source = path.join(root, "source");
  const storageRoot = path.join(root, "storage");
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  const client = createKernelClient({
    hostId: "experiment-workspace-test",
    storageRoot,
    kernelPath,
    buildVersion: buildVersion.version,
    allowCargoDevRunner: false,
  });
  clients.push(client);
  await client.start();
  const caller: ExperimentWorkspaceCaller = {
    workspaceId: "experiment-workspace",
    executionWorkspaceId: "experiment-workspace-execution",
    sessionId: "experiment-session",
    threadId: "experiment-thread",
    runId: "experiment-run",
  };
  return { root, source, storageRoot, client, caller };
}

it("freezes the source before queue time and records the actual capture semantics", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.source, "note.txt"), "before\n");
  await fs.writeFile(path.join(f.source, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(f.source, "ignored.txt"), "still captured\n");
  const input = await prepareExperimentInput(f.client, f.caller, f.source, { captureScopes: [], cwd: "nested" });
  assert.equal(input.captureSemantics.gitignore, "not-applied");
  assert.equal(input.captureSemantics.ignoredFilesIncluded, true);
  assert.deepEqual(input.captureSemantics.excludedDirectories, [".git", ".varin"]);

  // This is the live source changing while a queued attempt waits. The
  // materializer must use input.root, never the source path again.
  await fs.writeFile(path.join(f.source, "note.txt"), "after queue\n");
  const attempt = await materializeExperimentAttempt(f.client, f.caller, "attempt-queued", input);
  assert.equal(await fs.readFile(path.join(attempt.canonicalRoot, "note.txt"), "utf8"), "before\n");
  assert.equal(await fs.readFile(path.join(attempt.canonicalRoot, "ignored.txt"), "utf8"), "still captured\n");
  const managedRoot = await canonicalizePathIdentity(path.join(f.storageRoot, "managed", "experiments"));
  assert.ok(isPathWithinRoot(attempt.canonicalRoot, managedRoot));
  assert.equal(attempt.cwd, "nested");
});

it("materializes each attempt below its own managed directory", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.source, "result.txt"), "input baseline\n");
  const input = await prepareExperimentInput(f.client, f.caller, f.source, { captureScopes: [] });
  const first = await materializeExperimentAttempt(f.client, f.caller, "attempt-one", input);
  const second = await materializeExperimentAttempt(f.client, f.caller, "attempt-two", input);
  assert.notEqual(first.canonicalRoot, second.canonicalRoot);

  await fs.writeFile(path.join(first.canonicalRoot, "result.txt"), "first result\n");
  await fs.writeFile(path.join(second.canonicalRoot, "result.txt"), "second result\n");
  assert.equal(await fs.readFile(path.join(first.canonicalRoot, "result.txt"), "utf8"), "first result\n");
  assert.equal(await fs.readFile(path.join(second.canonicalRoot, "result.txt"), "utf8"), "second result\n");
});

it("reopens the kernel and materializes the same persisted input root", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.source, "reopen.txt"), "durable input\n");
  const input = await prepareExperimentInput(f.client, f.caller, f.source, { captureScopes: [] });
  await f.client.close();
  clients.splice(clients.indexOf(f.client), 1);

  const reopened = createKernelClient({
    hostId: "experiment-workspace-test",
    storageRoot: f.storageRoot,
    kernelPath,
    buildVersion: buildVersion.version,
    allowCargoDevRunner: false,
  });
  clients.push(reopened);
  await reopened.start();
  const attempt = await materializeExperimentAttempt(reopened, f.caller, "attempt-after-restart", input);
  assert.equal(attempt.branchId, input.branchId);
  assert.equal(attempt.snapshotRoot, input.root);
  assert.equal(await fs.readFile(path.join(attempt.canonicalRoot, "reopen.txt"), "utf8"), "durable input\n");
});

const symlinkIt = vitestIt.skipIf(!hasReleaseKernel);

symlinkIt("rewrites in-root absolute symlinks for the attempt snapshot and rejects escapes", async () => {
  const f = await fixture();
  const targetDirectory = path.join(f.source, "target-dir");
  const targetFile = path.join(targetDirectory, "target.txt");
  const link = path.join(f.source, "absolute-link");
  await fs.mkdir(targetDirectory, { recursive: true });
  await fs.writeFile(targetFile, "fixed target\n");
  if (process.platform === "win32") {
    await fs.symlink(targetDirectory, link, "junction");
  } else {
    await fs.symlink(targetFile, `${link}.txt`);
  }
  const input = await prepareExperimentInput(f.client, f.caller, f.source, { captureScopes: [] });
  await fs.writeFile(targetFile, "live target\n");
  if (process.platform === "win32") {
    // Windows junction creation requires a privilege that may be unavailable
    // to the release-kernel test process. Verify the immutable branch state,
    // which is the boundary responsible for rewriting the live absolute link.
    const grant = await f.client.issueGrant({
      grantId: "experiment-workspace-symlink-read",
      owningWorkspace: f.caller.workspaceId,
      executionWorkspace: f.caller.executionWorkspaceId,
      capabilities: ["storage.read"],
      pathScopes: [""],
    });
    const branch = await f.client.scoped(grant).readBranch({
      branchId: input.branchId,
      paths: ["absolute-link"],
      includeEntries: true,
    });
    const state = branch.entries[0]?.state;
    assert.equal(state?.kind, "symlink");
    assert.equal(path.isAbsolute(String((state as { symlinkTarget?: string }).symlinkTarget)), false);
  } else {
    const attempt = await materializeExperimentAttempt(f.client, f.caller, "attempt-symlink", input);
    const materializedLink = path.join(attempt.canonicalRoot, "absolute-link.txt");
    const target = await fs.readlink(materializedLink);
    assert.equal(path.isAbsolute(target), false);
    assert.equal(await fs.readFile(materializedLink, "utf8"), "fixed target\n");
  }

  const outsideDirectory = path.join(f.root, "outside-directory");
  await fs.mkdir(outsideDirectory, { recursive: true });
  const escaping = path.join(f.source, "escape-link");
  if (process.platform === "win32") {
    await fs.symlink(outsideDirectory, escaping, "junction");
  } else {
    await fs.symlink(path.join(f.root, "outside.txt"), `${escaping}.txt`);
  }
  await assert.rejects(prepareExperimentInput(f.client, f.caller, f.source, { captureScopes: [] }), /outside|symlink|captured/i);
});
