import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
import { AgentPersonalizationError, type AgentPersonalization } from './agent-personalization.js';
import { registerAgentPersonalizationRoutes } from './agent-personalization-routes.js';

function fixture() {
  const removeNote = vi.fn(async (_id: number, revision: number) => {
    if (revision !== 5) throw new AgentPersonalizationError('Content changed; reload before saving', 409);
    return { result: { removed: true }, revision: 6 };
  });
  const saveNote = vi.fn(async () => ({ revision: 6 }));
  const savePrompt = vi.fn(async () => ({ revision: 6 }));
  const app = express();
  // Use the production parser registration. A global express.json() would hide the packaged bug.
  registerCommonRequestMiddleware(app, { express });
  registerAgentPersonalizationRoutes(app, { removeNote, saveNote, savePrompt } as unknown as AgentPersonalization,
    (_req, _res, next) => next());
  return { app, removeNote, saveNote, savePrompt };
}

describe('Agent personalization HTTP mutations', () => {
  it('deletes with the catalog revision and preserves stale-revision rejection', async () => {
    const { app, removeNote } = fixture();
    await request(app).delete('/api/agent-personalization/memory/2').send({ revision: 4 }).expect(409);
    const response = await request(app).delete('/api/agent-personalization/memory/2').send({ revision: 5 }).expect(200);
    expect(response.body).toEqual({ result: { removed: true }, revision: 6 });
    expect(removeNote).toHaveBeenLastCalledWith(2, 5);
  });
  it('parses memory and prompt saves through the same production middleware', async () => {
    const { app, saveNote, savePrompt } = fixture();
    const scope = { kind: 'project', id: 'project-a' };
    await request(app).put('/api/agent-personalization/memory').send({ id: 2, content: 'Updated note', scope, revision: 5 }).expect(200);
    expect(saveNote).toHaveBeenCalledWith({ id: 2, content: 'Updated note', scope, revision: 5, source: { label: 'user' } });
    const profile = { sections: { preamble: 'My instructions' } };
    await request(app).put('/api/agent-personalization/prompt').send({ scope, profile, revision: 5 }).expect(200);
    expect(savePrompt).toHaveBeenCalledWith(scope, profile, 5);
  });
});
