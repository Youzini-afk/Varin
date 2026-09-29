import { describe, expect, it } from 'vitest';
import { knowledgeRememberEndpoint, knowledgeRememberPayload } from './knowledgeSuggestionRequest';

describe('RememberKnowledgeButton request projection', () => {
  it('commits user marks to the unified memory endpoint', () => {
    expect(knowledgeRememberEndpoint('session/a b')).toBe('/api/harness/sessions/session%2Fa%20b/knowledge/remember');
    expect(knowledgeRememberPayload('user', 'Remember this', 'message:user')).toEqual({
      scope: 'user',
      content: 'Remember this',
      kind: 'message:user',
    });
    expect(knowledgeRememberPayload('workspace', 'Owning scope', 'tool-result:bash')).toEqual({
      content: 'Owning scope',
      kind: 'tool-result:bash',
    });
  });
});
