import {
  VARIN_EXTENSION_CATALOG_SCHEMA_VERSION,
  VARIN_EXTENSION_MANIFEST_SCHEMA_VERSION,
  type JsonObject,
  type JsonValue,
  type VarinApplicationSurface,
  type VarinExtensionActivationEvent,
  type VarinExtensionActualState,
  type VarinExtensionActualStatus,
  type VarinExtensionAssetPayload,
  type VarinExtensionAssetRequest,
  type VarinExtensionCandidateRecord,
  type VarinExtensionCandidateCapabilityReviewRequest,
  type VarinExtensionCandidatePreparationResult,
  type VarinExtensionCandidateSelectionRequest,
  type VarinExtensionCatalogAvailability,
  type VarinExtensionCatalogDocument,
  type VarinExtensionCatalogEntry,
  type VarinExtensionCatalogSnapshot,
  type VarinExtensionCapabilityDelta,
  type VarinExtensionCapabilityDecision,
  type VarinExtensionCapabilityReviewRequest,
  type VarinExtensionCapabilityGrant,
  type VarinExtensionCapabilityReference,
  type VarinExtensionContributionKind,
  type VarinExtensionDesiredState,
  type VarinExtensionDiagnostic,
  type VarinExtensionHostEntrypoint,
  type VarinExtensionHostIdentityDocument,
  type VarinExtensionHostStateSnapshot,
  type VarinExtensionHostStateWaitRequest,
  type VarinExtensionInstallationRecord,
  type VarinExtensionManifest,
  type VarinExtensionManagedEntrypointPayload,
  type VarinExtensionManagedEntrypointRequest,
  type VarinExtensionLocalSourceReloadRequest,
  type VarinExtensionLocalSourceReloadResult,
  type VarinExtensionPackageSource,
  type VarinExtensionPackageInstallRequest,
  type VarinExtensionRemoveRequest,
  type VarinExtensionServiceProvision,
  type VarinExtensionServiceCatalogSnapshot,
  type VarinExtensionServiceInvocationRequest,
  type VarinExtensionServiceProviderSnapshot,
  type VarinExtensionServiceSelectionRequest,
  type VarinExtensionServiceRequirement,
  type VarinExtensionStaticContribution,
  type VarinExtensionStorageAddress,
  type VarinExtensionStorageDocument,
  type VarinExtensionStorageOpenRequest,
  type VarinExtensionStorageSnapshot,
  type VarinExtensionSurfaceEntrypoint,
} from "./types.js";
import {
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  parseVarinWorkbenchProfileSnapshot,
  parseVarinWorkbenchShellContributionData,
  VarinWorkbenchShellContractError,
} from "./workbench.js";
import {
  parseVarinTransitionSceneContributionData,
  VarinTransitionSceneContractError,
} from "./motion.js";
import {
  parseVarinExtensionServiceRoutingContext,
  parseVarinExtensionServiceRoutingSnapshot,
} from "./service-routing.js";
import {
  isVarinContributionCompatible,
} from "./compatibility.js";
import {
  parseVarinContextExpression,
  VarinContextExpressionError,
} from "./context-expression.js";
import semver from "semver";
import { parseVarinExtensionToolDeclaration } from "./tools.js";

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ENTRY_PATH_PATTERN = /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).+$/;
const INTEGRITY_PATTERN = /^sha256-[0-9a-f]{64}$/;

const HOST_MODES = new Set(["brokered", "native"]);
const SURFACE_MODES = new Set(["declarative", "isolated", "managed", "native"]);
const SURFACES = new Set<VarinApplicationSurface>(["desktop", "mobile", "web"]);
const ACTIVATION_EVENTS = new Set<VarinExtensionActivationEvent>([
  "application-startup",
  "background",
  "command",
  "contribution-visible",
  "service-request",
  "workspace-match",
]);
const CONTRIBUTION_KINDS = new Set<VarinExtensionContributionKind>([
  "command",
  "composer-action",
  "editor",
  "keybinding",
  "menu-item",
  "message-renderer",
  "page",
  "panel",
  "session-decoration",
  "settings-page",
  "shell",
  "sidebar",
  "status-item",
  "transition-scene",
  "tool-renderer",
  "view",
]);
const SOURCE_KINDS = new Set(["builtin", "git", "local", "npm"]);
const ACTUAL_STATUSES = new Set<VarinExtensionActualStatus>([
  "active",
  "activating",
  "deactivating",
  "failed",
  "inactive",
  "loading",
  "resolving",
  "restart-required",
  "rolling-back",
  "updating",
  "waiting",
]);
const STORAGE_STATES = new Set(["missing", "ready", "stale"]);

export class VarinExtensionContractError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "VarinExtensionContractError";
    this.issues = issues;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function timestamp(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    issues.push(`${path} must be an ISO timestamp`);
    return new Date(0).toISOString();
  }
  return normalized;
}

function positiveRevision(value: unknown, path: string, issues: string[], allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
    issues.push(`${path} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
    return allowZero ? 0 : 1;
  }
  return Number(value);
}

function identifier(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !ID_PATTERN.test(normalized)) {
    issues.push(`${path} must be a lowercase namespaced identifier`);
    return "invalid";
  }
  return normalized;
}

function integrity(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !INTEGRITY_PATTERN.test(normalized)) {
    issues.push(`${path} must be a lowercase sha256 integrity value`);
    return `sha256-${"0".repeat(64)}`;
  }
  return normalized;
}

function entryPath(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !ENTRY_PATH_PATTERN.test(normalized)) {
    issues.push(`${path} must be a forward-slash relative path without parent traversal`);
    return "invalid";
  }
  return normalized;
}

function uniqueStrings(value: unknown, path: string, issues: string[], id = false): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = id ? identifier(value[index], `${path}[${index}]`, issues) : text(value[index]);
    if (!item) {
      if (!id) issues.push(`${path}[${index}] must be a non-empty string`);
      continue;
    }
    if (seen.has(item)) {
      issues.push(`${path} contains duplicate value ${item}`);
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function jsonValue(value: unknown, path: string, issues: string[]): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`, issues));
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item, `${path}.${key}`, issues);
    return result;
  }
  issues.push(`${path} must contain only JSON values`);
  return null;
}

function activation(value: unknown, path: string, issues: string[]): VarinExtensionActivationEvent[] | undefined {
  if (value === undefined) return undefined;
  const values = uniqueStrings(value, path, issues);
  const result: VarinExtensionActivationEvent[] = [];
  for (const item of values) {
    if (!ACTIVATION_EVENTS.has(item as VarinExtensionActivationEvent)) issues.push(`${path} contains unsupported event ${item}`);
    else result.push(item as VarinExtensionActivationEvent);
  }
  return result;
}

function entryFile(value: unknown, path: string, issues: string[], required: boolean): string | undefined {
  const normalized = text(value);
  if (!normalized) {
    if (required) issues.push(`${path} is required`);
    return undefined;
  }
  if (!ENTRY_PATH_PATTERN.test(normalized)) issues.push(`${path} must be a relative forward-slash path without parent traversal`);
  return normalized;
}

function parseHostEntrypoint(value: unknown, path: string, issues: string[]): VarinExtensionHostEntrypoint | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const mode = text(value.mode);
  if (!mode || !HOST_MODES.has(mode)) issues.push(`${path}.mode must be brokered or native`);
  const file = entryFile(value.file, `${path}.file`, issues, true) ?? "invalid";
  const activationEvents = activation(value.activation, `${path}.activation`, issues);
  return {
    file,
    mode: mode === "native" ? "native" : "brokered",
    ...(activationEvents ? { activation: activationEvents } : {}),
  };
}

function parseSurfaceEntrypoints(value: unknown, path: string, issues: string[]): VarinExtensionSurfaceEntrypoint[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  const result: VarinExtensionSurfaceEntrypoint[] = [];
  const ids = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const id = identifier(raw.id, `${itemPath}.id`, issues);
    if (ids.has(id)) issues.push(`${path} contains duplicate entrypoint ${id}`);
    ids.add(id);
    const mode = text(raw.mode);
    if (!mode || !SURFACE_MODES.has(mode)) issues.push(`${itemPath}.mode is unsupported`);
    const file = entryFile(raw.file, `${itemPath}.file`, issues, mode !== "declarative");
    const rawSupports = uniqueStrings(raw.supports, `${itemPath}.supports`, issues);
    const supports: VarinApplicationSurface[] = [];
    for (const surface of rawSupports) {
      if (!SURFACES.has(surface as VarinApplicationSurface)) issues.push(`${itemPath}.supports contains unsupported surface ${surface}`);
      else supports.push(surface as VarinApplicationSurface);
    }
    if (supports.length === 0) issues.push(`${itemPath}.supports must contain at least one surface`);
    const activationEvents = activation(raw.activation, `${itemPath}.activation`, issues);
    const isolation = text(raw.isolation);
    if (isolation !== undefined && mode !== "isolated") issues.push(`${itemPath}.isolation is only valid for isolated entrypoints`);
    if (mode === "isolated" && isolation !== undefined && isolation !== "iframe" && isolation !== "worker") {
      issues.push(`${itemPath}.isolation must be iframe or worker`);
    }
    result.push({
      id,
      mode: SURFACE_MODES.has(mode ?? "") ? mode as VarinExtensionSurfaceEntrypoint["mode"] : "managed",
      supports,
      ...(mode === "isolated" ? { isolation: isolation === "worker" ? "worker" : "iframe" } : {}),
      ...(file ? { file } : {}),
      ...(activationEvents ? { activation: activationEvents } : {}),
    });
  });
  return result;
}

function parseServices<T extends VarinExtensionServiceRequirement | VarinExtensionServiceProvision>(
  value: unknown,
  path: string,
  issues: string[],
  kind: "provide" | "require",
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  const result: T[] = [];
  const keys = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const id = identifier(raw.id, `${itemPath}.id`, issues);
    const version = positiveRevision(raw.version, `${itemPath}.version`, issues);
    const key = `${id}@${version}`;
    if (keys.has(key)) issues.push(`${path} contains duplicate service ${key}`);
    keys.add(key);
    const flagKey = kind === "provide" ? "multiple" : "optional";
    const flag = raw[flagKey];
    if (flag !== undefined && typeof flag !== "boolean") issues.push(`${itemPath}.${flagKey} must be boolean`);
    const binding = kind === "require" && (raw.binding === "all" || raw.binding === "selected" || raw.binding === "single")
      ? raw.binding
      : undefined;
    if (kind === "require" && raw.binding !== undefined && !binding) issues.push(`${itemPath}.binding must be all, selected, or single`);
    let tool: VarinExtensionServiceProvision["tool"];
    if (kind === "provide" && raw.tool !== undefined) {
      try { tool = parseVarinExtensionToolDeclaration(raw.tool); }
      catch (error) { issues.push(`${itemPath}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    result.push({
      id,
      version,
      ...(tool ? { tool } : {}),
      ...(typeof flag === "boolean" ? { [flagKey]: flag } : {}),
      ...(binding ? { binding } : {}),
    } as T);
  });
  return result;
}

/** Parse the same declaration used by manifest discovery, activation, inspection and execution. */
export function parseVarinExtensionServiceProvision(value: unknown): VarinExtensionServiceProvision {
  const issues: string[] = [];
  const descriptor = parseServices<VarinExtensionServiceProvision>([value], "service", issues, "provide")?.[0];
  if (issues.length > 0 || !descriptor) throw new VarinExtensionContractError("Invalid service provision", issues);
  return descriptor;
}

function parseContributions(value: unknown, path: string, issues: string[]): VarinExtensionStaticContribution[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  const result: VarinExtensionStaticContribution[] = [];
  const ids = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const id = identifier(raw.id, `${itemPath}.id`, issues);
    if (ids.has(id)) issues.push(`${path} contains duplicate contribution ${id}`);
    ids.add(id);
    const kind = text(raw.kind);
    if (!kind || !CONTRIBUTION_KINDS.has(kind as VarinExtensionContributionKind)) issues.push(`${itemPath}.kind is unsupported`);
    const data = isRecord(raw.data) ? jsonValue(raw.data, `${itemPath}.data`, issues) as JsonObject : {};
    if (!isRecord(raw.data)) issues.push(`${itemPath}.data must be an object`);
    const contractVersion = positiveRevision(raw.contractVersion, `${itemPath}.contractVersion`, issues);
    const rawSupports = uniqueStrings(raw.supports, `${itemPath}.supports`, issues);
    const supports: VarinApplicationSurface[] = [];
    for (const surface of rawSupports) {
      if (!SURFACES.has(surface as VarinApplicationSurface)) issues.push(`${itemPath}.supports contains unsupported surface ${surface}`);
      else supports.push(surface as VarinApplicationSurface);
    }
    if (supports.length === 0) issues.push(`${itemPath}.supports must contain at least one surface`);
    // Only validate kind-specific data for contributions whose contract
    // version is compatible with the current runtime. Unsupported versions
    // are still parsed (structure, id, kind, supports) so the catalog can
    // retain the record, but their data payload is not validated.
    const kindKnown = kind !== undefined && CONTRIBUTION_KINDS.has(kind as VarinExtensionContributionKind);
    const versionCompatible = kindKnown
      && isVarinContributionCompatible(kind as VarinExtensionContributionKind, contractVersion);
    if (versionCompatible && kind === "editor") {
      const languageIds = data.languageIds === undefined
        ? []
        : uniqueStrings(data.languageIds, `${itemPath}.data.languageIds`, issues);
      const filenames = data.filenames === undefined
        ? []
        : uniqueStrings(data.filenames, `${itemPath}.data.filenames`, issues);
      if (languageIds.length === 0 && filenames.length === 0) {
        issues.push(`${itemPath}.data must declare languageIds or filenames`);
      }
      if (data.priority !== undefined && (typeof data.priority !== "number" || !Number.isFinite(data.priority))) {
        issues.push(`${itemPath}.data.priority must be finite`);
      }
    }
    if (versionCompatible && kind === "transition-scene") {
      try {
        parseVarinTransitionSceneContributionData(data);
      } catch (error) {
        if (error instanceof VarinTransitionSceneContractError) {
          issues.push(...error.issues.map((issue) => `${itemPath}.${issue}`));
        } else {
          throw error;
        }
      }
    }
    if (versionCompatible && kind === "shell") {
      try {
        parseVarinWorkbenchShellContributionData(raw.data, supports);
      } catch (error) {
        if (error instanceof VarinWorkbenchShellContractError) {
          issues.push(...error.issues.map((issue) => `${itemPath}.${issue}`));
        } else {
          throw error;
        }
      }
    }
    const entrypoint = raw.entrypoint === undefined ? undefined : identifier(raw.entrypoint, `${itemPath}.entrypoint`, issues);
    const requiresCapabilities = uniqueStrings(raw.requiresCapabilities, `${itemPath}.requiresCapabilities`, issues, true);
    let placement: VarinExtensionStaticContribution["placement"];
    if (raw.placement !== undefined) {
      if (!isRecord(raw.placement)) {
        issues.push(`${itemPath}.placement must be an object`);
      } else {
        const order = raw.placement.order;
        if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) issues.push(`${itemPath}.placement.order must be finite`);
        const slot = raw.placement.slot === undefined ? undefined : identifier(raw.placement.slot, `${itemPath}.placement.slot`, issues);
        placement = {
          ...(slot ? { slot } : {}),
          ...(typeof order === "number" && Number.isFinite(order) ? { order } : {}),
          ...(raw.placement.before !== undefined ? { before: uniqueStrings(raw.placement.before, `${itemPath}.placement.before`, issues, true) } : {}),
          ...(raw.placement.after !== undefined ? { after: uniqueStrings(raw.placement.after, `${itemPath}.placement.after`, issues, true) } : {}),
        };
      }
    }
    let replacement: VarinExtensionStaticContribution["replacement"];
    if (raw.replacement !== undefined) {
      if (!isRecord(raw.replacement)) {
        issues.push(`${itemPath}.replacement must be an object`);
      } else {
        const target = identifier(raw.replacement.target, `${itemPath}.replacement.target`, issues);
        const priority = raw.replacement.priority;
        if (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority))) issues.push(`${itemPath}.replacement.priority must be finite`);
        replacement = {
          target,
          ...(typeof priority === "number" && Number.isFinite(priority) ? { priority } : {}),
        };
      }
    }
    if (versionCompatible && kind === "transition-scene" && replacement?.target !== VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition) {
      issues.push(`${itemPath}.replacement.target must be ${VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition}`);
    }
    result.push({
      id,
      kind: CONTRIBUTION_KINDS.has(kind as VarinExtensionContributionKind) ? kind as VarinExtensionContributionKind : "page",
      contractVersion,
      data,
      supports,
      ...(entrypoint ? { entrypoint } : {}),
      ...(requiresCapabilities.length > 0 ? { requiresCapabilities } : {}),
      ...(placement ? { placement } : {}),
      ...(replacement ? { replacement } : {}),
      ...(text(raw.title) ? { title: text(raw.title) as string } : {}),
      ...(raw.when !== undefined ? (() => {
        // Shell and transition-scene cannot use `when` — context changes
        // would bypass Profile stage-and-commit and Recovery invariants.
        if (versionCompatible && (kind === "shell" || kind === "transition-scene")) {
          issues.push(`${itemPath}.when is not allowed for shell or transition-scene contributions`);
          return {};
        }
        try {
          const parsed = parseVarinContextExpression(raw.when);
          return { when: parsed };
        } catch (error) {
          if (error instanceof VarinContextExpressionError) {
            issues.push(...error.issues.map((issue) => `${itemPath}.${issue}`));
            return {};
          }
          throw error;
        }
      })() : {}),
    });
  });
  return result;
}

function throwIssues(label: string, issues: string[]): void {
  if (issues.length > 0) throw new VarinExtensionContractError(`${label} is invalid`, issues);
}

function hostId(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value);
  if (!normalized || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    issues.push(`${path} must be a UUID`);
    return "00000000-0000-4000-8000-000000000000";
  }
  return normalized;
}

export function parseVarinExtensionManifest(value: unknown): VarinExtensionManifest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension manifest is invalid", ["manifest must be an object"]);
  if (value.schemaVersion !== VARIN_EXTENSION_MANIFEST_SCHEMA_VERSION) issues.push("schemaVersion must be 1");
  const id = identifier(value.id, "id", issues);
  const version = text(value.version) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(version)) issues.push("version must be a SemVer version");
  const rawEngines = isRecord(value.engines) ? value.engines : {};
  if (!isRecord(value.engines)) issues.push("engines must be an object");
  const varinEngine = text(rawEngines.varin) ?? "*";
  if (!text(rawEngines.varin)) issues.push("engines.varin must be a non-empty compatibility range");
  else if (semver.validRange(varinEngine) === null) issues.push("engines.varin must be a valid SemVer range");

  const rawEntrypoints = value.entrypoints;
  if (rawEntrypoints !== undefined && !isRecord(rawEntrypoints)) issues.push("entrypoints must be an object");
  const entrypointsRecord = isRecord(rawEntrypoints) ? rawEntrypoints : {};
  const host = parseHostEntrypoint(entrypointsRecord.host, "entrypoints.host", issues);
  const surfaces = parseSurfaceEntrypoints(entrypointsRecord.surfaces, "entrypoints.surfaces", issues);

  const rawRequires = isRecord(value.requires) ? value.requires : {};
  if (value.requires !== undefined && !isRecord(value.requires)) issues.push("requires must be an object");
  const requiredServices = parseServices<VarinExtensionServiceRequirement>(rawRequires.services, "requires.services", issues, "require");
  const rawProvides = isRecord(value.provides) ? value.provides : {};
  if (value.provides !== undefined && !isRecord(value.provides)) issues.push("provides must be an object");
  const providedServices = parseServices<VarinExtensionServiceProvision>(rawProvides.services, "provides.services", issues, "provide");

  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : {};
  if (value.capabilities !== undefined && !isRecord(value.capabilities)) issues.push("capabilities must be an object");
  const hostCapabilities = uniqueStrings(rawCapabilities.host, "capabilities.host", issues, true);
  const surfaceCapabilities = uniqueStrings(rawCapabilities.surface, "capabilities.surface", issues, true);
  const rawIntegrates = isRecord(value.integrates) ? value.integrates : {};
  if (value.integrates !== undefined && !isRecord(value.integrates)) issues.push("integrates must be an object");
  const piPackages = uniqueStrings(rawIntegrates.piPackages, "integrates.piPackages", issues);
  const contributions = parseContributions(value.contributions, "contributions", issues);
  const rawMetadata = isRecord(value.metadata) ? value.metadata : {};
  if (value.metadata !== undefined && !isRecord(value.metadata)) issues.push("metadata must be an object");
  const metadataDescription = text(rawMetadata.description);
  const metadataHomepage = text(rawMetadata.homepage);
  const metadataIcon = rawMetadata.icon === undefined ? undefined : entryPath(rawMetadata.icon, "metadata.icon", issues);
  const metadataKeywords = uniqueStrings(rawMetadata.keywords, "metadata.keywords", issues);
  const metadataRepository = text(rawMetadata.repository);
  if (rawMetadata.description !== undefined && !metadataDescription) issues.push("metadata.description must be a non-empty string");
  if (rawMetadata.homepage !== undefined && !metadataHomepage) issues.push("metadata.homepage must be a non-empty string");
  if (rawMetadata.repository !== undefined && !metadataRepository) issues.push("metadata.repository must be a non-empty string");
  let storageSchemaVersion: number | undefined;
  if (value.storage !== undefined) {
    if (!isRecord(value.storage)) issues.push("storage must be an object");
    else storageSchemaVersion = positiveRevision(value.storage.schemaVersion, "storage.schemaVersion", issues);
  }
  const surfaceById = new Map((surfaces ?? []).map((surface) => [surface.id, surface]));
  for (const contribution of contributions ?? []) {
    if (!contribution.id.startsWith(`${id}.`)) issues.push(`contribution ${contribution.id} must be qualified by extension ID ${id}`);
    if (contribution.entrypoint) {
      const surface = surfaceById.get(contribution.entrypoint);
      if (!surface) issues.push(`contribution ${contribution.id} references unknown surface entrypoint ${contribution.entrypoint}`);
      else {
        for (const supported of contribution.supports) {
          if (!surface.supports.includes(supported)) issues.push(`contribution ${contribution.id} supports ${supported} but entrypoint ${surface.id} does not`);
        }
      }
    }
    for (const capability of contribution.requiresCapabilities ?? []) {
      if (!surfaceCapabilities.includes(capability)) issues.push(`contribution ${contribution.id} requires undeclared surface capability ${capability}`);
    }
  }
  throwIssues("Varin extension manifest", issues);

  return {
    schemaVersion: VARIN_EXTENSION_MANIFEST_SCHEMA_VERSION,
    id,
    version,
    engines: { varin: varinEngine },
    ...(text(value.displayName) ? { displayName: text(value.displayName) as string } : {}),
    ...(host || surfaces ? { entrypoints: { ...(host ? { host } : {}), ...(surfaces ? { surfaces } : {}) } } : {}),
    ...(requiredServices ? { requires: { services: requiredServices } } : {}),
    ...(providedServices ? { provides: { services: providedServices } } : {}),
    ...(hostCapabilities.length > 0 || surfaceCapabilities.length > 0 ? {
      capabilities: {
        ...(hostCapabilities.length > 0 ? { host: hostCapabilities } : {}),
        ...(surfaceCapabilities.length > 0 ? { surface: surfaceCapabilities } : {}),
      },
    } : {}),
    ...(piPackages.length > 0 ? { integrates: { piPackages } } : {}),
    ...(metadataDescription || metadataHomepage || metadataIcon || metadataKeywords.length > 0 || metadataRepository ? {
      metadata: {
        ...(metadataDescription ? { description: metadataDescription } : {}),
        ...(metadataHomepage ? { homepage: metadataHomepage } : {}),
        ...(metadataIcon ? { icon: metadataIcon } : {}),
        ...(metadataKeywords.length > 0 ? { keywords: metadataKeywords } : {}),
        ...(metadataRepository ? { repository: metadataRepository } : {}),
      },
    } : {}),
    ...(contributions ? { contributions } : {}),
    ...(storageSchemaVersion !== undefined ? { storage: { schemaVersion: storageSchemaVersion } } : {}),
  };
}

export function assertVarinApplicationVersion(varinVersion: string): void {
  if (semver.valid(varinVersion) === null) {
    const issue = `varinVersion must be a SemVer version; received ${JSON.stringify(varinVersion)}`;
    throw new VarinExtensionContractError(`Varin application version is invalid: ${issue}`, [issue]);
  }
}

export function assertVarinExtensionManifestCompatibility(
  manifest: VarinExtensionManifest,
  varinVersion: string,
): void {
  assertVarinApplicationVersion(varinVersion);
  if (!semver.satisfies(varinVersion, manifest.engines.varin)) {
    const issue = `extension ${manifest.id}@${manifest.version} requires Varin ${manifest.engines.varin}; current version is ${varinVersion}`;
    throw new VarinExtensionContractError(`Varin extension manifest is incompatible: ${issue}`, [issue]);
  }
}

function parseSource(value: unknown, path: string, issues: string[]): VarinExtensionPackageSource {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return { display: "Invalid source", kind: "local", specifier: "invalid" };
  }
  const kind = text(value.kind);
  if (!kind || !SOURCE_KINDS.has(kind)) issues.push(`${path}.kind is unsupported`);
  const display = text(value.display);
  const specifier = text(value.specifier);
  if (!display) issues.push(`${path}.display must be a non-empty string`);
  if (!specifier) issues.push(`${path}.specifier must be a non-empty string`);
  return {
    kind: SOURCE_KINDS.has(kind ?? "") ? kind as VarinExtensionPackageSource["kind"] : "local",
    display: display ?? "Invalid source",
    specifier: specifier ?? "invalid",
  };
}

function parseDesired(value: unknown, path: string, issues: string[]): VarinExtensionDesiredState {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return { enabled: false, revision: 1, updatedAt: new Date(0).toISOString() };
  }
  if (typeof value.enabled !== "boolean") issues.push(`${path}.enabled must be boolean`);
  return {
    enabled: value.enabled === true,
    revision: positiveRevision(value.revision, `${path}.revision`, issues),
    updatedAt: timestamp(value.updatedAt, `${path}.updatedAt`, issues),
  };
}

function parseGrants(value: unknown, path: string, issues: string[]): VarinExtensionCapabilityGrant[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const seen = new Set<string>();
  const result: VarinExtensionCapabilityGrant[] = [];
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const capability = identifier(raw.capability, `${itemPath}.capability`, issues);
    const realm = raw.realm === "host" || raw.realm === "surface" ? raw.realm : undefined;
    if (!realm) issues.push(`${itemPath}.realm must be host or surface`);
    const grantKey = `${realm ?? "invalid"}:${capability}`;
    if (seen.has(grantKey)) issues.push(`${path} contains duplicate capability ${grantKey}`);
    seen.add(grantKey);
    if (typeof raw.granted !== "boolean") issues.push(`${itemPath}.granted must be boolean`);
    const manifestVersion = text(raw.manifestVersion) ?? "0.0.0";
    if (!SEMVER_PATTERN.test(manifestVersion)) issues.push(`${itemPath}.manifestVersion must be SemVer`);
    result.push({
      capability,
      granted: raw.granted === true,
      manifestVersion,
      realm: realm ?? "surface",
      updatedAt: timestamp(raw.updatedAt, `${itemPath}.updatedAt`, issues),
    });
  });
  return result;
}

const capabilityKey = (reference: VarinExtensionCapabilityReference): string => `${reference.realm}:${reference.capability}`;

function parseCapabilityReferences(value: unknown, path: string, issues: string[]): VarinExtensionCapabilityReference[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return [];
    }
    const capability = identifier(raw.capability, `${itemPath}.capability`, issues);
    const realm = raw.realm === "host" || raw.realm === "surface" ? raw.realm : undefined;
    if (!realm) issues.push(`${itemPath}.realm must be host or surface`);
    const reference = { capability, realm: realm ?? "surface" } as const;
    const key = capabilityKey(reference);
    if (seen.has(key)) issues.push(`${path} contains duplicate capability ${key}`);
    seen.add(key);
    return [reference];
  });
}

function parseCapabilityDelta(value: unknown, path: string, issues: string[]): VarinExtensionCapabilityDelta {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return { added: [], removed: [] };
  }
  return {
    added: parseCapabilityReferences(value.added, `${path}.added`, issues),
    removed: parseCapabilityReferences(value.removed, `${path}.removed`, issues),
  };
}

function manifestCapabilityReferences(manifest: VarinExtensionManifest): VarinExtensionCapabilityReference[] {
  return (["host", "surface"] as const).flatMap((realm) => (
    (manifest.capabilities?.[realm] ?? []).map((capability) => ({ capability, realm }))
  ));
}

function validateCandidateCapabilityReview(
  selectedManifest: VarinExtensionManifest,
  candidateManifest: VarinExtensionManifest,
  delta: VarinExtensionCapabilityDelta,
  grants: VarinExtensionCapabilityGrant[],
  reviewed: boolean,
  path: string,
  issues: string[],
): void {
  const selected = new Set(manifestCapabilityReferences(selectedManifest).map(capabilityKey));
  const candidate = new Set(manifestCapabilityReferences(candidateManifest).map(capabilityKey));
  const expectedAdded = [...candidate].filter((key) => !selected.has(key)).sort();
  const expectedRemoved = [...selected].filter((key) => !candidate.has(key)).sort();
  const actualAdded = delta.added.map(capabilityKey).sort();
  const actualRemoved = delta.removed.map(capabilityKey).sort();
  if (JSON.stringify(actualAdded) !== JSON.stringify(expectedAdded)) issues.push(`${path}.capabilityDelta.added does not match the manifest capability change`);
  if (JSON.stringify(actualRemoved) !== JSON.stringify(expectedRemoved)) issues.push(`${path}.capabilityDelta.removed does not match the manifest capability change`);
  for (const grant of grants) {
    if (grant.manifestVersion !== candidateManifest.version) issues.push(`${path}.capabilityGrants must target the candidate manifest version`);
    if (!candidate.has(capabilityKey(grant))) issues.push(`${path}.capabilityGrants contains a capability not requested by the candidate manifest`);
  }
  const decisions = new Set(grants.map(capabilityKey));
  const completelyReviewed = expectedAdded.every((key) => decisions.has(key));
  if (reviewed !== completelyReviewed) issues.push(`${path}.capabilitiesReviewed does not match added-capability decisions`);
}

function parseCandidateRecord(value: unknown, path: string, issues: string[]): VarinExtensionCandidateRecord | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  let manifest: VarinExtensionManifest;
  try {
    manifest = parseVarinExtensionManifest(value.manifest);
  } catch (error) {
    if (error instanceof VarinExtensionContractError) issues.push(...error.issues.map((issue) => `${path}.manifest.${issue}`));
    manifest = { schemaVersion: 1, id: "invalid", version: "0.0.0", engines: { varin: "*" } };
  }
  const resolvedVersion = text(value.resolvedVersion) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(resolvedVersion)) issues.push(`${path}.resolvedVersion must be SemVer`);
  if (resolvedVersion !== manifest.version) issues.push(`${path}.resolvedVersion must match manifest.version`);
  const resolvedPath = text(value.resolvedPath);
  if (!resolvedPath) issues.push(`${path}.resolvedPath must be a non-empty string`);
  if (typeof value.capabilitiesReviewed !== "boolean") issues.push(`${path}.capabilitiesReviewed must be boolean`);
  if (typeof value.applyRequested !== "boolean") issues.push(`${path}.applyRequested must be boolean`);
  if (value.applyRequested === true && value.capabilitiesReviewed !== true) {
    issues.push(`${path}.applyRequested requires completed capability review`);
  }
  return {
    applyRequested: value.applyRequested === true,
    capabilitiesReviewed: value.capabilitiesReviewed === true,
    capabilityDelta: parseCapabilityDelta(value.capabilityDelta, `${path}.capabilityDelta`, issues),
    capabilityGrants: parseGrants(value.capabilityGrants, `${path}.capabilityGrants`, issues),
    integrity: integrity(value.integrity, `${path}.integrity`, issues),
    manifest,
    preparedAt: timestamp(value.preparedAt, `${path}.preparedAt`, issues),
    resolvedPath: resolvedPath ?? "invalid",
    resolvedVersion,
    source: parseSource(value.source, `${path}.source`, issues),
  };
}

export function parseVarinExtensionInstallationRecord(value: unknown, path = "installation"): VarinExtensionInstallationRecord {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension installation is invalid", [`${path} must be an object`]);
  let manifest: VarinExtensionManifest;
  try {
    manifest = parseVarinExtensionManifest(value.manifest);
  } catch (error) {
    if (error instanceof VarinExtensionContractError) issues.push(...error.issues.map((issue) => `${path}.manifest.${issue}`));
    manifest = { schemaVersion: 1, id: "invalid", version: "0.0.0", engines: { varin: "*" } };
  }
  const source = parseSource(value.source, `${path}.source`, issues);
  const desired = parseDesired(value.desired, `${path}.desired`, issues);
  const capabilityGrants = parseGrants(value.capabilityGrants, `${path}.capabilityGrants`, issues);
  const installedAt = timestamp(value.installedAt, `${path}.installedAt`, issues);
  const updatedAt = timestamp(value.updatedAt, `${path}.updatedAt`, issues);
  const resolvedVersion = text(value.resolvedVersion) ?? "0.0.0";
  const selectedVersion = text(value.selectedVersion) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(resolvedVersion)) issues.push(`${path}.resolvedVersion must be SemVer`);
  if (!SEMVER_PATTERN.test(selectedVersion)) issues.push(`${path}.selectedVersion must be SemVer`);
  if (resolvedVersion !== manifest.version) issues.push(`${path}.resolvedVersion must match manifest.version`);
  if (selectedVersion !== resolvedVersion) issues.push(`${path}.selectedVersion must match resolvedVersion until candidate updates are supported`);
  const selectedIntegrity = value.integrity === undefined
    ? undefined
    : integrity(value.integrity, `${path}.integrity`, issues);
  const resolvedPath = text(value.resolvedPath);
  const candidate = value.candidate === undefined
    ? undefined
    : parseCandidateRecord(value.candidate, `${path}.candidate`, issues);
  if (candidate && candidate.manifest.id !== manifest.id) {
    issues.push(`${path}.candidate.manifest.id must match selected manifest.id`);
  }
  if (candidate) {
    validateCandidateCapabilityReview(
      manifest,
      candidate.manifest,
      candidate.capabilityDelta,
      candidate.capabilityGrants,
      candidate.capabilitiesReviewed,
      `${path}.candidate`,
      issues,
    );
  }
  throwIssues("Varin extension installation", issues);
  return {
    manifest,
    source,
    desired,
    capabilityGrants,
    installedAt,
    updatedAt,
    resolvedVersion,
    selectedVersion,
    ...(selectedIntegrity ? { integrity: selectedIntegrity } : {}),
    ...(resolvedPath ? { resolvedPath } : {}),
    ...(candidate ? { candidate } : {}),
  };
}

export function parseVarinExtensionCatalogDocument(value: unknown): VarinExtensionCatalogDocument {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension catalog is invalid", ["catalog must be an object"]);
  if (value.schemaVersion !== VARIN_EXTENSION_CATALOG_SCHEMA_VERSION) issues.push("schemaVersion must be 1");
  const revision = positiveRevision(value.revision, "revision", issues, true);
  const updatedAt = timestamp(value.updatedAt, "updatedAt", issues);
  const extensions: Record<string, VarinExtensionInstallationRecord> = {};
  if (!isRecord(value.extensions)) {
    issues.push("extensions must be an object");
  } else {
    for (const [key, raw] of Object.entries(value.extensions)) {
      const id = identifier(key, `extensions.${key}`, issues);
      try {
        const record = parseVarinExtensionInstallationRecord(raw, `extensions.${key}`);
        if (record.manifest.id !== id) issues.push(`extensions.${key}.manifest.id must match its catalog key`);
        extensions[id] = record;
      } catch (error) {
        if (error instanceof VarinExtensionContractError) issues.push(...error.issues);
        else throw error;
      }
    }
  }
  throwIssues("Varin extension catalog", issues);
  return { schemaVersion: VARIN_EXTENSION_CATALOG_SCHEMA_VERSION, revision, updatedAt, extensions };
}

export function parseVarinExtensionHostIdentityDocument(value: unknown): VarinExtensionHostIdentityDocument {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension host identity is invalid", ["identity must be an object"]);
  if (value.schemaVersion !== VARIN_EXTENSION_CATALOG_SCHEMA_VERSION) issues.push("schemaVersion must be 1");
  const parsedHostId = hostId(value.hostId, "hostId", issues);
  const createdAt = timestamp(value.createdAt, "createdAt", issues);
  throwIssues("Varin extension host identity", issues);
  return { schemaVersion: VARIN_EXTENSION_CATALOG_SCHEMA_VERSION, hostId: parsedHostId, createdAt };
}

function parseDiagnostic(value: unknown, path: string, issues: string[]): VarinExtensionDiagnostic | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const code = text(value.code);
  const message = text(value.message);
  const severity = value.severity === "error" || value.severity === "info" || value.severity === "warning"
    ? value.severity
    : undefined;
  if (!code) issues.push(`${path}.code must be a non-empty string`);
  if (!message) issues.push(`${path}.message must be a non-empty string`);
  if (!severity) issues.push(`${path}.severity must be error, info, or warning`);
  const extensionId = value.extensionId === undefined
    ? undefined
    : identifier(value.extensionId, `${path}.extensionId`, issues);
  const realmId = value.realmId === undefined ? undefined : text(value.realmId);
  if (value.realmId !== undefined && !realmId) issues.push(`${path}.realmId must be a non-empty string`);
  return {
    code: code ?? "invalid",
    message: message ?? "Invalid diagnostic",
    severity: severity ?? "error",
    timestamp: timestamp(value.timestamp, `${path}.timestamp`, issues),
    ...(extensionId ? { extensionId } : {}),
    ...(realmId ? { realmId } : {}),
  };
}

function parseDiagnostics(value: unknown, path: string, issues: string[]): VarinExtensionDiagnostic[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return value.flatMap((item, index) => {
    const parsed = parseDiagnostic(item, `${path}[${index}]`, issues);
    return parsed ? [parsed] : [];
  });
}

function parseActualStates(value: unknown, path: string, issues: string[]): VarinExtensionActualState[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const states: VarinExtensionActualState[] = [];
  const keys = new Set<string>();
  value.forEach((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    const realmKind = raw.realmKind === "host" || raw.realmKind === "surface" ? raw.realmKind : undefined;
    if (!realmKind) issues.push(`${itemPath}.realmKind must be host or surface`);
    const realmId = text(raw.realmId);
    if (!realmId) issues.push(`${itemPath}.realmId must be a non-empty string`);
    const entrypointId = identifier(raw.entrypointId, `${itemPath}.entrypointId`, issues);
    const status = text(raw.status);
    if (!status || !ACTUAL_STATUSES.has(status as VarinExtensionActualStatus)) issues.push(`${itemPath}.status is unsupported`);
    const key = `${realmKind ?? "invalid"}:${realmId ?? "invalid"}:${entrypointId}`;
    if (keys.has(key)) issues.push(`${path} contains duplicate actual state ${key}`);
    keys.add(key);
    states.push({
      hostId: hostId(raw.hostId, `${itemPath}.hostId`, issues),
      realmKind: realmKind ?? "surface",
      realmId: realmId ?? "invalid",
      entrypointId,
      status: ACTUAL_STATUSES.has(status as VarinExtensionActualStatus) ? status as VarinExtensionActualStatus : "failed",
      generation: positiveRevision(raw.generation, `${itemPath}.generation`, issues, true),
      desiredRevision: positiveRevision(raw.desiredRevision, `${itemPath}.desiredRevision`, issues),
      updatedAt: timestamp(raw.updatedAt, `${itemPath}.updatedAt`, issues),
      diagnostics: parseDiagnostics(raw.diagnostics, `${itemPath}.diagnostics`, issues),
    });
  });
  return states;
}

function parsePublicCatalogEntry(value: unknown, path: string, issues: string[]): VarinExtensionCatalogEntry | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  let manifest: VarinExtensionManifest;
  try {
    manifest = parseVarinExtensionManifest(value.manifest);
  } catch (error) {
    if (error instanceof VarinExtensionContractError) issues.push(...error.issues.map((issue) => `${path}.manifest.${issue}`));
    manifest = { schemaVersion: 1, id: "invalid", version: "0.0.0", engines: { varin: "*" } };
  }
  const source = isRecord(value.source) ? value.source : {};
  if (!isRecord(value.source)) issues.push(`${path}.source must be an object`);
  const sourceKind = text(source.kind);
  if (!sourceKind || !SOURCE_KINDS.has(sourceKind)) issues.push(`${path}.source.kind is unsupported`);
  const sourceDisplay = text(source.display);
  if (!sourceDisplay) issues.push(`${path}.source.display must be a non-empty string`);
  const resolvedVersion = text(value.resolvedVersion) ?? "0.0.0";
  const selectedVersion = text(value.selectedVersion) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(resolvedVersion)) issues.push(`${path}.resolvedVersion must be SemVer`);
  if (!SEMVER_PATTERN.test(selectedVersion)) issues.push(`${path}.selectedVersion must be SemVer`);
  if (resolvedVersion !== manifest.version) issues.push(`${path}.resolvedVersion must match manifest.version`);
  if (selectedVersion !== resolvedVersion) issues.push(`${path}.selectedVersion must match resolvedVersion`);
  const selectedIntegrity = value.integrity === undefined
    ? undefined
    : integrity(value.integrity, `${path}.integrity`, issues);
  let candidate: VarinExtensionCatalogEntry["candidate"];
  if (value.candidate !== undefined) {
    if (!isRecord(value.candidate)) {
      issues.push(`${path}.candidate must be an object`);
    } else {
      let candidateManifest: VarinExtensionManifest;
      try {
        candidateManifest = parseVarinExtensionManifest(value.candidate.manifest);
      } catch (error) {
        if (error instanceof VarinExtensionContractError) {
          issues.push(...error.issues.map((issue) => `${path}.candidate.manifest.${issue}`));
        }
        candidateManifest = { schemaVersion: 1, id: "invalid", version: "0.0.0", engines: { varin: "*" } };
      }
      const candidateSource = isRecord(value.candidate.source) ? value.candidate.source : {};
      if (!isRecord(value.candidate.source)) issues.push(`${path}.candidate.source must be an object`);
      const candidateKind = text(candidateSource.kind);
      const candidateDisplay = text(candidateSource.display);
      if (!candidateKind || !SOURCE_KINDS.has(candidateKind)) issues.push(`${path}.candidate.source.kind is unsupported`);
      if (!candidateDisplay) issues.push(`${path}.candidate.source.display must be a non-empty string`);
      const candidateVersion = text(value.candidate.resolvedVersion) ?? "0.0.0";
      if (!SEMVER_PATTERN.test(candidateVersion)) issues.push(`${path}.candidate.resolvedVersion must be SemVer`);
      if (candidateVersion !== candidateManifest.version) issues.push(`${path}.candidate.resolvedVersion must match candidate manifest.version`);
      if (candidateManifest.id !== manifest.id) issues.push(`${path}.candidate.manifest.id must match selected manifest.id`);
      if (typeof value.candidate.capabilitiesReviewed !== "boolean") {
        issues.push(`${path}.candidate.capabilitiesReviewed must be boolean`);
      }
      if (typeof value.candidate.applyRequested !== "boolean") {
        issues.push(`${path}.candidate.applyRequested must be boolean`);
      }
      if (value.candidate.applyRequested === true && value.candidate.capabilitiesReviewed !== true) {
        issues.push(`${path}.candidate.applyRequested requires completed capability review`);
      }
      const candidateDelta = parseCapabilityDelta(
        value.candidate.capabilityDelta,
        `${path}.candidate.capabilityDelta`,
        issues,
      );
      const candidateGrants = parseGrants(
        value.candidate.capabilityGrants,
        `${path}.candidate.capabilityGrants`,
        issues,
      );
      validateCandidateCapabilityReview(
        manifest,
        candidateManifest,
        candidateDelta,
        candidateGrants,
        value.candidate.capabilitiesReviewed === true,
        `${path}.candidate`,
        issues,
      );
      candidate = {
        applyRequested: value.candidate.applyRequested === true,
        capabilitiesReviewed: value.candidate.capabilitiesReviewed === true,
        capabilityDelta: candidateDelta,
        capabilityGrants: candidateGrants,
        integrity: integrity(value.candidate.integrity, `${path}.candidate.integrity`, issues),
        manifest: candidateManifest,
        preparedAt: timestamp(value.candidate.preparedAt, `${path}.candidate.preparedAt`, issues),
        resolvedVersion: candidateVersion,
        source: {
          kind: SOURCE_KINDS.has(candidateKind ?? "")
            ? candidateKind as VarinExtensionCatalogEntry["source"]["kind"]
            : "local",
          display: candidateDisplay ?? "Invalid source",
        },
      };
    }
  }
  return {
    manifest,
    source: {
      kind: SOURCE_KINDS.has(sourceKind ?? "") ? sourceKind as VarinExtensionCatalogEntry["source"]["kind"] : "local",
      display: sourceDisplay ?? "Invalid source",
    },
    resolvedVersion,
    selectedVersion,
    desired: parseDesired(value.desired, `${path}.desired`, issues),
    actual: parseActualStates(value.actual, `${path}.actual`, issues),
    capabilityGrants: parseGrants(value.capabilityGrants, `${path}.capabilityGrants`, issues),
    installedAt: timestamp(value.installedAt, `${path}.installedAt`, issues),
    updatedAt: timestamp(value.updatedAt, `${path}.updatedAt`, issues),
    ...(selectedIntegrity ? { integrity: selectedIntegrity } : {}),
    ...(candidate ? { candidate } : {}),
  };
}

export function parseVarinExtensionCatalogSnapshot(value: unknown): VarinExtensionCatalogSnapshot {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension catalog snapshot is invalid", ["snapshot must be an object"]);
  if (value.schemaVersion !== VARIN_EXTENSION_CATALOG_SCHEMA_VERSION) issues.push("schemaVersion must be 1");
  const storageState = text(value.storageState);
  if (!storageState || !STORAGE_STATES.has(storageState)) issues.push("storageState is unsupported");
  if (typeof value.authoritative !== "boolean") issues.push("authoritative must be boolean");
  if (storageState === "stale" && value.authoritative !== false) issues.push("a stale snapshot cannot be authoritative");
  const extensions: VarinExtensionCatalogEntry[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(value.extensions)) {
    issues.push("extensions must be an array");
  } else {
    value.extensions.forEach((raw, index) => {
      const entry = parsePublicCatalogEntry(raw, `extensions[${index}]`, issues);
      if (!entry) return;
      if (ids.has(entry.manifest.id)) issues.push(`extensions contains duplicate extension ${entry.manifest.id}`);
      ids.add(entry.manifest.id);
      extensions.push(entry);
    });
  }
  const parsedHostId = hostId(value.hostId, "hostId", issues);
  const revision = positiveRevision(value.revision, "revision", issues, true);
  const loadedAt = timestamp(value.loadedAt, "loadedAt", issues);
  const diagnostics = parseDiagnostics(value.diagnostics, "diagnostics", issues);
  for (const entry of extensions) {
    for (const actual of entry.actual) {
      if (actual.hostId !== parsedHostId) issues.push(`actual state for ${entry.manifest.id} belongs to another host`);
      if (actual.desiredRevision !== entry.desired.revision) issues.push(`actual state for ${entry.manifest.id} has a stale desired revision`);
    }
  }
  throwIssues("Varin extension catalog snapshot", issues);
  return {
    schemaVersion: VARIN_EXTENSION_CATALOG_SCHEMA_VERSION,
    hostId: parsedHostId,
    revision,
    loadedAt,
    authoritative: value.authoritative === true,
    storageState: storageState as VarinExtensionCatalogSnapshot["storageState"],
    diagnostics,
    extensions,
  };
}

export function parseVarinExtensionCatalogAvailability(value: unknown): VarinExtensionCatalogAvailability {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension catalog response is invalid", ["response must be an object"]);
  if (value.supported === false) {
    const reason = text(value.reason);
    if (!reason) issues.push("reason must be a non-empty string");
    throwIssues("Varin extension catalog response", issues);
    return { supported: false, reason: reason as string };
  }
  if (value.supported !== true) issues.push("supported must be boolean");
  if (value.status === "ready") {
    let snapshot: VarinExtensionCatalogSnapshot | undefined;
    try {
      snapshot = parseVarinExtensionCatalogSnapshot(value.snapshot);
    } catch (error) {
      if (error instanceof VarinExtensionContractError) issues.push(...error.issues.map((issue) => `snapshot.${issue}`));
      else throw error;
    }
    throwIssues("Varin extension catalog response", issues);
    return { supported: true, status: "ready", snapshot: snapshot as VarinExtensionCatalogSnapshot };
  }
  if (value.status === "error") {
    if (!isRecord(value.error)) issues.push("error must be an object");
    const rawError = isRecord(value.error) ? value.error : {};
    const code = text(rawError.code);
    const message = text(rawError.message);
    if (!code) issues.push("error.code must be a non-empty string");
    if (!message) issues.push("error.message must be a non-empty string");
    if (typeof rawError.retryable !== "boolean") issues.push("error.retryable must be boolean");
    throwIssues("Varin extension catalog response", issues);
    return {
      supported: true,
      status: "error",
      error: { code: code as string, message: message as string, retryable: rawError.retryable === true },
    };
  }
  issues.push("status must be ready or error");
  throwIssues("Varin extension catalog response", issues);
  throw new Error("unreachable");
}

export function isVarinExtensionId(value: string): boolean {
  return ID_PATTERN.test(value);
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseArtifactSlot(value: unknown, path: string, issues: string[]): "candidate" | "selected" {
  if (value !== "candidate" && value !== "selected") {
    issues.push(`${path} must be candidate or selected`);
    return "selected";
  }
  return value;
}

export function parseVarinExtensionAssetRequest(value: unknown): VarinExtensionAssetRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension asset request is invalid", ["request must be an object"]);
  const result: VarinExtensionAssetRequest = {
    extensionId: identifier(value.extensionId, "extensionId", issues),
    integrity: integrity(value.integrity, "integrity", issues),
    path: entryPath(value.path, "path", issues),
    slot: parseArtifactSlot(value.slot, "slot", issues),
  };
  throwIssues("Varin extension asset request", issues);
  return result;
}

export function parseVarinExtensionManagedEntrypointRequest(value: unknown): VarinExtensionManagedEntrypointRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension entrypoint request is invalid", ["request must be an object"]);
  const result: VarinExtensionManagedEntrypointRequest = {
    entrypointId: identifier(value.entrypointId, "entrypointId", issues),
    extensionId: identifier(value.extensionId, "extensionId", issues),
    integrity: integrity(value.integrity, "integrity", issues),
    slot: parseArtifactSlot(value.slot, "slot", issues),
  };
  throwIssues("Varin extension entrypoint request", issues);
  return result;
}

function parseAssetPayload(value: unknown, path: string, issues: string[]): VarinExtensionAssetPayload {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return {
      artifactIntegrity: `sha256-${"0".repeat(64)}`,
      bytesBase64: "",
      contentType: "application/octet-stream",
      integrity: `sha256-${"0".repeat(64)}`,
      path: "invalid",
    };
  }
  const bytesBase64 = typeof value.bytesBase64 === "string" ? value.bytesBase64 : "";
  if (typeof value.bytesBase64 !== "string" || !BASE64_PATTERN.test(bytesBase64)) {
    issues.push(`${path}.bytesBase64 must be base64 data`);
  }
  const contentType = text(value.contentType);
  if (!contentType) issues.push(`${path}.contentType must be a non-empty string`);
  return {
    artifactIntegrity: integrity(value.artifactIntegrity, `${path}.artifactIntegrity`, issues),
    bytesBase64,
    contentType: contentType ?? "application/octet-stream",
    integrity: integrity(value.integrity, `${path}.integrity`, issues),
    path: entryPath(value.path, `${path}.path`, issues),
  };
}

export function parseVarinExtensionAssetPayload(value: unknown): VarinExtensionAssetPayload {
  const issues: string[] = [];
  const result = parseAssetPayload(value, "asset", issues);
  throwIssues("Varin extension asset payload", issues);
  return result;
}

export function parseVarinExtensionManagedEntrypointPayload(value: unknown): VarinExtensionManagedEntrypointPayload {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension entrypoint payload is invalid", ["payload must be an object"]);
  const styles = Array.isArray(value.styles)
    ? value.styles.map((style, index) => parseAssetPayload(style, `styles[${index}]`, issues))
    : (issues.push("styles must be an array"), []);
  const result: VarinExtensionManagedEntrypointPayload = {
    artifactIntegrity: integrity(value.artifactIntegrity, "artifactIntegrity", issues),
    entrypointId: identifier(value.entrypointId, "entrypointId", issues),
    module: parseAssetPayload(value.module, "module", issues),
    styles,
  };
  if (result.module.artifactIntegrity !== result.artifactIntegrity || styles.some((style) => style.artifactIntegrity !== result.artifactIntegrity)) {
    issues.push("entrypoint assets must belong to the declared artifact integrity");
  }
  throwIssues("Varin extension entrypoint payload", issues);
  return result;
}

export function parseVarinExtensionCandidateSelectionRequest(value: unknown): VarinExtensionCandidateSelectionRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension candidate selection request is invalid", ["request must be an object"]);
  const result: VarinExtensionCandidateSelectionRequest = {
    candidateIntegrity: integrity(value.candidateIntegrity, "candidateIntegrity", issues),
    expectedRevision: positiveRevision(value.expectedRevision, "expectedRevision", issues, true),
    extensionId: identifier(value.extensionId, "extensionId", issues),
  };
  throwIssues("Varin extension candidate selection request", issues);
  return result;
}

export function parseVarinExtensionCandidateCapabilityReviewRequest(
  value: unknown,
): VarinExtensionCandidateCapabilityReviewRequest {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new VarinExtensionContractError("Varin extension candidate capability review is invalid", ["request must be an object"]);
  }
  const decisions = parseCapabilityDecisions(value.decisions, "decisions", issues);
  const result: VarinExtensionCandidateCapabilityReviewRequest = {
    candidateIntegrity: integrity(value.candidateIntegrity, "candidateIntegrity", issues),
    decisions,
    expectedRevision: positiveRevision(value.expectedRevision, "expectedRevision", issues, true),
    extensionId: identifier(value.extensionId, "extensionId", issues),
  };
  throwIssues("Varin extension candidate capability review", issues);
  return result;
}

function parseCapabilityDecisions(value: unknown, path: string, issues: string[]): VarinExtensionCapabilityDecision[] {
  const decisions = Array.isArray(value) ? value.flatMap((raw, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${itemPath} must be an object`);
      return [];
    }
    const capability = identifier(raw.capability, `${itemPath}.capability`, issues);
    const realm = raw.realm === "host" || raw.realm === "surface" ? raw.realm : undefined;
    if (!realm) issues.push(`${itemPath}.realm must be host or surface`);
    if (typeof raw.granted !== "boolean") issues.push(`${itemPath}.granted must be boolean`);
    const normalizedRealm: "host" | "surface" = realm ?? "surface";
    return [{ capability, granted: raw.granted === true, realm: normalizedRealm }];
  }) : (issues.push(`${path} must be an array`), []);
  const keys = decisions.map(capabilityKey);
  if (new Set(keys).size !== keys.length) issues.push(`${path} contains duplicate capabilities`);
  return decisions;
}

export function parseVarinExtensionCapabilityReviewRequest(
  value: unknown,
): VarinExtensionCapabilityReviewRequest {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new VarinExtensionContractError("Varin extension capability review is invalid", ["request must be an object"]);
  }
  const result: VarinExtensionCapabilityReviewRequest = {
    decisions: parseCapabilityDecisions(value.decisions, "decisions", issues),
    expectedRevision: positiveRevision(value.expectedRevision, "expectedRevision", issues, true),
    extensionId: identifier(value.extensionId, "extensionId", issues),
  };
  throwIssues("Varin extension capability review", issues);
  return result;
}

export function parseVarinExtensionPackageSource(value: unknown): VarinExtensionPackageSource {
  const issues: string[] = [];
  const result = parseSource(value, "source", issues);
  throwIssues("Varin extension package source", issues);
  return result;
}

export function parseVarinExtensionPackageInstallRequest(value: unknown): VarinExtensionPackageInstallRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension install request is invalid", ["request must be an object"]);
  const result = {
    expectedRevision: positiveRevision(value.expectedRevision, "expectedRevision", issues, true),
    source: parseSource(value.source, "source", issues),
  };
  throwIssues("Varin extension install request", issues);
  return result;
}

export function parseVarinExtensionLocalSourceReloadRequest(value: unknown): VarinExtensionLocalSourceReloadRequest {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new VarinExtensionContractError("Varin extension local source reload request is invalid", ["request must be an object"]);
  }
  const result: VarinExtensionLocalSourceReloadRequest = {
    expectedRevision: positiveRevision(value.expectedRevision, "expectedRevision", issues, true),
    extensionId: identifier(value.extensionId, "extensionId", issues),
  };
  throwIssues("Varin extension local source reload request", issues);
  return result;
}

export function parseVarinExtensionLocalSourceReloadResult(value: unknown): VarinExtensionLocalSourceReloadResult {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new VarinExtensionContractError("Varin extension local source reload result is invalid", ["result must be an object"]);
  }
  const outcome = value.outcome === "staged" || value.outcome === "unchanged" ? value.outcome : undefined;
  if (!outcome) issues.push("outcome must be staged or unchanged");
  let snapshot: VarinExtensionCatalogSnapshot | undefined;
  try {
    snapshot = parseVarinExtensionCatalogSnapshot(value.snapshot);
  } catch (error) {
    if (error instanceof VarinExtensionContractError) {
      issues.push(...error.issues.map((issue) => `snapshot.${issue}`));
    } else throw error;
  }
  if (outcome === "staged") {
    const candidateIntegrity = integrity(value.candidateIntegrity, "candidateIntegrity", issues);
    throwIssues("Varin extension local source reload result", issues);
    return { candidateIntegrity, outcome, snapshot: snapshot as VarinExtensionCatalogSnapshot };
  }
  if (value.candidateIntegrity !== undefined) issues.push("candidateIntegrity is only valid for a staged reload");
  throwIssues("Varin extension local source reload result", issues);
  return { outcome: "unchanged", snapshot: snapshot as VarinExtensionCatalogSnapshot };
}

export function parseVarinExtensionRemoveRequest(value: unknown): VarinExtensionRemoveRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension remove request is invalid", ["request must be an object"]);
  const result = {
    deleteData: value.deleteData === true,
    expectedRevision: positiveRevision(value.expectedRevision, "expectedRevision", issues, true),
    extensionId: identifier(value.extensionId, "extensionId", issues),
  };
  if (value.deleteData !== undefined && typeof value.deleteData !== "boolean") {
    issues.push("deleteData must be boolean");
  }
  throwIssues("Varin extension remove request", issues);
  return result;
}

export function parseVarinExtensionActualState(value: unknown): VarinExtensionActualState {
  const issues: string[] = [];
  const states = parseActualStates([value], "actual", issues);
  throwIssues("Varin extension actual state", issues);
  return states[0] as VarinExtensionActualState;
}

function parseServiceProvider(value: unknown, path: string, issues: string[]): VarinExtensionServiceProviderSnapshot | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const descriptor = parseServices<VarinExtensionServiceProvision>([value.descriptor], `${path}.descriptor`, issues, "provide")?.[0];
  const status = value.status === "active" || value.status === "candidate" || value.status === "draining" ? value.status : undefined;
  if (!status) issues.push(`${path}.status must be active, candidate, or draining`);
  const providerId = text(value.providerId);
  if (!providerId) issues.push(`${path}.providerId must be a non-empty string`);
  const providerKey = text(value.providerKey);
  if (!providerKey) issues.push(`${path}.providerKey must be a non-empty string`);
  const extensionVersion = text(value.extensionVersion) ?? "0.0.0";
  if (!SEMVER_PATTERN.test(extensionVersion)) issues.push(`${path}.extensionVersion must be SemVer`);
  if (!descriptor) return undefined;
  return {
    descriptor,
    entrypointId: identifier(value.entrypointId, `${path}.entrypointId`, issues),
    extensionId: identifier(value.extensionId, `${path}.extensionId`, issues),
    extensionVersion,
    generation: positiveRevision(value.generation, `${path}.generation`, issues, true),
    providerId: providerId ?? "invalid",
    providerKey: providerKey ?? "invalid",
    status: status ?? "draining",
  };
}

export function parseVarinExtensionCandidatePreparationResult(value: unknown): VarinExtensionCandidatePreparationResult {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension candidate preparation is invalid", ["result must be an object"]);
  const providers = Array.isArray(value.providers)
    ? value.providers.flatMap((provider, index) => {
      const parsed = parseServiceProvider(provider, `providers[${index}]`, issues);
      if (parsed && parsed.status !== "candidate") issues.push(`providers[${index}].status must be candidate`);
      return parsed ? [parsed] : [];
    })
    : (issues.push("providers must be an array"), []);
  const integrity = text(value.integrity);
  if (!integrity) issues.push("integrity must be a non-empty string");
  const result: VarinExtensionCandidatePreparationResult = {
    extensionId: identifier(value.extensionId, "extensionId", issues),
    integrity: integrity ?? "invalid",
    providers,
  };
  throwIssues("Varin extension candidate preparation", issues);
  return result;
}

export function parseVarinExtensionServiceCatalogSnapshot(value: unknown): VarinExtensionServiceCatalogSnapshot {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension service catalog is invalid", ["catalog must be an object"]);
  const providers = Array.isArray(value.providers)
    ? value.providers.flatMap((provider, index) => {
      const parsed = parseServiceProvider(provider, `providers[${index}]`, issues);
      return parsed ? [parsed] : [];
    })
    : (issues.push("providers must be an array"), []);
  const providerIds = new Set<string>();
  for (const provider of providers) {
    if (providerIds.has(provider.providerId)) issues.push(`providers contains duplicate provider ${provider.providerId}`);
    providerIds.add(provider.providerId);
  }
  const selections: Record<string, string> = {};
  if (!isRecord(value.selections)) issues.push("selections must be an object");
  else {
    for (const [service, provider] of Object.entries(value.selections)) {
      const selected = text(provider);
      if (!selected) issues.push(`selections.${service} must be a non-empty provider ID`);
      else selections[service] = selected;
    }
  }
  const result = {
    hostId: hostId(value.hostId, "hostId", issues),
    providers,
    revision: positiveRevision(value.revision, "revision", issues, true),
    selections,
  };
  throwIssues("Varin extension service catalog", issues);
  return result;
}

export function parseVarinExtensionServiceInvocationRequest(value: unknown): VarinExtensionServiceInvocationRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension service invocation is invalid", ["request must be an object"]);
  const method = text(value.method);
  if (!method) issues.push("method must be a non-empty string");
  const args = Array.isArray(value.args)
    ? value.args.map((arg, index) => jsonValue(arg, `args[${index}]`, issues))
    : (issues.push("args must be an array"), []);
  const providerId = value.providerId === undefined ? undefined : text(value.providerId);
  if (value.providerId !== undefined && !providerId) issues.push("providerId must be a non-empty string");
  let routing: VarinExtensionServiceInvocationRequest["routing"];
  if (value.routing !== undefined) {
    try { routing = parseVarinExtensionServiceRoutingContext(value.routing, { allowEmpty: true }); }
    catch (error) { issues.push(`routing.${error instanceof Error ? error.message : String(error)}`); }
  }
  const result: VarinExtensionServiceInvocationRequest = {
    args,
    method: method ?? "invalid",
    serviceId: identifier(value.serviceId, "serviceId", issues),
    version: positiveRevision(value.version, "version", issues),
    ...(providerId ? { providerId } : {}),
    ...(routing ? { routing } : {}),
  };
  throwIssues("Varin extension service invocation", issues);
  return result;
}

export function parseVarinExtensionServiceSelectionRequest(value: unknown): VarinExtensionServiceSelectionRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension service selection is invalid", ["request must be an object"]);
  const providerId = value.providerId === null ? null : text(value.providerId);
  if (value.providerId !== null && !providerId) issues.push("providerId must be a non-empty string or null");
  const result: VarinExtensionServiceSelectionRequest = {
    providerId: providerId ?? null,
    serviceId: identifier(value.serviceId, "serviceId", issues),
    version: positiveRevision(value.version, "version", issues),
  };
  throwIssues("Varin extension service selection", issues);
  return result;
}

export function parseVarinExtensionHostStateWaitRequest(value: unknown): VarinExtensionHostStateWaitRequest {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension host-state wait request is invalid", ["request must be an object"]);
  const result = {
    hostId: hostId(value.hostId, "hostId", issues),
    revision: positiveRevision(value.revision, "revision", issues, true),
  };
  throwIssues("Varin extension host-state wait request", issues);
  return result;
}

export function parseVarinExtensionHostStateSnapshot(value: unknown): VarinExtensionHostStateSnapshot {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension host-state snapshot is invalid", ["snapshot must be an object"]);
  let catalog: VarinExtensionCatalogSnapshot | undefined;
  let services: VarinExtensionServiceCatalogSnapshot | undefined;
  let routing: ReturnType<typeof parseVarinExtensionServiceRoutingSnapshot> | undefined;
  let workbench: ReturnType<typeof parseVarinWorkbenchProfileSnapshot> | undefined;
  try { catalog = parseVarinExtensionCatalogSnapshot(value.catalog); }
  catch (error) { if (error instanceof VarinExtensionContractError) issues.push(...error.issues.map((issue) => `catalog.${issue}`)); else throw error; }
  try { services = parseVarinExtensionServiceCatalogSnapshot(value.services); }
  catch (error) { if (error instanceof VarinExtensionContractError) issues.push(...error.issues.map((issue) => `services.${issue}`)); else throw error; }
  try { routing = parseVarinExtensionServiceRoutingSnapshot(value.routing); }
  catch (error) { issues.push(`routing.${error instanceof Error ? error.message : String(error)}`); }
  try { workbench = parseVarinWorkbenchProfileSnapshot(value.workbench); }
  catch (error) { issues.push(`workbench.${error instanceof Error ? error.message : String(error)}`); }
  if (catalog && services && catalog.hostId !== services.hostId) issues.push("catalog and services must belong to the same application host");
  if (catalog && routing && catalog.hostId !== routing.hostId) issues.push("catalog and routing must belong to the same application host");
  if (catalog && workbench && catalog.hostId !== workbench.hostId) issues.push("catalog and workbench must belong to the same application host");
  const revision = positiveRevision(value.revision, "revision", issues, true);
  throwIssues("Varin extension host-state snapshot", issues);
  return {
    catalog: catalog as VarinExtensionCatalogSnapshot,
    revision,
    routing: routing as VarinExtensionHostStateSnapshot["routing"],
    services: services as VarinExtensionServiceCatalogSnapshot,
    workbench: workbench as VarinExtensionHostStateSnapshot["workbench"],
  };
}

const STORAGE_SCOPES = new Set(["application", "profile", "session", "surface", "workspace"]);

export function parseVarinExtensionStorageOpenRequest(value: unknown): VarinExtensionStorageOpenRequest {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new VarinExtensionContractError("Varin extension storage open request is invalid", ["request must be an object"]);
  }
  if (value.extensionId !== undefined) issues.push("extensionId is assigned by the Varin Host and must not be supplied");
  const key = text(value.key);
  if (!key) issues.push("key must be a non-empty string");
  const scope = text(value.scope);
  if (!scope || !STORAGE_SCOPES.has(scope)) issues.push("scope is unsupported");
  const schemaVersion = value.schemaVersion === undefined
    ? undefined
    : positiveRevision(value.schemaVersion, "schemaVersion", issues, true);
  const result: VarinExtensionStorageOpenRequest = {
    key: key ?? "invalid",
    scope: STORAGE_SCOPES.has(scope ?? "") ? scope as VarinExtensionStorageOpenRequest["scope"] : "application",
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
  };
  throwIssues("Varin extension storage open request", issues);
  return result;
}

export function parseVarinExtensionStorageAddress(value: unknown): VarinExtensionStorageAddress {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension storage address is invalid", ["address must be an object"]);
  const key = text(value.key);
  if (!key) issues.push("key must be a non-empty string");
  const scope = text(value.scope);
  if (!scope || !STORAGE_SCOPES.has(scope)) issues.push("scope is unsupported");
  const result: VarinExtensionStorageAddress = {
    extensionId: identifier(value.extensionId, "extensionId", issues),
    key: key ?? "invalid",
    scope: STORAGE_SCOPES.has(scope ?? "") ? scope as VarinExtensionStorageAddress["scope"] : "application",
  };
  throwIssues("Varin extension storage address", issues);
  return result;
}

function parseStorageDocument(value: unknown, path: string, issues: string[]): VarinExtensionStorageDocument {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return { data: {}, revision: 0, schemaVersion: 0, updatedAt: new Date(0).toISOString() };
  }
  const data = isRecord(value.data) ? jsonValue(value.data, `${path}.data`, issues) as JsonObject : {};
  if (!isRecord(value.data)) issues.push(`${path}.data must be an object`);
  return {
    data,
    revision: positiveRevision(value.revision, `${path}.revision`, issues, true),
    schemaVersion: positiveRevision(value.schemaVersion, `${path}.schemaVersion`, issues, true),
    updatedAt: timestamp(value.updatedAt, `${path}.updatedAt`, issues),
  };
}

export function parseVarinExtensionStorageSnapshot(value: unknown): VarinExtensionStorageSnapshot {
  const issues: string[] = [];
  if (!isRecord(value)) throw new VarinExtensionContractError("Varin extension storage snapshot is invalid", ["snapshot must be an object"]);
  const storageState = value.storageState === "missing" || value.storageState === "ready" || value.storageState === "stale"
    ? value.storageState
    : undefined;
  if (!storageState) issues.push("storageState is unsupported");
  if (typeof value.authoritative !== "boolean") issues.push("authoritative must be boolean");
  if (typeof value.exists !== "boolean") issues.push("exists must be boolean");
  if (storageState === "stale" && value.authoritative !== false) issues.push("stale storage cannot be authoritative");
  const result: VarinExtensionStorageSnapshot = {
    address: (() => {
      try { return parseVarinExtensionStorageAddress(value.address); }
      catch (error) {
        if (error instanceof VarinExtensionContractError) issues.push(...error.issues.map((issue) => `address.${issue}`));
        return { extensionId: "invalid", key: "invalid", scope: "application" };
      }
    })(),
    authoritative: value.authoritative === true,
    diagnostics: parseDiagnostics(value.diagnostics, "diagnostics", issues),
    document: parseStorageDocument(value.document, "document", issues),
    exists: value.exists === true,
    storageState: storageState ?? "stale",
  };
  throwIssues("Varin extension storage snapshot", issues);
  return result;
}
