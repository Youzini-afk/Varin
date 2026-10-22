import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GRAMMAR_INTEGRITY_PATTERN = /^sha256-[0-9a-f]{64}$/;

export interface GrammarPackEntry {
  languageId: string;
  packageName: string;
  version: string;
  tarballUrl: string;
  /** Omitted for npm tar archives; some upstream releases publish standalone wasm. */
  downloadFormat?: "wasm";
  wasmPath: string;
  grammarFile: string;
  integrity: string;
  bytes: number;
  abi: number;
  licensePath: string | null;
  /**
   * Upstream `queries/tags.scm`. Present only when the publish-time script
   * compiled it against the grammar, so a pack that carries one is a pack that
   * produces an outline once installed.
   */
  tagsPath: string | null;
  tagsIntegrity: string | null;
  /** Reviewed local unit query; independent of an upstream navigation tags file. */
  bundledQueryFile?: string;
  bundledQueryIntegrity?: string;
}

export interface GrammarPackManifest {
  generatedAt: string;
  minCompatibleAbi: number;
  maxCompatibleAbi: number;
  packs: Record<string, GrammarPackEntry>;
  skipped: Record<string, string>;
}

export const EMPTY_GRAMMAR_PACK_MANIFEST: GrammarPackManifest = {
  generatedAt: "",
  minCompatibleAbi: 0,
  maxCompatibleAbi: 0,
  packs: {},
  skipped: {},
};

export const isGrammarIntegrity = (value: string): boolean => GRAMMAR_INTEGRITY_PATTERN.test(value);

export const grammarIntegrityHex = (integrity: string): string => integrity.slice("sha256-".length);

export function parseGrammarPackManifest(value: unknown): GrammarPackManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Grammar pack manifest is not an object.");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.generatedAt !== "string" || typeof raw.minCompatibleAbi !== "number" || typeof raw.maxCompatibleAbi !== "number") {
    throw new Error("Grammar pack manifest is missing ABI bounds.");
  }
  const packs: Record<string, GrammarPackEntry> = {};
  const excluded: Record<string, string> = {};
  const rawPacks = raw.packs && typeof raw.packs === "object" && !Array.isArray(raw.packs)
    ? raw.packs as Record<string, unknown>
    : {};
  for (const [languageId, entry] of Object.entries(rawPacks)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const pack = entry as Record<string, unknown>;
    if (
      typeof pack.packageName !== "string"
      || typeof pack.version !== "string"
      || typeof pack.tarballUrl !== "string"
      || typeof pack.wasmPath !== "string"
      || typeof pack.grammarFile !== "string"
      || typeof pack.integrity !== "string"
      || !isGrammarIntegrity(pack.integrity)
      || typeof pack.bytes !== "number"
      || typeof pack.abi !== "number"
    ) {
      throw new Error(`Grammar pack manifest entry for ${languageId} is invalid.`);
    }
    if (pack.downloadFormat !== undefined && pack.downloadFormat !== "wasm") {
      throw new Error(`Grammar pack download format for ${languageId} is invalid.`);
    }
    if ((pack.bundledQueryFile !== undefined || pack.bundledQueryIntegrity !== undefined) && (
      typeof pack.bundledQueryFile !== "string" || !/^[\w.-]+\.scm$/.test(pack.bundledQueryFile)
      || typeof pack.bundledQueryIntegrity !== "string" || !isGrammarIntegrity(pack.bundledQueryIntegrity)
    )) {
      throw new Error(`Grammar pack bundled query identity for ${languageId} is invalid.`);
    }
    // A pack advertised outside the window the manifest itself declares can
    // never load, so it is not offered as installable.
    if (pack.abi < raw.minCompatibleAbi || pack.abi > raw.maxCompatibleAbi) {
      excluded[languageId] = `abi ${pack.abi} is outside the manifest window ${raw.minCompatibleAbi}-${raw.maxCompatibleAbi}`;
      continue;
    }
    const path = typeof pack.tagsPath === "string" && pack.tagsPath.trim() ? pack.tagsPath : null;
    const digest = typeof pack.tagsIntegrity === "string" && isGrammarIntegrity(pack.tagsIntegrity)
      ? pack.tagsIntegrity
      : null;
    // Both halves or neither: a query we cannot verify is not installed.
    const hasQuery = Boolean(path && digest);
    packs[languageId] = {
      languageId,
      packageName: pack.packageName,
      version: pack.version,
      tarballUrl: pack.tarballUrl,
      ...(pack.downloadFormat === "wasm" ? { downloadFormat: "wasm" as const } : {}),
      wasmPath: pack.wasmPath,
      grammarFile: pack.grammarFile,
      integrity: pack.integrity,
      bytes: pack.bytes,
      abi: pack.abi,
      licensePath: typeof pack.licensePath === "string" ? pack.licensePath : null,
      tagsPath: hasQuery ? path : null,
      tagsIntegrity: hasQuery ? digest : null,
      ...(typeof pack.bundledQueryFile === "string" && typeof pack.bundledQueryIntegrity === "string"
        && isGrammarIntegrity(pack.bundledQueryIntegrity)
        ? { bundledQueryFile: pack.bundledQueryFile, bundledQueryIntegrity: pack.bundledQueryIntegrity } : {}),
    };
  }
  const skipped = raw.skipped && typeof raw.skipped === "object" && !Array.isArray(raw.skipped)
    ? Object.fromEntries(
      Object.entries(raw.skipped as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
    : {};
  return {
    generatedAt: raw.generatedAt,
    minCompatibleAbi: raw.minCompatibleAbi,
    maxCompatibleAbi: raw.maxCompatibleAbi,
    packs,
    skipped: { ...skipped, ...excluded },
  };
}

export function loadCommittedGrammarPackManifest(
  fromUrl: string = import.meta.url,
): GrammarPackManifest {
  const source = readFileSync(fileURLToPath(new URL("./grammar-packs.json", fromUrl)), "utf8");
  return parseGrammarPackManifest(JSON.parse(source));
}
