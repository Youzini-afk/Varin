/** Native protocol declarations, over the original MCP connection. No transport or permission owner. */
export type McpServiceKind = 'resources' | 'prompts';
export type McpServiceOperation = 'resources/list' | 'resources/templates/list' | 'resources/read' | 'prompts/list' | 'prompts/get';
export interface McpAuthorityService {
  server: string;
  kind: McpServiceKind;
  schemaVersion: string;
  resourceKey: string;
}
export interface McpPromptDeclaration extends Record<string, unknown> {
  name: string;
  arguments?: { name: string; description?: string; required?: boolean; [key: string]: unknown }[];
}
export interface McpAuthorityPrompt {
  service: McpAuthorityService;
  name: string;
  schemaVersion: string;
  declaration: McpPromptDeclaration;
}
export type McpServiceRequest =
  | { operation: 'resources/list' | 'resources/templates/list' | 'prompts/list'; cursor?: string }
  | { operation: 'resources/read'; uri: string }
  | { operation: 'prompts/get'; prompt: McpAuthorityPrompt; arguments: Record<string, string> };
export interface McpServiceResult {
  result: Record<string, unknown>;
  promptVersions?: { name: string; schemaVersion: string }[];
}
export const isMcpObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function serviceKind(operation: McpServiceOperation): McpServiceKind {
  switch (operation) {
    case 'resources/list': case 'resources/templates/list': case 'resources/read': return 'resources';
    case 'prompts/list': case 'prompts/get': return 'prompts';
    default: throw new Error('mcp_service_operation_invalid');
  }
}
function invalid(): never { throw new Error('mcp_service_response_invalid'); }
function resource(value: unknown): boolean {
  return isMcpObject(value) && typeof value.uri === 'string'
    && (typeof value.text === 'string' || typeof value.blob === 'string');
}
function content(value: unknown): boolean {
  if (!isMcpObject(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'text': return typeof value.text === 'string';
    case 'image': case 'audio': return typeof value.data === 'string';
    case 'resource': return resource(value.resource);
    case 'resource_link': return typeof value.uri === 'string' && typeof value.name === 'string';
    // Future protocol content remains data. Never recursively interpret unknown fields.
    default: return true;
  }
}
export function validateServiceResult(operation: McpServiceOperation, value: unknown): Record<string, unknown> {
  if (!isMcpObject(value)) return invalid();
  if (operation === 'resources/read') {
    if (!Array.isArray(value.contents) || !value.contents.every(resource)) return invalid();
  } else if (operation === 'prompts/get') {
    if (!Array.isArray(value.messages) || !value.messages.every(message => isMcpObject(message)
      && (message.role === 'user' || message.role === 'assistant') && content(message.content))) return invalid();
  } else {
    if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string') return invalid();
    const key = operation === 'resources/list' ? 'resources' : operation === 'resources/templates/list' ? 'resourceTemplates' : 'prompts';
    if (!Array.isArray(value[key])) return invalid();
    for (const item of value[key]) {
      if (!isMcpObject(item) || typeof item.name !== 'string') return invalid();
      if (operation === 'resources/list' && typeof item.uri !== 'string') return invalid();
      if (operation === 'resources/templates/list' && typeof item.uriTemplate !== 'string') return invalid();
      if (operation === 'prompts/list' && item.arguments !== undefined) {
        if (!Array.isArray(item.arguments) || !item.arguments.every(argument => isMcpObject(argument)
          && typeof argument.name === 'string'
          && (argument.required === undefined || typeof argument.required === 'boolean'))) return invalid();
      }
    }
  }
  return value;
}
export function validatePromptArguments(prompt: McpPromptDeclaration, args: unknown): asserts args is Record<string, string> {
  if (!isMcpObject(args) || Object.values(args).some(value => typeof value !== 'string')) throw new Error('mcp_prompt_arguments_invalid');
  if ((prompt.arguments ?? []).some(argument => argument.required && !Object.hasOwn(args, argument.name))) throw new Error('mcp_prompt_arguments_invalid');
}
