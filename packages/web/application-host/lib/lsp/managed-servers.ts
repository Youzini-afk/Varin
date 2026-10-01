import { createHash, randomUUID } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import fs from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import type { SpawnOptions } from "node:child_process";
import { terminateManagedProcess, waitForManagedExit, type ManagedProcessHandle, type ManagedSpawn } from "../process/types.js";

const gunzipAsync = promisify(gunzip);

/** The native servers currently owned by Varin's on-demand provider. */
export type ManagedLanguageServerName = "gopls" | "rust-analyzer" | "clangd" | "marksman";
export type ManagedLanguageServerStatus =
  | "available"
  | "preparing"
  | "installed"
  | "failed"
  | "needs-runtime"
  | "unsupported";

export interface ManagedLanguageServerSnapshot {
  languageId: string;
  name?: ManagedLanguageServerName;
  status: ManagedLanguageServerStatus;
  command?: string;
  version?: string;
  message?: string;
}

export interface ManagedLanguageServerCommand {
  command: string;
  args: readonly string[];
  initializationOptions?: Readonly<Record<string, unknown>>;
}

/** An artifact descriptor. Defaults are the committed official release manifest. */
export interface ManagedLanguageServerArtifact {
  url: string;
  sha256: string;
  format: "raw" | "gzip" | "zip";
  executableName: string;
}

export class ManagedLanguageServerError extends Error {
  constructor(
    readonly code: "unknown-language" | "unsupported-platform" | "needs-runtime" | "preparation-failed" | "disposed" | "cancelled",
    readonly languageId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ManagedLanguageServerError";
  }
}

export interface ManagedLanguageServersOptions {
  /** Varin's per-user data directory. No workspace or global installation is used. */
  directory: string;
  /** Rust Kernel process service adapter. It must be the production native spawn. */
  spawn: ManagedSpawn;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: (url: string, init?: Omit<RequestInit, 'dispatcher'>) => Promise<Response>;
  /** Focused tests can resolve an executable without depending on the host PATH. */
  resolveExecutable?: (command: string) => string | null | Promise<string | null>;
  /** Focused tests can provide a small archive without making an external request. */
  download?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Optional test/packaging override; production uses the committed manifest below. */
  artifacts?: Partial<Record<ManagedLanguageServerName, ManagedLanguageServerArtifact>>;
  goplsVersion?: string;
  rustAnalyzerRelease?: string;
  clangdVersion?: string;
}

interface ArchiveSpec {
  url: string;
  sha256: string;
  format: "raw" | "gzip" | "zip";
  executableName: string;
}

interface ServerSpec {
  name: ManagedLanguageServerName;
  languageIds: readonly string[];
  version: string;
  supported: (platform: NodeJS.Platform, arch: string) => boolean;
  archive?: (platform: NodeJS.Platform, arch: string) => ArchiveSpec | null;
  commandName: string;
  initializationOptions?: Readonly<Record<string, unknown>>;
}

interface ServerState {
  status: ManagedLanguageServerStatus;
  command?: string | undefined;
  message?: string | undefined;
  preparing?: Preparation | undefined;
}

interface Preparation {
  controller: AbortController;
  promise: Promise<ManagedLanguageServerCommand>;
  waiters: number;
  settled: boolean;
}

const RUST_ANALYZER_RELEASE = "2026-09-14";
const CLANGD_VERSION = "23.1.0";
const GOPLS_VERSION = "v0.23.0";
const MARKSMAN_RELEASE = "2026-02-08";

// The release assets and digests are committed here instead of resolving a
// moving "latest" URL. Rust Analyzer and clangd publish these SHA-256 values
// beside each release asset; Go's module download is verified by the Go checksum
// database before go install produces the private GOBIN binary.
// Manifest sources:
// https://github.com/rust-lang/rust-analyzer/releases/tag/2026-09-14
// https://github.com/clangd/clangd/releases/tag/23.1.0
// https://go.dev/gopls/release/v0.23.0
// https://github.com/artempyanykh/marksman/releases/tag/2026-02-08
const rustAssets: Record<string, ArchiveSpec> = {
  "win32-x64": {
    url: `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE}/rust-analyzer-x86_64-pc-windows-msvc.zip`,
    sha256: "631ea40942cbc1e70a3465218f27f49fd73d82d9c0dd21e5279d8417f7f2dd93",
    format: "zip",
    executableName: "rust-analyzer.exe",
  },
  "win32-arm64": {
    url: `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE}/rust-analyzer-aarch64-pc-windows-msvc.zip`,
    sha256: "742a792325bb433ab7a12f859f9bf3bd5c6721fe503eee530c029917b537b01d",
    format: "zip",
    executableName: "rust-analyzer.exe",
  },
  "linux-x64": {
    url: `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE}/rust-analyzer-x86_64-unknown-linux-gnu.gz`,
    sha256: "7609ba53f85cd80a3bde77a4b2e94e304d0f94650e4f4cffc061b9bca454ba75",
    format: "gzip",
    executableName: "rust-analyzer",
  },
  "linux-arm64": {
    url: `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE}/rust-analyzer-aarch64-unknown-linux-gnu.gz`,
    sha256: "3d32c50aebf9288c2fd11b559813441bdff2aa57fbbb7177ad0ffe5ac4e9ad3d",
    format: "gzip",
    executableName: "rust-analyzer",
  },
  "darwin-x64": {
    url: `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE}/rust-analyzer-x86_64-apple-darwin.gz`,
    sha256: "58d827adc7bde3b8986ff52795484f462564a2beed3ba4f4b2cbc3cfd58ae05e",
    format: "gzip",
    executableName: "rust-analyzer",
  },
  "darwin-arm64": {
    url: `https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_RELEASE}/rust-analyzer-aarch64-apple-darwin.gz`,
    sha256: "0c579403271f4021eb1efdfaa9bedb43e099595d02a02ee9b1f34c6c51a3ac26",
    format: "gzip",
    executableName: "rust-analyzer",
  },
};

const clangdAssets: Record<string, ArchiveSpec> = {
  "win32-x64": {
    url: `https://github.com/clangd/clangd/releases/download/${CLANGD_VERSION}/clangd-windows-${CLANGD_VERSION}.zip`,
    sha256: "23412a240756a162e7b98a282f36aa2a23a88db5ce16a0cbc4fef7253768c810",
    format: "zip",
    executableName: "clangd.exe",
  },
  "linux-x64": {
    url: `https://github.com/clangd/clangd/releases/download/${CLANGD_VERSION}/clangd-linux-${CLANGD_VERSION}.zip`,
    sha256: "e53b1a96196095faedb7642cf64964f7fb9ad4a0c1f00dd2c172a3d9dcbafdfd",
    format: "zip",
    executableName: "clangd",
  },
  "darwin-x64": {
    url: `https://github.com/clangd/clangd/releases/download/${CLANGD_VERSION}/clangd-mac-${CLANGD_VERSION}.zip`,
    sha256: "1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253",
    format: "zip",
    executableName: "clangd",
  },
};

const marksmanAssets: Record<string, ArchiveSpec> = {
  "win32-x64": {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_RELEASE}/marksman.exe`,
    sha256: "a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705",
    format: "raw",
    executableName: "marksman.exe",
  },
  "linux-x64": {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_RELEASE}/marksman-linux-x64`,
    sha256: "be5098e8213219269c47fc0d916a66fa31ce0602ec967475c722260aabf26087",
    format: "raw",
    executableName: "marksman",
  },
  "linux-arm64": {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_RELEASE}/marksman-linux-arm64`,
    sha256: "db8e124527f7f8048e3e6c91821b9c52ef173d92c01e47d221bf1337afd962fb",
    format: "raw",
    executableName: "marksman",
  },
  "darwin-x64": {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_RELEASE}/marksman-macos`,
    sha256: "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
    format: "raw",
    executableName: "marksman",
  },
  "darwin-arm64": {
    url: `https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_RELEASE}/marksman-macos`,
    sha256: "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
    format: "raw",
    executableName: "marksman",
  },
};

const languageAliases = new Map<string, ManagedLanguageServerName>([
  ["go", "gopls"],
  ["golang", "gopls"],
  ["rust", "rust-analyzer"],
  ["rust-analyzer", "rust-analyzer"],
  ["c", "clangd"],
  ["cpp", "clangd"],
  ["c++", "clangd"],
  ["markdown", "marksman"],
  ["md", "marksman"],
  ["mdx", "marksman"],
]);

const keyFor = (platform: NodeJS.Platform, arch: string): string => `${platform}-${arch}`;
const normalizeArch = (arch: string): string => {
  if (arch === "x64" || arch === "amd64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  return arch;
};

const supportedHost = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "linux" || platform === "darwin";
const platformName = (platform: NodeJS.Platform): string => platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;

const specs = (goplsVersion: string, rustRelease: string, clangdVersion: string): Record<ManagedLanguageServerName, ServerSpec> => ({
  gopls: {
    name: "gopls",
    languageIds: ["go", "golang"],
    version: goplsVersion,
    supported: (platform) => supportedHost(platform),
    commandName: "gopls",
  },
  "rust-analyzer": {
    name: "rust-analyzer",
    languageIds: ["rust", "rust-analyzer"],
    version: rustRelease,
    supported: (platform, arch) => Boolean(rustAssets[keyFor(platform, normalizeArch(arch))]),
    archive: (platform, arch) => rustAssets[keyFor(platform, normalizeArch(arch))] ?? null,
    commandName: "rust-analyzer",
  },
  clangd: {
    name: "clangd",
    languageIds: ["c", "cpp", "c++"],
    version: clangdVersion,
    supported: (platform, arch) => Boolean(clangdAssets[keyFor(platform, normalizeArch(arch))]),
    archive: (platform, arch) => clangdAssets[keyFor(platform, normalizeArch(arch))] ?? null,
    commandName: "clangd",
    initializationOptions: { clangdFileStatus: true },
  },
  marksman: {
    name: "marksman",
    languageIds: ["markdown", "md", "mdx"],
    version: MARKSMAN_RELEASE,
    supported: (platform, arch) => Boolean(marksmanAssets[keyFor(platform, normalizeArch(arch))]),
    archive: (platform, arch) => marksmanAssets[keyFor(platform, normalizeArch(arch))] ?? null,
    commandName: "marksman",
  },
});

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
const isAbortError = (error: unknown): boolean => error instanceof Error && (error.name === "AbortError" || error.name === "CanceledError" || /aborted|cancelled|canceled/i.test(error.message));
const serverArgs = (spec: ServerSpec): readonly string[] => spec.name === "marksman" ? ["server"] : [];

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ManagedLanguageServerError("cancelled", "", "Language server preparation was cancelled", { cause: signal.reason });
}

function safeChildPath(root: string, entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Archive entry has an absolute path: ${entryName}`);
  }
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Archive entry escapes installation directory: ${entryName}`);
  }
  return target;
}

function managedCommandPath(installRoot: string, serverName: ManagedLanguageServerName, platform: NodeJS.Platform): string {
  const fallback = platform === "win32" ? `${serverName}.exe` : serverName;
  let relative = fallback;
  try {
    relative = fs.readFileSync(path.join(installRoot, ".command"), "utf8").trim() || fallback;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return safeChildPath(installRoot, relative);
}

async function writeDownload(url: string, bytes: Uint8Array, expectedSha256: string): Promise<Buffer> {
  const buffer = Buffer.from(bytes);
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== expectedSha256) throw new Error(`Downloaded ${url} failed SHA-256 verification`);
  return buffer;
}

async function extractZip(bytes: Buffer, destination: string): Promise<void> {
  const archive = new AdmZip(bytes);
  const entries = archive.getEntries();
  for (const entry of entries) {
    safeChildPath(destination, entry.entryName);
    const mode = (entry.attr >>> 16) & 0xf000;
    if (mode === 0xa000) throw new Error(`Archive contains an unsupported symbolic link: ${entry.entryName}`);
  }
  await archive.extractAllToAsync(destination, true, false);
}

async function findFile(root: string, basename: string): Promise<string | null> {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === basename) return candidate;
    }
  }
  return null;
}

async function ensureExecutable(file: string): Promise<void> {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`Installed language server is missing or empty: ${file}`);
  if (process.platform !== "win32") await chmod(file, 0o755);
}

async function runManagedCommand(
  spawn: ManagedSpawn,
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const child = await spawn(command, args, { ...options, signal, windowsHide: true });
  if (signal.aborted) {
    await terminateManagedProcess(child, true).catch(() => undefined);
    throwIfAborted(signal);
  }
  child.stdout?.resume();
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string | Buffer) => { stderr += chunk.toString(); });
  child.stderr?.resume();
  const onAbort = () => { void child.requestTermination?.(true).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await waitForManagedExit(child);
    throwIfAborted(signal);
    if (child.exitCode !== 0 || child.signalCode) {
      const detail = stderr.trim();
      throw new Error(`${command} ${args.join(" ")} exited with ${child.signalCode ?? child.exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function probeExecutable(command: string, spawn: ManagedSpawn, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  let child: ManagedProcessHandle;
  try {
    child = await spawn(command, ["--version"], {
      cwd,
      env,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    } as SpawnOptions);
  } catch {
    if (signal.aborted) throwIfAborted(signal);
    return false;
  }
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    await waitForManagedExit(child);
    throwIfAborted(signal);
    return child.exitCode === 0;
  } catch {
    if (signal.aborted) throwIfAborted(signal);
    return false;
  }
}

async function defaultResolveExecutable(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | null> {
  const candidates: string[] = [];
  const add = (value: string): void => { if (value && !candidates.includes(value)) candidates.push(value); };
  if (path.isAbsolute(command) || command.includes(path.sep) || (platform === "win32" && command.includes("/"))) add(command);
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    add(path.join(directory, command));
    if (platform === "win32" && !extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()))) {
      for (const extension of extensions) add(path.join(directory, command + extension));
    }
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile() && (platform === "win32" || (info.mode & 0o111) !== 0)) return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

export function createManagedLanguageServers(options: ManagedLanguageServersOptions) {
  if (!path.isAbsolute(options.directory)) throw new Error("Managed language server directory must be absolute");
  const platform = options.platform ?? process.platform;
  const arch = normalizeArch(options.arch ?? process.arch);
  const env = { ...process.env, ...options.env };
  const serverSpecs = specs(options.goplsVersion ?? GOPLS_VERSION, options.rustAnalyzerRelease ?? RUST_ANALYZER_RELEASE, options.clangdVersion ?? CLANGD_VERSION);
  for (const [name, artifact] of Object.entries(options.artifacts ?? {}) as Array<[ManagedLanguageServerName, ManagedLanguageServerArtifact]>) {
    if (!artifact) continue;
    const spec = serverSpecs[name];
    spec.supported = () => true;
    spec.archive = () => artifact;
  }
  const state = new Map<ManagedLanguageServerName, ServerState>();
  const lifecycle = new AbortController();
  let disposed = false;
  const probeRoot = path.join(options.directory, "language-servers", ".probe");

  const specFor = (languageId: string): ServerSpec | null => {
    const name = languageAliases.get(languageId.trim().toLowerCase());
    return name ? serverSpecs[name] : null;
  };
  const initialState = (spec: ServerSpec): ServerState => ({
    status: !spec.supported(platform, arch)
      ? "unsupported"
      : spec.name === "gopls" && !supportedHost(platform)
        ? "unsupported"
        : "available",
    message: !spec.supported(platform, arch) ? `${spec.name} has no official ${platformName(platform)} ${arch} release` : undefined,
  });
  for (const spec of Object.values(serverSpecs)) state.set(spec.name, initialState(spec));

  const resolve = async (command: string): Promise<string | null> => options.resolveExecutable
    ? options.resolveExecutable(command)
    : defaultResolveExecutable(command, env, platform);

  const localCandidates = (spec: ServerSpec): readonly string[] => {
    if (spec.name === "clangd") return ["clangd", "clangd-23", "clangd-22", "clangd-21", "clangd-20"];
    return [spec.commandName];
  };

  const findLocal = async (spec: ServerSpec, signal: AbortSignal): Promise<string | null> => {
    await mkdir(probeRoot, { recursive: true });
    for (const candidate of localCandidates(spec)) {
      const executable = await resolve(platform === "win32" && !candidate.endsWith(".exe") ? `${candidate}.exe` : candidate);
      if (executable && await probeExecutable(executable, options.spawn, probeRoot, env, signal)) return executable;
    }
    return null;
  };

  const managedInstallRoot = (spec: ServerSpec): string => path.join(options.directory, "language-servers", spec.name, spec.version, `${platform}-${arch}`);

  const updateInstalledState = async (spec: ServerSpec): Promise<string | null> => {
    const current = state.get(spec.name)!;
    if (current.preparing) return null;
    const installRoot = managedInstallRoot(spec);
    const managed = managedCommandPath(installRoot, spec.name, platform);
    try {
      await ensureExecutable(managed);
      current.status = "installed";
      current.command = managed;
      current.message = undefined;
      return managed;
    } catch {
      return null;
    }
  };

  const inspect = (languageId: string): ManagedLanguageServerSnapshot => {
    const spec = specFor(languageId);
    if (!spec) return { languageId, status: "unsupported", message: `No managed language server is registered for ${languageId}` };
    const current = state.get(spec.name)!;
    if (current.status === "preparing" || current.status === "failed") return { languageId, name: spec.name, status: current.status, ...(current.command ? { command: current.command } : {}), ...(current.message ? { message: current.message } : {}) };
    const installRoot = managedInstallRoot(spec);
    let managed: string;
    try {
      managed = managedCommandPath(installRoot, spec.name, platform);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        managed = path.join(installRoot, platform === "win32" ? `${spec.name}.exe` : spec.name);
      } else {
        current.status = "failed";
        current.message = `Private ${spec.name} installation metadata is invalid: ${asError(error).message}`;
        return { languageId, name: spec.name, status: current.status, message: current.message };
      }
    }
    try {
      const info = fs.statSync(managed);
      if (info.isFile() && info.size > 0) {
        current.status = "installed";
        current.command = managed;
        current.message = undefined;
        return { languageId, name: spec.name, status: "installed", command: managed, version: spec.version };
      }
    } catch { /* no private install yet */ }
    // PATH inspection is deliberately synchronous and side-effect free. It does
    // not execute a binary and never starts a download from getStatus/inspect.
    const pathValue = env.PATH ?? env.Path ?? "";
    const candidates = localCandidates(spec).flatMap((candidate) => {
      const names = platform === "win32" && !candidate.endsWith(".exe") ? [candidate, `${candidate}.exe`] : [candidate];
      return pathValue.split(path.delimiter).flatMap((directory) => names.map((name) => path.join(directory, name)));
    });
    const local = candidates.find((candidate) => {
      try { const info = fs.statSync(candidate); return info.isFile() && (platform === "win32" || (info.mode & 0o111) !== 0); } catch { return false; }
    });
    if (local) {
      current.status = "available";
      current.command = local;
      current.message = undefined;
      return { languageId, name: spec.name, status: "available", command: local };
    }
    if (!spec.supported(platform, arch)) {
      current.status = "unsupported";
      current.message = `${spec.name} has no official ${platformName(platform)} ${arch} release`;
      return { languageId, name: spec.name, status: current.status, message: current.message };
    }
    if (spec.name === "gopls") {
      if (!runtimeOnPath("go", env, platform)) {
        current.status = "needs-runtime";
        current.command = undefined;
        current.message = "gopls needs an existing Go toolchain (`go`) on PATH; Varin does not install Go.";
        return { languageId, name: spec.name, status: current.status, message: current.message };
      }
    }
    current.status = "available";
    current.command = undefined;
    current.message = spec.name === "gopls" ? "gopls will be installed in Varin user data using the existing Go toolchain." : `Varin can prepare ${spec.name} in its private user-data directory.`;
    return { languageId, name: spec.name, status: current.status, message: current.message };
  };

  const prepareGo = async (spec: ServerSpec, goCommand: string, signal: AbortSignal): Promise<ManagedLanguageServerCommand> => {
    const installRoot = managedInstallRoot(spec);
    const finalBin = path.join(installRoot, platform === "win32" ? "gopls.exe" : "gopls");
    const staging = `${installRoot}.staging-${randomUUID()}`;
    const privateCache = path.join(options.directory, "language-servers", ".cache", "gopls", spec.version, `${platform}-${arch}`);
    const privateCwd = path.join(privateCache, "cwd");
    await mkdir(staging, { recursive: true });
    await mkdir(privateCwd, { recursive: true });
    try {
      await runManagedCommand(options.spawn, goCommand, ["install", `golang.org/x/tools/gopls@${spec.version}`], {
        cwd: privateCwd,
        env: { ...env, GOBIN: staging, GOMODCACHE: path.join(privateCache, "mod"), GOCACHE: path.join(privateCache, "build") },
        stdio: ["ignore", "pipe", "pipe"],
      }, signal);
      await ensureExecutable(finalBin.replace(installRoot, staging));
      throwIfAborted(signal);
      await writeFile(path.join(staging, ".command"), `${path.basename(finalBin)}\n`, { mode: 0o600 });
      throwIfAborted(signal);
      await mkdir(path.dirname(finalBin), { recursive: true });
      await rm(installRoot, { recursive: true, force: true });
      throwIfAborted(signal);
      await rename(staging, installRoot);
      return { command: finalBin, args: serverArgs(spec) };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };

  const prepareArchive = async (spec: ServerSpec, signal: AbortSignal): Promise<ManagedLanguageServerCommand> => {
    const archive = spec.archive?.(platform, arch);
    if (!archive) throw new ManagedLanguageServerError("unsupported-platform", spec.languageIds[0]!, `${spec.name} has no official ${platformName(platform)} ${arch} release`);
    const installRoot = managedInstallRoot(spec);
    const staging = `${installRoot}.staging-${randomUUID()}`;
    await mkdir(staging, { recursive: true });
    try {
      throwIfAborted(signal);
      const bytes = await (options.download ? options.download(archive.url, signal) : downloadWithFetch(options.fetch ?? fetch, archive.url, signal));
      throwIfAborted(signal);
      const verified = await writeDownload(archive.url, bytes, archive.sha256);
      if (archive.format === "gzip") {
        const executable = await gunzipAsync(verified);
        const target = path.join(staging, archive.executableName);
        await writeFile(target, executable, { mode: 0o755 });
      } else if (archive.format === "raw") {
        const target = path.join(staging, archive.executableName);
        await writeFile(target, verified, { mode: 0o755 });
      } else {
        await extractZip(verified, staging);
      }
      const executable = await findFile(staging, archive.executableName);
      if (!executable) throw new Error(`Verified ${spec.name} archive does not contain ${archive.executableName}`);
      await ensureExecutable(executable);
      throwIfAborted(signal);
      await writeFile(path.join(staging, ".command"), `${path.relative(staging, executable)}\n`, { mode: 0o600 });
      throwIfAborted(signal);
      await mkdir(path.dirname(installRoot), { recursive: true });
      await rm(installRoot, { recursive: true, force: true });
      throwIfAborted(signal);
      await rename(staging, installRoot);
      const final = path.join(installRoot, path.relative(staging, executable));
      return { command: final, args: serverArgs(spec), ...(spec.initializationOptions ? { initializationOptions: spec.initializationOptions } : {}) };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };

  const startPreparation = (spec: ServerSpec): Preparation => {
    const controller = new AbortController();
    const current = state.get(spec.name)!;
    current.status = "preparing";
    current.command = undefined;
    current.message = `Preparing ${spec.name} ${spec.version} in Varin user data…`;
    const preparation: Preparation = { controller, waiters: 0, settled: false, promise: Promise.resolve({ command: "", args: [] }) };
    preparation.promise = (async () => {
      const local = await findLocal(spec, controller.signal);
      if (local) return { command: local, args: serverArgs(spec), ...(spec.initializationOptions ? { initializationOptions: spec.initializationOptions } : {}) };
      if (spec.name === "gopls") {
        const runtime = await resolve(platform === "win32" ? "go.exe" : "go");
        if (!runtime) throw new ManagedLanguageServerError("needs-runtime", spec.languageIds[0]!, "gopls requires an existing Go toolchain (`go`) on PATH; Varin does not install Go.");
        return prepareGo(spec, runtime, controller.signal);
      }
      return prepareArchive(spec, controller.signal);
    })();
    void preparation.promise.then((command) => {
      current.status = command.command.includes(`${path.sep}language-servers${path.sep}`) ? "installed" : "available";
      current.command = command.command;
      current.message = undefined;
    }, (error: unknown) => {
      if (isAbortError(error) || controller.signal.aborted) {
        current.status = "available";
        current.command = undefined;
        current.message = "Preparation was cancelled before an executable was installed.";
      } else {
        current.status = error instanceof ManagedLanguageServerError && error.code === "needs-runtime" ? "needs-runtime" : "failed";
        current.command = undefined;
        current.message = asError(error).message;
      }
    }).finally(() => { preparation.settled = true; if (current.preparing === preparation) delete current.preparing; }).catch(() => undefined);
    current.preparing = preparation;
    return preparation;
  };

  async function ensure(languageId: string, root: string, signal?: AbortSignal): Promise<ManagedLanguageServerCommand> {
    const spec = specFor(languageId);
    if (!spec) throw new ManagedLanguageServerError("unknown-language", languageId, `No managed language server is registered for ${languageId}`);
    if (disposed) throw new ManagedLanguageServerError("disposed", languageId, "Managed language server preparation has been disposed");
    if (!path.isAbsolute(root)) throw new Error("Managed language server root must be absolute");
    const callerSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
    throwIfAborted(callerSignal);
    const local = await findLocal(spec, callerSignal);
    throwIfAborted(callerSignal);
    if (local) {
      const current = state.get(spec.name)!;
      current.status = "available";
      current.command = local;
      current.message = undefined;
      return { command: local, args: serverArgs(spec), ...(spec.initializationOptions ? { initializationOptions: spec.initializationOptions } : {}) };
    }
    if (await updateInstalledState(spec)) {
      throwIfAborted(callerSignal);
      const current = state.get(spec.name)!;
      return { command: current.command!, args: serverArgs(spec), ...(spec.initializationOptions ? { initializationOptions: spec.initializationOptions } : {}) };
    }
    if (!spec.supported(platform, arch)) throw new ManagedLanguageServerError("unsupported-platform", languageId, `${spec.name} has no official ${platformName(platform)} ${arch} release`);
    let preparation = state.get(spec.name)!.preparing;
    if (preparation?.controller.signal.aborted) {
      // A cancelled job owns its staging directory until its cleanup finally
      // settles. Do not let a new request attach to that doomed promise.
      try {
        await raceAbort(preparation.promise, callerSignal, languageId);
      } catch (error) {
        if (callerSignal.aborted) throw error;
      }
      if (state.get(spec.name)!.preparing === preparation) delete state.get(spec.name)!.preparing;
      preparation = undefined;
    }
    if (!preparation) preparation = startPreparation(spec);
    preparation.waiters += 1;
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      preparation!.waiters -= 1;
      if (preparation!.waiters === 0 && !preparation!.settled) {
        preparation!.controller.abort();
        await preparation!.promise.catch(() => undefined);
        if (state.get(spec.name)!.preparing === preparation) delete state.get(spec.name)!.preparing;
        preparation!.settled = true;
      }
    };
    try {
      return await raceAbort(preparation.promise, callerSignal, languageId);
    } finally {
      await release();
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    lifecycle.abort();
    const pending = [...state.values()].map((entry) => entry.preparing).filter((entry): entry is Preparation => Boolean(entry));
    for (const preparation of pending) preparation.controller.abort();
    await Promise.allSettled(pending.map((preparation) => preparation.promise));
  }

  return { inspect, ensure, dispose, languageIds: [...languageAliases.keys()] as readonly string[] };
}

function candidatesForRuntime(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathValue = env.PATH ?? env.Path ?? "";
  const names = platform === "win32" ? [command, `${command}.exe`] : [command];
  return pathValue.split(path.delimiter).flatMap((directory) => names.map((name) => path.join(directory, name)));
}

function runtimeOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return candidatesForRuntime(command, env, platform).some((candidate) => {
    try {
      const info = fs.statSync(candidate);
      return info.isFile() && (platform === "win32" || (info.mode & 0o111) !== 0);
    } catch {
      return false;
    }
  });
}

async function downloadWithFetch(fetcher: NonNullable<ManagedLanguageServersOptions['fetch']>, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const origin = new URL(url).origin;
  try {
    const response = await fetcher(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    signal.throwIfAborted();
    const cause = error instanceof Error ? error.cause : undefined;
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
    throw new Error(`Language server download from ${origin} failed: ${asError(error).message}${typeof code === 'string' ? ` (${code})` : ''}`, { cause: error });
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, languageId: string): Promise<T> {
  if (signal.aborted) throw new ManagedLanguageServerError("cancelled", languageId, "Language server preparation was cancelled", { cause: signal.reason });
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ManagedLanguageServerError("cancelled", languageId, "Language server preparation was cancelled", { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

export const MANAGED_LANGUAGE_SERVER_VERSIONS = Object.freeze({
  gopls: GOPLS_VERSION,
  "rust-analyzer": RUST_ANALYZER_RELEASE,
  clangd: CLANGD_VERSION,
  marksman: MARKSMAN_RELEASE,
});
