import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
  VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID,
  VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION_ID,
  VARIN_BUILTIN_RETRIEVAL_KEYWORD_EXTENSION_ID,
  VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
  VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
} from "./index.js";

const ASAR_DIRECTORY_SEGMENT = /(^|[\\/])([^\\/]+\.asar)([\\/])/i;

export const VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE = "varin-builtin-fingerprint.txt";

/**
 * Electron keeps the logical module URL inside app.asar even when electron-builder
 * physically unpacks runtime files beside it. Built-in packages are copied into an
 * immutable artifact before execution, so their registered roots must name the
 * physical directory rather than an ASAR virtual directory.
 */
export const resolveVarinBuiltinPackageRoot = (
  sourcePath: string,
  pathExists: (candidate: string) => boolean = existsSync,
): string => {
  const unpackedPath = sourcePath.replace(
    ASAR_DIRECTORY_SEGMENT,
    (_segment, prefix: string, archive: string, separator: string) => (
      `${prefix}${archive}.unpacked${separator}`
    ),
  );
  if (unpackedPath === sourcePath || !pathExists(unpackedPath)) return sourcePath;
  return unpackedPath;
};

export const VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS: ReadonlyMap<string, string> = new Map([
  [VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID, resolveVarinBuiltinPackageRoot(fileURLToPath(new URL("./builtin-packages/context-fragments/", import.meta.url)))],
  [VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION_ID, resolveVarinBuiltinPackageRoot(fileURLToPath(new URL("./builtin-packages/retrieval-structured/", import.meta.url)))],
  [VARIN_BUILTIN_RETRIEVAL_KEYWORD_EXTENSION_ID, resolveVarinBuiltinPackageRoot(fileURLToPath(new URL("./builtin-packages/retrieval-keyword/", import.meta.url)))],
  [
    VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
    resolveVarinBuiltinPackageRoot(
      fileURLToPath(new URL("./builtin-packages/language-servers/", import.meta.url)),
    ),
  ],
  [
    VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
    resolveVarinBuiltinPackageRoot(
      fileURLToPath(new URL("./builtin-packages/typescript-language/", import.meta.url)),
    ),
  ],
  [
    VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
    resolveVarinBuiltinPackageRoot(
      fileURLToPath(new URL("./builtin-packages/recovery/", import.meta.url)),
    ),
  ],
]);
