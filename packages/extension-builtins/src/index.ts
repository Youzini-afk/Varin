import type {
  JsonObject,
  VarinApplicationSurface,
  VarinExtensionManifest,
  VarinExtensionStaticContribution,
} from "@varin/extension-contract";
import {
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES,
  VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_BOT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_BOT_WORKSPACE_SURFACES,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_SURFACES,
  VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID,
  VARIN_BUILTIN_RESEARCH_WORKBENCH_SHELL_CONTRIBUTION_ID,
  VARIN_BUILTIN_RESEARCH_WORKBENCH_SURFACES,
  VARIN_BUILTIN_TRANSITION_SCENE_CONTRIBUTION_ID,
  VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION_ID,
  VARIN_TRANSITION_SCENE_DATA_CONTRACT,
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  VARIN_CORE_SERVICE_VERSION,
  VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
  VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
  VARIN_WORKBENCH_LAYOUT_SERVICE_ID,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
  VARIN_WORKBENCH_SLOTS,
  VARIN_RETRIEVAL_PLAN_SERVICE_ID,
  VARIN_RETRIEVAL_PLAN_VERSION,
} from "@varin/extension-contract";

export interface VarinBuiltinExtensionDefinition {
  enabledByDefault: boolean;
  manifest: VarinExtensionManifest;
}

export interface VarinBuiltinPluginAdapterData {
  adapterId: string;
  contract: "pi-plugin-settings-adapter/v1";
  icon: string;
  packageNames: string[];
}

export const VARIN_BUILTIN_EXTENSION_VERSION = "0.1.0";
export const VARIN_BUILTIN_EXTENSION_PREFIX = "varin.builtin.";
export const VARIN_INTEGRATION_ENTRYPOINT_ID = "main";
export const VARIN_INTEGRATION_SURFACES: VarinApplicationSurface[] = ["web", "desktop", "mobile"];
export const VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID = "varin.builtin.typescript-language";
export const VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_VERSION = "5.3.0+typescript.5.9.3.varin.1";
export const VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID = "varin.builtin.language-servers";
export const VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_VERSION = "0.1.0";
export const VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID = "varin.builtin.context-fragments";
export const VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION_ID = "varin.builtin.retrieval-structured";
export const VARIN_BUILTIN_RETRIEVAL_KEYWORD_EXTENSION_ID = "varin.builtin.retrieval-keyword";
export const VARIN_BUILTIN_RETRIEVAL_DEFAULT_PROVIDER_KEY = `${VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION_ID}:host:${VARIN_RETRIEVAL_PLAN_SERVICE_ID}@${VARIN_RETRIEVAL_PLAN_VERSION}`;
export const VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID = "varin.builtin.recovery";
export const VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_VERSION = "0.4.0";

export interface VarinBundledLanguageServer {
  extensionId: string;
  id: string;
  name: string;
  languageIds: readonly string[];
}

/**
 * Browser-safe catalog of language providers shipped in the desktop artifact.
 * The ids are provider ids used by workspace.language status and registration.
 */
export const VARIN_BUNDLED_LANGUAGE_SERVERS: readonly VarinBundledLanguageServer[] = [
  {
    extensionId: VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
    id: "varin.typescript-language",
    name: "TypeScript and JavaScript",
    languageIds: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
  },
  {
    extensionId: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
    id: "varin.python-language",
    name: "Python (Pyright)",
    languageIds: ["python"],
  },
  {
    extensionId: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
    id: "varin.html-language",
    name: "HTML",
    languageIds: ["html"],
  },
  {
    extensionId: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
    id: "varin.css-language",
    name: "CSS, SCSS, and LESS",
    languageIds: ["css", "scss", "less"],
  },
  {
    extensionId: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
    id: "varin.json-language",
    name: "JSON and JSONC",
    languageIds: ["json", "jsonc"],
  },
  {
    extensionId: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
    id: "varin.yaml-language",
    name: "YAML",
    languageIds: ["yaml"],
  },
  {
    extensionId: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
    id: "varin.bash-language",
    name: "Bash",
    languageIds: ["shellscript"],
  },
] as const;

export const VARIN_BUNDLED_LANGUAGE_SERVER_PROVIDER_IDS = VARIN_BUNDLED_LANGUAGE_SERVERS.map(
  ({ id }) => id,
);

const pageContribution = (input: {
  group: "pi" | "harness";
  icon: string;
  id: string;
  keywords: string[];
  kind: "single" | "split";
  order: number;
  slug: string;
  title: string;
  titleKey: string;
}): VarinExtensionStaticContribution => ({
  contractVersion: 1,
  data: {
    group: input.group,
    icon: input.icon,
    keywords: input.keywords,
    kind: input.kind,
    order: input.order,
    slug: input.slug,
    title: input.title,
    titleKey: input.titleKey,
  },
  entrypoint: VARIN_INTEGRATION_ENTRYPOINT_ID,
  id: input.id,
  kind: "settings-page",
  placement: { order: input.order, slot: `settings.nav.${input.group}` },
  supports: VARIN_INTEGRATION_SURFACES,
});

const pluginAdapterContribution = (
  extensionId: string,
  adapterId: string,
  icon: string,
  packageNames: string[],
): VarinExtensionStaticContribution => ({
  contractVersion: 1,
  data: {
    adapterId,
    contract: "pi-plugin-settings-adapter/v1",
    icon,
    packageNames,
      } satisfies VarinBuiltinPluginAdapterData & JsonObject,
  entrypoint: VARIN_INTEGRATION_ENTRYPOINT_ID,
  id: `${extensionId}.adapter`,
  kind: "panel",
  placement: { slot: "pi.plugin-settings.adapters" },
  supports: VARIN_INTEGRATION_SURFACES,
});

const definition = (input: {
  contributions: VarinExtensionStaticContribution[];
  displayName: string;
  id: string;
  piPackages?: string[];
  provides?: VarinExtensionManifest['provides'];
  supports?: VarinApplicationSurface[];
}): VarinBuiltinExtensionDefinition => {
  const supports = input.supports ?? VARIN_INTEGRATION_SURFACES;
  return {
    enabledByDefault: true,
    manifest: {
      contributions: input.contributions,
      displayName: input.displayName,
      engines: { varin: "*" },
      entrypoints: {
        surfaces: [{
          id: VARIN_INTEGRATION_ENTRYPOINT_ID,
          mode: "declarative",
          supports,
        }],
      },
      id: input.id,
      ...(input.piPackages ? { integrates: { piPackages: input.piPackages } } : {}),
      ...(input.provides ? { provides: input.provides } : {}),
      schemaVersion: 1,
      version: VARIN_BUILTIN_EXTENSION_VERSION,
    },
  };
};

export const VARIN_BUILTIN_AGENTS_EXTENSION = definition({
  id: "varin.builtin.pi-agents",
  displayName: "Pi Agents Workbench",
  piPackages: ["pi-subagents", "@cortexkit/pi-magic-context"],
  contributions: [pageContribution({
    group: "harness",
    icon: "robot-2",
    id: "varin.builtin.pi-agents.page.agents",
    keywords: ["agent", "agents", "subagent", "subagents", "roles", "workflow"],
    kind: "split",
    order: 2,
    slug: "agents",
    title: "Agents",
    titleKey: "settings.page.agents.title",
  })],
});

export const VARIN_BUILTIN_MCP_EXTENSION = definition({
  id: "varin.builtin.pi-mcp",
  displayName: "Pi MCP Workbench",
  contributions: [pageContribution({
    group: "pi",
    icon: "mcp",
    id: "varin.builtin.pi-mcp.page.mcp",
    keywords: ["mcp", "model context protocol", "servers", "tools", "oauth"],
    kind: "split",
    order: 46,
    slug: "mcp",
    title: "MCP",
    titleKey: "settings.page.mcp.title",
  })],
});

export const VARIN_BUILTIN_PLUGIN_SETTINGS_EXTENSION = definition({
  id: "varin.builtin.pi-plugin-settings",
  displayName: "Pi Plugin Settings",
  contributions: [pageContribution({
    group: "pi",
    icon: "settings-3",
    id: "varin.builtin.pi-plugin-settings.page.plugin-settings",
    keywords: ["pi", "plugin", "settings", "configuration", "json", "jsonc"],
    kind: "split",
    order: 48,
    slug: "plugin-settings",
    title: "Plugin Settings",
    titleKey: "settings.page.pluginSettings.title",
  })],
});

export const VARIN_BUILTIN_RECOVERY_EXTENSION = definition({
  id: "varin.builtin.pi-recovery",
  displayName: "Varin Recovery",
  piPackages: [],
  contributions: [{
    contractVersion: 1,
    data: { contract: "pi-settings-panel/v1", panelId: "recovery" },
    entrypoint: VARIN_INTEGRATION_ENTRYPOINT_ID,
    id: "varin.builtin.pi-recovery.panel.recovery",
    kind: "panel",
    placement: { order: 40, slot: "settings.sessions.panels" },
    supports: VARIN_INTEGRATION_SURFACES,
  }],
});

export const VARIN_BUILTIN_HARNESS_EXTENSION = definition({
  id: "varin.builtin.pi-harness",
  displayName: "Agent Harness",
  contributions: [
    pageContribution({
      group: "harness",
      icon: "terminal",
      id: "varin.builtin.pi-harness.page.tools",
      keywords: ["harness", "agent", "tools", "shell", "bash", "output", "process"],
      kind: "single",
      order: 1,
      slug: "harness-tools",
      title: "Tools & Execution",
      titleKey: "settings.page.harness.page.tools.title",
    }),
    pageContribution({
      group: "harness",
      icon: "shield-check",
      id: "varin.builtin.pi-harness.page.permissions",
      keywords: ["harness", "permissions", "approval", "rules", "policy"],
      kind: "single",
      order: 0,
      slug: "harness-permissions",
      title: "Permissions & Policy",
      titleKey: "settings.page.harness.page.permissions.title",
    }),
    pageContribution({
      group: "harness",
      icon: "chat-history",
      id: "varin.builtin.pi-harness.page.context",
      keywords: ["harness", "context", "compaction", "preparation", "long session", "recovery", "next step"],
      kind: "single",
      order: 4,
      slug: "harness-context",
      title: "Context Management",
      titleKey: "settings.page.harness.page.context.title",
    }),
    pageContribution({
      group: "harness",
      icon: "search-eye",
      id: "varin.builtin.pi-harness.page.retrieval",
      keywords: ["harness", "retrieval", "embedding", "rerank", "code", "search"],
      kind: "single",
      order: 7,
      slug: "harness-retrieval",
      title: "Code Retrieval",
      titleKey: "settings.page.harness.page.retrieval.title",
    }),
    pageContribution({
      group: "harness",
      icon: "database-2",
      id: "varin.builtin.pi-harness.page.index",
      keywords: ["index", "embedding", "storage", "progress", "semantic"],
      kind: "single",
      order: 8,
      slug: "harness-index",
      title: "Semantic File Index",
      titleKey: "settings.page.harness.page.index.title",
    }),
    pageContribution({
      group: "harness",
      icon: "global",
      id: "varin.builtin.pi-harness.page.web",
      keywords: ["harness", "web", "search", "brave", "exa", "tavily", "jina", "searxng", "domains", "browser"],
      kind: "single",
      order: 6,
      slug: "harness-web",
      title: "Web Access",
      titleKey: "settings.page.harness.page.web.title",
    }),
    pageContribution({
      group: "harness",
      icon: "computer",
      id: "varin.builtin.pi-harness.page.computers",
      keywords: ["computer", "desktop", "computer use", "gui", "automation", "screen"],
      kind: "single",
      order: 10,
      slug: "harness-computers",
      title: "Computer Use",
      titleKey: "settings.page.harness.page.computers.title",
    }),
    pageContribution({
      group: "harness",
      icon: "robot",
      id: "varin.builtin.pi-harness.page.bots",
      keywords: ["bot", "bots", "assistant", "persona", "durable agent"],
      kind: "single",
      order: 9,
      slug: "harness-bots",
      title: "Bots",
      titleKey: "settings.page.harness.page.bots.title",
    }),
  ],
});

const AGENT_FEATURE_TARGETS = [
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
];

export const VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION = definition({
  id: VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  displayName: "Agent Workspace",
  contributions: [{
    contractVersion: 1,
    data: {
      contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
      seams: {
        web: {
          replacementTargets: [
            ...AGENT_FEATURE_TARGETS,
            VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
          ],
          slots: [],
        },
        desktop: {
          replacementTargets: [
            ...AGENT_FEATURE_TARGETS,
            VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
          ],
          slots: [],
        },
        mobile: {
          replacementTargets: AGENT_FEATURE_TARGETS,
          slots: [],
        },
      },
    },
    entrypoint: VARIN_INTEGRATION_ENTRYPOINT_ID,
    id: VARIN_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
    kind: "shell",
    replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
    supports: VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES,
  }],
});

const IDE_FEATURE_TARGETS = [
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
];

const IDE_STRUCTURE_TARGETS = [
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.activity,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.editor,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.panel,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.status,
];

const IDE_SLOTS = [
  VARIN_WORKBENCH_SLOTS.activityItems,
  VARIN_WORKBENCH_SLOTS.primarySidebarViews,
  VARIN_WORKBENCH_SLOTS.editorActions,
  VARIN_WORKBENCH_SLOTS.secondarySidebarViews,
  VARIN_WORKBENCH_SLOTS.panelViews,
  VARIN_WORKBENCH_SLOTS.statusItems,
];

const ideSeams = () => ({
  replacementTargets: [...IDE_FEATURE_TARGETS, ...IDE_STRUCTURE_TARGETS],
  slots: IDE_SLOTS,
});

export const VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION = definition({
  id: VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  displayName: "IDE Workbench",
  supports: VARIN_BUILTIN_IDE_WORKBENCH_SURFACES,
  provides: {
    services: [{
      id: VARIN_WORKBENCH_LAYOUT_SERVICE_ID,
      multiple: true,
      version: VARIN_CORE_SERVICE_VERSION,
    }],
  },
  contributions: [{
    contractVersion: 1,
    data: {
      contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
      seams: Object.fromEntries(
        VARIN_BUILTIN_IDE_WORKBENCH_SURFACES.map((surface) => [surface, ideSeams()]),
      ),
    },
    entrypoint: VARIN_INTEGRATION_ENTRYPOINT_ID,
    id: VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
    kind: "shell",
    replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
    supports: VARIN_BUILTIN_IDE_WORKBENCH_SURFACES,
  }],
});

const RESEARCH_SHELL_TARGETS = [
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.agents,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.mcp,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.settings,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
];

export const VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION = definition({
  id: VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION_ID,
  displayName: "Research Workbench",
  supports: VARIN_BUILTIN_RESEARCH_WORKBENCH_SURFACES,
  contributions: [{
    contractVersion: 1,
    data: {
      contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
      seams: Object.fromEntries(
        VARIN_BUILTIN_RESEARCH_WORKBENCH_SURFACES.map((surface) => [surface, {
          replacementTargets: RESEARCH_SHELL_TARGETS,
          slots: [],
        }]),
      ),
    },
    entrypoint: VARIN_INTEGRATION_ENTRYPOINT_ID,
    id: VARIN_BUILTIN_RESEARCH_WORKBENCH_SHELL_CONTRIBUTION_ID,
    kind: "shell",
    replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
    supports: VARIN_BUILTIN_RESEARCH_WORKBENCH_SURFACES,
  }],
});

export const VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION = definition({
  id: VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION_ID,
  displayName: "Varin bot",
  supports: VARIN_BUILTIN_BOT_WORKSPACE_SURFACES,
  contributions: [{
    contractVersion: 1,
    data: {
      contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
      seams: Object.fromEntries(
        VARIN_BUILTIN_BOT_WORKSPACE_SURFACES.map((surface) => [surface, {
          replacementTargets: surface === "mobile"
            ? AGENT_FEATURE_TARGETS
            : [...AGENT_FEATURE_TARGETS, VARIN_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer],
          slots: [],
        }]),
      ),
    },
    entrypoint: VARIN_INTEGRATION_ENTRYPOINT_ID,
    id: VARIN_BUILTIN_BOT_WORKSPACE_SHELL_CONTRIBUTION_ID,
    kind: "shell",
    replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
    supports: VARIN_BUILTIN_BOT_WORKSPACE_SURFACES,
  }],
});

export const VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION = definition({
  id: VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION_ID,
  displayName: "Varin Transition Scene",
  supports: VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES,
  contributions: [{
    contractVersion: 1,
    data: {
      contract: VARIN_TRANSITION_SCENE_DATA_CONTRACT,
      durations: {
        [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
          covering: { quick: 1_040, reduced: 260, standard: 1_900 },
          revealing: { quick: 1_040, reduced: 260, standard: 1_900 },
        },
      },
      fallback: true,
      scenes: [VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE],
    },
    entrypoint: VARIN_INTEGRATION_ENTRYPOINT_ID,
    id: VARIN_BUILTIN_TRANSITION_SCENE_CONTRIBUTION_ID,
    kind: "transition-scene",
    replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition },
    supports: VARIN_BUILTIN_AGENT_WORKSPACE_SURFACES,
  }],
});

export const VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION: VarinBuiltinExtensionDefinition = {
  enabledByDefault: true,
  manifest: {
    capabilities: { host: ["workspace.language"] },
    displayName: "TypeScript and JavaScript Language Service",
    engines: { varin: "*" },
    entrypoints: {
      host: {
        activation: ["workspace-match"],
        file: "host.cjs",
        mode: "brokered",
      },
    },
    id: VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
    schemaVersion: 1,
    version: VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_VERSION,
  },
};

export const VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION: VarinBuiltinExtensionDefinition = {
  enabledByDefault: true,
  manifest: {
    capabilities: { host: ["workspace.language"] },
    displayName: "Built-in Language Servers",
    engines: { varin: "*" },
    entrypoints: {
      host: {
        activation: ["workspace-match"],
        file: "host.cjs",
        mode: "brokered",
      },
    },
    id: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
    schemaVersion: 1,
    version: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_VERSION,
  },
};

export const VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION: VarinBuiltinExtensionDefinition = {
  enabledByDefault: true,
  manifest: {
    id: VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID, displayName: "Varin Context Guidance",
    version: "1.0.0", schemaVersion: 1, engines: { varin: "*" },
    entrypoints: { host: { activation: ["service-request"], file: "host.cjs", mode: "brokered" } },
    provides: { services: [{ id: "varin.context.fragments", version: 1, multiple: true }] },
  },
};

const retrievalPlanDefinition = (id: string, displayName: string): VarinBuiltinExtensionDefinition => ({
  enabledByDefault: true,
  manifest: {
    id, displayName, version: "1.0.0", schemaVersion: 1, engines: { varin: "*" },
    entrypoints: { host: { activation: ["service-request"], file: "host.cjs", mode: "brokered" } },
    provides: { services: [{ id: VARIN_RETRIEVAL_PLAN_SERVICE_ID, version: VARIN_RETRIEVAL_PLAN_VERSION, multiple: true }] },
  },
});

export const VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION = retrievalPlanDefinition(
  VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION_ID, "Native Retrieval: Keyword and Structure",
);
export const VARIN_BUILTIN_RETRIEVAL_KEYWORD_EXTENSION = retrievalPlanDefinition(
  VARIN_BUILTIN_RETRIEVAL_KEYWORD_EXTENSION_ID, "Native Retrieval: Keyword Only",
);

export const VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION: VarinBuiltinExtensionDefinition = {
  enabledByDefault: true,
  manifest: {
    capabilities: { host: ["workspace.recovery-primitives"] },
    displayName: "Varin Workspace Recovery",
    engines: { varin: "*" },
    entrypoints: {
      host: {
        activation: ["service-request"],
        file: "host.cjs",
        mode: "brokered",
      },
    },
    id: VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
    provides: {
      services: [{
        id: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
        multiple: true,
        version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
      }],
    },
    schemaVersion: 1,
    storage: { schemaVersion: 1 },
    version: VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_VERSION,
  },
};

const pluginAdapter = (
  suffix: string,
  displayName: string,
  adapterId: string,
  icon: string,
  packageNames: string[],
): VarinBuiltinExtensionDefinition => {
  const id = `varin.builtin.plugin-adapter.${suffix}`;
  return definition({
    id,
    displayName,
    piPackages: packageNames,
    contributions: [pluginAdapterContribution(id, adapterId, icon, packageNames)],
  });
};

export const VARIN_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS = [
  pluginAdapter("mcp", "MCP Settings Adapter", "mcp", "server", ["@varin/pi-mcp-adapter", "pi-mcp-adapter"]),
  pluginAdapter("subagents", "pi-subagents Settings Adapter", "subagents", "robot-2", ["pi-subagents"]),
  pluginAdapter("magic-context", "Magic Context Settings Adapter", "magic-context", "brain", ["@cortexkit/pi-magic-context"]),
  pluginAdapter("web-access", "Web Access Settings Adapter", "web-access", "global", ["pi-web-access"]),
  pluginAdapter("openai-codex-compat", "OpenAI Codex Compatibility Settings Adapter", "openai-codex-compat", "code-box", ["pi-openai-codex-compat"]),
  pluginAdapter("observational-memory", "Observational Memory Settings Adapter", "observational-memory", "brain", ["pi-observational-memory"]),
  pluginAdapter("context-mode", "Context Mode Integration Adapter", "context-mode", "database-2", ["context-mode"]),
  pluginAdapter("aft", "AFT Settings Adapter", "aft", "tools", ["@cortexkit/aft-pi"]),
  pluginAdapter("pi-lens", "pi-lens Settings Adapter", "pi-lens", "pulse", ["pi-lens"]),
  pluginAdapter("hermes-memory", "Hermes Memory Settings Adapter", "hermes-memory", "brain", ["pi-hermes-memory"]),
  pluginAdapter("rtk", "RTK Optimizer Settings Adapter", "rtk", "terminal-box", ["pi-rtk-optimizer"]),
] as const;

export const VARIN_BUILTIN_EXTENSION_DEFINITIONS: readonly VarinBuiltinExtensionDefinition[] = [
  VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION,
  VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION,
  VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION,
  VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION,
  VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION,
  VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION,
  VARIN_BUILTIN_RETRIEVAL_KEYWORD_EXTENSION,
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION,
  VARIN_BUILTIN_RESEARCH_WORKBENCH_EXTENSION,
  VARIN_BUILTIN_BOT_WORKSPACE_EXTENSION,
  VARIN_BUILTIN_AGENTS_EXTENSION,
  VARIN_BUILTIN_MCP_EXTENSION,
  VARIN_BUILTIN_PLUGIN_SETTINGS_EXTENSION,
  VARIN_BUILTIN_RECOVERY_EXTENSION,
  VARIN_BUILTIN_HARNESS_EXTENSION,
  ...VARIN_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS,
];

export const varinBuiltinDefinition = (extensionId: string): VarinBuiltinExtensionDefinition | undefined => (
  VARIN_BUILTIN_EXTENSION_DEFINITIONS.find((definition) => definition.manifest.id === extensionId)
);
