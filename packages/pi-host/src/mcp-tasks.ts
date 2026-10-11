/** Task protocol validation over the original client's request API. No transport or durable owner. */
import type { McpEndpoint, McpTaskState } from '@varin/protocol';
import type { McpClient, Tool } from '@earendil-works/pi-mcp';
export type { McpEndpoint, McpTaskState } from '@varin/protocol';
export type McpTaskSupport = 'forbidden' | 'optional' | 'required';
/** Tool-level requirements apply only after the request capability is negotiated. */
export const requiresMcpTask = (tool:{taskSupport:McpTaskSupport;taskCapable:boolean}):boolean => tool.taskCapable && tool.taskSupport === 'required';
export interface McpTaskResponse { task: McpTaskState; result: Record<string, unknown> }
export interface McpTaskLease {
  readonly endpoint: McpEndpoint;
  start(name: string, arguments_: Record<string, unknown>, options: {schemaVersion:string;signal:AbortSignal;ttl?:number;beforeDispatch?:()=>void|Promise<void>}): Promise<McpTaskResponse>;
  get(taskId:string, signal:AbortSignal):Promise<McpTaskResponse>;
  result(taskId:string, signal:AbortSignal):Promise<Record<string,unknown>>;
  cancel(taskId:string, signal:AbortSignal):Promise<McpTaskResponse>;
  onChange(listener:(taskId:string, unsupported?:boolean)=>void):()=>void;
  release():void;
}
export const object = (value:unknown):value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function taskCapabilities(client: McpClient | undefined): {supported:boolean;call:boolean;cancel:boolean;list:boolean} {
  const capabilities: unknown = client?.serverCapabilities;
  const tasks = object(capabilities) && object(capabilities.tasks) ? capabilities.tasks : undefined;
  const requests = tasks && object(tasks.requests) ? tasks.requests : undefined;
  const tools = requests && object(requests.tools) ? requests.tools : undefined;
  const supported = client?.protocolVersion === '2025-11-25';
  return {supported:supported && !!tasks,call: supported && !!tools && object(tools.call), cancel:supported && !!tasks && object(tasks.cancel),list:supported && !!tasks && object(tasks.list)};
}
export function taskSupport(tool: Tool): McpTaskSupport {
  const support = tool.execution?.taskSupport;
  if (support === undefined) return 'forbidden';
  if (support !== 'forbidden' && support !== 'optional' && support !== 'required') throw new Error('mcp_task_declaration_invalid');
  return support;
}
function invalid():never { throw new Error('mcp_task_response_invalid'); }
export function validateTaskResponse(value:unknown, creation=false):McpTaskResponse {
  if (!object(value)) return invalid();
  const raw = creation ? value.task : value;
  if (!object(raw) || typeof raw.taskId !== 'string' || !raw.taskId
    || !['working','input_required','completed','failed','cancelled'].includes(String(raw.status))
    || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))
    || typeof raw.lastUpdatedAt !== 'string' || !Number.isFinite(Date.parse(raw.lastUpdatedAt))
    || !(raw.ttl === null || Number.isSafeInteger(raw.ttl) && Number(raw.ttl) >= 0)
    || (raw.pollInterval !== undefined && (!Number.isSafeInteger(raw.pollInterval) || Number(raw.pollInterval) < 0))
    || (raw.statusMessage !== undefined && typeof raw.statusMessage !== 'string')
    || creation && raw.status !== 'working') return invalid();
  const {taskId,status,createdAt,lastUpdatedAt,ttl,pollInterval} = raw;
  return {task:{taskId,status:status as McpTaskState['status'],createdAt,lastUpdatedAt,ttl:ttl as number|null,
    ...(pollInterval === undefined ? {} : {pollInterval:pollInterval as number})},result:value};
}
export function validateTaskResult(value:unknown, taskId:string):Record<string,unknown> {
  if (!object(value) || !Array.isArray(value.content)
    || (value.isError !== undefined && typeof value.isError !== 'boolean')
    || (value.structuredContent !== undefined && !object(value.structuredContent))) return invalid();
  const meta = object(value._meta) ? value._meta : undefined;
  const related = meta && object(meta['io.modelcontextprotocol/related-task']) ? meta['io.modelcontextprotocol/related-task'] : undefined;
  if (!related || related.taskId !== taskId) return invalid();
  return value;
}
