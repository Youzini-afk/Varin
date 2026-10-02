import type {
  EventBus,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type {
  JsonValue,
  PiAgentActionDescriptor,
  PiAgentDescriptor,
  PiAgentDiagnostic,
  PiAgentKind,
  PiAgentProviderActionResult,
  PiAgentProviderDescriptor,
  PiAgentSourceScope,
  PiAgentStatus,
} from "@varin/protocol";
import { HostError } from "../errors.js";
import { isWorkFocusId } from "@varin/protocol";
import { toJsonValue } from "../json.js";
import type {
  AgentProviderAdapter,
  AgentProviderContext,
  AgentProviderListResult,
} from "./types.js";

export const AGENT_PROVIDER_BRIDGE_CHANNEL = "varin.agent-provider.discover/v1";
export const AGENT_PROVIDER_BRIDGE_VERSION = 1 as const;

interface AgentProviderBridgeContext {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  sessionId: string;
}

interface AgentProviderBridgeProvider {
  action?: (
    request: AgentProviderBridgeContext & {
      action: string;
      agentId?: string;
      input?: JsonValue;
    },
  ) => Promise<unknown> | unknown;
  bridgeVersion: typeof AGENT_PROVIDER_BRIDGE_VERSION;
  descriptor: PiAgentProviderDescriptor;
  list: (context: AgentProviderBridgeContext) => Promise<unknown> | unknown;
}

interface AgentProviderBridgeDiscovery {
  register(provider: unknown): void;
  version: typeof AGENT_PROVIDER_BRIDGE_VERSION;
}

export interface AgentProviderBridgeSnapshot {
  adapters: AgentProviderAdapter[];
  diagnostics: PiAgentDiagnostic[];
}

const AGENT_KINDS = new Set<PiAgentKind>([
  "delegatable",
  "internal",
  "primary",
  "profile",
  "service",
  "workflow",
]);
const AGENT_STATUSES = new Set<PiAgentStatus>([
  "available",
  "disabled",
  "error",
  "unavailable",
  "unconfigured",
]);
const SOURCE_SCOPES = new Set<PiAgentSourceScope>([
  "builtin",
  "package",
  "project",
  "runtime",
  "user",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HostError("agent_provider_bridge_invalid", `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HostError("agent_provider_bridge_invalid", `${label} must be a string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HostError("agent_provider_bridge_invalid", `${label} must be a string array`);
  }
  return [...new Set(value)];
}

function parseActions(value: unknown): PiAgentActionDescriptor[] {
  if (!Array.isArray(value)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent provider actions must be an array");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new HostError("agent_provider_bridge_invalid", "Agent provider actions must be objects");
    }
    if (entry.destructive !== undefined && typeof entry.destructive !== "boolean") {
      throw new HostError("agent_provider_bridge_invalid", "Agent action destructive must be boolean");
    }
    if (entry.requiresScope !== undefined && typeof entry.requiresScope !== "boolean") {
      throw new HostError("agent_provider_bridge_invalid", "Agent action requiresScope must be boolean");
    }
    return {
      ...(entry.destructive === undefined ? {} : { destructive: entry.destructive }),
      id: requiredString(entry.id, "Agent action id"),
      label: requiredString(entry.label, "Agent action label"),
      ...(entry.requiresScope === undefined ? {} : { requiresScope: entry.requiresScope }),
    };
  });
}

function parseConfiguration(value: unknown) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent configuration must be an object");
  }
  const section = optionalString(value.section, "Agent configuration section");
  return {
    pluginId: requiredString(value.pluginId, "Agent configuration pluginId"),
    ...(section === undefined ? {} : { section }),
  };
}

function parseProviderDescriptor(value: unknown): PiAgentProviderDescriptor {
  if (!isRecord(value)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent provider descriptor must be an object");
  }
  if (typeof value.available !== "boolean") {
    throw new HostError("agent_provider_bridge_invalid", "Agent provider available must be boolean");
  }
  const configuration = parseConfiguration(value.configuration);
  const source = optionalString(value.source, "Agent provider source");
  return {
    actions: parseActions(value.actions),
    available: value.available,
    ...(configuration === undefined ? {} : { configuration }),
    description: requiredString(value.description, "Agent provider description"),
    id: requiredString(value.id, "Agent provider id"),
    label: requiredString(value.label, "Agent provider label"),
    ...(source === undefined ? {} : { source }),
  };
}

function parseAgent(value: unknown, providerId: string): PiAgentDescriptor {
  if (!isRecord(value) || !isRecord(value.source)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent descriptors require a source object");
  }
  if (!AGENT_KINDS.has(value.kind as PiAgentKind)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent kind is invalid");
  }
  if (!AGENT_STATUSES.has(value.status as PiAgentStatus)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent status is invalid");
  }
  if (!SOURCE_SCOPES.has(value.source.scope as PiAgentSourceScope)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent source scope is invalid");
  }
  const configuration = parseConfiguration(value.configuration);
  const aliases = stringArray(value.aliases, "Agent aliases");
  const fallbackModels = stringArray(value.fallbackModels, "Agent fallbackModels");
  const packageName = optionalString(value.source.packageName, "Agent source packageName");
  const path = optionalString(value.source.path, "Agent source path");
  const model = optionalString(value.model, "Agent model");
  const thinking = optionalString(value.thinking, "Agent thinking");
  if (value.workFocus !== undefined && (!Array.isArray(value.workFocus) || !value.workFocus.every(isWorkFocusId))) {
    throw new HostError("agent_provider_bridge_invalid", "Agent workFocus is invalid");
  }
  let invocation: PiAgentDescriptor["invocation"];
  if (value.invocation !== undefined) {
    if (
      !isRecord(value.invocation)
      || value.invocation.kind !== "slash-command"
      || (value.invocation.taskSeparator !== "space" && value.invocation.taskSeparator !== "double-dash")
    ) {
      throw new HostError("agent_provider_bridge_invalid", "Agent invocation is invalid");
    }
    invocation = {
      command: requiredString(value.invocation.command, "Agent invocation command"),
      kind: "slash-command",
      taskSeparator: value.invocation.taskSeparator,
    };
  }
  return {
    actions: parseActions(value.actions),
    ...(aliases === undefined ? {} : { aliases }),
    ...(configuration === undefined ? {} : { configuration }),
    description: requiredString(value.description, "Agent description"),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    id: requiredString(value.id, "Agent id"),
    ...(invocation === undefined ? {} : { invocation }),
    kind: value.kind as PiAgentKind,
    ...(model === undefined ? {} : { model }),
    name: requiredString(value.name, "Agent name"),
    providerId,
    source: {
      ...(packageName === undefined ? {} : { packageName }),
      ...(path === undefined ? {} : { path }),
      scope: value.source.scope as PiAgentSourceScope,
    },
    status: value.status as PiAgentStatus,
    ...(thinking === undefined ? {} : { thinking }),
    ...(value.workFocus === undefined ? {} : { workFocus: [...value.workFocus as import("@varin/protocol").WorkFocusId[]] }),
  };
}

function parseDiagnostic(value: unknown, providerId: string): PiAgentDiagnostic {
  if (!isRecord(value) || (value.severity !== "error" && value.severity !== "warning")) {
    throw new HostError("agent_provider_bridge_invalid", "Agent provider diagnostic is invalid");
  }
  const path = optionalString(value.path, "Agent diagnostic path");
  return {
    message: requiredString(value.message, "Agent diagnostic message"),
    ...(path === undefined ? {} : { path }),
    providerId,
    severity: value.severity,
  };
}

function parseListResult(value: unknown, providerId: string): AgentProviderListResult {
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent provider list result is invalid");
  }
  if (value.diagnostics !== undefined && !Array.isArray(value.diagnostics)) {
    throw new HostError("agent_provider_bridge_invalid", "Agent provider diagnostics must be an array");
  }
  return {
    agents: value.agents.map((agent) => parseAgent(agent, providerId)),
    diagnostics: (value.diagnostics ?? []).map((diagnostic) => parseDiagnostic(diagnostic, providerId)),
  };
}

function parseActionResult(value: unknown, providerId: string): PiAgentProviderActionResult {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    throw new HostError("agent_provider_bridge_invalid", "Agent provider action result is invalid");
  }
  const agentId = optionalString(value.agentId, "Agent action result agentId");
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(value.data === undefined ? {} : { data: toJsonValue(value.data) }),
    message: requiredString(value.message, "Agent action result message"),
    providerId,
    success: value.success,
  };
}

function parseBridgeProvider(value: unknown): AgentProviderBridgeProvider | undefined {
  if (
    !isRecord(value)
    || value.bridgeVersion !== AGENT_PROVIDER_BRIDGE_VERSION
    || typeof value.list !== "function"
    || (value.action !== undefined && typeof value.action !== "function")
  ) {
    return undefined;
  }
  try {
    const action = value.action as AgentProviderBridgeProvider["action"];
    return {
      ...(action === undefined ? {} : { action }),
      bridgeVersion: AGENT_PROVIDER_BRIDGE_VERSION,
      descriptor: parseProviderDescriptor(value.descriptor),
      list: value.list as AgentProviderBridgeProvider["list"],
    };
  } catch {
    return undefined;
  }
}

class BridgeAgentProviderAdapter implements AgentProviderAdapter {
  readonly descriptor: PiAgentProviderDescriptor;
  readonly #context: AgentProviderBridgeContext;
  readonly #provider: AgentProviderBridgeProvider;

  constructor(provider: AgentProviderBridgeProvider, context: AgentProviderContext) {
    this.#provider = provider;
    this.descriptor = provider.descriptor;
    this.#context = {
      agentDir: context.agentDir,
      cwd: context.cwd,
      projectTrusted: context.projectTrusted,
      sessionId: context.session.sessionId,
    };
  }

  async list(): Promise<AgentProviderListResult> {
    try {
      return parseListResult(
        await this.#provider.list(this.#context),
        this.descriptor.id,
      );
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError(
        "agent_provider_failed",
        `${this.descriptor.label} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async action(
    action: string,
    agentId: string | undefined,
    input: JsonValue | undefined,
  ): Promise<PiAgentProviderActionResult> {
    if (!this.#provider.action) {
      throw new HostError(
        "unsupported_agent_action",
        `${this.descriptor.label} is configured through its plugin-owned settings`,
      );
    }
    try {
      return parseActionResult(
        await this.#provider.action({
          ...this.#context,
          action,
          ...(agentId === undefined ? {} : { agentId }),
          ...(input === undefined ? {} : { input }),
        }),
        this.descriptor.id,
      );
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError(
        "agent_provider_failed",
        `${this.descriptor.label} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

export class AgentProviderBridge {
  #events: EventBus | undefined;

  attach(events: EventBus): void {
    this.#events = events;
  }

  detach(events: EventBus): void {
    if (this.#events === events) this.#events = undefined;
  }

  snapshot(context: AgentProviderContext): AgentProviderBridgeSnapshot {
    if (!this.#events) return { adapters: [], diagnostics: [] };
    const providers = new Map<string, AgentProviderBridgeProvider>();
    const diagnostics: PiAgentDiagnostic[] = [];
    const discovery: AgentProviderBridgeDiscovery = {
      register: (value) => {
        const provider = parseBridgeProvider(value);
        if (!provider) {
          diagnostics.push({
            message: "An extension offered an invalid Varin agent provider bridge",
            providerId: "varin-agent-provider-bridge",
            severity: "warning",
          });
          return;
        }
        if (providers.has(provider.descriptor.id)) {
          diagnostics.push({
            message: `Ignoring duplicate bridged agent provider: ${provider.descriptor.id}`,
            providerId: provider.descriptor.id,
            severity: "warning",
          });
          return;
        }
        providers.set(provider.descriptor.id, provider);
      },
      version: AGENT_PROVIDER_BRIDGE_VERSION,
    };
    try {
      this.#events.emit(AGENT_PROVIDER_BRIDGE_CHANNEL, discovery);
    } catch (error) {
      diagnostics.push({
        message: `Agent provider discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        providerId: "varin-agent-provider-bridge",
        severity: "error",
      });
    }
    return {
      adapters: [...providers.values()].map(
        (provider) => new BridgeAgentProviderAdapter(provider, context),
      ),
      diagnostics,
    };
  }
}

export function createAgentProviderBridgeExtension(bridge: AgentProviderBridge): ExtensionFactory {
  return (pi) => {
    bridge.attach(pi.events);
    pi.on("session_shutdown", () => bridge.detach(pi.events));
  };
}
