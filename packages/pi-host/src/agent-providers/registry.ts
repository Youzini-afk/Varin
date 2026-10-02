import type {
  JsonValue,
  PiAgentCatalogSnapshot,
  PiAgentProviderActionResult,
} from "@varin/protocol";
import { HostError } from "../errors.js";
import type { AgentProviderBridge } from "./bridge.js";
import { findMagicContextExtension, MagicContextProvider } from "./magic-context-provider.js";
import { findPiSubagentsTool, PiSubagentsProvider } from "./pi-subagents-provider.js";
import type { AgentProviderAdapter, AgentProviderContext } from "./types.js";
import { VarinAgentProvider } from "./varin-provider.js";

export class AgentProviderRegistry {
  readonly #bridge: AgentProviderBridge | undefined;
  readonly #context: AgentProviderContext;

  constructor(context: AgentProviderContext, bridge?: AgentProviderBridge) {
    this.#context = context;
    this.#bridge = bridge;
  }

  async list(): Promise<PiAgentCatalogSnapshot> {
    const { adapters, diagnostics } = this.#adapterSnapshot();
    const results = await Promise.allSettled(adapters.map((adapter) => adapter.list()));
    const agents: PiAgentCatalogSnapshot["agents"] = [];
    for (const [index, result] of results.entries()) {
      const provider = adapters[index];
      if (!provider) continue;
      if (result.status === "fulfilled") {
        agents.push(...result.value.agents);
        diagnostics.push(...result.value.diagnostics);
      } else {
        diagnostics.push({
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          providerId: provider.descriptor.id,
          severity: "error",
        });
      }
    }
    agents.sort((left, right) =>
      left.providerId.localeCompare(right.providerId) || left.name.localeCompare(right.name),
    );
    return {
      agents,
      diagnostics,
      projectTrusted: this.#context.projectTrusted,
      providers: adapters.map((adapter) => adapter.descriptor),
    };
  }

  async action(
    providerId: string,
    action: string,
    agentId: string | undefined,
    input: JsonValue | undefined,
  ): Promise<PiAgentProviderActionResult> {
    const adapter = this.#adapterSnapshot().adapters.find(
      (candidate) => candidate.descriptor.id === providerId,
    );
    if (!adapter) throw new HostError("agent_provider_not_found", `Unknown agent provider: ${providerId}`);
    if (!adapter.action) {
      throw new HostError(
        "unsupported_agent_action",
        `${adapter.descriptor.label} is configured through its plugin-owned settings`,
      );
    }
    return adapter.action(action, agentId, input);
  }

  #adapterSnapshot(): {
    adapters: AgentProviderAdapter[];
    diagnostics: PiAgentCatalogSnapshot["diagnostics"];
  } {
    const bridged = this.#bridge?.snapshot(this.#context) ?? { adapters: [], diagnostics: [] };
    const adapters: AgentProviderAdapter[] = [
      ...(this.#context.nativeSettings ? [new VarinAgentProvider(this.#context)] : []),
      ...bridged.adapters.filter(adapter => adapter.descriptor.id !== "varin"),
    ];
    const providerIds = new Set(adapters.map((adapter) => adapter.descriptor.id));
    const extensions = this.#context.session.resourceLoader.getExtensions();
    const subagentsTool = findPiSubagentsTool(this.#context.session);
    const subagentsError = subagentsTool
      ? undefined
      : extensions.errors.find((entry) => entry.path.toLowerCase().includes("pi-subagents"));
    if (!providerIds.has("pi-subagents") && (subagentsTool || subagentsError)) {
      adapters.push(
        new PiSubagentsProvider(this.#context, subagentsTool, subagentsError?.error),
      );
    }
    const magic = findMagicContextExtension(this.#context);
    if (!providerIds.has("magic-context") && magic) {
      adapters.push(
        new MagicContextProvider(
          this.#context,
          magic.available,
          magic.source,
          magic.loadError,
        ),
      );
    }
    return { adapters, diagnostics: bridged.diagnostics };
  }
}
