import type {
  VarinApplicationSurface,
  VarinExtensionCatalogEntry,
  VarinExtensionCatalogSnapshot,
  VarinExtensionDiagnostic,
  VarinExtensionStorageSnapshot,
} from "./types.js";

const record = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

export const VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION = 1 as const;

export const VARIN_WORKBENCH_DEFAULT_PROFILE_ID = "default";
export const VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL = "Agent";
export const VARIN_WORKBENCH_IDE_PROFILE_ID = "varin.ide";
export const VARIN_WORKBENCH_IDE_PROFILE_LABEL = "IDE";
export const VARIN_WORKBENCH_RESEARCH_PROFILE_ID = "varin.research";
export const VARIN_WORKBENCH_RESEARCH_PROFILE_LABEL = "Research";
export const VARIN_WORKBENCH_BOT_PROFILE_ID = "varin.bot";
export const VARIN_WORKBENCH_BOT_PROFILE_LABEL = "Varin bot";
export const VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID = "varin.builtin.bot-workspace";
export const VARIN_BUILTIN_BOT_WORKSPACE_SHELL_CONTRIBUTION_ID = "varin.builtin.bot-workspace.shell";
export const VARIN_BUILTIN_BOT_WORKSPACE_SURFACES: VarinApplicationSurface[] = ["web", "desktop", "mobile"];
export const VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID = "varin.builtin.agent-workspace";
export const VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID = "varin.builtin.agent-workspace.shell";
export const VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES: VarinApplicationSurface[] = ["web", "desktop", "mobile"];
export const VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID = "varin.builtin.ide-workbench";
export const VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID = "varin.builtin.ide-workbench.shell";
export const VARIN_BUILTIN_IDE_WORKBENCH_SURFACES: VarinApplicationSurface[] = ["web", "desktop"];
export const VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID = "varin.builtin.research-workbench";
export const VARIN_BUILTIN_RESEARCH_WORKBENCH_SHELL_CONTRIBUTION_ID = "varin.builtin.research-workbench.shell";
export const VARIN_BUILTIN_RESEARCH_WORKBENCH_SURFACES: VarinApplicationSurface[] = ["web", "desktop", "mobile"];

export const VARIN_WORKBENCH_REPLACEMENT_TARGETS = {
  agents: "agents.workbench",
  chatComposer: "chat.composer",
  chatTimeline: "chat.timeline",
  mcp: "mcp.workbench",
  sessionNavigator: "sessions.navigator",
  settings: "settings.workbench",
  shell: "workbench.shell",
  workspaceExplorer: "workspace.explorer",
  activity: "workbench.activity",
  primarySidebar: "workbench.primary-sidebar",
  editor: "workbench.editor",
  secondarySidebar: "workbench.secondary-sidebar",
  panel: "workbench.panel",
  status: "workbench.status",
  transition: "workbench.transition",
} as const;

export const VARIN_WORKBENCH_SLOTS = {
  activityItems: "workbench.activity.items",
  primarySidebarViews: "workbench.primary-sidebar.views",
  editorActions: "workbench.editor.actions",
  secondarySidebarViews: "workbench.secondary-sidebar.views",
  panelViews: "workbench.panel.views",
  statusItems: "workbench.status.items",
} as const;

// ---------------------------------------------------------------------------
// Public slot props types
//
// These are the JSON-safe props passed to contributions mounted in each
// standard slot. They contain only serializable identifiers — no React
// callbacks, stores, or Host paths. Extensions use command/document services
// to perform actions.
// ---------------------------------------------------------------------------

/** Props for `workbench.editor.actions` — rendered in the active editor group's action strip. */
export interface VarinWorkbenchEditorActionsSlotProps {
  workspaceId: string;
  groupId: string;
  resourceId?: string;
  viewId?: string;
}

/** Props for `workbench.panel.views` — rendered in the panel content area. */
export interface VarinWorkbenchPanelViewsSlotProps {
  workspaceId: string;
  activePanelId: string;
}

/** Props for `workbench.activity.items` — rendered in the activity bar. */
export interface VarinWorkbenchActivityItemsSlotProps {
  workspaceId: string;
}

/** Props for `workbench.primary-sidebar.views` — rendered in the primary sidebar. */
export interface VarinWorkbenchPrimarySidebarViewsSlotProps {
  workspaceId: string;
  activeActivityId: string;
}

/** Props for `workbench.secondary-sidebar.views` — rendered in the secondary sidebar. */
export interface VarinWorkbenchSecondarySidebarViewsSlotProps {
  workspaceId: string;
}

/** Props for `workbench.status.items` — rendered in the status bar. */
export interface VarinWorkbenchStatusItemsSlotProps {
  workspaceId: string;
}

export const VARIN_WORKBENCH_CONTEXT_KEYS = {
  editorHasSelection: "editorHasSelection",
  editorIsDirty: "editorIsDirty",
  editorIsOpen: "editorIsOpen",
  debugIsActive: "debugIsActive",
  debugIsPaused: "debugIsPaused",
  testHasFailure: "testHasFailure",
  taskIsRunning: "taskIsRunning",
} as const;

// ---------------------------------------------------------------------------
// Shell seam contract (v1)
//
// A shell contribution declares which replacement targets and slots it
// actually hosts per surface. This makes the contract truthful: the
// Extensions settings page can distinguish supported, dormant, and
// missing selections instead of showing every target as available.
// ---------------------------------------------------------------------------

export const VARIN_WORKBENCH_SHELL_DATA_CONTRACT = "varin-workbench-shell/v1" as const;

export interface VarinWorkbenchShellSurfaceSeams {
  replacementTargets: string[];
  slots: string[];
}

export type VarinWorkbenchShellContributionDataV1 = {
  contract: typeof VARIN_WORKBENCH_SHELL_DATA_CONTRACT;
  seams: Partial<Record<VarinApplicationSurface, VarinWorkbenchShellSurfaceSeams>>;
};

const SHELL_SEAM_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const FORBIDDEN_NESTED_TARGETS: Set<string> = new Set([
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition,
]);

export class VarinWorkbenchShellContractError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "VarinWorkbenchShellContractError";
    this.issues = issues;
  }
}

const isShellSurface = (value: unknown): value is VarinApplicationSurface => (
  value === "desktop" || value === "mobile" || value === "web"
);

const validateSeamIdentifiers = (
  values: unknown,
  label: string,
  issues: string[],
): string[] => {
  if (!Array.isArray(values)) {
    issues.push(`${label} must be an array`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (typeof item !== "string" || !SHELL_SEAM_ID_PATTERN.test(item)) {
      issues.push(`${label}[${index}] must be a lowercase namespaced identifier`);
      continue;
    }
    if (FORBIDDEN_NESTED_TARGETS.has(item)) {
      issues.push(`${label}[${index}] must not be ${item} (prevents recursive shell mounting)`);
      continue;
    }
    if (seen.has(item)) {
      issues.push(`${label} contains duplicate ${item}`);
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
};

/**
 * Parse and validate shell contribution data. Throws
 * `VarinWorkbenchShellContractError` on validation failure.
 *
 * Rules:
 * - `contract` must equal `VARIN_WORKBENCH_SHELL_DATA_CONTRACT`
 * - every surface in `supports` must have a `seams` entry
 * - `seams` must not declare surfaces not in `supports`
 * - `replacementTargets` and `slots` must be unique within and across each
 *   surface's seam
 * - no seam may include `workbench.shell` or `workbench.transition`
 *   (prevents recursive nesting)
 * - identifiers must match the standard contribution ID pattern
 */
export const parseVarinWorkbenchShellContributionData = (
  data: unknown,
  supports: readonly VarinApplicationSurface[],
): VarinWorkbenchShellContributionDataV1 => {
  const raw = record(data);
  if (!raw) throw new VarinWorkbenchShellContractError("Shell contribution data must be an object", ["data must be an object"]);
  const issues: string[] = [];
  // Reject unknown top-level fields (matches schema additionalProperties: false)
  const allowedTopLevel = new Set(["contract", "seams"]);
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) issues.push(`data.${key} is not a recognized field`);
  }
  const contract = raw.contract;
  if (contract !== VARIN_WORKBENCH_SHELL_DATA_CONTRACT) {
    issues.push(`data.contract must be ${VARIN_WORKBENCH_SHELL_DATA_CONTRACT}`);
  }
  const rawSeams = record(raw.seams);
  if (!rawSeams) {
    issues.push("data.seams must be an object");
  }
  const supportSet = new Set(supports);
  const seams: Partial<Record<VarinApplicationSurface, VarinWorkbenchShellSurfaceSeams>> = {};
  const processedSurfaces = new Set<string>();
  if (rawSeams) {
    for (const [surfaceKey, surfaceValue] of Object.entries(rawSeams)) {
      if (!isShellSurface(surfaceKey)) {
        issues.push(`data.seams.${surfaceKey} is not a valid surface`);
        continue;
      }
      if (!supportSet.has(surfaceKey)) {
        issues.push(`data.seams.${surfaceKey} declares a surface not in contribution supports`);
        continue;
      }
      processedSurfaces.add(surfaceKey);
      const surfaceRaw = record(surfaceValue);
      if (!surfaceRaw) {
        issues.push(`data.seams.${surfaceKey} must be an object`);
        continue;
      }
      // Reject unknown fields in surface seams (matches schema additionalProperties: false)
      const allowedSeamFields = new Set(["replacementTargets", "slots"]);
      for (const fieldKey of Object.keys(surfaceRaw)) {
        if (!allowedSeamFields.has(fieldKey)) {
          issues.push(`data.seams.${surfaceKey}.${fieldKey} is not a recognized field`);
        }
      }
      const replacementTargets = validateSeamIdentifiers(
        surfaceRaw.replacementTargets,
        `data.seams.${surfaceKey}.replacementTargets`,
        issues,
      );
      const slots = validateSeamIdentifiers(
        surfaceRaw.slots,
        `data.seams.${surfaceKey}.slots`,
        issues,
      );
      // Cross-check: no overlap between targets and slots within a surface
      const targetSet = new Set(replacementTargets);
      for (const slot of slots) {
        if (targetSet.has(slot)) {
          issues.push(`data.seams.${surfaceKey} has ${slot} in both replacementTargets and slots`);
        }
      }
      seams[surfaceKey] = { replacementTargets, slots };
    }
  }
  // Every supported surface must have a seams entry
  for (const surface of supports) {
    if (!processedSurfaces.has(surface)) {
      issues.push(`data.seams.${surface} is missing (surface is in contribution supports)`);
    }
  }
  if (issues.length > 0) {
    throw new VarinWorkbenchShellContractError("Shell contribution data is invalid", issues);
  }
  return {
    contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
    seams,
  };
};

/**
 * Resolve the seams for a specific surface from a parsed shell contribution
 * data. Returns empty seams if the surface is not declared.
 */
export const resolveVarinWorkbenchShellSurfaceSeams = (
  data: VarinWorkbenchShellContributionDataV1,
  surface: VarinApplicationSurface,
): VarinWorkbenchShellSurfaceSeams => (
  data.seams[surface] ?? { replacementTargets: [], slots: [] }
);

export type VarinWorkbenchShellStatus = "builtin" | "disabled" | "failed" | "missing" | "ready";

export interface VarinWorkbenchResolvedProfile {
  layout: VarinWorkbenchResolvedLayout;
  profileId: string;
  shellContributionId?: string;
  shellExtensionId?: string;
  status: VarinWorkbenchShellStatus;
}

export type VarinWorkbenchLayoutScope = "distribution" | "user" | "workspace";

export interface VarinWorkbenchLayoutReference {
  contributionId: string;
  order?: number;
  region?: string;
  size?: number;
  visible?: boolean;
}

export interface VarinWorkbenchLayoutLayer {
  profileId: string;
  references: VarinWorkbenchLayoutReference[];
  replacementSelections: Record<string, string>;
  scope: VarinWorkbenchLayoutScope;
  scopeId: string;
  surface: VarinApplicationSurface;
}

export interface VarinWorkbenchDistributionProfile {
  extensionIds?: string[];
  id: string;
  label: string;
}

export interface VarinWorkbenchProfileSelections {
  users: Record<string, string>;
}

export interface VarinWorkbenchProfileDocument {
  activeProfileId: string;
  layouts: VarinWorkbenchLayoutLayer[];
  profileSelections: VarinWorkbenchProfileSelections;
  profiles: VarinWorkbenchDistributionProfile[];
  revision: number;
  schemaVersion: typeof VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION;
  updatedAt: string;
}

export interface VarinWorkbenchProfileSnapshot {
  authoritative: boolean;
  diagnostics: VarinExtensionDiagnostic[];
  document: VarinWorkbenchProfileDocument;
  hostId: string;
  storageState: "missing" | "ready" | "stale";
}

export interface VarinWorkbenchLayoutUpdateRequest {
  expectedRevision: number;
  layer: VarinWorkbenchLayoutLayer;
}

export interface VarinWorkbenchProfileSelectionRequest {
  expectedRevision: number;
  profileId: string;
  scope: "application" | "user";
  scopeId?: string;
}

export interface VarinWorkbenchProfileUpsertRequest {
  expectedRevision: number;
  profile: VarinWorkbenchDistributionProfile;
}

export interface VarinWorkbenchProfileRemoveRequest {
  expectedRevision: number;
  profileId: string;
}

export interface VarinWorkbenchProfileApplyRequest {
  expectedCatalogRevision: number;
  profileId: string;
}

export interface VarinWorkbenchResolutionContext {
  surface: VarinApplicationSurface;
  userId: string;
  workspaceId?: string;
}

export interface VarinWorkbenchResolvedLayout {
  profileId: string;
  references: VarinWorkbenchLayoutReference[];
  replacementSelections: Record<string, string>;
}

const SURFACES = new Set<VarinApplicationSurface>(["desktop", "mobile", "web"]);
const SCOPES = new Set<VarinWorkbenchLayoutScope>(["distribution", "user", "workspace"]);
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const revision = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return Number(value);
};

const profileId = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
};

const contributionId = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
};

const parseProfile = (value: unknown, label: string): VarinWorkbenchDistributionProfile => {
  const raw = record(value);
  if (!raw) throw new Error(`${label} must be an object`);
  let extensionIds: string[] | undefined;
  if (raw.extensionIds !== undefined) {
    if (!Array.isArray(raw.extensionIds)) throw new Error(`${label}.extensionIds must be an array`);
    extensionIds = raw.extensionIds.map((id, index) => contributionId(id, `${label}.extensionIds[${index}]`));
    if (new Set(extensionIds).size !== extensionIds.length) throw new Error(`${label}.extensionIds contains duplicates`);
  }
  return {
    id: profileId(raw.id, `${label}.id`),
    label: text(raw.label, `${label}.label`),
    ...(extensionIds ? { extensionIds } : {}),
  };
};

const parseReference = (value: unknown, label: string): VarinWorkbenchLayoutReference => {
  const raw = record(value);
  if (!raw) throw new Error(`${label} must be an object`);
  const result: VarinWorkbenchLayoutReference = {
    contributionId: contributionId(raw.contributionId, `${label}.contributionId`),
  };
  if (raw.order !== undefined) {
    if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) throw new Error(`${label}.order must be finite`);
    result.order = raw.order;
  }
  if (raw.region !== undefined) result.region = text(raw.region, `${label}.region`);
  if (raw.size !== undefined) {
    if (typeof raw.size !== "number" || !Number.isFinite(raw.size) || raw.size <= 0) throw new Error(`${label}.size must be positive`);
    result.size = raw.size;
  }
  if (raw.visible !== undefined) {
    if (typeof raw.visible !== "boolean") throw new Error(`${label}.visible must be boolean`);
    result.visible = raw.visible;
  }
  return result;
};

export const parseVarinWorkbenchLayoutLayer = (value: unknown): VarinWorkbenchLayoutLayer => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench layout layer must be an object");
  const surface = text(raw.surface, "layer.surface") as VarinApplicationSurface;
  if (!SURFACES.has(surface)) throw new Error("layer.surface is unsupported");
  const scope = text(raw.scope, "layer.scope") as VarinWorkbenchLayoutScope;
  if (!SCOPES.has(scope)) throw new Error("layer.scope is unsupported");
  if (!Array.isArray(raw.references)) throw new Error("layer.references must be an array");
  const references = raw.references.map((item, index) => parseReference(item, `layer.references[${index}]`));
  if (new Set(references.map((item) => item.contributionId)).size !== references.length) {
    throw new Error("layer.references contains duplicate contribution IDs");
  }
  const rawSelections = record(raw.replacementSelections);
  if (!rawSelections) throw new Error("layer.replacementSelections must be an object");
  const replacementSelections: Record<string, string> = {};
  for (const [target, selected] of Object.entries(rawSelections)) {
    replacementSelections[contributionId(target, `layer.replacementSelections.${target}`)] = contributionId(
      selected,
      `layer.replacementSelections.${target}`,
    );
  }
  return {
    profileId: profileId(raw.profileId, "layer.profileId"),
    references,
    replacementSelections,
    scope,
    scopeId: text(raw.scopeId, "layer.scopeId"),
    surface,
  };
};

const parseStringMap = (value: unknown, label: string): Record<string, string> => {
  const raw = record(value);
  if (!raw) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, selected] of Object.entries(raw)) {
    if (!key.trim()) throw new Error(`${label} contains an empty scope ID`);
    result[key] = profileId(selected, `${label}.${key}`);
  }
  return result;
};

export const parseVarinWorkbenchProfileDocument = (value: unknown): VarinWorkbenchProfileDocument => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile document must be an object");
  if (raw.schemaVersion !== VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION) throw new Error("Workbench profile schemaVersion is unsupported");
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) throw new Error("Workbench profiles must contain at least one profile");
  const profiles = raw.profiles.map((item, index) => parseProfile(item, `profiles[${index}]`));
  if (new Set(profiles.map((item) => item.id)).size !== profiles.length) throw new Error("Workbench profile IDs must be unique");
  if (!Array.isArray(raw.layouts)) throw new Error("Workbench layouts must be an array");
  const layouts = raw.layouts.map(parseVarinWorkbenchLayoutLayer);
  const layoutKeys = layouts.map((layer) => `${layer.profileId}\0${layer.surface}\0${layer.scope}\0${layer.scopeId}`);
  if (new Set(layoutKeys).size !== layoutKeys.length) throw new Error("Workbench layout layer identities must be unique");
  const selections = record(raw.profileSelections);
  if (!selections) throw new Error("Workbench profileSelections must be an object");
  const activeProfileId = profileId(raw.activeProfileId, "activeProfileId");
  const knownProfiles = new Set(profiles.map((item) => item.id));
  const profileSelections = {
    users: parseStringMap(selections.users, "profileSelections.users"),
  };
  if (!knownProfiles.has(activeProfileId)) throw new Error("activeProfileId does not name an installed profile");
  for (const selected of Object.values(profileSelections.users)) {
    if (!knownProfiles.has(selected)) throw new Error(`Profile selection names an unknown profile: ${selected}`);
  }
  for (const layer of layouts) {
    if (!knownProfiles.has(layer.profileId)) throw new Error(`Layout names an unknown profile: ${layer.profileId}`);
  }
  const updatedAt = text(raw.updatedAt, "updatedAt");
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("updatedAt must be an ISO timestamp");
  return {
    activeProfileId,
    layouts,
    profileSelections,
    profiles,
    revision: revision(raw.revision, "revision"),
    schemaVersion: VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION,
    updatedAt,
  };
};

export const parseVarinWorkbenchProfileSnapshot = (value: unknown): VarinWorkbenchProfileSnapshot => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile snapshot must be an object");
  const storageState = raw.storageState;
  if (storageState !== "missing" && storageState !== "ready" && storageState !== "stale") {
    throw new Error("Workbench profile storageState is unsupported");
  }
  if (typeof raw.authoritative !== "boolean") throw new Error("Workbench profile authoritative must be boolean");
  if (!Array.isArray(raw.diagnostics)) throw new Error("Workbench profile diagnostics must be an array");
  return {
    authoritative: raw.authoritative,
    diagnostics: raw.diagnostics as VarinExtensionDiagnostic[],
    document: parseVarinWorkbenchProfileDocument(raw.document),
    hostId: text(raw.hostId, "hostId"),
    storageState,
  };
};

export const parseVarinWorkbenchLayoutUpdateRequest = (value: unknown): VarinWorkbenchLayoutUpdateRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench layout update request must be an object");
  return {
    expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
    layer: parseVarinWorkbenchLayoutLayer(raw.layer),
  };
};

export const parseVarinWorkbenchProfileSelectionRequest = (value: unknown): VarinWorkbenchProfileSelectionRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile selection request must be an object");
  const scope = raw.scope;
  if (scope !== "application" && scope !== "user") throw new Error("Profile selection scope is unsupported");
  const scopeId = raw.scopeId === undefined ? undefined : text(raw.scopeId, "scopeId");
  if (scope === "application" && scopeId !== undefined) throw new Error("Application profile selection cannot include scopeId");
  if (scope !== "application" && scopeId === undefined) throw new Error(`${scope} profile selection requires scopeId`);
  return {
    expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
    profileId: profileId(raw.profileId, "profileId"),
    scope,
    ...(scopeId ? { scopeId } : {}),
  };
};

export const parseVarinWorkbenchProfileUpsertRequest = (value: unknown): VarinWorkbenchProfileUpsertRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile upsert request must be an object");
  return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), profile: parseProfile(raw.profile, "profile") };
};

export const parseVarinWorkbenchProfileRemoveRequest = (value: unknown): VarinWorkbenchProfileRemoveRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile remove request must be an object");
  return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), profileId: profileId(raw.profileId, "profileId") };
};

export const parseVarinWorkbenchProfileApplyRequest = (value: unknown): VarinWorkbenchProfileApplyRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Workbench profile apply request must be an object");
  return {
    expectedCatalogRevision: revision(raw.expectedCatalogRevision, "expectedCatalogRevision"),
    profileId: profileId(raw.profileId, "profileId"),
  };
};

const distributionShellLayer = (
  profileId: string,
  surface: VarinApplicationSurface,
  shellContributionId: string,
): VarinWorkbenchLayoutLayer => ({
  profileId,
  references: [],
  replacementSelections: {
    [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: shellContributionId,
  },
  scope: "distribution",
  scopeId: profileId,
  surface,
});

const ensureDistributionShellLayouts = (
  document: VarinWorkbenchProfileDocument,
  profileId: string,
  surfaces: readonly VarinApplicationSurface[],
  shellContributionId: string,
): boolean => {
  let changed = false;
  for (const surface of surfaces) {
    const index = document.layouts.findIndex((layer) => (
      layer.profileId === profileId
      && layer.scope === "distribution"
      && layer.scopeId === profileId
      && layer.surface === surface
    ));
    if (index === -1) {
      document.layouts.push(distributionShellLayer(profileId, surface, shellContributionId));
      changed = true;
      continue;
    }
    const layer = document.layouts[index];
    if (!layer || layer.replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]) continue;
    document.layouts[index] = {
      ...layer,
      replacementSelections: {
        ...layer.replacementSelections,
        [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: shellContributionId,
      },
    };
    changed = true;
  }
  return changed;
};

export const defaultVarinWorkbenchProfileDocument = (): VarinWorkbenchProfileDocument => ({
  activeProfileId: VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
  layouts: [
    ...VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES.map((surface) => (
      distributionShellLayer(
        VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
        surface,
        VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
      )
    )),
    ...VARIN_BUILTIN_IDE_WORKBENCH_SURFACES.map((surface) => (
      distributionShellLayer(
        VARIN_WORKBENCH_IDE_PROFILE_ID,
        surface,
        VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
      )
    )),
    ...VARIN_BUILTIN_RESEARCH_WORKBENCH_SURFACES.map((surface) => (
      distributionShellLayer(
        VARIN_WORKBENCH_RESEARCH_PROFILE_ID,
        surface,
        VARIN_BUILTIN_RESEARCH_WORKBENCH_SHELL_CONTRIBUTION_ID,
      )
    )),
    ...VARIN_BUILTIN_BOT_WORKSPACE_SURFACES.map((surface) => (
      distributionShellLayer(VARIN_WORKBENCH_BOT_PROFILE_ID, surface, VARIN_BUILTIN_BOT_WORKSPACE_SHELL_CONTRIBUTION_ID)
    )),
  ],
  profileSelections: { users: {} },
  profiles: [
    { id: VARIN_WORKBENCH_DEFAULT_PROFILE_ID, label: VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL },
    { id: VARIN_WORKBENCH_IDE_PROFILE_ID, label: VARIN_WORKBENCH_IDE_PROFILE_LABEL },
    { id: VARIN_WORKBENCH_RESEARCH_PROFILE_ID, label: VARIN_WORKBENCH_RESEARCH_PROFILE_LABEL },
    { id: VARIN_WORKBENCH_BOT_PROFILE_ID, label: VARIN_WORKBENCH_BOT_PROFILE_LABEL },
  ],
  revision: 0,
  schemaVersion: VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
});

export const migrateVarinWorkbenchProfileDocument = (
  document: VarinWorkbenchProfileDocument,
): boolean => {
  let changed = false;
  const profile = document.profiles.find((candidate) => candidate.id === VARIN_WORKBENCH_DEFAULT_PROFILE_ID);
  if (profile && profile.label === "Default") {
    profile.label = VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL;
    changed = true;
  }
  if (!document.profiles.some((candidate) => candidate.id === VARIN_WORKBENCH_IDE_PROFILE_ID)) {
    document.profiles.push({ id: VARIN_WORKBENCH_IDE_PROFILE_ID, label: VARIN_WORKBENCH_IDE_PROFILE_LABEL });
    changed = true;
  }
  if (!document.profiles.some((candidate) => candidate.id === VARIN_WORKBENCH_RESEARCH_PROFILE_ID)) {
    document.profiles.push({ id: VARIN_WORKBENCH_RESEARCH_PROFILE_ID, label: VARIN_WORKBENCH_RESEARCH_PROFILE_LABEL });
    changed = true;
  }
  if (!document.profiles.some((candidate) => candidate.id === VARIN_WORKBENCH_BOT_PROFILE_ID)) {
    document.profiles.push({ id: VARIN_WORKBENCH_BOT_PROFILE_ID, label: VARIN_WORKBENCH_BOT_PROFILE_LABEL });
    changed = true;
  }
  changed = ensureDistributionShellLayouts(
    document,
    VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
    VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES,
    VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  ) || changed;
  changed = ensureDistributionShellLayouts(
    document,
    VARIN_WORKBENCH_IDE_PROFILE_ID,
    VARIN_BUILTIN_IDE_WORKBENCH_SURFACES,
    VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
  ) || changed;
  changed = ensureDistributionShellLayouts(
    document,
    VARIN_WORKBENCH_RESEARCH_PROFILE_ID,
    VARIN_BUILTIN_RESEARCH_WORKBENCH_SURFACES,
    VARIN_BUILTIN_RESEARCH_WORKBENCH_SHELL_CONTRIBUTION_ID,
  ) || changed;
  changed = ensureDistributionShellLayouts(
    document,
    VARIN_WORKBENCH_BOT_PROFILE_ID,
    VARIN_BUILTIN_BOT_WORKSPACE_SURFACES,
    VARIN_BUILTIN_BOT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  ) || changed;
  return changed;
};

export const resolveVarinWorkbenchLayout = (
  documentValue: VarinWorkbenchProfileDocument | unknown,
  context: VarinWorkbenchResolutionContext,
): VarinWorkbenchResolvedLayout => {
  const document = parseVarinWorkbenchProfileDocument(documentValue);
  if (!SURFACES.has(context.surface)) throw new Error("Workbench resolution surface is unsupported");
  const userId = text(context.userId, "userId");
  const workspaceId = context.workspaceId?.trim() || undefined;
  // Profile identity is a user choice. `workspaceId` still participates in
  // project layout layering below, but opening a project/session must not
  // replace the selected Shell with a workspace-scoped profile.
  const profileIdValue = document.profileSelections.users[userId]
    ?? document.activeProfileId;
  const layers = document.layouts.filter((layer) => (
    layer.profileId === profileIdValue
    && layer.surface === context.surface
    && (
      (layer.scope === "distribution" && layer.scopeId === profileIdValue)
      || (layer.scope === "user" && layer.scopeId === userId)
      || (layer.scope === "workspace" && workspaceId !== undefined && layer.scopeId === workspaceId)
    )
  )).sort((left, right) => (
    ["distribution", "user", "workspace"].indexOf(left.scope)
    - ["distribution", "user", "workspace"].indexOf(right.scope)
  ));
  const references = new Map<string, VarinWorkbenchLayoutReference>();
  const replacementSelections: Record<string, string> = {};
  for (const layer of layers) {
    for (const reference of layer.references) {
      references.set(reference.contributionId, {
        ...(references.get(reference.contributionId) ?? {}),
        ...reference,
      });
    }
    Object.assign(replacementSelections, layer.replacementSelections);
  }
  return { profileId: profileIdValue, references: [...references.values()], replacementSelections };
};

const catalogExtensions = (
  catalog: Pick<VarinExtensionCatalogSnapshot, "extensions"> | readonly VarinExtensionCatalogEntry[],
): readonly VarinExtensionCatalogEntry[] => (
  "extensions" in catalog ? catalog.extensions : catalog
);

export const inspectVarinWorkbenchShell = (
  replacementSelections: Readonly<Record<string, string>>,
  catalog: Pick<VarinExtensionCatalogSnapshot, "extensions"> | readonly VarinExtensionCatalogEntry[],
  surface: VarinApplicationSurface,
  actualScope?: { hostId?: string; realmIds?: readonly string[] },
): Pick<VarinWorkbenchResolvedProfile, "shellContributionId" | "shellExtensionId" | "status"> => {
  const shellContributionId = replacementSelections[VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]?.trim();
  if (!shellContributionId) return { status: "builtin" };
  const extensions = catalogExtensions(catalog);
  for (const entry of extensions) {
    const contribution = entry.manifest.contributions?.find((item) => item.id === shellContributionId);
    if (!contribution || !contribution.supports.includes(surface)) continue;
    if (!entry.desired.enabled) {
      return { status: "disabled", shellContributionId, shellExtensionId: entry.manifest.id };
    }
    if (entry.actual.some((state) => (
      state.status === "failed"
      && (
        actualScope === undefined
        || (
          state.desiredRevision === entry.desired.revision
          && (actualScope.hostId === undefined || state.hostId === actualScope.hostId)
          && (state.realmKind === "host" || actualScope.realmIds?.includes(state.realmId) === true)
        )
      )
    ))) {
      return { status: "failed", shellContributionId, shellExtensionId: entry.manifest.id };
    }
    return { status: "ready", shellContributionId, shellExtensionId: entry.manifest.id };
  }
  return { status: "missing", shellContributionId };
};

export const resolveVarinWorkbenchLayoutForProfile = (
  documentValue: VarinWorkbenchProfileDocument | unknown,
  context: VarinWorkbenchResolutionContext,
  profileIdValue: string,
): VarinWorkbenchResolvedLayout => {
  const document = parseVarinWorkbenchProfileDocument(documentValue);
  const selected = profileId(profileIdValue, "profileId");
  if (!document.profiles.some((profile) => profile.id === selected)) {
    throw new Error(`Workbench profile is not installed: ${selected}`);
  }
  const userId = text(context.userId, "userId");
  const nextDocument: VarinWorkbenchProfileDocument = {
    ...document,
    activeProfileId: selected,
    profileSelections: {
      users: { ...document.profileSelections.users, [userId]: selected },
    },
  };
  return resolveVarinWorkbenchLayout(nextDocument, context);
};

export const resolveVarinWorkbenchProfile = (
  documentValue: VarinWorkbenchProfileDocument | unknown,
  catalog: Pick<VarinExtensionCatalogSnapshot, "extensions"> | readonly VarinExtensionCatalogEntry[],
  context: VarinWorkbenchResolutionContext,
): VarinWorkbenchResolvedProfile => {
  const layout = resolveVarinWorkbenchLayout(documentValue, context);
  const inspected = inspectVarinWorkbenchShell(layout.replacementSelections, catalog, context.surface);
  return {
    layout,
    profileId: layout.profileId,
    status: inspected.status,
    ...(inspected.shellContributionId ? { shellContributionId: inspected.shellContributionId } : {}),
    ...(inspected.shellExtensionId ? { shellExtensionId: inspected.shellExtensionId } : {}),
  };
};

export const workbenchDocumentFromStorage = (
  snapshot: VarinExtensionStorageSnapshot,
): VarinWorkbenchProfileDocument => parseVarinWorkbenchProfileDocument({
  ...(snapshot.exists ? snapshot.document.data : defaultVarinWorkbenchProfileDocument()),
  revision: snapshot.document.revision,
  schemaVersion: VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION,
  updatedAt: snapshot.document.updatedAt,
});
