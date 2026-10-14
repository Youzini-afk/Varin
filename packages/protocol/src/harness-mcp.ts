/** Credential-free MCP configuration and live connections owned by the Application Host. */
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
