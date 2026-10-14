/** Application Host MCP configuration and sign-in, independent of conversation runtimes. */
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';
export interface AuthorizationState { id: string; status: 'pending' | 'completed' | 'cancelled' | 'failed'; authorizationUrl?: string; message?: string }
export interface McpConfigurationSource { path: string; scope: 'global' | 'project' }
export interface McpConfigurationServer {
  name: string; source: string; override?: string; enabled: boolean; exposure: string;
  status: string; cachedToolCount: number; connectedToolCount: number; error?: string;
  canSignIn: boolean;
}
export interface McpConfigurationSnapshot { view: string; sources: McpConfigurationSource[]; servers: McpConfigurationServer[]; issues: string[] }
export interface McpConfigurationDocument { path: string; content: string; revision: string; exists: boolean }
export function createMcpConnectionsHttpAPI(generation = getRuntimeEndpointGeneration()) {
  const post = async <T>(action: string, value: unknown, signal?: AbortSignal): Promise<T> => {
    const check = () => { signal?.throwIfAborted(); if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed. Reload settings.'); };
    check();
    const response = await runtimeFetch(`/api/mcp/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), ...(signal ? { signal } : {}) });
    const result = await response.json(); check();
    if (!response.ok) throw new Error(result.message ?? 'MCP configuration request failed');
    return result as T;
  };
  return {
    open: (cwd?: string, signal?: AbortSignal) => post<McpConfigurationSnapshot>('open', { cwd }, signal),
    read: (view: string, signal?: AbortSignal) => post<McpConfigurationSnapshot>('read', { view }, signal),
    readDocument: (view: string, path: string, signal?: AbortSignal) => post<McpConfigurationDocument>('document/read', { view, path }, signal),
    saveDocument: (view: string, path: string, content: string, expectedRevision: string, signal?: AbortSignal) => post<McpConfigurationDocument>('document/save', { view, path, content, expectedRevision }, signal),
    command: (view: string, name: string, command: 'connect' | 'reconnect' | 'disconnect' | 'sign-out', signal?: AbortSignal) => post<McpConfigurationSnapshot>('command', { view, name, command }, signal),
    signIn: (view: string, name: string, signal?: AbortSignal) => post<AuthorizationState>('authorization/start', { view, name }, signal),
    authorization: (view: string, id: string, signal?: AbortSignal) => post<AuthorizationState>('authorization/read', { view, id }, signal),
    reply: (view: string, id: string, redirect: string) => post<void>('authorization/reply', { view, id, redirect }),
    cancelAuthorization: (view: string, id: string) => post<void>('authorization/cancel', { view, id }),
    close: (view: string) => post<void>('close', { view }),
  };
}
