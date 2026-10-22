/**
 * On-demand grammar installs.
 *
 * The trust anchor is the committed manifest digest, not the network: bytes are
 * downloaded to memory, hashed, compared, and only then handed to the store.
 * A pack's `tags.scm` is part of the same anchor, because that query is what
 * makes the grammar produce an outline.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { extract } from "tar";
import type { LanguageSupportInstallResult } from "@varin/application-client";
import { MAX_USER_GRAMMAR_BYTES } from "./constants.js";
import { treeSitterLanguageSpec } from "./languages.js";
import type { GrammarPackManifest } from "./grammar-manifest.js";
import { GrammarStoreUnreadableError, grammarIntegrityOf, type GrammarStore } from "./grammar-store.js";

export interface GrammarInstaller {
  install(request: { languageId: string }): Promise<LanguageSupportInstallResult>;
  cancelInstall(request: { languageId: string }): Promise<LanguageSupportInstallResult>;
  importUserGrammar(request: { languageId: string; path: string }): Promise<LanguageSupportInstallResult>;
}

export interface GrammarInstallerOptions {
  store: GrammarStore;
  manifest: GrammarPackManifest;
  minAbi: number;
  maxAbi: number;
  /** Required: an install that cannot check the ABI must not happen at all. */
  inspectAbi: (bytes: Uint8Array) => Promise<number>;
  download?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  extractFiles?: (
    tarball: Uint8Array,
    paths: readonly string[],
    signal?: AbortSignal,
  ) => Promise<Map<string, Uint8Array>>;
  readLocal?: (path: string) => Promise<Uint8Array>;
  maxUserBytes?: number;
}

const failed = (
  languageId: string,
  reason: Extract<LanguageSupportInstallResult, { status: "failed" }>["reason"],
  message: string,
): LanguageSupportInstallResult => ({ status: "failed", languageId, reason, message });

export async function downloadBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error("Download failed: empty body.");
  return new Uint8Array(await response.arrayBuffer());
}

const normalizeEntry = (entry: string): string => entry.replace(/\\/g, "/");

export async function extractFilesFromTarball(
  tarball: Uint8Array,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const wanted = new Set(paths.map(normalizeEntry));
  const work = await mkdtemp(join(tmpdir(), "varin-grammar-extract-"));
  const archive = join(work, "pack.tgz");
  try {
    await writeFile(archive, tarball);
    await extract({
      file: archive,
      cwd: work,
      filter: (entry) => wanted.has(normalizeEntry(entry)),
    });
    const found = new Map<string, Uint8Array>();
    for (const path of paths) {
      try {
        found.set(path, new Uint8Array(await readFile(join(work, path))));
      } catch {
        // Absent entries are reported by the caller against the manifest.
      }
    }
    return found;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const isAbort = (error: unknown): boolean => (
  (error instanceof Error && error.name === "AbortError")
  || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
);

export function createGrammarInstaller(options: GrammarInstallerOptions): GrammarInstaller {
  const download = options.download ?? downloadBytes;
  const extractFiles = options.extractFiles ?? extractFilesFromTarball;
  const readLocal = options.readLocal ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const maxUserBytes = options.maxUserBytes ?? MAX_USER_GRAMMAR_BYTES;
  const controllers = new Map<string, AbortController>();
  const inflight = new Map<string, Promise<LanguageSupportInstallResult>>();

  const checkAbi = async (languageId: string, bytes: Uint8Array): Promise<LanguageSupportInstallResult | null> => {
    const abi = await options.inspectAbi(bytes);
    if (abi < options.minAbi || abi > options.maxAbi) {
      return failed(
        languageId,
        "abi",
        `Grammar ABI ${abi} is locked out of this application (compatible ${options.minAbi}-${options.maxAbi}).`,
      );
    }
    return null;
  };

  const runInstall = async (id: string, controller: AbortController): Promise<LanguageSupportInstallResult> => {
    const pack = options.manifest.packs[id]!;
    try {
      const tarball = await download(pack.tarballUrl, controller.signal);
      if (controller.signal.aborted) return { status: "cancelled", languageId: id };
      const wanted = pack.tagsPath ? [pack.wasmPath, pack.tagsPath] : [pack.wasmPath];
      const files = pack.downloadFormat === "wasm"
        ? new Map([[pack.wasmPath, tarball]])
        : await extractFiles(tarball, wanted, controller.signal);
      if (controller.signal.aborted) return { status: "cancelled", languageId: id };
      const wasm = files.get(pack.wasmPath);
      if (!wasm) return failed(id, "integrity", "The published archive did not contain the expected grammar file.");
      if (grammarIntegrityOf(wasm) !== pack.integrity) {
        return failed(id, "integrity", "Downloaded grammar wasm did not match the published digest.");
      }
      let tags: { bytes: Uint8Array; integrity: string } | undefined;
      if (pack.tagsPath && pack.tagsIntegrity) {
        const bytes = files.get(pack.tagsPath);
        if (!bytes) return failed(id, "integrity", "The published archive did not contain the expected query file.");
        const tagsIntegrity = grammarIntegrityOf(bytes);
        if (tagsIntegrity !== pack.tagsIntegrity) {
          return failed(id, "integrity", "Downloaded grammar query did not match the published digest.");
        }
        tags = { bytes, integrity: tagsIntegrity };
      }
      const abiFailure = await checkAbi(id, wasm);
      if (abiFailure) return abiFailure;
      options.store.put(id, wasm, {
        integrity: pack.integrity,
        source: "manifest",
        grammarFile: pack.grammarFile,
        packageName: pack.packageName,
        version: pack.version,
      }, tags);
      return { status: "ready", languageId: id, grammarStatus: "installed" };
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) return { status: "cancelled", languageId: id };
      if (error instanceof GrammarStoreUnreadableError) {
        return failed(id, "store-unreadable", "The installed-grammar index could not be read, so nothing was written.");
      }
      return failed(id, "failed", error instanceof Error ? error.message : "Grammar install failed.");
    }
  };

  const install = async ({ languageId }: { languageId: string }): Promise<LanguageSupportInstallResult> => {
    const id = languageId.trim();
    if (!id) return failed(languageId, "absent", "Language id is required.");
    if (treeSitterLanguageSpec(id)) {
      return { status: "ready", languageId: id, grammarStatus: "bundled" };
    }
    if (!options.manifest.packs[id]) {
      return failed(id, "absent", "No published grammar pack is listed for this language.");
    }
    // A second click must join the running download, not abort it and report
    // the first caller as cancelled.
    const running = inflight.get(id);
    if (running) return running;
    const controller = new AbortController();
    controllers.set(id, controller);
    const pending = runInstall(id, controller).finally(() => {
      if (controllers.get(id) === controller) controllers.delete(id);
      if (inflight.get(id) === pending) inflight.delete(id);
    });
    inflight.set(id, pending);
    return pending;
  };

  return {
    install,
    cancelInstall: async ({ languageId }) => {
      const id = languageId.trim();
      const controller = controllers.get(id);
      if (!controller) return failed(id, "absent", "No grammar download is in progress.");
      controller.abort();
      return { status: "cancelled", languageId: id };
    },
    importUserGrammar: async ({ languageId, path }) => {
      const id = languageId.trim();
      if (!id) return failed(languageId, "absent", "Language id is required.");
      if (treeSitterLanguageSpec(id)) {
        return failed(id, "unsupported", "Bundled grammars cannot be replaced by a user file.");
      }
      const source = path.trim();
      if (!source) return failed(id, "absent", "A local .wasm path is required.");
      if (extname(source).toLowerCase() !== ".wasm") {
        return failed(id, "unsupported", "A grammar must be a .wasm file.");
      }
      let bytes: Uint8Array;
      try {
        bytes = await readLocal(source);
      } catch {
        // The caller picked this path, so it learns nothing from the OS error
        // text — and an authenticated remote client must not use this endpoint
        // to probe the host filesystem.
        return failed(id, "failed", "The selected file could not be read.");
      }
      if (bytes.byteLength === 0 || bytes.byteLength > maxUserBytes) {
        return failed(id, "failed", `A grammar must be between 1 byte and ${maxUserBytes} bytes.`);
      }
      let abiFailure: LanguageSupportInstallResult | null;
      try {
        abiFailure = await checkAbi(id, bytes);
      } catch {
        return failed(id, "abi", "The selected file is not a loadable tree-sitter grammar.");
      }
      if (abiFailure) return abiFailure;
      try {
        options.store.put(id, bytes, {
          integrity: grammarIntegrityOf(bytes),
          source: "user",
          grammarFile: `${id}.wasm`,
        });
      } catch (error) {
        if (error instanceof GrammarStoreUnreadableError) {
          return failed(id, "store-unreadable", "The installed-grammar index could not be read, so nothing was written.");
        }
        // Same reasoning as the read above: the store path is ours, not the
        // caller's, so its error text does not go back over the wire.
        return failed(id, "failed", "The grammar could not be stored.");
      }
      return { status: "ready", languageId: id, grammarStatus: "user-unverified" };
    },
  };
}
