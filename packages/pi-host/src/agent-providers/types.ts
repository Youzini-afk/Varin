import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  JsonValue,
  PiAgentDescriptor,
  PiAgentDiagnostic,
  PiAgentProviderActionResult,
  PiAgentProviderDescriptor,
  PiSettingsSnapshot,
} from "@varin/protocol";

export interface AgentProviderContext {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  session: AgentSession;
  nativeSettings?: {
    read(): Promise<PiSettingsSnapshot>;
    write(harness: JsonValue, revision: string): Promise<PiSettingsSnapshot>;
  };
}

export interface AgentProviderListResult {
  agents: PiAgentDescriptor[];
  diagnostics: PiAgentDiagnostic[];
}

export interface AgentProviderAdapter {
  readonly descriptor: PiAgentProviderDescriptor;
  list(): Promise<AgentProviderListResult>;
  action?(
    action: string,
    agentId: string | undefined,
    input: JsonValue | undefined,
  ): Promise<PiAgentProviderActionResult>;
}
