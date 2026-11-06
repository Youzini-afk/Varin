import { parseGithubReleaseSource, parseNpmReleaseSource } from "./releases.js";
import type { VarinExtensionPackageSource } from "./types.js";

export const VARIN_EXTENSION_DISCOVERY_SCHEMA_VERSION = 1 as const;

export interface VarinExtensionDiscoveryEntry {
  author?: string;
  categories?: string[];
  repository?: string;
  description?: string;
  displayName?: string;
  homepage?: string;
  icon?: string;
  id: string;
  keywords?: string[];
  source: VarinExtensionPackageSource;
}

export interface VarinExtensionDiscoveryDocument {
  contentVersion?: string;
  entries: VarinExtensionDiscoveryEntry[];
  schemaVersion: typeof VARIN_EXTENSION_DISCOVERY_SCHEMA_VERSION;
}

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SOURCE_KINDS = new Set<VarinExtensionPackageSource["kind"]>(["builtin", "git", "local", "npm", "github-release", "release-archive"]);

const record = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const optionalText = (value: unknown, label: string): string | undefined => (
  value === undefined ? undefined : text(value, label)
);

const parseSource = (value: unknown, label: string): VarinExtensionPackageSource => {
  const raw = record(value);
  if (!raw) throw new Error(`${label} must be an object`);
  const kind = text(raw.kind, `${label}.kind`) as VarinExtensionPackageSource["kind"];
  if (!SOURCE_KINDS.has(kind)) throw new Error(`${label}.kind is unsupported`);
  const specifier = text(raw.specifier, `${label}.specifier`);
  if (kind === 'github-release') parseGithubReleaseSource(specifier);
  if (kind === 'npm') parseNpmReleaseSource(specifier);
  return {
    display: text(raw.display, `${label}.display`),
    kind,
    specifier,
  };
};

export const parseVarinExtensionDiscoveryDocument = (
  value: unknown,
): VarinExtensionDiscoveryDocument => {
  const raw = record(value);
  if (!raw) throw new Error("Varin extension discovery document must be an object");
  if (raw.schemaVersion !== VARIN_EXTENSION_DISCOVERY_SCHEMA_VERSION) {
    throw new Error("Varin extension discovery schemaVersion is unsupported");
  }
  if (!Array.isArray(raw.entries)) throw new Error("Varin extension discovery entries must be an array");
  const entries = raw.entries.map<VarinExtensionDiscoveryEntry>((value, index) => {
    const entry = record(value);
    if (!entry) throw new Error(`entries[${index}] must be an object`);
    const id = text(entry.id, `entries[${index}].id`);
    if (!ID_PATTERN.test(id)) throw new Error(`entries[${index}].id is invalid`);
    let keywords: string[] | undefined;
    if (entry.keywords !== undefined) {
      if (!Array.isArray(entry.keywords)) throw new Error(`entries[${index}].keywords must be an array`);
      keywords = entry.keywords.map((item, keywordIndex) => text(item, `entries[${index}].keywords[${keywordIndex}]`));
      if (new Set(keywords).size !== keywords.length) throw new Error(`entries[${index}].keywords contains duplicates`);
    }
    const description = optionalText(entry.description, `entries[${index}].description`);
    const displayName = optionalText(entry.displayName, `entries[${index}].displayName`);
    const homepage = optionalText(entry.homepage, `entries[${index}].homepage`);
    const icon = optionalText(entry.icon, `entries[${index}].icon`);
    if (entry.categories !== undefined && !Array.isArray(entry.categories)) throw new Error('categories must be an array');
    const categories = (entry.categories as unknown[] | undefined)?.map(item => text(item, 'category'));
    if (categories && new Set(categories).size !== categories.length) throw new Error('categories contains duplicates');
    const repository = optionalText(entry.repository, 'repository');
    for (const link of [homepage, repository]) {
      if (link) { const url = new URL(link); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Discovery links must be public HTTP(S) URLs'); }
    }
    if (icon && (icon.startsWith('//') || icon.includes('\\'))) throw new Error('Invalid discovery icon path');
    if (icon?.includes(':')) { const url = new URL(icon); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid discovery icon URL'); }
    return {
      id,
      ...(entry.author ? { author: text(entry.author, "author") } : {}),
      ...(repository ? { repository } : {}),
      ...(categories ? { categories } : {}),
      source: parseSource(entry.source, `entries[${index}].source`),
      ...(description ? { description } : {}),
      ...(displayName ? { displayName } : {}),
      ...(homepage ? { homepage } : {}),
      ...(icon ? { icon } : {}),
      ...(keywords ? { keywords } : {}),
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("Varin extension discovery entry IDs must be unique");
  }
  return { entries, ...(raw.contentVersion !== undefined ? { contentVersion: text(raw.contentVersion, "contentVersion") } : {}), schemaVersion: VARIN_EXTENSION_DISCOVERY_SCHEMA_VERSION };
};
