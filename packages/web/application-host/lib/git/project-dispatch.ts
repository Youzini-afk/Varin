import type { Express, Request } from 'express';
import { createGitHttpClient, createGitHubHttpAPI, createRuntimeUrlResolver, type ProjectGitCommand, type ProjectGitHubCommand } from '@varin/application-client';

export interface GitRouteResponse {
  status(code: number): GitRouteResponse;
  json(value: unknown): GitRouteResponse;
  setHeader(name: string, value: string): GitRouteResponse;
}
type GitRouteHandler = (request: Pick<Request, 'query' | 'body' | 'params'>, response: GitRouteResponse) => Promise<unknown>;
export type ProjectGitDispatcher = (command: ProjectGitCommand | ProjectGitHubCommand, signal?: AbortSignal) => Promise<unknown>;

/** One registration owns both HTTP and project dispatch. Project callers select
 * typed client operations, never a URL, handler name, or credential transport. */
export function createProjectGitRoutes(app: Express, family: 'git' | 'github' = 'git') {
  const handlers: Array<{ method: string; path: string; handler: GitRouteHandler }> = [];
  const register = (method: 'get' | 'post' | 'put' | 'delete', path: string, handler: GitRouteHandler) => {
    handlers.push({ method: method.toUpperCase(), path, handler });
    app[method](path, async (request, response) => { await handler(request, response); });
  };
  const dispatch: ProjectGitDispatcher = async (command, signal) => {
    signal?.throwIfAborted();
    const transport: Parameters<typeof createGitHttpClient>[0] = {
      runtimeKey: () => 'original-target-git',
      url: (path, query) => {
        const url = new URL(path, 'http://target.invalid');
        for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
        return url.toString();
      },
      fetch: async (input, init) => {
        signal?.throwIfAborted();
        const url = new URL(String(input), 'http://target.invalid');
        const method = String(init?.method ?? 'GET').toUpperCase();
        const requestParts = url.pathname.split('/');
        let params: Request['params'] = {};
        const route = handlers.find(candidate => {
          if (candidate.method !== method) return false;
          const parts = candidate.path.split('/');
          if (parts.length !== requestParts.length) return false;
          const values: Request['params'] = {};
          for (let i = 0; i < parts.length; i++) {
            if (parts[i]!.startsWith(':')) values[parts[i]!.slice(1)] = decodeURIComponent(requestParts[i]!);
            else if (parts[i] !== requestParts[i]) return false;
          }
          params = values; return true;
        });
        if (!route) throw new Error('Original Git operation has no registered target handler');
        let status = 200, body: unknown;
        const headers = new Headers({ 'content-type': 'application/json' });
        const response: GitRouteResponse = {
          status(value) { status = value; return response; },
          json(value) { body = value; return response; },
          setHeader(name, value) { headers.set(name, value); return response; },
        };
        await route.handler({ query: Object.fromEntries(url.searchParams), params,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }, response);
        // Preserve an actual mutation response after dispatch even if its caller
        // disconnected. Cancellation is not evidence that Git did not write.
        return new Response(JSON.stringify(body), { status, headers });
      },
    };
    const client = (family === 'git' ? createGitHttpClient(transport) : createGitHubHttpAPI({ urls: createRuntimeUrlResolver({ apiBaseUrl: 'http://target.invalid' }), fetch: transport.fetch! })) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    if (!command || typeof command.operation !== 'string' || !Object.hasOwn(client, command.operation) || !Array.isArray(command.args)) {
      throw new Error('Invalid project Git operation');
    }
    const invoke = client[command.operation] as (...args: unknown[]) => Promise<unknown>;
    return invoke(...command.args);
  };
  return { dispatch,
    get: (path: string, handler: GitRouteHandler) => register('get', path, handler),
    post: (path: string, handler: GitRouteHandler) => register('post', path, handler),
    put: (path: string, handler: GitRouteHandler) => register('put', path, handler),
    delete: (path: string, handler: GitRouteHandler) => register('delete', path, handler),
  };
}
