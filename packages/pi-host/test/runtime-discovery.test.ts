import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type CommandResult,
  discoverPiRuntimes,
  readPinnedPiVersion,
  toRuntimeInstallation,
} from "../src/runtime-discovery.js";

describe("discoverPiRuntimes", () => {
  it("resolves bundled startup without searching PATH or inspecting unrelated custom runtimes", async () => {
    const candidates = await discoverPiRuntimes({
      selectedId: "bundled",
      env: { VARIN_PI_CUSTOM_ROOT: "unrelated-missing-install", VARIN_PI_SOURCE: "unrelated-source" },
      commandRunner: async () => { throw new Error("bundled startup must not run external commands"); },
    });
    assert.deepEqual(candidates.map(candidate => candidate.id), ["bundled"]);
    assert.equal(candidates[0]?.available, true);
  });

  it("reads the bundled Pi version from production dependencies", () => {
    assert.equal(
      readPinnedPiVersion({
        dependencies: { "@earendil-works/pi-coding-agent": "0.84.1" },
      }),
      "0.84.1",
    );
    assert.throws(() => readPinnedPiVersion({}), /does not pin/);
  });

  it("reports bundled, system, and source runtimes with compatibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-runtime-"));
    try {
      const source = join(root, "pi");
      const custom = join(root, "custom-pi");
      const customNode = join(root, "node.exe");
      await mkdir(join(source, "packages", "coding-agent"), { recursive: true });
      await mkdir(custom, { recursive: true });
      await writeFile(
        join(source, "packages", "coding-agent", "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.1" }),
      );
      await writeFile(
        join(custom, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.1" }),
      );
      await writeFile(customNode, "");
      const commandRunner = async (command: string): Promise<CommandResult> => {
        if (command === customNode) {
          return { exitCode: 0, stderr: "", stdout: "v24.18.0\n" };
        }
        if (command === "where.exe") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: "C:\\tools\\pi\r\nC:\\tools\\pi.ps1\r\nC:\\tools\\pi.cmd\r\n",
          };
        }
        return { exitCode: 0, stderr: "", stdout: "1.0.0\n" };
      };

      const candidates = await discoverPiRuntimes({
        commandRunner,
        customRuntimes: [{ id: "developer", nodePath: customNode, packageRoot: custom }],
        env: {},
        platform: "win32",
        sourcePaths: [source],
      });

      assert.equal(candidates[0]?.id, "bundled");
      assert.equal(candidates[0]?.compatible, true);
      assert.equal(candidates[1]?.command, "C:\\tools\\pi.cmd");
      assert.equal(candidates[1]?.version, "1.0.0");
      assert.equal(candidates[1]?.compatible, true);
      assert.equal(candidates[2]?.version, "1.0.1");
      assert.equal(candidates[2]?.packageRoot, source);
      assert.equal(candidates[3]?.id, "custom:developer");
      assert.equal(candidates[3]?.available, true);
      assert.equal(candidates[3]?.compatible, true);
      assert.equal(candidates[3]?.packageRoot, custom);
      assert.equal(candidates[3]?.nodePath, customNode);
      assert.equal(candidates[2]?.source, "development");
      const installation = toRuntimeInstallation(candidates[3]!);
      assert.equal(installation.state, "ready");
      assert.equal("compatible" in installation, false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resolves commandPath, nodePath, and packageRoot from a real system shim", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-system-layout-"));
    try {
      const codingAgent = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
      await mkdir(join(codingAgent, "dist"), { recursive: true });
      await writeFile(
        join(codingAgent, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.1" }),
      );
      const nodePath = join(root, "node.exe");
      const command = join(root, "pi.cmd");
      await writeFile(nodePath, "");
      await writeFile(
        command,
        [
          "@ECHO off",
          `endLocal & "${nodePath}"  "${join(codingAgent, "dist", "cli.js")}" %*`,
          "",
        ].join("\r\n"),
      );
      let versionProbeCount = 0;
      const candidates = await discoverPiRuntimes({
        commandRunner: async (invoked) => {
          if (invoked === "where.exe") {
            return { exitCode: 0, stderr: "", stdout: `${command}\r\n` };
          }
          versionProbeCount += 1;
          return { exitCode: 1, stderr: "command probe should not be needed", stdout: "" };
        },
        env: {},
        includeBundled: false,
        platform: "win32",
      });
      assert.equal(candidates[0]?.id, "system");
      assert.equal(candidates[0]?.command, command);
      assert.equal(candidates[0]?.nodePath, nodePath);
      assert.equal(candidates[0]?.packageRoot, codingAgent);
      assert.equal(candidates[0]?.version, "0.84.1");
      assert.equal(versionProbeCount, 0);
      const installation = toRuntimeInstallation(candidates[0]!);
      assert.equal(installation.commandPath, command);
      assert.equal(installation.nodePath, nodePath);
      assert.equal(installation.packageRoot, codingAgent);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("classifies a user-global standalone layout separately from PATH system installs", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-standalone-layout-"));
    try {
      const localAppData = join(root, "AppData", "Local");
      const codingAgent = join(
        localAppData,
        "Pi",
        "runtime",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      await mkdir(join(codingAgent, "dist"), { recursive: true });
      await writeFile(
        join(codingAgent, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.1" }),
      );
      const command = join(localAppData, "Pi", "bin", "pi.cmd");
      await mkdir(join(localAppData, "Pi", "bin"), { recursive: true });
      await writeFile(
        command,
        `"node.exe" "${join(codingAgent, "dist", "cli.js")}" %*\r\n`,
      );
      const candidates = await discoverPiRuntimes({
        commandRunner: async (invoked) => {
          if (invoked === "where.exe") {
            return { exitCode: 0, stderr: "", stdout: `${command}\r\n` };
          }
          return { exitCode: 0, stderr: "", stdout: "0.84.1\n" };
        },
        env: { LOCALAPPDATA: localAppData },
        includeBundled: false,
        platform: "win32",
      });
      assert.equal(candidates[0]?.id, "standalone");
      assert.equal(candidates[0]?.source, "standalone");
      assert.equal(candidates[0]?.packageRoot, codingAgent);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns diagnostic candidates instead of throwing", async () => {
    const candidates = await discoverPiRuntimes({
      commandRunner: async () => ({ exitCode: 1, stderr: "not found", stdout: "" }),
      env: {},
      platform: "win32",
      sourcePaths: [join(tmpdir(), "missing-varin-source")],
    });

    assert.equal(candidates[1]?.available, false);
    assert.match(candidates[1]?.issue ?? "", /not found on PATH/i);
    assert.equal(candidates[2]?.available, false);
    assert.match(candidates[2]?.issue ?? "", /package\.json/i);
  });

  it("does not treat a prerelease at the minimum version as compatible", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-prerelease-"));
    try {
      await mkdir(join(root, "packages", "coding-agent"), { recursive: true });
      await writeFile(
        join(root, "packages", "coding-agent", "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0-rc.1" }),
      );
      const candidates = await discoverPiRuntimes({
        commandRunner: async () => ({ exitCode: 1, stderr: "not found", stdout: "" }),
        env: {},
        platform: "win32",
        sourcePaths: [root],
      });
      assert.equal(candidates[2]?.available, true);
      assert.equal(candidates[2]?.compatible, false);
      assert.equal(toRuntimeInstallation(candidates[2]!).state, "upgrade-required");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("executes a Windows cmd shim whose path requires quoting", {
    skip: process.platform !== "win32",
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-runtime-"));
    const bin = join(root, "bin with spaces");
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "pi.cmd"), "@echo off\r\necho 1.0.0\r\n");
      const env = { ...process.env };
      const pathEntry = Object.entries(env).find(([key]) => key.toLowerCase() === "path");
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") delete env[key];
      }
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      env[pathEntry?.[0] ?? "Path"] = `${bin};${join(systemRoot, "System32")};${systemRoot}`;
      const candidates = await discoverPiRuntimes({ env, platform: "win32" });
      assert.equal(candidates[1]?.available, true);
      assert.equal(
        await realpath(candidates[1]?.command ?? ""),
        await realpath(join(bin, "pi.cmd")),
      );
      assert.equal(candidates[1]?.version, "1.0.0");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
