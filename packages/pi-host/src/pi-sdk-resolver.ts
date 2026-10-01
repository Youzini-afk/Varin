import type { InitializeHook, ResolveHook, LoadHook } from "node:module";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptPiSdkSource } from "./pi-sdk-adaptation.js";
import {
  findSdkPackageDir,
  importerParentURL,
  matchPiSdkPackage,
  resolvePiSdkSpecifier,
  PI_SDK_PACKAGE_NAMES,
} from "./pi-sdk-packages.js";

let packageRoot: string | undefined;
let packageDirectories: Array<{ name: (typeof PI_SDK_PACKAGE_NAMES)[number]; path: string }> = [];

export const initialize: InitializeHook<{ packageRoot?: string }> = (data) => {
  packageRoot = typeof data?.packageRoot === "string" && data.packageRoot.trim()
    ? data.packageRoot
    : undefined;
  packageDirectories = packageRoot ? PI_SDK_PACKAGE_NAMES.flatMap(name => {
    const directory = findSdkPackageDir(packageRoot!, name);
    return directory ? [{ name, path: realpathSync(directory) }] : [];
  }) : [];
};

export const load: LoadHook = async (url, context, nextLoad) => {
  const loaded = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith("file:")) return loaded;
  const path = fileURLToPath(url);
  for (const { name, path: directory } of packageDirectories) {
    const local = relative(directory, path).replaceAll("\\", "/");
    if (!local.startsWith("dist/") || !local.endsWith(".js")) continue;
    const source = typeof loaded.source === "string" ? loaded.source
      : loaded.source ? new TextDecoder().decode(loaded.source) : undefined;
    if (source === undefined) return loaded;
    return { ...loaded, source: adaptPiSdkSource(name, local, source) };
  }
  return loaded;
};

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const name = matchPiSdkPackage(specifier);
  if (!packageRoot || !name) {
    return nextResolve(specifier, context);
  }
  const packageDir = findSdkPackageDir(packageRoot, name);
  if (!packageDir) {
    throw new Error(`Unable to resolve ${specifier} from Pi package root ${packageRoot}`);
  }
  const importer = importerParentURL(packageDir, name);
  if (importer) {
    return nextResolve(specifier, { ...context, parentURL: importer });
  }
  try {
    return {
      format: "module",
      shortCircuit: true,
      url: resolvePiSdkSpecifier(packageRoot, specifier),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message, { cause: error });
  }
};
