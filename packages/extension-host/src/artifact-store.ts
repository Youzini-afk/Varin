import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createRequire, isBuiltin } from "node:module";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BuildOptions, Metafile } from "esbuild";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import {
  VARIN_EXTENSION_MANIFEST_FILE,
  assertVarinApplicationVersion,
  assertVarinExtensionManifestCompatibility,
  isVarinExtensionId,
  parseVarinExtensionManifest,
  parseVarinRuntimeSourceRequest,
  type VarinRuntimeSourceRequest,
  type VarinRuntimeSourceOutcome,
  type VarinExtensionAssetPayload,
  type VarinExtensionPreparedArtifact,
  type VarinExtensionManagedEntrypointPayload,
  type VarinExtensionManifest,
  type VarinExtensionPackageSource,
  type VarinExtensionSourceViewProvenance,
  parseVarinExtensionSourceViewProvenance,
} from "@varin/extension-contract";
import {
  createDefaultExtensionPackageSourceRegistry,
  resolveNpmLaunchTarget,
  runExtensionSourceCommand,
  type ExtensionSourceCommandRunner,
  type VarinExtensionPackageSourceRegistry,
} from "./package-sources.js";

class ArtifactVerificationError extends Error {}

/** Only actual verification failures are corruption; I/O failures retain unavailability. */
function sourceReadFailure(error: unknown): VarinRuntimeSourceOutcome {
  if (error instanceof ArtifactVerificationError) return { status: 'corrupt', code: 'artifact_corrupt' };
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return { status: 'unavailable', code: 'artifact_unavailable' };
  }
  throw error;
}

const INDEX_FILE = "artifact-index.json";
const MANAGED_RUNTIME_DIRECTORY = "runtime/surface";

interface ArtifactFileRecord {
  contentType: string;
  integrity: string;
}

interface ArtifactEntrypointRecord {
  module: string;
  styles: string[];
}

interface ArtifactIndex {
  artifactIntegrity: string;
  entrypoints: Record<string, ArtifactEntrypointRecord>;
  files: Record<string, ArtifactFileRecord>;
  host?: { module: string };
  manifest: VarinExtensionManifest;
  schemaVersion: 1;
}

export interface BrokeredHostEntrypointArtifact {
  artifactIntegrity: string;
  integrity: string;
  modulePath: string;
  packageRoot: string;
}

export interface ExtensionArtifactStoreOptions {
  builtinRoots?: ReadonlyMap<string, string> | Record<string, string>;
  buildModule?: ExtensionModuleBuilder;
  dataDir: string;
  packageSources?: VarinExtensionPackageSourceRegistry;
  varinVersion: string;
  run?: ExtensionSourceCommandRunner;
}

export type ExtensionModuleBuilder = (options: BuildOptions, signal?: AbortSignal) => Promise<{ metafile: Metafile | undefined }>;

const buildModuleWithEsbuild: ExtensionModuleBuilder = async (options, signal) => {
  signal?.throwIfAborted();
  const { context } = await import("esbuild");
  const build = await context(options);
  const abort = () => { void build.cancel(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) { await build.cancel(); signal.throwIfAborted(); }
    const result = await build.rebuild();
    signal?.throwIfAborted();
    return { metafile: result.metafile };
  } finally {
    signal?.removeEventListener("abort", abort);
    // Disposal waits for the actual build; a rejected observer never releases its input tree.
    await build.dispose();
  }
};

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path, { highWaterMark: 64 * 1024, signal })) {
    signal?.throwIfAborted(); hash.update(bytes);
  }
  signal?.throwIfAborted();
  return `sha256-${hash.digest("hex")}`;
}
async function copyFile(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await pipeline(createReadStream(source), createWriteStream(destination, { mode: 0o600 }), { signal });
  await chmod(destination, (await lstat(await realpath(source))).mode);
}
async function copyPackage(source: string, destination: string, signal?: AbortSignal, includeDependencies = false): Promise<void> {
  const visit = async (path: string, target: string, ancestors = new Set<string>()): Promise<void> => {
    signal?.throwIfAborted();
    if (!shouldCopyPackagePath(source, path, includeDependencies)) return;
    const actual = await realpath(path), logical = relative(source, actual);
    if (logical === ".." || logical.startsWith(`..${sep}`)) throw new Error("Extension package link escapes its captured root");
    const info = await lstat(actual);
    if (info.isDirectory()) {
      if (ancestors.has(actual)) throw new Error("Extension package contains a directory link cycle");
      await mkdir(target, { recursive: true });
      const next = new Set(ancestors).add(actual);
      for (const child of await readdir(path)) await visit(join(path, child), join(target, child), next);
    } else if (info.isFile()) await copyFile(path, target, signal);
    else throw new Error(`Extension package contains an unsupported entry: ${relative(source, path)}`);
  };
  await visit(source, destination);
}

/** Normalize only extends resolution, leaving option inheritance to esbuild. All shadows live
 * beside their configs in this owner's disposable compiler copy, never in the source artifact. */
async function capturedTsconfig(root: string, signal?: AbortSignal): Promise<Pick<BuildOptions, "tsconfig" | "tsconfigRaw">> {
  const inside = (file: string): string => {
    const logical = relative(root, file);
    if (logical === ".." || logical.startsWith(`..${sep}`) || isAbsolute(logical)) {
      throw new Error("Extension tsconfig extends outside its captured package; include the configuration and dependencies inside the package or prebuild the entrypoint");
    }
    return file;
  };
  const fileAt = async (file: string): Promise<string | undefined> => {
    signal?.throwIfAborted(); inside(file);
    try {
      const physical = inside(await realpath(file));
      return (await lstat(physical)).isFile() ? physical : undefined;
    } catch (error) { if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return; throw error; }
  };
  const rootConfig = await fileAt(join(root, "tsconfig.json"));
  if (!rootConfig) return { tsconfigRaw: {} };
  const readConfig = async (file: string): Promise<Record<string, unknown>> => {
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(await readFile(file, { encoding: "utf8", signal }), errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid captured configuration: ${relative(root, file)}`);
    }
    return value as Record<string, unknown>;
  };
  const resolveBase = async (from: string, specifier: string): Promise<string> => {
    const spec = specifier.replaceAll("\\", "/");
    if (isAbsolute(spec) || spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
      const file = resolve(dirname(from), spec === "." || spec === ".." ? `${spec}/tsconfig.json` : spec);
      const found = await fileAt(file) ?? (!file.endsWith(".json") ? await fileAt(`${file}.json`) : undefined);
      if (found) return found;
    } else {
      const segments = spec.split("/");
      if (segments.some(part => !part || part === "." || part === "..")) throw new Error("Invalid captured tsconfig dependency");
      const packageName = segments.slice(0, spec.startsWith("@") ? 2 : 1).join("/");
      let directory = dirname(from);
      for (;;) {
        // Match esbuild's package config choices, but never search above this capture.
        const packageRoot = inside(join(directory, "node_modules", packageName));
        const manifestPath = await fileAt(join(packageRoot, "package.json"));
        let target = join(directory, "node_modules", spec);
        if (manifestPath) {
          const manifest = await readConfig(manifestPath);
          if (manifest.exports !== undefined) {
            let exported: string | undefined;
            try { exported = createRequire(join(directory, "varin-config.cjs")).resolve(spec); }
            catch { /* esbuild also tries ordinary config locations after unmatched exports. */ }
            if (exported) { const found = await fileAt(exported); if (found) return found; }
          }
          if (typeof manifest.tsconfig === "string" && manifest.tsconfig) target = resolve(packageRoot, manifest.tsconfig);
        }
        for (const candidate of [join(target, "tsconfig.json"), target, `${target}.json`]) {
          const found = await fileAt(candidate); if (found) return found;
        }
        if (directory === root) break;
        directory = inside(dirname(directory));
      }
    }
    throw new Error(`Cannot resolve captured tsconfig dependency ${JSON.stringify(specifier)}; include it inside the package or prebuild the entrypoint`);
  };
  const shadows = new Map<string, string>(), visiting = new Set<string>();
  const visit = async (file: string): Promise<string> => {
    signal?.throwIfAborted();
    if (visiting.has(file)) throw new Error("Captured tsconfig extends forms a cycle");
    const previous = shadows.get(file); if (previous) return previous;
    visiting.add(file);
    const config = await readConfig(file);
    if (config.extends !== undefined) {
      const bases = Array.isArray(config.extends) ? config.extends : [config.extends];
      if (bases.some(base => typeof base !== "string" || !base)) throw new Error("Captured tsconfig extends must name a configuration or an array of configurations");
      const resolved: string[] = [];
      for (const base of bases) resolved.push(await visit(await resolveBase(file, base as string)));
      config.extends = Array.isArray(config.extends) ? resolved : resolved[0];
    }
    const shadow = join(dirname(file), `.varin-tsconfig-${randomUUID()}.json`);
    await writeFile(shadow, JSON.stringify(config), { flag: "wx", mode: 0o600, signal });
    visiting.delete(file); shadows.set(file, shadow);
    return shadow;
  };
  return { tsconfig: await visit(rootConfig) };
}

/** A compiler may consume only the captured closure. Node builtins remain the declared Host execution mode. */
function capturedBuildOptions(options: BuildOptions, root: string): BuildOptions {
  return { ...options, logLevel: "silent", nodePaths: [], plugins: [{ name: "captured-source", setup(build) {
    build.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData?.capturedSource === root) return;
      if (options.platform === "node" && isBuiltin(args.path)) return { path: args.path, external: true };
      const result = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir,
        importer: args.importer, namespace: args.namespace, pluginData: { capturedSource: root } });
      if (result.errors.length) return { errors: result.errors.map(error => ({ ...error,
        text: `${error.text}. Include dependencies in the captured package or build a self-contained entrypoint before staging; Varin does not install them.` })) };
      if (result.external || !result.path) return { errors: [{ text: "Captured extension imports must resolve inside the captured package" }] };
      const resolved = await realpath(result.path), logical = relative(root, resolved);
      if (logical === ".." || logical.startsWith(`..${sep}`) || resolve(root, logical) !== resolved) {
        return { errors: [{ text: "Extension import escapes its captured package" }] };
      }
      return result;
    });
  } }] };
}

const sha256 = (value: Uint8Array | string): string => `sha256-${createHash("sha256").update(value).digest("hex")}`;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("Varin extension artifact index contains a non-JSON value");
};

const artifactIntegrityForIndex = (index: Omit<ArtifactIndex, "artifactIntegrity">): string => sha256(canonicalJson(index));

const toLogicalPath = (value: string): string => value.split(sep).join("/");

const contentTypeForPath = (path: string): string => {
  switch (extname(path).toLowerCase()) {
    case ".css": return "text/css; charset=utf-8";
    case ".gif": return "image/gif";
    case ".html": return "text/html; charset=utf-8";
    case ".jpeg":
    case ".jpg": return "image/jpeg";
    case ".js":
    case ".cjs":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".txt":
    case ".md": return "text/plain; charset=utf-8";
    case ".webp": return "image/webp";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
};

const isMissing = (error: unknown): boolean => (
  typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
);

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

const assertSafeTree = async (root: string): Promise<void> => {
  const visit = async (directory: string, ancestors = new Set<string>()): Promise<void> => {
    const physical = await realpath(directory);
    if (ancestors.has(physical)) throw new Error("Varin extension package contains a directory link cycle");
    const next = new Set(ancestors).add(physical);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const actual = await realpath(path), logical = relative(root, actual);
      if (logical === ".." || logical.startsWith(`..${sep}`)) throw new Error(`Varin extension package link escapes its root: ${toLogicalPath(relative(root, path))}`);
      const info = await lstat(actual);
      if (info.isDirectory()) await visit(path, next);
      else if (!info.isFile()) throw new Error(`Unsupported Varin extension package entry: ${toLogicalPath(relative(root, path))}`);
    }
  };
  await visit(root);
};

const shouldCopyPackagePath = (sourceRoot: string, path: string, includeDependencies = false): boolean => {
  const logical = toLogicalPath(relative(sourceRoot, path));
  return logical !== ".git"
    && !logical.startsWith(".git/")
    && (includeDependencies || (logical !== "node_modules" && !logical.startsWith("node_modules/")))
    && logical !== ".varin-runtime"
    && !logical.startsWith(".varin-runtime/");
};

const walkFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(toLogicalPath(relative(root, path)));
      else throw new Error(`Immutable Varin extension artifact contains an unsupported entry: ${path}`);
    }
  };
  await visit(root);
  return files.sort();
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const INTEGRITY_PATTERN = /^sha256-[0-9a-f]{64}$/;
const LOGICAL_PATH_PATTERN = /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).+$/;

const assertExactKeys = (record: Record<string, unknown>, expected: readonly string[], label: string): void => {
  const actual = Object.keys(record).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
};

const parseIndex = (value: unknown): ArtifactIndex => {
  if (!isRecord(value)) throw new Error("Varin extension artifact index is invalid");
  const hasHost = value.host !== undefined;
  assertExactKeys(
    value,
    hasHost
      ? ["artifactIntegrity", "entrypoints", "files", "host", "manifest", "schemaVersion"]
      : ["artifactIntegrity", "entrypoints", "files", "manifest", "schemaVersion"],
    "Varin extension artifact index",
  );
  if (value.schemaVersion !== 1 || typeof value.artifactIntegrity !== "string" || !INTEGRITY_PATTERN.test(value.artifactIntegrity)) {
    throw new Error("Varin extension artifact index header is invalid");
  }
  const manifest = parseVarinExtensionManifest(value.manifest);
  if (!isRecord(value.files) || !isRecord(value.entrypoints)) {
    throw new Error("Varin extension artifact index contents are invalid");
  }

  const files: Record<string, ArtifactFileRecord> = {};
  for (const [logicalPath, rawFile] of Object.entries(value.files)) {
    if (!LOGICAL_PATH_PATTERN.test(logicalPath) || logicalPath === INDEX_FILE || !isRecord(rawFile)) {
      throw new Error(`Varin extension artifact file record is invalid: ${logicalPath}`);
    }
    assertExactKeys(rawFile, ["contentType", "integrity"], `Varin extension artifact file record ${logicalPath}`);
    if (typeof rawFile.contentType !== "string" || rawFile.contentType.trim().length === 0
      || typeof rawFile.integrity !== "string" || !INTEGRITY_PATTERN.test(rawFile.integrity)) {
      throw new Error(`Varin extension artifact file record is invalid: ${logicalPath}`);
    }
    files[logicalPath] = { contentType: rawFile.contentType, integrity: rawFile.integrity };
  }

  const entrypoints: Record<string, ArtifactEntrypointRecord> = {};
  for (const [entrypointId, rawEntrypoint] of Object.entries(value.entrypoints)) {
    if (!isVarinExtensionId(entrypointId) || !isRecord(rawEntrypoint)) {
      throw new Error(`Varin extension artifact Surface entrypoint record is invalid: ${entrypointId}`);
    }
    assertExactKeys(rawEntrypoint, ["module", "styles"], `Varin extension artifact Surface entrypoint ${entrypointId}`);
    if (typeof rawEntrypoint.module !== "string" || !LOGICAL_PATH_PATTERN.test(rawEntrypoint.module)
      || !Array.isArray(rawEntrypoint.styles)
      || rawEntrypoint.styles.some((style) => typeof style !== "string" || !LOGICAL_PATH_PATTERN.test(style))) {
      throw new Error(`Varin extension artifact Surface entrypoint record is invalid: ${entrypointId}`);
    }
    const styles = rawEntrypoint.styles as string[];
    if (new Set(styles).size !== styles.length || !files[rawEntrypoint.module]
      || styles.some((style) => !files[style])) {
      throw new Error(`Varin extension artifact Surface entrypoint files are invalid: ${entrypointId}`);
    }
    entrypoints[entrypointId] = { module: rawEntrypoint.module, styles: [...styles] };
  }
  const executableEntrypoints = (manifest.entrypoints?.surfaces ?? [])
    .filter((entrypoint) => entrypoint.mode !== "declarative")
    .map((entrypoint) => entrypoint.id)
    .sort();
  if (JSON.stringify(Object.keys(entrypoints).sort()) !== JSON.stringify(executableEntrypoints)) {
    throw new Error("Varin extension artifact Surface entrypoint mapping does not match its manifest snapshot");
  }

  let host: ArtifactIndex["host"];
  if (hasHost) {
    if (!isRecord(value.host)) throw new Error("Varin extension artifact Host entrypoint record is invalid");
    assertExactKeys(value.host, ["module"], "Varin extension artifact Host entrypoint");
    if (typeof value.host.module !== "string" || !LOGICAL_PATH_PATTERN.test(value.host.module) || !files[value.host.module]) {
      throw new Error("Varin extension artifact Host entrypoint file is invalid");
    }
    host = { module: value.host.module };
  }
  if (Boolean(host) !== Boolean(manifest.entrypoints?.host)) {
    throw new Error("Varin extension artifact Host entrypoint mapping does not match its manifest snapshot");
  }
  if (!files[`package/${VARIN_EXTENSION_MANIFEST_FILE}`]) {
    throw new Error("Varin extension artifact manifest file is missing from its index");
  }
  return {
    artifactIntegrity: value.artifactIntegrity,
    entrypoints,
    files,
    ...(host ? { host } : {}),
    manifest,
    schemaVersion: 1,
  };
};

const readManifest = async (sourceRoot: string): Promise<VarinExtensionManifest> => {
  const raw = JSON.parse(await readFile(join(sourceRoot, VARIN_EXTENSION_MANIFEST_FILE), "utf8")) as unknown;
  return parseVarinExtensionManifest(raw);
};

const hasDependencies = async (sourceRoot: string): Promise<boolean> => {
  try {
    const value = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as Record<string, unknown>;
    return [value.dependencies, value.devDependencies, value.optionalDependencies]
      .some((item) => item && typeof item === "object" && Object.keys(item as object).length > 0);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

export class ExtensionArtifactStore {
  readonly dataDir: string;
  readonly directory: string;
  readonly varinVersion: string;
  readonly #build: ExtensionModuleBuilder;
  readonly #builtinRoots: ReadonlyMap<string, string>;
  readonly #packageSources: VarinExtensionPackageSourceRegistry;
  readonly #run: ExtensionSourceCommandRunner;

  constructor(options: ExtensionArtifactStoreOptions) {
    this.dataDir = resolve(options.dataDir);
    this.directory = join(this.dataDir, "extensions", "artifacts", "sha256");
    this.varinVersion = options.varinVersion;
    assertVarinApplicationVersion(this.varinVersion);
    this.#build = options.buildModule ?? buildModuleWithEsbuild;
    this.#run = options.run ?? runExtensionSourceCommand;
    const builtinRootEntries = options.builtinRoots instanceof Map
      ? [...options.builtinRoots.entries()]
      : Object.entries(options.builtinRoots ?? {});
    this.#builtinRoots = new Map(builtinRootEntries.map(([extensionId, root]) => [extensionId, resolve(root)]));
    this.#packageSources = options.packageSources ?? createDefaultExtensionPackageSourceRegistry({
      ...(options.builtinRoots ? { builtinRoots: options.builtinRoots } : {}),
      run: this.#run,
    });
  }

  async builtinDistributionFingerprint(extensionId: string, fingerprintFile: string): Promise<string | null> {
    const sourceRoot = this.#builtinRoots.get(extensionId);
    if (!sourceRoot || !/^[A-Za-z0-9._-]+$/.test(fingerprintFile)) return null;
    try {
      const fingerprint = (await readFile(join(sourceRoot, fingerprintFile), "utf8")).trim();
      return /^sha256-[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : null;
    } catch {
      return null;
    }
  }

  async builtinArtifactMatchesDistribution(input: {
    artifactIntegrity: string;
    artifactRoot: string;
    distributionFingerprint: string;
    fingerprintFile: string;
    manifest: VarinExtensionManifest;
  }): Promise<boolean> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.fingerprintFile)
      || !/^sha256-[0-9a-f]{64}$/.test(input.distributionFingerprint)) return false;
    try {
      const selected = await this.readAsset(
        input.artifactRoot,
        input.artifactIntegrity,
        `package/${input.fingerprintFile}`,
        input.manifest,
      );
      return Buffer.from(selected.bytesBase64, "base64").toString("utf8").trim() === input.distributionFingerprint;
    } catch {
      return false;
    }
  }

  async prepare(source: VarinExtensionPackageSource, signal?: AbortSignal): Promise<VarinExtensionPreparedArtifact> {
    if (source.kind === "source_view") throw new Error("SourceView packages require the original admitted capture owner");
    return this.#prepare(source, signal);
  }

  /** Trusted Host seam: directory is owned by the original Source capture, never supplied by a public source specifier. */
  async prepareCaptured(directory: string, provenanceValue: VarinExtensionSourceViewProvenance, signal?: AbortSignal): Promise<VarinExtensionPreparedArtifact> {
    const provenance = parseVarinExtensionSourceViewProvenance(provenanceValue);
    const source: VarinExtensionPackageSource = { kind: "source_view", display: provenance.packagePath,
      specifier: provenance.captureIntegrity, provenance };
    return this.#prepare(source, signal, await realpath(directory));
  }

  async #prepare(source: VarinExtensionPackageSource, signal?: AbortSignal, capturedRoot?: string): Promise<VarinExtensionPreparedArtifact> {
    signal?.throwIfAborted();
    const temporaryRoot = await mkdtemp(join(tmpdir(), "varin-extension-"));
    const materializedSourceRoot = join(temporaryRoot, "source");
    const artifactRoot = join(temporaryRoot, "artifact");
    try {
      let sourceRoot = capturedRoot ?? await this.#packageSources.materialize(source, materializedSourceRoot, signal);
      let compilerConfig: Pick<BuildOptions, "tsconfig" | "tsconfigRaw"> = {};
      signal?.throwIfAborted();
      const build = async (options: BuildOptions) => {
        signal?.throwIfAborted();
        const result = await this.#build(capturedRoot ? capturedBuildOptions({ ...options, ...compilerConfig }, sourceRoot) : options, signal);
        signal?.throwIfAborted();
        return result;
      };
      await assertSafeTree(sourceRoot);
      const manifest = await readManifest(sourceRoot);
      assertVarinExtensionManifestCompatibility(manifest, this.varinVersion);
      if (!capturedRoot && !(await exists(join(sourceRoot, "node_modules"))) && await hasDependencies(sourceRoot)) {
        if (source.kind === "local") {
          throw new Error(
            `Local Varin extension dependencies are not installed: ${source.display}. Run npm install in the extension project before reloading it. Varin will not modify the working tree.`,
          );
        }
        if (source.kind === "builtin") {
          throw new Error(
            `Built-in Varin extension dependencies are missing from its read-only distribution: ${source.display}. Rebuild the bundled extension package before using it.`,
          );
        }
        const npm = await resolveNpmLaunchTarget();
        await this.#run(npm.executable, [...npm.argsPrefix, "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
          cwd: sourceRoot,
          ...(signal ? { signal } : {}),
        });
      }

      await mkdir(artifactRoot, { recursive: true });
      await copyPackage(sourceRoot, join(artifactRoot, "package"), signal);
      if (capturedRoot) {
        if (await exists(join(sourceRoot, "tsconfig.json"))) {
          // Preserve captured dependency files while deriving writable compiler configs.
          // The immutable package copy above contains only the original captured text.
          await copyPackage(sourceRoot, materializedSourceRoot, signal, true);
          sourceRoot = materializedSourceRoot;
        }
        compilerConfig = await capturedTsconfig(sourceRoot, signal);
      }
      const entrypoints: Record<string, ArtifactEntrypointRecord> = {};
      for (const entrypoint of manifest.entrypoints?.surfaces ?? []) {
        if (entrypoint.mode === "declarative") continue;
        if (!entrypoint.file) throw new Error(`Executable Surface entrypoint has no file: ${entrypoint.id}`);
        const outputDirectory = join(artifactRoot, MANAGED_RUNTIME_DIRECTORY, entrypoint.id);
        await mkdir(outputDirectory, { recursive: true });
        const isolated = entrypoint.mode === "isolated";
        const modulePath = join(outputDirectory, isolated ? "module.js" : "module.cjs");
        if (!isolated && entrypoint.file.endsWith(".cjs")) {
          await copyFile(resolve(sourceRoot, entrypoint.file), modulePath, signal);
          entrypoints[entrypoint.id] = {
            module: toLogicalPath(relative(artifactRoot, modulePath)),
            styles: [],
          };
          continue;
        }
        const options: BuildOptions = {
          absWorkingDir: sourceRoot,
          assetNames: "assets/[name]-[hash]",
          bundle: true,
          entryPoints: [resolve(sourceRoot, entrypoint.file)],
          format: isolated ? "iife" : "cjs",
          ...(isolated ? { globalName: "VarinIsolatedModule" } : {}),
          loader: {
            ".gif": "file",
            ".jpeg": "file",
            ".jpg": "file",
            ".png": "file",
            ".svg": "file",
            ".webp": "file",
            ".woff": "file",
            ".woff2": "file",
          },
          metafile: true,
          outfile: modulePath,
          platform: "browser",
          sourcemap: "external",
          target: ["es2022"],
        };
        const result = await build(options);
        if (!result.metafile) throw new Error(`Surface entrypoint build returned no metadata: ${entrypoint.id}`);
        const stylePath = join(outputDirectory, "module.css");
        entrypoints[entrypoint.id] = {
          module: toLogicalPath(relative(artifactRoot, modulePath)),
          styles: await exists(stylePath) ? [toLogicalPath(relative(artifactRoot, stylePath))] : [],
        };
      }

      let host: ArtifactIndex["host"];
      const hostEntrypoint = manifest.entrypoints?.host;
      if (hostEntrypoint?.mode === "brokered" || hostEntrypoint?.mode === "native") {
        const outputDirectory = join(artifactRoot, "runtime", "host");
        const modulePath = join(outputDirectory, "module.cjs");
        await mkdir(outputDirectory, { recursive: true });
        if (hostEntrypoint.file.endsWith(".cjs")) {
          await copyFile(resolve(sourceRoot, hostEntrypoint.file), modulePath, signal);
        } else {
          const result = await build({
            absWorkingDir: sourceRoot,
            bundle: true,
            entryPoints: [resolve(sourceRoot, hostEntrypoint.file)],
            format: "cjs",
            metafile: true,
            outfile: modulePath,
            platform: "node",
            sourcemap: "external",
            target: ["node22"],
          });
          if (!result.metafile) throw new Error("Host entrypoint build returned no metadata");
        }
        host = { module: toLogicalPath(relative(artifactRoot, modulePath)) };
      }

      const files: Record<string, ArtifactFileRecord> = {};
      for (const logicalPath of await walkFiles(artifactRoot)) {
        if (logicalPath === INDEX_FILE) continue;
        signal?.throwIfAborted();
        files[logicalPath] = { contentType: contentTypeForPath(logicalPath), integrity: await hashFile(join(artifactRoot, ...logicalPath.split("/")), signal) };
      }
      const indexContent: Omit<ArtifactIndex, "artifactIntegrity"> = {
        entrypoints,
        files,
        ...(host ? { host } : {}),
        manifest,
        schemaVersion: 1,
      };
      const artifactIntegrity = artifactIntegrityForIndex(indexContent);
      const index: ArtifactIndex = { artifactIntegrity, ...indexContent };
      await writeFile(join(artifactRoot, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

      signal?.throwIfAborted();
      const finalPath = join(this.directory, artifactIntegrity.slice("sha256-".length));
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await rename(artifactRoot, finalPath);
      } catch (error) {
        if (!(await exists(finalPath))) throw error;
      }
      await this.#readVerifiedIndex(finalPath, artifactIntegrity, manifest, true, signal);
      signal?.throwIfAborted();
      return {
        integrity: artifactIntegrity,
        manifest,
        preparedAt: new Date().toISOString(),
        resolvedPath: finalPath,
        resolvedVersion: manifest.version,
        source: structuredClone(source),
      };
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }

  async readAsset(
    artifactRoot: string,
    artifactIntegrity: string,
    logicalPath: string,
    expectedManifest?: VarinExtensionManifest,
  ): Promise<VarinExtensionAssetPayload> {
    const { index, root } = await this.#readVerifiedIndex(artifactRoot, artifactIntegrity, expectedManifest);
    const { bytes, record } = await this.#readVerifiedFile(root, index, logicalPath);
    return {
      artifactIntegrity,
      bytesBase64: bytes.toString("base64"),
      contentType: record.contentType,
      integrity: record.integrity,
      path: logicalPath,
    };
  }

  /** Explicit source read uses the same authenticated index and file verifier as assets. */
  async readSource(
    artifactRoot: string,
    requestValue: VarinRuntimeSourceRequest,
    expectedManifest: VarinExtensionManifest,
    signal?: AbortSignal,
  ): Promise<VarinRuntimeSourceOutcome> {
    const request = parseVarinRuntimeSourceRequest(requestValue);
    signal?.throwIfAborted();
    let verified: { index: ArtifactIndex; root: string };
    try {
      verified = await this.#readVerifiedIndex(artifactRoot, request.artifactIntegrity, expectedManifest, false, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return sourceReadFailure(error);
    }
    const logicalPath = `package/${request.path}`;
    if (!Object.hasOwn(verified.index.files, logicalPath)) return { status: 'missing', code: 'source_missing' };
    try {
      const result = await this.#readVerifiedFile(verified.root, verified.index, logicalPath, signal,
        { offset: request.offset ?? 0, maxBytes: request.maxBytes ?? 16_384 });
      return result.source!;
    } catch (error) {
      signal?.throwIfAborted();
      return sourceReadFailure(error);
    }
  }

  async readManagedEntrypoint(
    artifactRoot: string,
    artifactIntegrity: string,
    entrypointId: string,
    expectedManifest?: VarinExtensionManifest,
  ): Promise<VarinExtensionManagedEntrypointPayload> {
    const { index, root } = await this.#readVerifiedIndex(artifactRoot, artifactIntegrity, expectedManifest);
    const entrypoint = index.entrypoints[entrypointId];
    if (!entrypoint) throw new Error(`Managed Surface entrypoint is not present in the artifact: ${entrypointId}`);
    const readPayload = async (logicalPath: string): Promise<VarinExtensionAssetPayload> => {
      const { bytes, record } = await this.#readVerifiedFile(root, index, logicalPath);
      return {
        artifactIntegrity,
        bytesBase64: bytes.toString("base64"),
        contentType: record.contentType,
        integrity: record.integrity,
        path: logicalPath,
      };
    };
    const [module, styles] = await Promise.all([
      readPayload(entrypoint.module),
      Promise.all(entrypoint.styles.map(readPayload)),
    ]);
    return { artifactIntegrity, entrypointId, module, styles };
  }

  async resolveBrokeredHostEntrypoint(
    artifactRoot: string,
    artifactIntegrity: string,
    expectedManifest?: VarinExtensionManifest,
  ): Promise<BrokeredHostEntrypointArtifact> {
    const { index, root } = await this.#readVerifiedIndex(artifactRoot, artifactIntegrity, expectedManifest);
    if (!index.host) throw new Error("Host entrypoint is not present in the artifact");
    const { path, record } = await this.#readVerifiedFile(root, index, index.host.module);
    return {
      artifactIntegrity,
      integrity: record.integrity,
      modulePath: path,
      packageRoot: join(root, "package"),
    };
  }

  async #readVerifiedIndex(
    artifactRoot: string,
    artifactIntegrity: string,
    expectedManifest?: VarinExtensionManifest,
    verifyAllFiles = false,
    signal?: AbortSignal,
  ): Promise<{ index: ArtifactIndex; root: string }> {
    signal?.throwIfAborted();
    const root = await this.#assertArtifactRoot(artifactRoot, artifactIntegrity);
    let indexBytes: string;
    try { indexBytes = await readFile(join(root, INDEX_FILE), { encoding: "utf8", signal }); }
    catch (error) {
      if (isMissing(error)) throw new ArtifactVerificationError('Varin extension artifact index is missing');
      throw error;
    }
    let index: ArtifactIndex;
    try { index = parseIndex(JSON.parse(indexBytes) as unknown); }
    catch { throw new ArtifactVerificationError('Varin extension artifact index is malformed'); }
    const indexContent: Omit<ArtifactIndex, "artifactIntegrity"> = {
      entrypoints: index.entrypoints,
      files: index.files,
      ...(index.host ? { host: index.host } : {}),
      manifest: index.manifest,
      schemaVersion: 1,
    };
    const canonicalIntegrity = artifactIntegrityForIndex(indexContent);
    if (canonicalIntegrity !== index.artifactIntegrity || index.artifactIntegrity !== artifactIntegrity) {
      throw new ArtifactVerificationError("Varin extension artifact canonical index integrity no longer matches its content address");
    }
    const manifestLogicalPath = `package/${VARIN_EXTENSION_MANIFEST_FILE}`;
    const { bytes: manifestBytes } = await this.#readVerifiedFile(root, index, manifestLogicalPath, signal);
    let artifactManifest: VarinExtensionManifest;
    try { artifactManifest = parseVarinExtensionManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown); }
    catch { throw new ArtifactVerificationError('Varin extension artifact manifest is malformed'); }
    if (canonicalJson(artifactManifest) !== canonicalJson(index.manifest)) {
      throw new ArtifactVerificationError("Varin extension artifact manifest file does not match its authenticated index snapshot");
    }
    if (expectedManifest && canonicalJson(expectedManifest) !== canonicalJson(index.manifest)) {
      throw new ArtifactVerificationError("Varin extension artifact manifest snapshot no longer matches the catalog record");
    }
    if (verifyAllFiles) {
      const actualFiles = (await walkFiles(root)).filter((logicalPath) => logicalPath !== INDEX_FILE);
      const indexedFiles = Object.keys(index.files).sort();
      if (JSON.stringify(actualFiles) !== JSON.stringify(indexedFiles)) {
        throw new ArtifactVerificationError("Varin extension artifact files do not match its authenticated index");
      }
      for (const logicalPath of indexedFiles) {
        signal?.throwIfAborted();
        if (await hashFile(join(root, logicalPath), signal) !== index.files[logicalPath]!.integrity) throw new ArtifactVerificationError(`Varin extension asset integrity failed: ${logicalPath}`);
      }
    }
    return { index, root };
  }

  async #readVerifiedFile(
    root: string,
    index: ArtifactIndex,
    logicalPath: string,
    signal?: AbortSignal,
    sourcePage?: { offset: number; maxBytes: number },
  ): Promise<{ bytes: Buffer; path: string; record: ArtifactFileRecord; source?: VarinRuntimeSourceOutcome }> {
    try {
      signal?.throwIfAborted();
      const record = Object.hasOwn(index.files, logicalPath) ? index.files[logicalPath] : undefined;
      if (!record) throw new ArtifactVerificationError(`Varin extension artifact does not contain asset: ${logicalPath}`);
      const path = resolve(root, ...logicalPath.split("/"));
      const relativePath = relative(root, path);
      if (!relativePath || relativePath.startsWith("..") || resolve(root, relativePath) !== path) {
        throw new ArtifactVerificationError("Varin extension asset path escapes its immutable artifact");
      }
      const info = await lstat(path);
      if (!info.isFile() || await realpath(path) !== path) throw new ArtifactVerificationError(`Varin extension artifact asset is not an immutable file: ${logicalPath}`);
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      const decoder = sourcePage ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined;
      let totalBytes = 0, invalidEncoding = false;
      const offset = sourcePage?.offset ?? 0;
      const captureEnd = sourcePage ? Math.min(Number.MAX_SAFE_INTEGER, offset + sourcePage.maxBytes + 3) : Infinity;
      // Each asynchronous chunk yields to control/cancellation. Only a requested source page is retained,
      // while the complete original file is checked against its existing authenticated hash.
      const stream = createReadStream(path, { highWaterMark: 64 * 1024, signal });
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        const bytes = chunk as Buffer;
        hash.update(bytes);
        if (decoder && !invalidEncoding) {
          try { decoder.decode(bytes, { stream: true }); } catch { invalidEncoding = true; }
        }
        const start = Math.max(0, offset - totalBytes), end = Math.min(bytes.length, captureEnd - totalBytes);
        if (start < end) chunks.push(Buffer.from(bytes.subarray(start, end)));
        totalBytes += bytes.length;
      }
      signal?.throwIfAborted();
      if (`sha256-${hash.digest('hex')}` !== record.integrity) throw new ArtifactVerificationError(`Varin extension asset integrity failed: ${logicalPath}`);
      if (decoder && !invalidEncoding) { try { decoder.decode(); } catch { invalidEncoding = true; } }
      const bytes = Buffer.concat(chunks);
      if (!sourcePage) return { bytes, path, record };
      let source: VarinRuntimeSourceOutcome;
      if (invalidEncoding) source = { status: 'invalid_encoding', code: 'source_not_utf8' };
      else if (offset > totalBytes) source = { status: 'invalid_range', code: 'offset_out_of_range' };
      else if (bytes.length && (bytes[0]! & 0xc0) === 0x80) source = { status: 'invalid_range', code: 'offset_not_utf8_boundary' };
      else {
        let byteLength = Math.min(sourcePage.maxBytes, bytes.length);
        // A one-byte budget remains valid: complete its final code point, never replace or split it.
        while (byteLength < bytes.length && (bytes[byteLength]! & 0xc0) === 0x80) byteLength++;
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, byteLength));
        source = { status: 'found', fileIntegrity: record.integrity, page: {
          encoding: 'utf-8', text, offset, byteLength, totalBytes,
          nextOffset: offset + byteLength < totalBytes ? offset + byteLength : null,
        } };
      }
      return { bytes, path, record, source };
    } catch (error) {
      if (isMissing(error)) throw new ArtifactVerificationError(`Varin extension indexed asset is missing: ${logicalPath}`);
      throw error;
    }
  }

  async #assertArtifactRoot(artifactRoot: string, artifactIntegrity: string): Promise<string> {
    const expected = join(this.directory, artifactIntegrity.slice("sha256-".length));
    const [actualRoot, actualExpected] = await Promise.all([realpath(artifactRoot), realpath(expected)]);
    if (actualRoot !== actualExpected) throw new ArtifactVerificationError("Varin extension artifact path does not match its content address");
    return actualRoot;
  }
}
