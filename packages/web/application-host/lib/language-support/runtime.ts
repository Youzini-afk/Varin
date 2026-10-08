import { languageIdForPath } from "@varin/protocol";
import type {
  LanguageSupportAPI,
  LanguageSupportInstallResult,
  LanguageSupportLanguageRow,
  LanguageSupportServerInfo,
  LanguageSupportStatus,
  LanguageSupportStoreStatus,
  StructureGrammarStatus,
} from "@varin/application-client";
import { NO_STRUCTURE_CAPABILITIES } from "../structure/types.js";
import { capabilitiesFromSpec, treeSitterLanguageSpec, treeSitterTagsSpec } from "../structure/languages.js";
import type { GrammarInstaller } from "../structure/grammar-installer.js";
import type { GrammarPackManifest } from "../structure/grammar-manifest.js";
import { GrammarStoreUnreadableError, type GrammarStore } from "../structure/grammar-store.js";
import type { FileSearchItem } from "../fs/types.js";

/** Enumerate this many files, then stop and set `partial` (D-120). */
export const LANGUAGE_DISTRIBUTION_FILE_LIMIT = 8_000;
/** Per-workspace cache for getStatus. Settings is a user gesture (D-120). */
export const LANGUAGE_DISTRIBUTION_CACHE_MS = 30_000;

export interface LanguageSupportRuntimeOptions {
  searchFilesystemFiles: (
    rootPath: string,
    options: { query: string; respectGitignore?: boolean; limit?: number; signal?: AbortSignal },
  ) => Promise<FileSearchItem[]>;
  inspectWorkspace: (workspaceId: string) => Promise<{ root: string }>;
  fileLimit?: number;
  cacheTtlMs?: number;
  now?: () => number;
  /**
   * Language ids that have a downloadable pack but are not on this machine.
   * Defaults from the committed manifest + store when those are provided.
   */
  installableLanguageIds?: () => readonly string[];
  installedLanguageIds?: () => readonly string[];
  userUnverifiedLanguageIds?: () => readonly string[];
  manifest?: GrammarPackManifest;
  store?: GrammarStore;
  installer?: GrammarInstaller;
  serverInfo?: (languageId: string) => LanguageSupportServerInfo | Promise<LanguageSupportServerInfo>;
  prepareServer?: (languageId: string, root: string, signal: AbortSignal) => Promise<unknown>;
}

export interface LanguageSupportRuntime extends LanguageSupportAPI {
  warmupDocuments(workspaceId: string, signal?: AbortSignal, refresh?: boolean): Promise<Array<{ languageId: string; resourceId: string }>>;
  noteRequest(languageId: string, workspaceId?: string): void;
  peekWanted(workspaceId: string): readonly string[];
  /**
   * Structure wiring for a language that was installed rather than bundled.
   * This runtime owns the memo because it also owns install and remove, so the
   * structure provider never has to guess when to forget a miss (D-129).
   */
  installedStructureSpec(languageId: string): { grammarFile: string; tagsQuery: string } | null;
}

const unsupportedInstall = (languageId: string): LanguageSupportInstallResult => ({
  status: "failed",
  languageId,
  reason: "unsupported",
  message: "On-demand grammar install is not available.",
});

export function resolveGrammarStatus(
  languageId: string,
  options: {
    installable: ReadonlySet<string>;
    installed: ReadonlySet<string>;
    userUnverified: ReadonlySet<string>;
    storeStatus?: LanguageSupportStoreStatus;
  },
): StructureGrammarStatus {
  if (treeSitterLanguageSpec(languageId)) return "bundled";
  // Bundled grammars are known from the table alone; everything else depends on
  // an index we could not read, so it is unknown rather than absent.
  if (options.storeStatus === "unreadable") return "unknown";
  if (options.userUnverified.has(languageId)) return "user-unverified";
  if (options.installed.has(languageId)) return "installed";
  if (options.installable.has(languageId)) return "available";
  return "absent";
}

export function createLanguageSupportRuntime(options: LanguageSupportRuntimeOptions): LanguageSupportRuntime {
  const fileLimit = options.fileLimit ?? LANGUAGE_DISTRIBUTION_FILE_LIMIT;
  const cacheTtlMs = options.cacheTtlMs ?? LANGUAGE_DISTRIBUTION_CACHE_MS;
  const now = options.now ?? Date.now;
  const wantedByWorkspace = new Map<string, Set<string>>();
  const cache = new Map<string, { expiresAt: number; status: LanguageSupportStatus }>();
  const samples = new Map<string, Map<string, string>>();
  const serverPreparations = new Map<string, { controller: AbortController; result: Promise<LanguageSupportServerInfo> }>();

  const installableLanguageIds = options.installableLanguageIds ?? (() => {
    const packs = Object.keys(options.manifest?.packs ?? {});
    return packs.filter((languageId) => (
      !treeSitterLanguageSpec(languageId) && !options.store?.has(languageId)
    ));
  });
  const installedLanguageIds = options.installedLanguageIds ?? (() => options.store?.idsBySource("manifest") ?? []);
  const userUnverifiedLanguageIds = options.userUnverifiedLanguageIds ?? (() => options.store?.idsBySource("user") ?? []);

  const sets = () => ({
    installable: new Set(installableLanguageIds()),
    installed: new Set(installedLanguageIds()),
    userUnverified: new Set(userUnverifiedLanguageIds()),
  });

  const specMemo = new Map<string, { grammarFile: string; tagsQuery: string } | null>();

  const installedStructureSpec = (languageId: string): { grammarFile: string; tagsQuery: string } | null => {
    if (treeSitterLanguageSpec(languageId)) return null;
    const memoized = specMemo.get(languageId);
    if (memoized !== undefined) return memoized;
    let resolved: { grammarFile: string; tagsQuery: string } | null = null;
    try {
      const record = options.store?.get(languageId);
      if (record) {
        const tagsQuery = options.store?.readTagsQuery(languageId) ?? null;
        // A grammar with no query cannot produce an outline, so it is installed
        // but not wired. Saying so is the point (D-128).
        if (tagsQuery?.trim()) resolved = { grammarFile: record.grammarFile, tagsQuery };
      }
    } catch (error) {
      if (!(error instanceof GrammarStoreUnreadableError)) throw error;
      // The structure path has no way to say "unknown", so it degrades to
      // unsupported. `getStatus` reads the store itself and still reports
      // `grammarStore: 'unreadable'`, so the user is not told "nothing here".
      return null;
    }
    specMemo.set(languageId, resolved);
    return resolved;
  };

  const capabilitiesFor = (languageId: string) => {
    const bundled = treeSitterLanguageSpec(languageId);
    if (bundled) return capabilitiesFromSpec(bundled);
    const installed = installedStructureSpec(languageId);
    return capabilitiesFromSpec(installed ? treeSitterTagsSpec(installed.grammarFile, installed.tagsQuery) : undefined);
  };

  const forget = (): void => {
    specMemo.clear();
    cache.clear();
  };

  const noteRequest = (languageId: string, workspaceId?: string): void => {
    if (!languageId || !workspaceId) return;
    let status: StructureGrammarStatus;
    try {
      status = resolveGrammarStatus(languageId, sets());
    } catch {
      // Demand is a hint for the settings page. An unreadable index is reported
      // by getStatus; it must not turn a structure request into a failure.
      return;
    }
    if (status !== "available") return;
    const wanted = wantedByWorkspace.get(workspaceId) ?? new Set<string>();
    wanted.add(languageId);
    wantedByWorkspace.set(workspaceId, wanted);
    cache.delete(workspaceId);
  };

  const withServers = async (status: LanguageSupportStatus): Promise<LanguageSupportStatus> => {
    if (!options.serverInfo) return status;
    return { ...status, languages: await Promise.all(status.languages.map(async (row) => ({
      ...row, server: await options.serverInfo!(row.languageId),
    }))) };
  };

  const getStatus = async (request: { workspaceId: string; signal?: AbortSignal }): Promise<LanguageSupportStatus> => {
    request.signal?.throwIfAborted();
    const workspaceId = request.workspaceId.trim();
    if (!workspaceId) {
      return { workspaceId, languages: [], partial: false, scannedFiles: 0, fileLimit, grammarStore: "ready" };
    }
    const cached = cache.get(workspaceId);
    if (cached && cached.expiresAt > now()) return withServers(cached.status);

    let grammarStore: LanguageSupportStoreStatus = "ready";
    let catalog: ReturnType<typeof sets>;
    try {
      catalog = sets();
    } catch (error) {
      if (!(error instanceof GrammarStoreUnreadableError)) throw error;
      grammarStore = "unreadable";
      catalog = { installable: new Set(), installed: new Set(), userUnverified: new Set() };
    }
    const workspace = await options.inspectWorkspace(workspaceId);
    const files = await options.searchFilesystemFiles(workspace.root, {
      query: "",
      respectGitignore: true,
      limit: fileLimit + 1,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const partial = files.length > fileLimit;
    const scanned = files.slice(0, fileLimit);
    const counts = new Map<string, number>();
    const representatives = new Map<string, string>();
    for (const file of scanned) {
      const languageId = languageIdForPath(file.relativePath);
      if (!languageId) continue;
      counts.set(languageId, (counts.get(languageId) ?? 0) + 1);
      if (!representatives.has(languageId)) representatives.set(languageId, file.relativePath);
    }

    const wanted = wantedByWorkspace.get(workspaceId) ?? new Set<string>();
    const languageIds = new Set([...counts.keys(), ...wanted]);
    const languages: LanguageSupportLanguageRow[] = [...languageIds].map((languageId) => {
      const pack = options.manifest?.packs[languageId];
      return {
        languageId,
        grammarStatus: resolveGrammarStatus(languageId, { ...catalog, storeStatus: grammarStore }),
        capabilities: grammarStore === "unreadable"
          ? capabilitiesFromSpec(treeSitterLanguageSpec(languageId))
          : capabilitiesFor(languageId),
        fileCount: counts.get(languageId) ?? 0,
        wanted: wanted.has(languageId),
        ...(pack ? {
          pack: {
            abi: pack.abi,
            bytes: pack.bytes,
            packageName: pack.packageName,
            version: pack.version,
            providesOutline: Boolean(pack.tagsPath),
          },
        } : {}),
      };
    });
    languages.sort((left, right) => {
      if (left.wanted !== right.wanted) return left.wanted ? -1 : 1;
      if (right.fileCount !== left.fileCount) return right.fileCount - left.fileCount;
      return left.languageId.localeCompare(right.languageId);
    });

    const status: LanguageSupportStatus = {
      workspaceId,
      languages,
      partial,
      scannedFiles: scanned.length,
      fileLimit,
      grammarStore,
    };
    cache.set(workspaceId, { expiresAt: now() + cacheTtlMs, status });
    samples.set(workspaceId, representatives);
    return withServers(status);
  };

  return {
    async warmupDocuments(workspaceId, signal, refresh) {
      if (refresh) cache.delete(workspaceId);
      const status = await getStatus({ workspaceId, ...(signal ? { signal } : {}) });
      return status.languages.flatMap(language => {
        const resourceId = samples.get(workspaceId)?.get(language.languageId);
        return resourceId ? [{ languageId: language.languageId, resourceId }] : [];
      });
    },
    noteRequest,
    peekWanted: (workspaceId) => [...(wantedByWorkspace.get(workspaceId) ?? [])],
    installedStructureSpec,
    getStatus,
    prepareServer(request) {
      const { workspaceId, languageId } = request;
      const key = JSON.stringify([workspaceId, languageId]);
      const existing = serverPreparations.get(key);
      if (existing) return existing.result;
      const controller = new AbortController();
      const result = (async (): Promise<LanguageSupportServerInfo> => {
        if (!options.prepareServer || !options.serverInfo) return { status: 'unsupported' };
        try {
          const workspace = await options.inspectWorkspace(workspaceId);
          controller.signal.throwIfAborted();
          await options.prepareServer(languageId, workspace.root, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
        return options.serverInfo(languageId);
      })();
      const pending = { controller, result };
      serverPreparations.set(key, pending);
      void result.finally(() => { if (serverPreparations.get(key) === pending) serverPreparations.delete(key); }).catch(() => {});
      return result;
    },
    async cancelServerPreparation(request) {
      serverPreparations.get(JSON.stringify([request.workspaceId, request.languageId]))?.controller.abort();
    },
    install: async (request) => {
      if (!options.installer) return unsupportedInstall(request.languageId);
      const result = await options.installer.install(request);
      forget();
      return result;
    },
    cancelInstall: async (request) => {
      if (!options.installer) return unsupportedInstall(request.languageId);
      return options.installer.cancelInstall(request);
    },
    importUserGrammar: async (request) => {
      if (!options.installer) return unsupportedInstall(request.languageId);
      const result = await options.installer.importUserGrammar(request);
      forget();
      return result;
    },
  };
}

export const emptyLanguageSupportCapabilities = NO_STRUCTURE_CAPABILITIES;
