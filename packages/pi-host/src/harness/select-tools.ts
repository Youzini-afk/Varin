import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessSettings, ResolvedPreset, ResearchCapabilityOption } from "@varin/protocol";
import { createBashTool } from "./bash-tool.js";
import { createGrepTool } from "./grep-tool.js";
import { createApplyPatchTool } from "./apply-patch-tool.js";
import {
  createGetOutputTool,
  createWriteToProcessTool,
  createKillShellTool,
  createDiagnosticsTool,
} from "./output-tools.js";
import { createWebFetchTool } from "./webfetch-tool.js";
import { createNetworkDiagnosticsTool } from "./network-diagnostics-tool.js";
import { createWebSearchTool } from "./websearch-tool.js";
import { createResearchSearchTool } from "./research-search-tool.js";
import { createMaterialsTool } from "./materials-tool.js";
import { createResearchDecideTool } from "./research-decide-tool.js";
import { createTodoTool } from "./todo-tool.js";
import { createRecallTool } from "./recall-tool.js";
import { createMemoryTool } from "./memory-tools.js";
import { createComputerTool } from "./computer-tools.js";
import { createExploreTool } from "./explore-tool.js";
import { createHistoryTool } from "./history-tool.js";
import { createRelatedTool } from "./related-tool.js";
import { createLspNavigationTools } from "./lsp-tools.js";
import { createSurfaceAwareReadTool } from "./read-tool.js";
import { createPiDocsTool } from "./pi-docs-tool.js";
import { createDocumentReadTool } from "./document-read-tool.js";
import { createSurfaceAwareFindTool } from "./find-tool.js";
import { createSurfaceAwareLsTool } from "./ls-tool.js";
import {
  createDispatchTool,
  createThreadsTool,
  createWaitTool,
  createSendTool,
  createReadThreadTool,
  createMergeTool,
  createSubmitCodeTool,
  createUpdateTool,
  createKillTool,
} from "./thread-tools.js";
import { createSubmitFactsTool } from "./submit-facts-tool.js";
import {
  createExperimentTool,
  createResourcesTool,
  createResearchSourceTool,
} from "./experiment-tools.js";
import {
  createSettingsSearchTool,
  createSettingsReadTool,
  createSettingsUpdateTool,
  createSettingsActionTool,
} from "./settings-tools.js";
import { createFollowUpTool } from "./follow-up-tools.js";
import { createScheduledTaskTool } from "./scheduled-task-tools.js";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { WorkspaceMutationJournalBridge } from "../workspace-mutation-journal.js";

import { withToolExecutionResources } from "./tool-execution-resources.js";

export interface SelectHarnessToolsDeps {
  bridge: HostServicesBridge;
  sessionId: string;
  cwd: string;
  workspaceMutationJournal: WorkspaceMutationJournalBridge | undefined;
  isOpenAIFamily: boolean;
  /** Whether the Host exposes real LanguageSupervisor navigation services. */
  lspNavigationAvailable?: boolean;
  /** Whether the Host exposes the Documents-backed native Pi read source. */
  documentReadAvailable?: boolean;
  /** Native Pi image resize setting, kept in sync with the built-in read tool. */
  autoResizeImages?: boolean;
  /** Whether the Host exposes the Documents-backed native Pi find/ls overlay. */
  documentPathOverlayAvailable?: boolean;
  /** Session-local reader model path; absent keeps webfetch extraction-only. */
  readPage?: NonNullable<Parameters<typeof createWebFetchTool>[2]>["readPage"];
  /** Session-local explore model path; absent keeps algorithm/vector explore. */
  completeExplore?: NonNullable<Parameters<typeof createExploreTool>[2]>["complete"];
  /** Whether the host registered a real web.search service. */
  webSearchAvailable?: boolean;
  /** Whether the Host registered public scholarly metadata search. */
  researchSearchAvailable?: boolean;
  /** Whether the Host registered the material collection service (D-315 L3). */
  materialsAvailable?: boolean;
  /** Whether the host provides a thread runtime (thread registry + spawn).
   * When false, thread tools are not registered. */
  threadRuntimeAvailable?: boolean;
  /** Whether the Host registered experiment/resource/source services (7C/7D).
   * When false, the experiment tool family is not registered. */
  experimentAvailable?: boolean;
  /** Whether the Host registered the shared settings catalog service (D-306). */
  settingsAvailable?: boolean;
  /** Whether the Host provides durable follow-up registrations bound to a
   * thread (D-307). Requires the thread runtime — the continuation target. */
  followUpAvailable?: boolean;
  /** Whether the Host exposes the project scheduled-task authority (D-307). */
  scheduledTasksAvailable?: boolean;
  /** Execution presets for the initial team prompt; the Host resolves new dispatches. */
  resolvedPresets?: readonly ResolvedPreset[];
  /** Research capability model slots resolved for this worker. */
  researchCapabilities?: readonly ResearchCapabilityOption[];
  /** Read current user choices when assigning a research capability to new work. */
  getResearchCapabilities?: () => Promise<readonly ResearchCapabilityOption[]>;
  /** Active tool names of the dispatching session; the normal-dispatch tool default. */
  getActiveToolNames?: () => string[];
  /** Frozen session tool allowlist; submit_facts registers only when this includes it. */
  sessionToolAllowlist?: readonly string[];
}

/**
 * Pure function: given HarnessSettings + deps, returns the list of harness
 * ToolDefinitions to register. session-host calls this; tests verify gating
 * without needing a real session.
 *
 * Override tools (read, bash, grep) fall back to Pi built-in when disabled or
 * when the Host does not advertise the required source service — they
 * are simply omitted from the returned list.
 * New tools (get_output, write_to_process, kill_shell, diagnostics,
 * apply_patch) are omitted when disabled.
 * apply_patch is only included when isOpenAIFamily is true AND not disabled.
 * webfetch / websearch remain Varin-native unless explicitly disabled in
 * harness.tools. Installing pi-web-access does not silently replace them.
 * websearch uses the Host's default search unless the user selected a provider.
 */
export function selectHarnessTools(
  settings: HarnessSettings,
  deps: SelectHarnessToolsDeps,
): ToolDefinition[] {
  const tools = settings.tools;
  const {
    bridge,
    sessionId,
    cwd,
    workspaceMutationJournal,
    isOpenAIFamily,
    lspNavigationAvailable,
    documentReadAvailable,
    documentPathOverlayAvailable,
    autoResizeImages,
    readPage,
    webSearchAvailable,
    researchSearchAvailable,
    materialsAvailable,
    threadRuntimeAvailable,
    experimentAvailable,
    settingsAvailable,
    followUpAvailable,
    scheduledTasksAvailable,
    resolvedPresets,
    researchCapabilities,
    getResearchCapabilities,
    getActiveToolNames,
    sessionToolAllowlist,
  } = deps;
  const result: ToolDefinition[] = [];

  if (tools.pi_docs !== false) result.push(createPiDocsTool());

  if (tools.bash !== false) {
    result.push(createBashTool(bridge, sessionId, cwd, settings.bash.waitMs));
  }
  if (documentReadAvailable && tools.read !== false) {
    result.push(createSurfaceAwareReadTool(
      bridge,
      cwd,
      { ...(autoResizeImages === undefined ? {} : { autoResizeImages }) },
    ));
  }
  if (documentReadAvailable && tools.document_read !== false) {
    result.push(createDocumentReadTool(bridge));
  }
  if (documentPathOverlayAvailable) {
    if (tools.find !== false) result.push(createSurfaceAwareFindTool(bridge, cwd));
    if (tools.ls !== false) result.push(createSurfaceAwareLsTool(bridge, cwd));
  }
  if (tools.grep !== false) {
    result.push(createGrepTool(bridge, sessionId));
  }
  if (tools.get_output !== false) {
    result.push(createGetOutputTool(bridge, sessionId));
  }
  if (tools.write_to_process !== false) {
    result.push(createWriteToProcessTool(bridge, sessionId));
  }
  if (tools.kill_shell !== false) {
    result.push(createKillShellTool(bridge, sessionId));
  }
  if (tools.diagnostics !== false) {
    result.push(createDiagnosticsTool(bridge, sessionId));
  }
  if (lspNavigationAvailable) {
    const navigationTools = createLspNavigationTools(bridge);
    for (const tool of navigationTools) {
      if (tools[tool.name] !== false) result.push(tool);
    }
  }
  if (isOpenAIFamily && tools.apply_patch !== false) {
    result.push(
      createApplyPatchTool(bridge, sessionId, cwd, workspaceMutationJournal, {
        // Reads follow the fixed draft only when the Host advertises that
        // source, so surface writes apply under the same condition (D-225).
        surfaceWrite: documentReadAvailable === true,
      }),
    );
  }
  if (tools.webfetch !== false) {
    result.push(createWebFetchTool(bridge, sessionId, readPage ? { readPage } : undefined));
    // Read-only egress probe ships with the web slot: fetch failures are
    // where an agent needs proxy/DNS/policy diagnostics.
    result.push(createNetworkDiagnosticsTool(bridge));
  }
  if (webSearchAvailable && tools.websearch !== false) {
    result.push(createWebSearchTool(bridge, sessionId));
  }
  if (researchSearchAvailable && tools.research_search !== false) {
    result.push(createResearchSearchTool(bridge));
  }
  // research_decide reports unconfigured/disabled fast-decision honestly, so
  // it registers with the web slot even before a purpose binding exists.
  if ((webSearchAvailable || researchSearchAvailable) && tools.research_decide !== false) {
    result.push(createResearchDecideTool(bridge));
  }
  if (materialsAvailable && tools.materials !== false) {
    result.push(createMaterialsTool(bridge));
  }
  // Phase 2 tools
  if (tools.todo !== false) {
    result.push(createTodoTool(bridge));
  }
  if (tools.recall !== false) {
    result.push(createRecallTool(bridge, sessionId));
  }
  if (tools.memory !== false) {
    result.push(createMemoryTool(bridge, sessionId));
  }
  // Computer Use registers unconditionally like research_decide: when no
  // desktop/driver is available the service reports it honestly rather than
  // silently hiding the tool.
  if (tools.computer !== false) {
    result.push(createComputerTool(bridge, sessionId));
  }
  if (tools.explore !== false) {
    result.push(createExploreTool(bridge, sessionId, deps.completeExplore ? { complete: deps.completeExplore } : undefined));
  }
  if (tools.related !== false) {
    result.push(createRelatedTool(bridge, sessionId));
  }
  if (tools.history !== false) {
    result.push(createHistoryTool(threadRuntimeAvailable ? bridge : undefined));
  }
  // Phase 3 thread tools — only registered when the host provides a
  // thread runtime (thread registry + spawn capability).
  if (threadRuntimeAvailable) {
    if (tools.dispatch !== false) {
      result.push(createDispatchTool(bridge, sessionId, resolvedPresets ?? [], {
        concurrency: settings.dispatch.concurrency,
        ...(getActiveToolNames ? { getActiveToolNames } : {}),
        ...(researchCapabilities ? { researchCapabilities } : {}),
        ...(getResearchCapabilities ? { getResearchCapabilities } : {}),
      }));
    }
    if (tools.threads !== false) {
      result.push(createThreadsTool(bridge, sessionId));
    }
    if (tools.wait !== false) {
      result.push(createWaitTool(bridge, sessionId));
    }
    if (tools.send !== false) {
      result.push(createSendTool(bridge, sessionId, {
        ...(researchCapabilities ? { researchCapabilities } : {}),
        ...(getResearchCapabilities ? { getResearchCapabilities } : {}),
      }));
    }
    if (tools.read_thread !== false) {
      result.push(createReadThreadTool(bridge, sessionId));
    }
    if (tools.merge !== false) {
      result.push(createMergeTool(bridge, sessionId));
    }
    if (tools.submit_code !== false) result.push(createSubmitCodeTool(bridge, sessionId));
    if (tools.update !== false) {
      result.push(createUpdateTool(bridge, sessionId));
    }
    if (tools.kill !== false) {
      result.push(createKillTool(bridge, sessionId));
    }
  }
  // Experiment tools — only registered when the Host exposes the
  // experiment/resource/source services (7C/7D, D-300).
  if (experimentAvailable) {
    if (tools.experiment !== false) {
      result.push(createExperimentTool(bridge, sessionId));
    }
    if (tools.resources !== false) {
      result.push(createResourcesTool(bridge, sessionId));
    }
    if (tools.research_source !== false) {
      result.push(createResearchSourceTool(bridge, sessionId));
    }
  }
  // Settings tools — the shared catalog service (D-306). One family covers
  // search/read/update; the catalog itself stays out of the prompt.
  if (settingsAvailable) {
    if (tools.settings_search !== false) {
      result.push(createSettingsSearchTool(bridge));
    }
    if (tools.settings_read !== false) {
      result.push(createSettingsReadTool(bridge));
    }
    if (tools.settings_update !== false) {
      result.push(createSettingsUpdateTool(bridge));
    }
    if (tools.settings_action !== false) {
      result.push(createSettingsActionTool(bridge));
    }
  }
  // Follow-up tool — durable wait + continuation on this thread (D-307).
  // Requires the thread runtime: the trigger resumes the same thread through
  // normal admission, which does not exist without it.
  if (followUpAvailable) {
    if (tools.follow_up !== false) {
      result.push(createFollowUpTool(bridge));
    }
  }
  // Calendar task management — the project scheduler authority (D-307 W-C).
  // Distinct from follow_up: these create new sessions on a schedule, not
  // continuations of this thread.
  if (scheduledTasksAvailable) {
    if (tools.scheduled_task !== false) {
      result.push(createScheduledTaskTool(bridge));
    }
  }
  if (
    tools.submit_facts !== false
    && sessionToolAllowlist?.includes("submit_facts")
  ) {
    result.push(createSubmitFactsTool(bridge));
  }

  return result.map((tool) => withToolExecutionResources(tool, cwd));
}
