import type { ModelTextDescription, ModelTextService } from '../model-text/service.js';

export type WalkthroughLanguage = 'en' | 'fr' | 'zh-CN' | 'zh-TW' | 'uk' | 'es' | 'pt-BR' | 'ko' | 'pl' | 'ja';
export type WalkthroughSource =
  | { kind: 'working-tree'; scope: 'all' | 'staged' | 'working' }
  | { baseRef: string; headRef: string; kind: 'branch' }
  | { kind: 'pr'; number: number };

export interface DiffHunk {
  added: number;
  body: string;
  deleted: number;
  header: string;
  id: string;
  newLines: number;
  newStart: number;
  oldLines: number;
  oldStart: number;
  patch: string;
}

export interface DiffFile {
  binary: boolean;
  generated?: boolean;
  headerText: string;
  hunks: DiffHunk[];
  oldPath: string | null;
  path: string;
  scope?: string;
  status: string;
}

export interface ParsingDiffFile extends DiffFile {
  hunkDigests: Map<string, number>;
}

export interface ParsingHunk {
  added: number;
  deleted: number;
  header: string;
  lines: string[];
  newLines: number;
  newStart: number;
  oldLines: number;
  oldStart: number;
}

export interface DiffSection {
  patch: string;
  scope: string;
}

export interface IndexedHunk extends DiffHunk {
  path: string;
  status: string;
}

export interface DigestHunk {
  added: number;
  alias: string;
  deleted: number;
  header: string;
  newLines: string;
  oldLines: string;
  patch: string;
}

export interface DigestFile {
  binary?: true;
  hunks: DigestHunk[];
  oldPath?: string;
  path: string;
  scope?: string;
  status: string;
}

export interface BuiltDigest {
  aliasById: Map<string, string>;
  digest: { files: DigestFile[] };
  fileCount: number;
  files: DiffFile[];
  generatedFileCount: number;
  generatedPaths: string[];
  hunkCount: number;
  idByAlias: Map<string, string>;
}

export type WalkthroughChapterIcon = 'bug' | 'wrench' | 'path' | 'flask' | 'doc' | 'gear';
export type WalkthroughStopImportance = 'critical' | 'normal' | 'context';

export interface WalkthroughStop {
  hunkIds: string[];
  id: string;
  importance: WalkthroughStopImportance;
  prose: string;
  title: string;
}

export interface WalkthroughChapter {
  blurb: string;
  icon: WalkthroughChapterIcon;
  id: string;
  stops: WalkthroughStop[];
  title: string;
}

export interface Walkthrough {
  chapters: WalkthroughChapter[];
  droppedAnchors: number;
  focus: string;
  title: string;
}

export type WalkthroughModel = ModelTextDescription;

export interface PullRequestDiff {
  meta: Record<string, unknown>;
  patch: string;
}

export interface WalkthroughDependencies {
  modelText?: Pick<ModelTextService, 'describe' | 'generate'>;
  getPullRequestDiff?: (directory: string, number: number) => Promise<PullRequestDiff>;
}

export interface WalkthroughCacheEntry {
  requestId?: string;
  cacheKey: string;
  generatedAt: string;
  language?: WalkthroughLanguage | null;
  model: { modelID: string; providerID: string; source: string };
  repoRoot: string;
  sourceKey: string;
  walkthrough: Walkthrough;
  walkthroughVersion?: number;
}

export interface WalkthroughPointer {
  cacheKey: string;
  generatedAt: string;
  repoRoot: string;
  sourceKey: string;
}

export interface SerializedHunk {
  added: number;
  deleted: number;
  header: string;
  id: string;
  newStart: number;
  oldPath: string | null;
  patch: string;
  path: string;
  scope?: string;
  status: string;
}

export interface WalkthroughResolution {
  isStale: boolean;
  missingHunkIds: string[];
  staleStopIds: string[];
  uncoveredHunkIds: string[];
}

export type WalkthroughReadiness =
  | { ready: false; reason: 'no-model' }
  | { generatedFileCount: number; model?: WalkthroughModel; ready: false; reason: 'only-generated' | 'empty-diff' }
  | { ready: false; reason: 'no-provider-login' }
  | { availableChars?: number; model: WalkthroughModel; ready: false; reason: 'structured-output-unsupported'; requiredChars?: number }
  | { availableChars: number; model: WalkthroughModel; ready: false; reason: 'context-too-small'; requiredChars: number }
  | { availableChars: number; fileCount: number; hunkCount: number; model: WalkthroughModel; ready: true; requiredChars: number };

interface WalkthroughResultBase {
  requestId?: string;
  hunkCount: number;
  hunks: SerializedHunk[];
  language?: WalkthroughLanguage | null;
  source: WalkthroughSource;
}

export type WalkthroughReadResult = WalkthroughResultBase & {
  generating: boolean;
  readiness: WalkthroughReadiness;
} & (
  | { walkthrough: null }
  | (WalkthroughResolution & {
      generatedAt: string;
      language: WalkthroughLanguage | null;
      model: WalkthroughCacheEntry['model'];
      walkthrough: Walkthrough;
    })
);

export type WalkthroughGenerationResult = WalkthroughResultBase & WalkthroughResolution & {
  fromCache: boolean;
  generatedAt: string;
  language: WalkthroughLanguage | null;
  model: WalkthroughCacheEntry['model'];
  walkthrough: Walkthrough;
};
