import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, join, relative, resolve } from "node:path";
import { extract } from "tar";
import type { LocalSemanticStatus } from "@varin/protocol";
import { resolveModelPackAtComponentRoot, type ResolvedModelPack } from "./model-store.js";

export const LOCAL_SEMANTIC_COMPONENT_ID = "local-semantic";
export const LOCAL_SEMANTIC_TRANSFORMERS_ENTRY = "runtime/node_modules/@huggingface/transformers/dist/transformers.node.mjs";
export const LOCAL_SEMANTIC_WORKER_ENTRY = "runtime/local-embedding-worker.mjs";
const LOCAL_SEMANTIC_ROOT_NAME = "optional-components/local-semantic";
const ACTIVE_NAME = "active.json";
const MANIFEST_NAME = "manifest.json";

export interface LocalSemanticComponentManifest {
  schemaVersion: 2;
  id: typeof LOCAL_SEMANTIC_COMPONENT_ID;
  version: string;
  platform: "win32" | "linux" | "darwin";
  arch: "x64" | "arm64";
  modelPath: "model";
  transformersEntry: typeof LOCAL_SEMANTIC_TRANSFORMERS_ENTRY;
  workerEntry: typeof LOCAL_SEMANTIC_WORKER_ENTRY;
  files: Record<string, { sha256: string; bytes: number }>;
}

interface ActiveComponentPointer {
  schemaVersion: 1;
  root: string;
  version: string;
}

interface LocalSemanticComponentManagerOptions {
  dataDir: string;
  version: string;
  platform?: "win32" | "linux" | "darwin";
  arch?: "x64" | "arm64";
  fetch?: typeof fetch;
  validatePack?: (pack: ResolvedModelPack, signal?: AbortSignal) => Promise<void>;
  onEnabled?: () => void | Promise<void>;
}

export interface LocalSemanticComponentManager {
  status(): LocalSemanticStatus;
  install(url?: string): Promise<void>;
  importArchive(file: string): Promise<void>;
  cancel(): LocalSemanticStatus;
  dispose(): Promise<void>;
}

const isAbort = (error: unknown): boolean => (
  error instanceof Error && error.name === "AbortError"
);

const componentRootFor = (dataDir: string): string => join(dataDir, LOCAL_SEMANTIC_ROOT_NAME);
const versionsRootFor = (dataDir: string): string => join(componentRootFor(dataDir), "versions");
const activePathFor = (dataDir: string): string => join(componentRootFor(dataDir), ACTIVE_NAME);

const safeRelativePath = (value: string, allowEmpty = false): string => {
  const normalized = value.replace(/\\/g, "/");
  if ((!normalized && !allowEmpty) || normalized.startsWith("/") || /^[A-Za-z]:(?:\/|$)/u.test(normalized)) {
    throw new Error(`Archive path is unsafe: ${value}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) throw new Error(`Archive path escapes its root: ${value}`);
  const result = parts.filter((part) => part && part !== ".").join("/");
  if (!result && !allowEmpty) throw new Error(`Archive path is empty: ${value}`);
  return result;
};

const pathInRoot = (root: string, relativePath: string): string => {
  const normalized = safeRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, normalized);
  const prefix = `${absoluteRoot}${process.platform === "win32" ? "\\" : "/"}`;
  if (!candidate.startsWith(prefix)) throw new Error(`Archive path escapes its root: ${relativePath}`);
  return candidate;
};

const parseManifest = (raw: unknown): LocalSemanticComponentManifest => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Local semantic manifest is malformed.");
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 2 || value.id !== LOCAL_SEMANTIC_COMPONENT_ID
    || typeof value.version !== "string" || !value.version.trim()
    || (value.platform !== "win32" && value.platform !== "linux" && value.platform !== "darwin")
    || (value.arch !== "x64" && value.arch !== "arm64")
    || value.modelPath !== "model"
    || value.transformersEntry !== LOCAL_SEMANTIC_TRANSFORMERS_ENTRY
    || value.workerEntry !== LOCAL_SEMANTIC_WORKER_ENTRY
    || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error("Local semantic manifest has an unsupported shape.");
  }
  const files: LocalSemanticComponentManifest["files"] = {};
  for (const [name, descriptor] of Object.entries(value.files as Record<string, unknown>)) {
    const normalized = safeRelativePath(name);
    if (normalized === MANIFEST_NAME || !descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error(`Local semantic manifest file entry is malformed: ${name}`);
    }
    const row = descriptor as Record<string, unknown>;
    if (typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/iu.test(row.sha256)
      || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      throw new Error(`Local semantic manifest file entry is malformed: ${name}`);
    }
    files[normalized] = { sha256: row.sha256.toLowerCase(), bytes: row.bytes };
  }
  if (!files["model/recipe.json"] || !files["model/tokenizer.json"] || !files[LOCAL_SEMANTIC_TRANSFORMERS_ENTRY] || !files[LOCAL_SEMANTIC_WORKER_ENTRY]) {
    throw new Error("Local semantic manifest is missing the model recipe, tokenizer, or runtime entry.");
  }
  return {
    schemaVersion: 2,
    id: LOCAL_SEMANTIC_COMPONENT_ID,
    version: value.version.trim(),
    platform: value.platform,
    arch: value.arch,
    modelPath: "model",
    transformersEntry: LOCAL_SEMANTIC_TRANSFORMERS_ENTRY,
    workerEntry: LOCAL_SEMANTIC_WORKER_ENTRY,
    files,
  };
};

const manifestForDirectory = async (root: string): Promise<LocalSemanticComponentManifest> => (
  parseManifest(JSON.parse(await readFile(join(root, MANIFEST_NAME), "utf8")))
);

const readActivePointer = (dataDir: string): ActiveComponentPointer | null => {
  try {
    const raw = JSON.parse(readFileSync(activePathFor(dataDir), "utf8")) as Record<string, unknown>;
    if (raw.schemaVersion !== 1 || typeof raw.root !== "string" || typeof raw.version !== "string") return null;
    const parent = componentRootFor(dataDir);
    const root = resolve(parent, raw.root);
    const prefix = `${resolve(parent)}${process.platform === "win32" ? "\\" : "/"}`;
    if (!root.startsWith(prefix) || raw.root.includes("\\") || raw.root.split(/[\\/]/u).some((part) => part === "..")) return null;
    return { schemaVersion: 1, root: raw.root.replace(/\\/g, "/"), version: raw.version };
  } catch {
    return null;
  }
};

const activeManifest = (dataDir: string): { pointer: ActiveComponentPointer; manifest: LocalSemanticComponentManifest } | null => {
  const pointer = readActivePointer(dataDir);
  if (!pointer) return null;
  try {
    const manifest = parseManifest(JSON.parse(readFileSync(join(componentRootFor(dataDir), pointer.root, MANIFEST_NAME), "utf8")));
    return { pointer, manifest };
  } catch {
    return null;
  }
};

const archiveFiles = async (root: string): Promise<string[]> => {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = safeRelativePath(relative(root, absolute));
      if (entry.isSymbolicLink()) throw new Error(`Archive contains a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(relativePath);
      else throw new Error(`Archive contains an unsupported filesystem entry: ${relativePath}`);
    }
  };
  await visit(root);
  return result.sort();
};

const hashFile = async (file: string, expected: { sha256: string; bytes: number }): Promise<void> => {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const value = chunk as Buffer;
    bytes += value.byteLength;
    digest.update(value);
  }
  if (bytes !== expected.bytes || digest.digest("hex") !== expected.sha256) {
    throw new Error(`Local semantic component file failed integrity verification: ${basename(file)}`);
  }
};

const validateExtractedComponent = async (
  root: string,
  expectedPlatform: string,
  expectedArch: string,
): Promise<{ manifest: LocalSemanticComponentManifest; pack: ResolvedModelPack; installedBytes: number }> => {
  const manifest = await manifestForDirectory(root);
  if (manifest.platform !== expectedPlatform || manifest.arch !== expectedArch) {
    throw new Error(`Local semantic component targets ${manifest.platform}-${manifest.arch}, expected ${expectedPlatform}-${expectedArch}.`);
  }
  const actualFiles = await archiveFiles(root);
  const expectedFiles = [MANIFEST_NAME, ...Object.keys(manifest.files)].sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((name, index) => name !== expectedFiles[index])) {
    throw new Error("Local semantic component contains files outside its manifest.");
  }
  let installedBytes = 0;
  for (const [name, descriptor] of Object.entries(manifest.files)) {
    const file = pathInRoot(root, name);
    const fileStat = await stat(file);
    if (!fileStat.isFile()) throw new Error(`Local semantic component entry is not a regular file: ${name}`);
    await hashFile(file, descriptor);
    installedBytes += descriptor.bytes;
  }
  const pack = resolveModelPackAtComponentRoot(root, manifest);
  if (!pack?.onnxPath || !pack.tokenizerPath || !pack.transformersEntry) {
    throw new Error("Local semantic component does not contain a complete encoder model and runtime.");
  }
  return { manifest, pack, installedBytes };
};

const defaultValidatePack = async (pack: ResolvedModelPack, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  const entry = pack.transformersEntry;
  if (!entry || !pack.inferenceWorkerEntry || !pack.root || !pack.onnxPath) throw new Error("Local semantic component runtime entry is unavailable.");
  const modelFileName = basename(pack.onnxPath, ".onnx");
  const script = `
    import { Worker } from "node:worker_threads";
    import { pathToFileURL } from "node:url";
    const entry = process.argv[1];
    const modelRoot = process.argv[2];
    const dim = Number(process.argv[3]);
    const pooling = process.argv[4];
    const normalize = process.argv[5] === "true";
    const modelFileName = process.argv[6];
    const worker = new Worker(pathToFileURL(process.argv[7]), {
      execArgv: [],
      workerData: { entry, modelRoot, modelFileName, dim, pooling, normalize, threads: 1 },
    });
    try {
      await new Promise((resolve, reject) => {
        worker.on("error", reject);
        worker.on("exit", () => reject(new Error("Local component validation worker exited")));
        worker.on("message", message => {
          if (message.type === "ready") {
            worker.postMessage({ id: 1, texts: ["Varin local semantic component validation"], priority: "foreground" });
            return;
          }
          if (message.error) { reject(new Error(message.error)); return; }
          const row = message.vectors?.[0];
          if (!Array.isArray(row) || row.length !== dim || row.some(value => !Number.isFinite(value)) || !row.some(value => value !== 0)) {
            reject(new Error("Local semantic component inference returned an invalid vector."));
          } else resolve();
        });
      });
    } finally { await worker.terminate(); }
  `.trim();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, entry, pack.root, String(pack.space.dim), pack.space.pooling, String(pack.space.normalize), modelFileName, pack.inferenceWorkerEntry!], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, 2000); });
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new DOMException("The operation was aborted.", "AbortError"));
      else if (code === 0) resolvePromise();
      else reject(new Error(`Local semantic component inference validation failed${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
    });
  });
};

const writeArchiveWithProgress = async (
  source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
  destination: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<void> => {
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.byteLength);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.from(source as AsyncIterable<Uint8Array>), progress, createWriteStream(destination), { signal });
};

const extractArchive = async (archive: string, destination: string, signal: AbortSignal): Promise<void> => {
  await extract({
    file: archive,
    cwd: destination,
    strict: true,
    filter: (entryPath: string, entry: unknown) => {
      signal.throwIfAborted();
      const normalized = safeRelativePath(entryPath, true);
      const type = entry && typeof entry === "object" && "type" in entry
        ? String((entry as { type?: unknown }).type)
        : "";
      if (type && type !== "File" && type !== "Directory" && type !== "NextFileHeader") {
        throw new Error(`Local semantic component archive contains unsupported entry type: ${type}`);
      }
      return Boolean(normalized);
    },
  });
};

const componentUrl = (version: string, platform: string, arch: string): string => (
  `https://github.com/Youzini-afk/Varin/releases/download/v${encodeURIComponent(version)}/Varin-local-semantic-${encodeURIComponent(version)}-${platform}-${arch}.tar.gz`
);

export const localSemanticComponentUrl = componentUrl;

export function createLocalSemanticComponentManager(
  options: LocalSemanticComponentManagerOptions,
): LocalSemanticComponentManager {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetch ?? fetch;
  const validatePack = options.validatePack ?? defaultValidatePack;
  const active = activeManifest(options.dataDir);
  let currentStatus: LocalSemanticStatus = active
    ? {
        status: "ready",
        version: active.manifest.version,
        installedBytes: Object.values(active.manifest.files).reduce((sum, entry) => sum + entry.bytes, 0),
      }
    : existsSync(activePathFor(options.dataDir))
      ? { status: "failed", error: "The installed local semantic component pointer is unreadable." }
      : { status: "not-installed" };
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;

  const setStatus = (next: LocalSemanticStatus): void => {
    currentStatus = { ...next };
  };
  const preserveInstalledFields = (): Partial<Pick<LocalSemanticStatus, "version" | "installedBytes">> => {
    const current = activeManifest(options.dataDir);
    if (!current) return {};
    return {
      version: current.manifest.version,
      installedBytes: Object.values(current.manifest.files).reduce((sum, entry) => sum + entry.bytes, 0),
    };
  };

  const runInstall = async (
    source: { url?: string; file?: string },
    signal: AbortSignal,
    installedFields: Partial<Pick<LocalSemanticStatus, "version" | "installedBytes">>,
  ): Promise<void> => {
    const root = componentRootFor(options.dataDir);
    const staging = join(versionsRootFor(options.dataDir), `.staging-${randomUUID()}`);
    const archive = join(staging, "component.tar.gz");
    let activated = false;
    let verifiedVersion: string | undefined;
    let verifiedBytes: number | undefined;
    try {
      await mkdir(staging, { recursive: true });
      let totalBytes: number | undefined;
      let downloadedBytes = 0;
      if (source.url) {
        const response = await fetchImpl(source.url, { signal });
        if (!response.ok) throw new Error(`Local semantic component download failed: ${response.status} ${response.statusText}`);
        const contentLength = response.headers.get("content-length");
        totalBytes = contentLength === null ? undefined : Number(contentLength);
        if (totalBytes !== undefined && (!Number.isFinite(totalBytes) || totalBytes < 0)) totalBytes = undefined;
        if (!response.body) throw new Error("Local semantic component download returned an empty body.");
        setStatus({ status: "installing", stage: "downloading", ...installedFields, ...(totalBytes === undefined ? {} : { totalBytes }), downloadedBytes: 0 });
        await writeArchiveWithProgress(Readable.fromWeb(response.body as never), archive, signal, (bytes) => {
          downloadedBytes += bytes;
          setStatus({ status: "installing", stage: "downloading", ...installedFields, downloadedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
        });
      } else {
        if (!source.file) throw new Error("A local semantic component archive is required.");
        setStatus({ status: "installing", stage: "downloading", ...installedFields });
        await writeArchiveWithProgress(createReadStream(source.file), archive, signal, (bytes) => {
          downloadedBytes += bytes;
          setStatus({ status: "installing", stage: "downloading", ...installedFields, downloadedBytes, totalBytes: downloadedBytes });
        });
      }
      signal.throwIfAborted();
      setStatus({ status: "installing", stage: "extracting", ...installedFields, downloadedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
      await extractArchive(archive, staging, signal);
      signal.throwIfAborted();
      await rm(archive, { force: true });
      setStatus({ status: "installing", stage: "verifying", ...installedFields, downloadedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
      const verified = await validateExtractedComponent(staging, platform, arch);
      verifiedVersion = verified.manifest.version;
      verifiedBytes = verified.installedBytes;
      await validatePack(verified.pack, signal);
      signal.throwIfAborted();
      await mkdir(root, { recursive: true });
      const relativeRoot = relative(root, staging).split("\\").join("/");
      const pointer: ActiveComponentPointer = { schemaVersion: 1, root: relativeRoot, version: verified.manifest.version };
      const pointerTemp = `${activePathFor(options.dataDir)}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(pointerTemp, `${JSON.stringify(pointer)}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        signal.throwIfAborted();
        await rename(pointerTemp, activePathFor(options.dataDir));
      } catch (error) {
        await rm(pointerTemp, { force: true });
        throw error;
      }
      activated = true;
      try { await options.onEnabled?.(); } catch (error) {
        console.error("[LocalSemantic] Enabled component refresh failed:", error instanceof Error ? error.message : String(error));
      }
      setStatus({ status: "ready", version: verified.manifest.version, installedBytes: verified.installedBytes });
      // The active version owns the archive. The archive inside it is no longer
      // needed after extraction and would otherwise inflate the status bytes.
      await rm(archive, { force: true }).catch(() => undefined);
    } catch (error) {
      if (!activated) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      const failure = error instanceof Error ? error.message : String(error);
      const retained = Object.keys(installedFields).length > 0;
      if (isAbort(error)) {
        setStatus({ status: retained ? "ready" : "failed", ...installedFields, error: "Local semantic component installation was cancelled." });
      } else if (activated) {
        setStatus({ status: "ready", ...(verifiedVersion ? { version: verifiedVersion } : {}), ...(verifiedBytes === undefined ? {} : { installedBytes: verifiedBytes }) });
      } else {
        setStatus({ status: retained ? "ready" : "failed", ...installedFields, error: failure });
      }
    }
  };

  const begin = (source: { url?: string; file?: string }): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) return running;
    const installedFields = preserveInstalledFields();
    controller = new AbortController();
    setStatus({ status: "installing", stage: "downloading", ...installedFields });
    const task = runInstall(source, controller.signal, installedFields).finally(() => {
      if (running === task) running = null;
      controller = null;
    });
    running = task;
    return task;
  };

  return {
    status: () => ({ ...currentStatus }),
    install: (url = componentUrl(options.version, platform, arch)) => begin({ url }),
    importArchive: (file) => begin({ file }),
    cancel: () => {
      controller?.abort();
      return { ...currentStatus };
    },
    dispose: async () => {
      disposed = true;
      controller?.abort();
      await running;
    },
  };
}
