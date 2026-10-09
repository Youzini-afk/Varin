import type {
  VarinExtensionDiagnostic,
  VarinExtensionStorageSnapshot,
} from "./types.js";

export const VARIN_SERVICE_ROUTING_SCHEMA_VERSION = 1 as const;

export interface VarinExtensionServiceRoutingContext {
  agentId?: string;
  distributionId?: string;
  invocationId?: string;
  modelId?: string;
  modelProviderId?: string;
  profileId?: string;
  projectId?: string;
  runtimeId?: string;
  sessionId?: string;
  userId?: string;
  workspaceId?: string;
}

export interface VarinExtensionServiceRoutingRule {
  allowFallback: boolean;
  providerKey: string;
  scope: VarinExtensionServiceRoutingContext;
  serviceId: string;
  version: number;
}

export interface VarinExtensionServiceRoutingDocument {
  revision: number;
  rules: VarinExtensionServiceRoutingRule[];
  schemaVersion: typeof VARIN_SERVICE_ROUTING_SCHEMA_VERSION;
  updatedAt: string;
}

export interface VarinExtensionServiceRoutingSnapshot {
  authoritative: boolean;
  diagnostics: VarinExtensionDiagnostic[];
  document: VarinExtensionServiceRoutingDocument;
  hostId: string;
  storageState: "missing" | "ready" | "stale";
}

export interface VarinExtensionServiceRoutingRuleUpdateRequest {
  expectedRevision: number;
  rule: VarinExtensionServiceRoutingRule;
}

export interface VarinExtensionServiceRoutingRuleRemoveRequest {
  expectedRevision: number;
  scope: VarinExtensionServiceRoutingContext;
  serviceId: string;
  version: number;
}

export interface VarinExtensionServiceRoutingCandidate {
  providerId: string;
  providerKey: string;
}

export interface VarinExtensionServiceRoutingResolution {
  diagnostics: VarinExtensionDiagnostic[];
  matchedRule?: VarinExtensionServiceRoutingRule;
  providerId?: string;
  providerKey?: string;
  status: "ambiguous" | "resolved" | "unavailable";
}

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SCOPE_FIELDS = [
  "distributionId",
  "profileId",
  "userId",
  "workspaceId",
  "projectId",
  "runtimeId",
  "sessionId",
  "agentId",
  "modelProviderId",
  "modelId",
  "invocationId",
] as const satisfies readonly (keyof VarinExtensionServiceRoutingContext)[];

const record = (value: unknown): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const serviceId = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!ID_PATTERN.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
};

const revision = (value: unknown, label: string, allowZero = true): number => {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return Number(value);
};

export const parseVarinExtensionServiceRoutingContext = (
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): VarinExtensionServiceRoutingContext => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing context must be an object");
  const context: VarinExtensionServiceRoutingContext = {};
  for (const field of SCOPE_FIELDS) {
    if (raw[field] !== undefined) context[field] = text(raw[field], `scope.${field}`);
  }
  if (!options.allowEmpty && Object.keys(context).length === 0) throw new Error("Service routing scope must select at least one context dimension");
  return context;
};

export const parseVarinExtensionServiceRoutingRule = (value: unknown): VarinExtensionServiceRoutingRule => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing rule must be an object");
  if (typeof raw.allowFallback !== "boolean") throw new Error("Service routing rule allowFallback must be boolean");
  return {
    allowFallback: raw.allowFallback,
    providerKey: text(raw.providerKey, "providerKey"),
    scope: parseVarinExtensionServiceRoutingContext(raw.scope),
    serviceId: serviceId(raw.serviceId, "serviceId"),
    version: revision(raw.version, "version", false),
  };
};

export const serviceRoutingScopeKey = (scopeValue: VarinExtensionServiceRoutingContext | unknown): string => {
  const scope = parseVarinExtensionServiceRoutingContext(scopeValue);
  return SCOPE_FIELDS.flatMap((field) => scope[field] ? [`${field}=${JSON.stringify(scope[field])}`] : []).join("&");
};

export const serviceRoutingRuleKey = (
  rule: Pick<VarinExtensionServiceRoutingRule, "scope" | "serviceId" | "version">,
): string => `${rule.serviceId}@${rule.version}\0${serviceRoutingScopeKey(rule.scope)}`;

export const parseVarinExtensionServiceRoutingDocument = (
  value: unknown,
): VarinExtensionServiceRoutingDocument => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing document must be an object");
  if (raw.schemaVersion !== VARIN_SERVICE_ROUTING_SCHEMA_VERSION) throw new Error("Service routing schemaVersion is unsupported");
  if (!Array.isArray(raw.rules)) throw new Error("Service routing rules must be an array");
  const rules = raw.rules.map(parseVarinExtensionServiceRoutingRule);
  const keys = rules.map(serviceRoutingRuleKey);
  if (new Set(keys).size !== keys.length) throw new Error("Service routing rule identities must be unique");
  const updatedAt = text(raw.updatedAt, "updatedAt");
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("updatedAt must be an ISO timestamp");
  return {
    revision: revision(raw.revision, "revision"),
    rules,
    schemaVersion: VARIN_SERVICE_ROUTING_SCHEMA_VERSION,
    updatedAt,
  };
};

export const parseVarinExtensionServiceRoutingSnapshot = (
  value: unknown,
): VarinExtensionServiceRoutingSnapshot => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing snapshot must be an object");
  const storageState = raw.storageState;
  if (storageState !== "missing" && storageState !== "ready" && storageState !== "stale") {
    throw new Error("Service routing storageState is unsupported");
  }
  if (typeof raw.authoritative !== "boolean") throw new Error("Service routing authoritative must be boolean");
  if (!Array.isArray(raw.diagnostics)) throw new Error("Service routing diagnostics must be an array");
  return {
    authoritative: raw.authoritative,
    diagnostics: raw.diagnostics as VarinExtensionDiagnostic[],
    document: parseVarinExtensionServiceRoutingDocument(raw.document),
    hostId: text(raw.hostId, "hostId"),
    storageState,
  };
};

export const parseVarinExtensionServiceRoutingRuleUpdateRequest = (
  value: unknown,
): VarinExtensionServiceRoutingRuleUpdateRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing update request must be an object");
  return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), rule: parseVarinExtensionServiceRoutingRule(raw.rule) };
};

export const parseVarinExtensionServiceRoutingRuleRemoveRequest = (
  value: unknown,
): VarinExtensionServiceRoutingRuleRemoveRequest => {
  const raw = record(value);
  if (!raw) throw new Error("Service routing remove request must be an object");
  return {
    expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
    scope: parseVarinExtensionServiceRoutingContext(raw.scope),
    serviceId: serviceId(raw.serviceId, "serviceId"),
    version: revision(raw.version, "version", false),
  };
};

export const defaultVarinExtensionServiceRoutingDocument = (): VarinExtensionServiceRoutingDocument => ({
  revision: 0,
  rules: [],
  schemaVersion: VARIN_SERVICE_ROUTING_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
});

export const serviceRoutingDocumentFromStorage = (
  snapshot: VarinExtensionStorageSnapshot,
): VarinExtensionServiceRoutingDocument => parseVarinExtensionServiceRoutingDocument({
  ...(snapshot.exists ? snapshot.document.data : defaultVarinExtensionServiceRoutingDocument()),
  revision: snapshot.document.revision,
  schemaVersion: VARIN_SERVICE_ROUTING_SCHEMA_VERSION,
  updatedAt: snapshot.document.updatedAt,
});

const precedence = (scope: VarinExtensionServiceRoutingContext): [number, number] => {
  let highest = -1;
  let dimensions = 0;
  SCOPE_FIELDS.forEach((field, index) => {
    if (scope[field] === undefined) return;
    highest = Math.max(highest, index);
    dimensions += 1;
  });
  return [highest, dimensions];
};

const matchesContext = (
  scope: VarinExtensionServiceRoutingContext,
  context: VarinExtensionServiceRoutingContext,
): boolean => SCOPE_FIELDS.every((field) => scope[field] === undefined || scope[field] === context[field]);

const routingDiagnostic = (code: string, message: string): VarinExtensionDiagnostic => ({
  code,
  message,
  severity: code.includes("fallback") ? "warning" : "error",
  timestamp: new Date().toISOString(),
});

export const resolveVarinExtensionServiceRouting = (options: {
  candidates: readonly VarinExtensionServiceRoutingCandidate[];
  /** Distribution default, considered only after all applicable explicit routing rules. */
  defaultProviderKey?: string;
  context?: VarinExtensionServiceRoutingContext;
  document: VarinExtensionServiceRoutingDocument | unknown;
  serviceId: string;
  version: number;
}): VarinExtensionServiceRoutingResolution => {
  const document = parseVarinExtensionServiceRoutingDocument(options.document);
  const context = parseVarinExtensionServiceRoutingContext(options.context ?? {}, { allowEmpty: true });
  const id = serviceId(options.serviceId, "serviceId");
  const version = revision(options.version, "version", false);
  const candidates = options.candidates.filter((candidate) => candidate.providerId.trim() && candidate.providerKey.trim());
  const matching = document.rules.filter((rule) => (
    rule.serviceId === id && rule.version === version && matchesContext(rule.scope, context)
  )).sort((left, right) => {
    const leftPrecedence = precedence(left.scope);
    const rightPrecedence = precedence(right.scope);
    return rightPrecedence[0] - leftPrecedence[0] || rightPrecedence[1] - leftPrecedence[1];
  });
  const diagnostics: VarinExtensionDiagnostic[] = [];
  for (let index = 0; index < matching.length;) {
    const rank = precedence(matching[index]!.scope);
    const peers: VarinExtensionServiceRoutingRule[] = [];
    while (index < matching.length) {
      const current = matching[index] as VarinExtensionServiceRoutingRule;
      const currentRank = precedence(current.scope);
      if (currentRank[0] !== rank[0] || currentRank[1] !== rank[1]) break;
      peers.push(current);
      index += 1;
    }
    const providerKeys = new Set(peers.map((rule) => rule.providerKey));
    if (providerKeys.size > 1) {
      return {
        diagnostics: [routingDiagnostic(
          "service_selection_scope_conflict",
          `Multiple equally specific routing rules select different providers for ${id}@${version}`,
        )],
        status: "ambiguous",
      };
    }
    const rule = peers[0] as VarinExtensionServiceRoutingRule;
    const provider = candidates.find((candidate) => candidate.providerKey === rule.providerKey);
    if (provider) {
      return {
        diagnostics,
        matchedRule: rule,
        providerId: provider.providerId,
        providerKey: provider.providerKey,
        status: "resolved",
      };
    }
    diagnostics.push(routingDiagnostic(
      rule.allowFallback ? "service_selection_fallback" : "service_selection_provider_unavailable",
      `Selected provider ${rule.providerKey} is unavailable for ${id}@${version}`,
    ));
    if (!rule.allowFallback) return { diagnostics, matchedRule: rule, providerKey: rule.providerKey, status: "unavailable" };
  }
  const defaultProvider = options.defaultProviderKey
    ? candidates.find(candidate => candidate.providerKey === options.defaultProviderKey) : undefined;
  if (defaultProvider) return { diagnostics, providerId: defaultProvider.providerId,
    providerKey: defaultProvider.providerKey, status: "resolved" };
  if (candidates.length === 1) {
    const candidate = candidates[0] as VarinExtensionServiceRoutingCandidate;
    return {
      diagnostics,
      providerId: candidate.providerId,
      providerKey: candidate.providerKey,
      status: "resolved",
    };
  }
  if (candidates.length > 1) {
    return {
      diagnostics: [...diagnostics, routingDiagnostic(
        "service_selection_ambiguous",
        `Multiple providers are available for ${id}@${version}; an explicit routing rule is required`,
      )],
      status: "ambiguous",
    };
  }
  return {
    diagnostics: [...diagnostics, routingDiagnostic(
      "service_provider_unavailable",
      `No provider is available for ${id}@${version}`,
    )],
    status: "unavailable",
  };
};
