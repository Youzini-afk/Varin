import { expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerGitHubRoutes } from './routes.js';

const resolveRepo = vi.hoisted(() => vi.fn(async () => ({ repo: { owner: 'target-account', repo: 'project' } })));
vi.mock('./index.js', () => ({ resolveGitHubRepoFromDirectory: resolveRepo }));

test('managed project and HTTP share the original target issue reader and credentials', async () => {
  const get = vi.fn(async () => ({ data: { number: 17, title: 'Target issue', body: 'Context', html_url: 'https://github.com/target-account/project/issues/17', state: 'open', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', labels: [], user: null } }));
  const app = express();
  const read = registerGitHubRoutes(app, { getGitHubLibraries: async () => ({ getOctokitOrNull: () => ({ rest: { issues: { get } } }) }) });
  const managed = await read({ action: 'github-issue', input: { number: 17 } }, '/target/registered-project');
  expect(resolveRepo).toHaveBeenCalledWith('/target/registered-project');
  expect(get).toHaveBeenCalledWith({ owner: 'target-account', repo: 'project', issue_number: 17 });
  const http = await request(app).get('/api/github/issues/get').query({ directory: '/target/registered-project', number: 17 }).expect(200);
  expect(managed).toEqual(http.body);
  expect(get).toHaveBeenCalledTimes(2);
});

test('target auth absence and abort do not fall back to another credential owner', async () => {
  const getOctokitOrNull = vi.fn(() => null);
  const read = registerGitHubRoutes(express(), { getGitHubLibraries: async () => ({ getOctokitOrNull }) });
  expect(await read({ action: 'github-prs', input: {} }, '/target/project')).toEqual({ connected: false });
  const abort = new AbortController(); abort.abort();
  await expect(read({ action: 'github-issues', input: {} }, '/target/project', abort.signal)).rejects.toThrow();
  expect(getOctokitOrNull).toHaveBeenCalledTimes(1);
});

test('typed complete GitHub dispatch reaches the original target credential mutation', async () => {
  const activateGitHubAuth = vi.fn(async () => true);
  const read = registerGitHubRoutes(express(), { getGitHubLibraries: async () => ({ activateGitHubAuth, getGitHubAuth: () => null, getGitHubAuthAccounts: () => [], GH_CLI_ACCOUNT_ID: 'cli' }) });
  expect(await read.dispatch!({ operation: 'authActivate', args: ['target-account'], selection: { mode: 'live_root' } })).toEqual({ connected: false, accounts: [] });
  expect(activateGitHubAuth).toHaveBeenCalledWith('target-account');
});
