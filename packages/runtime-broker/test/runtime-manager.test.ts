import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HostHandshakeResult, PiRuntimeInstallation } from "@varin/protocol";
import { readPinnedPiVersion, type RuntimeCandidate } from "@varin/pi-host/discovery";
import { PiHostEntryUnavailableError } from "../src/errors.js";
import { PiRuntimeManager, type PiRuntimeManagerOptions } from "../src/runtime-manager.js";
import { saveRuntimeSelection } from "../src/runtime-selection-store.js";

const SYSTEM_ROOT = "C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent";
const BUNDLED_ROOT = "C:\\Varin\\bundled\\pi";
const CUSTOM_ROOT = "D:\\other\\pi-coding-agent";
const TARGET_VERSION = readPinnedPiVersion();
const NEWER_VERSION = `${Number(TARGET_VERSION.split('.')[0]) + 1}.0.0`;

// These tests own discovery results and install plans. Package-manager probing
// belongs to the discovery/installer suites, not the developer's real PATH.
const createManager = (options: PiRuntimeManagerOptions): PiRuntimeManager => new PiRuntimeManager({
  ...options,
  discovery: { commandRunner: async () => ({ exitCode: 1, stderr: '', stdout: '' }), ...options.discovery },
});

const systemReady: RuntimeCandidate = {
  available: true,
  command: "C:\\tools\\pi.cmd",
  compatible: true,
  id: "system",
  nodePath: "C:\\tools\\node.exe",
  packageRoot: SYSTEM_ROOT,
  source: "system",
  version: TARGET_VERSION,
};

const systemOld: RuntimeCandidate = {
  ...systemReady,
  compatible: false,
  version: "0.80.0",
};

const systemNewer: RuntimeCandidate = {
  ...systemReady,
  version: NEWER_VERSION,
};

const bundledReady: RuntimeCandidate = {
  available: true,
  compatible: true,
  id: "bundled",
  nodePath: "C:\\Varin\\node.exe",
  packageRoot: BUNDLED_ROOT,
  source: "bundled",
  version: TARGET_VERSION,
};

const planNone = () => ({
  action: "none" as const,
  reason: "already installed",
  targetVersion: TARGET_VERSION,
});

const handshakeFor = (
  installation: PiRuntimeInstallation,
  dataDir: string,
): HostHandshakeResult => ({
  capabilities: {
    agentProviders: true,
    extensionUi: true,
    fleet: true,
    models: true,
    packages: true,
    providerConfiguration: true,
    recovery: true,
    resources: true,
    sessionFeatures: true,
    sessions: true,
    settings: true,
  },
  hostVersion: "0.1.0",
  protocolVersion: 1,
  runtime: {
    agentDir: dataDir,
    nodePath: installation.nodePath ?? "C:\\tools\\node.exe",
    nodeVersion: "22.19.0",
    ...(installation.packageRoot === undefined ? {} : { packageRoot: installation.packageRoot }),
    piVersion: installation.version ?? TARGET_VERSION,
    source: installation.source,
  },
});

const withDataDir = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-runtime-manager-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
};

test("starts a discovered system install and records the callback handshake", async () => {
  await withDataDir(async (dataDir) => {
    const revisions: number[] = [];
    const manager = createManager({
      dataDir,
      discover: async () => [systemReady],
      planInstall: planNone,
      startRuntime: async (installation) => {
        assert.equal(installation.packageRoot, SYSTEM_ROOT);
        return handshakeFor(installation, dataDir);
      },
    });
    manager.subscribe((snapshot) => revisions.push(snapshot.revision));

    const snapshot = await manager.refresh();

    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.active?.source, "system");
    assert.equal(snapshot.active?.packageRoot, SYSTEM_ROOT);
    assert.equal(snapshot.active?.state, "ready");
    assert.equal("compatible" in (snapshot.active ?? {}), false);
    assert.equal(snapshot.revision, revisions.at(-1));
    assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!));
  });
});

test("keeps a newer installed Pi without downgrading or skipping startup", async () => {
  await withDataDir(async (dataDir) => {
    let started = false;
    const manager = createManager({
      dataDir,
      discover: async () => [systemNewer],
      planInstall: () => ({
        action: "keep-newer" as const,
        currentVersion: NEWER_VERSION,
        reason: "keep newer",
        targetVersion: TARGET_VERSION,
      }),
      startRuntime: async (installation) => {
        started = true;
        return handshakeFor(installation, dataDir);
      },
    });

    const snapshot = await manager.refresh();

    assert.equal(started, true);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.active?.version, NEWER_VERSION);
    assert.equal(JSON.stringify(snapshot).includes("downgrade"), false);
  });
});

test("marks an older install as upgrade-required without starting it", async () => {
  await withDataDir(async (dataDir) => {
    let started = false;
    const manager = createManager({
      dataDir,
      discover: async () => [systemOld],
      planInstall: () => ({
        action: "upgrade" as const,
        currentVersion: "0.80.0",
        manager: "npm" as const,
        executable: "npm.cmd",
        args: ["install", "-g", `@earendil-works/pi-coding-agent@${TARGET_VERSION}`],
        reason: "upgrade",
        targetVersion: TARGET_VERSION,
      }),
      startRuntime: async (installation) => {
        started = true;
        return handshakeFor(installation, dataDir);
      },
    });

    const snapshot = await manager.refresh();

    assert.equal(started, false);
    assert.equal(snapshot.status, "upgrade-required");
    assert.equal(snapshot.installations[0]?.state, "upgrade-required");
  });
});

test("preserves a typed Host startup failure through the runtime snapshot", async () => {
  await withDataDir(async (dataDir) => {
    const manager = createManager({
      dataDir,
      discover: async () => [systemReady],
      planInstall: planNone,
      startRuntime: async () => {
        throw new PiHostEntryUnavailableError([join(dataDir, "host-bootstrap.js")]);
      },
    });

    const snapshot = await manager.refresh();

    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.issueCode, "host-entry-unavailable");
    assert.match(snapshot.issue ?? "", /installation files required to start Pi are missing/);
  });
});

test("reports probing until the startup callback completes", async () => {
  await withDataDir(async (dataDir) => {
    let release!: () => void;
    let callbackEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      callbackEntered = resolve;
    });
    const manager = createManager({
      dataDir,
      discover: async () => [systemReady],
      planInstall: planNone,
      startRuntime: async (installation) => {
        callbackEntered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return handshakeFor(installation, dataDir);
      },
    });

    const startPromise = manager.refresh();
    try {
      await Promise.race([
        entered,
        startPromise.then(() => assert.fail('refresh completed without entering the startup callback')),
      ]);
      assert.equal(manager.snapshot.status, "probing");
      assert.equal(manager.snapshot.active, undefined);
    } finally {
      release?.();
    }
    const snapshot = await startPromise;
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.active?.state, "ready");
  });
});

test("start selects bundled Pi directly without invoking install discovery", async () => {
  await withDataDir(async (dataDir) => {
    const selectedIds: Array<string | undefined> = [];
    let commandRunnerCalls = 0;
    const manager = createManager({
      dataDir,
      discover: async (options = {}) => {
        selectedIds.push(options.selectedId);
        return [systemReady, bundledReady];
      },
      discovery: {
        commandRunner: async () => {
          commandRunnerCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
      startRuntime: async (installation) => handshakeFor(installation, dataDir),
    });

    const snapshot = await manager.start();

    assert.deepEqual(selectedIds, ["bundled"]);
    assert.equal(commandRunnerCalls, 0);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.active?.id, "bundled");
  });
});

test("honors an explicit selected runtime ahead of bundled Pi", async () => {
  await withDataDir(async (dataDir) => {
    await saveRuntimeSelection(dataDir, { selectedId: "system" });
    const selectedIds: Array<string | undefined> = [];
    const started: string[] = [];
    const manager = createManager({
      dataDir,
      discover: async (options = {}) => {
        selectedIds.push(options.selectedId);
        return [systemReady, bundledReady];
      },
      startRuntime: async (installation) => {
        started.push(installation.id);
        return handshakeFor(installation, dataDir);
      },
    });

    const snapshot = await manager.start();

    assert.deepEqual(selectedIds, ["system"]);
    assert.deepEqual(started, ["system"]);
    assert.equal(snapshot.selectedId, "system");
    assert.equal(snapshot.active?.id, "system");
  });
});

test("does not fall back to bundled Pi when an explicit selection is missing", async () => {
  await withDataDir(async (dataDir) => {
    await saveRuntimeSelection(dataDir, { selectedId: "system" });
    let started = false;
    const manager = createManager({
      dataDir,
      discover: async (options = {}) => {
        assert.equal(options.selectedId, "system");
        return [bundledReady];
      },
      startRuntime: async (installation) => {
        started = true;
        return handshakeFor(installation, dataDir);
      },
    });

    const snapshot = await manager.start();

    assert.equal(started, false);
    assert.equal(snapshot.status, "missing");
    assert.equal(snapshot.selectedId, "system");
    assert.equal(snapshot.active, undefined);
  });
});

test("does not download or install when PATH already has a usable Pi", async () => {
  await withDataDir(async (dataDir) => {
    let installed = false;
    const manager = createManager({
      dataDir,
      discover: async () => [systemReady],
      installer: {
        runCommand: async () => {
          installed = true;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
      planInstall: planNone,
      startRuntime: async (installation) => handshakeFor(installation, dataDir),
    });

    await manager.refresh();
    await manager.install();
    assert.equal(installed, false);
  });
});

test("upgrades an older Pi then starts the rediscovered install", async () => {
  await withDataDir(async (dataDir) => {
    const calls: string[][] = [];
    let discoverCount = 0;
    const manager = createManager({
      dataDir,
      discover: async () => {
        discoverCount += 1;
        return discoverCount === 1 ? [systemOld] : [systemReady];
      },
      installer: {
        runCommand: async (_executable, args) => {
          calls.push(args);
          return { exitCode: 0, stderr: "", stdout: "upgraded" };
        },
      },
      planInstall: () => ({
        action: "upgrade" as const,
        args: ["install", "-g", `@earendil-works/pi-coding-agent@${TARGET_VERSION}`],
        currentVersion: "0.80.0",
        executable: "npm.cmd",
        manager: "npm" as const,
        reason: "upgrade",
        targetVersion: TARGET_VERSION,
      }),
      startRuntime: async (installation) => handshakeFor(installation, dataDir),
    });

    await manager.refresh();
    const snapshot = await manager.upgrade();

    assert.deepEqual(calls, [["install", "-g", `@earendil-works/pi-coding-agent@${TARGET_VERSION}`]]);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.active?.version, TARGET_VERSION);
  });
});

test("keeps the rediscovered state when an upgrade command fails", async () => {
  await withDataDir(async (dataDir) => {
    const manager = createManager({
      dataDir,
      discover: async () => [systemOld],
      installer: {
        runCommand: async () => ({
          exitCode: 1,
          stderr: "npm ERR! network timeout",
          stdout: "",
        }),
      },
      planInstall: () => ({
        action: "upgrade" as const,
        args: ["install", "-g", `@earendil-works/pi-coding-agent@${TARGET_VERSION}`],
        currentVersion: "0.80.0",
        executable: "npm.cmd",
        manager: "npm" as const,
        reason: "upgrade",
        targetVersion: TARGET_VERSION,
      }),
      startRuntime: async () => {
        throw new Error("should not start after a failed upgrade");
      },
    });

    await manager.refresh();
    const snapshot = await manager.upgrade();

    assert.equal(snapshot.status, "failed");
    assert.match(snapshot.issue ?? "", /network timeout/);
    assert.equal(snapshot.installations[0]?.version, "0.80.0");
  });
});

test("installs a missing Pi then starts the rediscovered runtime", async () => {
  await withDataDir(async (dataDir) => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    let discoverCount = 0;
    const manager = createManager({
      dataDir,
      discover: async () => {
        discoverCount += 1;
        return discoverCount === 1 ? [] : [systemReady];
      },
      installer: {
        runCommand: async (executable, args) => {
          calls.push({ executable, args });
          return { exitCode: 0, stderr: "", stdout: "added 1 package" };
        },
      },
      planInstall: () => ({
        action: "install" as const,
        args: ["install", "-g", `@earendil-works/pi-coding-agent@${TARGET_VERSION}`],
        executable: "npm.cmd",
        manager: "npm" as const,
        reason: "install",
        targetVersion: TARGET_VERSION,
      }),
      startRuntime: async (installation) => handshakeFor(installation, dataDir),
    });

    const missing = await manager.refresh();
    const snapshot = await manager.install();

    assert.equal(missing.status, "missing");
    assert.deepEqual(calls, [{
      executable: "npm.cmd",
      args: ["install", "-g", `@earendil-works/pi-coding-agent@${TARGET_VERSION}`],
    }]);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.active?.packageRoot, SYSTEM_ROOT);
  });
});

test("activateCustom preserves the selected custom runtime and starts it", async () => {
  await withDataDir(async (dataDir) => {
    const seen: Array<{
      selectedId?: string;
      customRuntimes?: Array<{ id?: string; nodePath?: string; packageRoot: string }>;
    }> = [];
    const manager = createManager({
      dataDir,
      discover: async (options = {}) => {
        seen.push({
          ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
          ...(options.customRuntimes === undefined ? {} : { customRuntimes: options.customRuntimes }),
        });
        return [{
          available: true,
          compatible: true,
          id: "custom:selected",
          nodePath: "D:\\other\\node.exe",
          packageRoot: CUSTOM_ROOT,
          source: "custom",
          version: TARGET_VERSION,
        }];
      },
      startRuntime: async (installation) => handshakeFor(installation, dataDir),
    });

    const snapshot = await manager.activateCustom(CUSTOM_ROOT, "D:\\other\\node.exe");

    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.selectedId, "custom:selected");
    assert.equal(snapshot.active?.id, "custom:selected");
    assert.deepEqual(seen, [{
      selectedId: "custom:selected",
      customRuntimes: [{ id: "selected", nodePath: "D:\\other\\node.exe", packageRoot: CUSTOM_ROOT }],
    }]);
  });
});

test("preserves a persisted custom runtime id suffix across startup", async () => {
  await withDataDir(async (dataDir) => {
    await saveRuntimeSelection(dataDir, {
      selectedId: "custom:0",
      customNodePath: "D:\\other\\node.exe",
      customPackageRoot: CUSTOM_ROOT,
    });
    const seen: Array<{
      selectedId?: string;
      customRuntimes?: Array<{ id?: string; nodePath?: string; packageRoot: string }>;
    }> = [];
    const manager = createManager({
      dataDir,
      discover: async (options = {}) => {
        seen.push({
          ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
          ...(options.customRuntimes === undefined ? {} : { customRuntimes: options.customRuntimes }),
        });
        return [{
          available: true,
          compatible: true,
          id: "custom:0",
          nodePath: "D:\\other\\node.exe",
          packageRoot: CUSTOM_ROOT,
          source: "custom",
          version: TARGET_VERSION,
        }];
      },
      startRuntime: async (installation) => handshakeFor(installation, dataDir),
    });

    const snapshot = await manager.start();

    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.selectedId, "custom:0");
    assert.deepEqual(seen, [{
      selectedId: "custom:0",
      customRuntimes: [{ id: "0", nodePath: "D:\\other\\node.exe", packageRoot: CUSTOM_ROOT }],
    }]);
  });
});
