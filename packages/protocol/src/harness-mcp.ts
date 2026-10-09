/** Private Pi-worker ↔ Application Host MCP owner channel. No credential values are returned. */
export interface McpOwnerEntry {
  name: string;
  config: Record<string, unknown>;
  source: string;
  scope?: "global" | "project" | "extension";
  override?: string;
}
export interface McpOwnerConnectionSnapshot {
  handle: string;
  generation: number;
  entry: McpOwnerEntry;
  state: "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";
  error?: string;
  tools: Array<{ name: string; title?: string; description?: string; inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>; annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
    execution?: { taskSupport?: "forbidden" | "optional" | "required" }; _meta?: Record<string, unknown> }>;
  schemaVersions: Record<string, string>;
  hasResources: boolean;
  resources: unknown[];
  resourceTemplates: unknown[];
  instructions?: string;
  timeoutMs: number;
  oauthUrl?: string;
  credentialRevision: string;
}
export interface McpOwnerConfig {
  servers: McpOwnerEntry[];
  autoEnableCodemode?: boolean;
  errors: string[];
  projectConfig?: string;
}
export type McpOwnerRequest =
  | { operation: "open" }
  | { operation: "close"; scope: string }
  | { operation: "connect"; scope: string; entry: McpOwnerEntry }
  | { operation: "updateConfig"; scope: string; name: string; projectOverride: boolean; patch: { enabled?: boolean; exposure?: "direct" | "codemode" | "deferred" | "hidden" } }
  | { operation: "snapshot" | "reconnect" | "signOut" | "release"; scope: string; handle: string }
  | { operation: "callTool"; scope: string; handle: string; tool: string; schemaVersion: string; arguments: Record<string, unknown> }
  | { operation: "readResource"; scope: string; handle: string; uri: string }
  | { operation: "resourcesPage" | "resourceTemplatesPage"; scope: string; handle: string; cursor?: string }
  | { operation: "allResources" | "allResourceTemplates"; scope: string; handle: string }
  | { operation: "authStart"; scope: string; handle: string }
  | { operation: "authPoll" | "authCancel"; scope: string; flow: string }
  | { operation: "authReply"; scope: string; flow: string; redirectUrl?: string };
export interface McpOwnerAuthState {
  flow: string;
  state: "pending" | "succeeded" | "failed";
  authorizationUrl?: string;
  error?: string;
}
/** Operation discriminant narrows this transport response at the private adapter. */
export interface McpOwnerResponse {
  scope?: string;
  config?: McpOwnerConfig;
  connection?: McpOwnerConnectionSnapshot;
  value?: unknown;
  auth?: McpOwnerAuthState;
}
