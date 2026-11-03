import { access, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  VARIN_EXTENSION_MANIFEST_FILE,
  checkVarinContributionCompatibility,
  inspectVarinSurfaceContributions,
  parseVarinExtensionManifest,
  type VarinExtensionManifest,
} from "@varin/extension-contract";
import type { CheckResult, ExtensionBuildEntrypointConfig, ExtensionPackageMetadata, LoadedExtensionProject } from "./types.js";

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const isMissing = (error: unknown): boolean => (
  typeof error === "object"
  && error !== null
  && "code" in error
  && (error as { code?: unknown }).code === "ENOENT"
);

const asObject = (value: unknown): Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export const normalizeProjectDirectory = (directory = "."): string => resolve(process.cwd(), directory);

const readJson = async (path: string, label: string): Promise<unknown> => {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error(`${label} is missing: ${path}`);
    throw new Error(`Cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
};

const readPackage = async (path: string): Promise<ExtensionPackageMetadata> => {
  const value = asObject(await readJson(path, "package.json"));
  return value as ExtensionPackageMetadata;
};

const readManifest = async (path: string): Promise<VarinExtensionManifest> => (
  parseVarinExtensionManifest(await readJson(path, VARIN_EXTENSION_MANIFEST_FILE))
);

export const loadProject = async (directory = "."): Promise<LoadedExtensionProject> => {
  const normalizedDirectory = normalizeProjectDirectory(directory);
  try {
    const directoryInfo = await stat(normalizedDirectory);
    if (!directoryInfo.isDirectory()) throw new Error(`Project path is not a directory: ${normalizedDirectory}`);
  } catch (error) {
    if (isMissing(error)) throw new Error(`Project directory does not exist: ${normalizedDirectory}`);
    throw error;
  }
  const manifestPath = join(normalizedDirectory, VARIN_EXTENSION_MANIFEST_FILE);
  const packageJsonPath = join(normalizedDirectory, "package.json");
  const [manifest, packageJson] = await Promise.all([readManifest(manifestPath), readPackage(packageJsonPath)]);
  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error("package.json must declare a non-empty version; it must match varin.extension.json version");
  }
  if (packageJson.version !== manifest.version) {
    throw new Error(`Version mismatch: package.json is ${packageJson.version}, but ${VARIN_EXTENSION_MANIFEST_FILE} is ${manifest.version}. Update one version so they match.`);
  }
  return { directory: normalizedDirectory, manifest, manifestPath, packageJson, packageJsonPath };
};

const referencedEntrypoints = (manifest: VarinExtensionManifest): Array<{
  file: string;
  id: string;
  kind: "host" | "surface";
}> => {
  const result: Array<{ file: string; id: string; kind: "host" | "surface" }> = [];
  const host = manifest.entrypoints?.host;
  if (host) result.push({ file: host.file, id: "host", kind: "host" });
  for (const surface of manifest.entrypoints?.surfaces ?? []) {
    if (surface.file) result.push({ file: surface.file, id: surface.id, kind: "surface" });
  }
  return result;
};

const pathInside = (root: string, file: string): string => {
  const absolute = resolve(root, ...file.split("/"));
  const relativePath = relative(root, absolute);
  if (!relativePath || relativePath.startsWith("..") || resolve(root, relativePath) !== absolute) {
    throw new Error(`Manifest entrypoint path escapes the project: ${file}`);
  }
  return absolute;
};

export const entrypointSourceConfig = (
  project: LoadedExtensionProject,
  id: string,
): ExtensionBuildEntrypointConfig | undefined => {
  const value = project.packageJson.varin?.build?.entrypoints?.[id];
  if (typeof value === "string") return { source: value };
  if (value && typeof value.source === "string") return value;
  return undefined;
};

export const entrypointSourcePath = (project: LoadedExtensionProject, id: string, target: string): string => {
  const configured = entrypointSourceConfig(project, id);
  return pathInside(project.directory, configured?.source ?? target);
};

export const entrypointTargetPath = (project: LoadedExtensionProject, target: string): string => pathInside(project.directory, target);

export const checkProject = async (directory = "."): Promise<CheckResult> => {
  const project = await loadProject(directory);
  const referenced = referencedEntrypoints(project.manifest);
  const missingFiles: string[] = [];
  for (const entrypoint of referenced) {
    const path = pathInside(project.directory, entrypoint.file);
    try {
      await access(path);
      const info = await stat(path);
      if (!info.isFile()) missingFiles.push(entrypoint.file);
    } catch (error) {
      if (isMissing(error)) missingFiles.push(entrypoint.file);
      else throw error;
    }
  }
  const incompatibleContributions = (project.manifest.contributions ?? [])
    .map((contribution) => ({
      contributionId: contribution.id,
      result: checkVarinContributionCompatibility(contribution.kind, contribution.contractVersion),
    }))
    .filter((entry): entry is { contributionId: string; result: Extract<typeof entry.result, { status: "unsupported-contract-version" }> } => (
      entry.result.status === "unsupported-contract-version"
    ))
    .map((entry) => ({
      id: entry.contributionId,
      kind: entry.result.kind,
      contractVersion: entry.result.contractVersion,
      supportedVersions: entry.result.supportedVersions,
    }));
  return { project, referencedFiles: referenced.map((entrypoint) => entrypoint.file), missingFiles, incompatibleContributions,
    authorDiagnostics: inspectVarinSurfaceContributions(project.manifest) };
};

export const formatContractError = (error: unknown): string[] => {
  if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues?: unknown }).issues)) {
    return (error as { issues: unknown[] }).issues.map((issue) => String(issue));
  }
  return [error instanceof Error ? error.message : String(error)];
};

export const isExtensionId = (value: string): boolean => ID_PATTERN.test(value);
