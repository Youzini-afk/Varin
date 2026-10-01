import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { createManagedLanguageServers, type ManagedLanguageServerArtifact } from "./managed-servers.js";
import type { ManagedProcessHandle } from "../process/types.js";

const zipArtifact = (executableName = "clangd.exe"): { artifact: ManagedLanguageServerArtifact; bytes: Uint8Array } => {
  const zip = new AdmZip();
  zip.addFile(`clangd_23.1.0/bin/${executableName}`, Buffer.from("managed-clangd"));
  const bytes = zip.toBuffer();
  return {
    bytes,
    artifact: {
      url: "https://test.invalid/clangd.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "zip",
      executableName,
    },
  };
};

const versionProcess = (exitCode: number, output: string, error = ""): ManagedProcessHandle => {
  const child = new EventEmitter() as ManagedProcessHandle;
  Object.assign(child, {
    pid: 1,
    stdin: null,
    stdout: Readable.from([output]),
    stderr: Readable.from([error]),
    exitCode,
    signalCode: null,
    killed: false,
    completion: Promise.resolve(),
  });
  return child;
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "varin-managed-lsp-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe("managed native language servers", () => {
  it('reports the failing download origin and transport cause without exposing URL credentials', async () => {
    const f = await fixture();
    const manager = createManagedLanguageServers({
      directory: f.directory, platform: 'linux', arch: 'x64', env: { PATH: '' },
      resolveExecutable: async () => null,
      spawn: async () => { throw new Error('unexpected process'); },
      artifacts: { marksman: { url: 'https://user:private@test.invalid/marksman?token=private',
        sha256: 'unused', format: 'raw', executableName: 'marksman' } },
      fetch: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); },
    });
    try {
      await expect(manager.ensure('markdown', f.directory)).rejects.toThrow('https://test.invalid failed: fetch failed (UND_ERR_CONNECT_TIMEOUT)');
      expect(manager.inspect('markdown').message).not.toContain('private');
    } finally { await manager.dispose(); await f.cleanup(); }
  });

  it("keeps inspect side-effect free and de-duplicates concurrent preparation", async () => {
    const f = await fixture();
    const { artifact, bytes } = zipArtifact();
    let downloads = 0;
    const manager = createManagedLanguageServers({
      directory: f.directory,
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
      resolveExecutable: async () => null,
      spawn: async () => { throw new Error("Go spawn should not be used for clangd"); },
      artifacts: { clangd: artifact },
      download: async () => {
        downloads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return bytes;
      },
    });
    expect(manager.inspect("cpp").status).toBe("available");
    const root = path.join(f.directory, "workspace");
    const [first, second] = await Promise.all([manager.ensure("cpp", root), manager.ensure("c", root)]);
    expect(first.command).toBe(second.command);
    expect(downloads).toBe(1);
    expect(manager.inspect("cpp")).toMatchObject({ status: "installed", command: first.command });
    await manager.dispose();
    await f.cleanup();
  });

  it("cancels the last preparation waiter and removes staging output", async () => {
    const f = await fixture();
    const { artifact, bytes } = zipArtifact();
    let downloads = 0;
    const manager = createManagedLanguageServers({
      directory: f.directory,
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
      resolveExecutable: async () => null,
      spawn: async () => { throw new Error("unexpected process"); },
      artifacts: { clangd: artifact },
      download: async (_url, signal) => {
        downloads += 1;
        if (downloads > 1) return bytes;
        return await new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = manager.ensure("cpp", f.directory, controller.signal);
    for (let attempt = 0; attempt < 100 && downloads === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(downloads).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    const serverRoot = path.join(f.directory, "language-servers");
    const entries = await readdir(serverRoot).catch(() => [] as string[]);
    expect(entries.some((entry) => entry.includes("staging"))).toBe(false);
    const retry = await manager.ensure("cpp", f.directory);
    expect(retry.command).toContain("language-servers");
    await manager.dispose();
    await f.cleanup();
  });

  it("reports a missing Go runtime without downloading", async () => {
    const f = await fixture();
    let downloaded = false;
    const manager = createManagedLanguageServers({
      directory: f.directory,
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
      resolveExecutable: async () => null,
      spawn: async () => { throw new Error("unexpected process"); },
      download: async () => { downloaded = true; return new Uint8Array(); },
    });
    expect(manager.inspect("go")).toMatchObject({ status: "needs-runtime" });
    expect(downloaded).toBe(false);
    await manager.dispose();
    await f.cleanup();
  });

  it("probes a rustup proxy before reusing it and falls back after a failed probe", async () => {
    const f = await fixture();
    const { artifact, bytes } = zipArtifact("rust-analyzer.exe");
    let probeCalls = 0;
    let downloads = 0;
    const manager = createManagedLanguageServers({
      directory: f.directory,
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
      resolveExecutable: async () => "C:\\rustup\\bin\\rust-analyzer.exe",
      spawn: async (_command, args) => {
        probeCalls += 1;
        expect(args).toEqual(["--version"]);
        return versionProcess(1, "", "rustup component is missing");
      },
      artifacts: { "rust-analyzer": artifact },
      download: async () => { downloads += 1; return bytes; },
    });
    const installed = await manager.ensure("rust", f.directory);
    expect(installed.command).toContain("language-servers");
    expect(probeCalls).toBeGreaterThan(0);
    expect(downloads).toBe(1);
    await manager.dispose();
    await f.cleanup();
  });

  it("reuses an arm64 macOS clangd when no official download asset is available", async () => {
    const f = await fixture();
    let downloads = 0;
    const manager = createManagedLanguageServers({
      directory: f.directory,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
      resolveExecutable: async () => "/opt/homebrew/bin/clangd",
      spawn: async () => versionProcess(0, "clangd version 23.1.0\n"),
      download: async () => { downloads += 1; return new Uint8Array(); },
    });
    const command = await manager.ensure("cpp", f.directory);
    expect(command.command).toBe("/opt/homebrew/bin/clangd");
    expect(downloads).toBe(0);
    await manager.dispose();
    await f.cleanup();
  });

  it("prepares the independent Marksman binary with its server subcommand", async () => {
    const f = await fixture();
    const bytes = Buffer.from("marksman-test-binary");
    const artifact: ManagedLanguageServerArtifact = {
      url: "https://test.invalid/marksman.exe",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "raw",
      executableName: "marksman.exe",
    };
    const manager = createManagedLanguageServers({
      directory: f.directory,
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
      resolveExecutable: async () => null,
      spawn: async () => { throw new Error("unexpected process"); },
      artifacts: { marksman: artifact },
      download: async () => bytes,
    });
    await expect(manager.ensure("markdown", f.directory)).resolves.toMatchObject({ args: ["server"] });
    await expect(manager.ensure("mdx", f.directory)).resolves.toMatchObject({ args: ["server"] });
    expect(manager.inspect("markdown")).toMatchObject({ name: "marksman", status: "installed" });
    await manager.dispose();
    await f.cleanup();
  });
});
