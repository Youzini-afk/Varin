import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { dispatchRuntimeRequest, PiRuntimeBroker } from "../src/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

const delay = (milliseconds: number) => new Promise((resolveDelay) => {
  setTimeout(resolveDelay, milliseconds);
});

test("package authority never loads project extensions from the server cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-foundation-neutral-cwd-"));
  const serverCwd = join(root, "server-project");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const packageRoot = join(root, "foundation-package");
  await Promise.all([
    mkdir(join(serverCwd, ".pi", "extensions"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
  ]);
  await writeFile(
    join(serverCwd, ".pi", "extensions", "blocking-project-extension.ts"),
    "await new Promise<void>(() => {});\nexport default function () {}\n",
    "utf8",
  );
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "pi-mcp-adapter",
      version: "2.29.0-neutral-cwd",
      pi: { extensions: ["./index.ts"] },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(packageRoot, "index.ts"), "export default function () {}\n", "utf8");

  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "foundation-neutral-cwd-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    cwd: serverCwd,
    environment: { HOME: homeDir },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
  });

  try {
    await broker.warmup();
    await Promise.race([
      dispatchRuntimeRequest(broker, "package.install", { cwd: serverCwd, scope: "global", source: packageRoot }),
      delay(15_000).then(() => {
        throw new Error("package authority was blocked by the server cwd");
      }),
    ]);
    assert.deepEqual(await broker.listSessions(), []);
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("a broken global extension remains removable through the package authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-package-recovery-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "blocking-package");
  const extensionStarted = join(root, "blocking-extension-started");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
  ]);
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "pi-mcp-adapter",
      version: "2.29.0-blocking",
      pi: { extensions: ["./index.ts"] },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(packageRoot, "index.ts"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(extensionStarted)}, "started\\n", "utf8");
await new Promise<void>(() => {});
export default function () {}
`,
    "utf8",
  );
  const broker = new PiRuntimeBroker({
    agentDir,
    client: { clientName: "package-recovery-test", clientVersion: "0.1.0", mode: "test" },
    cwd: workspace,
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
    shutdownTimeoutMs: 100,
  });
  let blocked: Promise<{ error?: unknown; status: "fulfilled" | "rejected" }> | undefined;
  try {
    await broker.warmup();
    await Promise.race([
      dispatchRuntimeRequest(broker, "package.install", { cwd: workspace, scope: "global", source: packageRoot }),
      delay(15_000).then(() => { throw new Error("package install did not finish"); }),
    ]);
    blocked = broker.listCommandsForWorkspace(workspace).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );
    await Promise.race([
      (async () => {
        while (true) {
          try {
            await access(extensionStarted);
            return;
          } catch {
            await delay(10);
          }
        }
      })(),
      delay(15_000).then(() => { throw new Error("broken extension did not reach its blocking point"); }),
    ]);
    const removed = await Promise.race([
      dispatchRuntimeRequest(broker, "package.remove", {
        cwd: workspace,
        scope: "global",
        source: packageRoot,
      }),
      delay(15_000).then(() => { throw new Error("package recovery was blocked by its extension"); }),
    ]);
    assert.equal(removed.removed, true);
    assert.equal((await blocked).status, "rejected");
    assert.deepEqual(await broker.listSessions(), []);
  } finally {
    await broker.dispose();
    await blocked;
    await rm(root, { force: true, recursive: true });
  }
});
