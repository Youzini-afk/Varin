import type { Request } from 'express';
import type { ProjectManagementCommand } from '@varin/application-client';

export type GitHubProjectReadCommand = Exclude<Extract<ProjectManagementCommand, { action: `github-${string}` }>, { action: 'github-command' }>;
export type GitHubProjectReader = ((command: GitHubProjectReadCommand, directory: string, signal?: AbortSignal) => Promise<unknown>) & { dispatch?: import('../git/project-dispatch.js').ProjectGitDispatcher };
interface ReadResponse {
  status(code: number): ReadResponse;
  json(body: Record<string, unknown>): unknown;
}
type ReadHandler = (request: Pick<Request, 'query'>, response: ReadResponse) => Promise<unknown>;
const routes = {
  'github-auth': '/api/github/auth/status',
  'github-issues': '/api/github/issues/list',
  'github-prs': '/api/github/pulls/list',
  'github-issue': '/api/github/issues/get',
  'github-issue-comments': '/api/github/issues/comments',
  'github-pr-context': '/api/github/pulls/context',
} as const;

/** Both HTTP and registered-project reads run the original target Host handlers.
 * The project owner authorizes and resolves directory before calling read; this
 * adapter never accepts a directory or credential from the command payload. */
export function createGitHubProjectReads(app: { get(path: string, handler: ReadHandler): unknown }) {
  const handlers = new Map<string, ReadHandler>();
  const register = (path: string, handler: ReadHandler) => {
    handlers.set(path, handler);
    app.get(path, async (req, res) => { await handler(req, res); });
  };
  const read: GitHubProjectReader = async (command, directory, signal) => {
    signal?.throwIfAborted();
    const handler = handlers.get(routes[command.action]);
    if (!handler) throw new Error('GitHub project reader is unavailable');
    const input = command.input;
    const query: Request['query'] = { directory };
    if ('page' in input && input.page !== undefined) query.page = String(input.page);
    if ('query' in input && input.query !== undefined) query.query = input.query;
    if ('number' in input) query.number = String(input.number);
    if ('sourceRepo' in input && input.sourceRepo) {
      query.owner = input.sourceRepo.owner; query.repo = input.sourceRepo.repo;
    }
    if ('includeDiff' in input) query.diff = String(input.includeDiff === true);
    if ('includeCheckDetails' in input) query.checkDetails = String(input.includeCheckDetails === true);
    let status = 200;
    let body: Record<string, unknown> | undefined;
    const response: ReadResponse = {
      status(code) { status = code; return response; },
      json(value) { body = value; return response; },
    };
    await handler({ query }, response);
    signal?.throwIfAborted();
    if (status >= 400) throw new Error(typeof body?.error === 'string' ? body.error : `GitHub project read failed (${status})`);
    if (!body) throw new Error('GitHub project read returned no result');
    return body;
  };
  return { register, read };
}
