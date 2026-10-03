import { expect, test } from 'vitest';

import { getRuntimeKey } from '@varin/application-client';
import {
  listAgentFileChangeHints,
  recordHintsFromToolCall,
  resetAgentFileChangeHints,
} from './hints';

test('keeps external-store snapshots stable until the hint state changes', () => {
  resetAgentFileChangeHints();
  const initial = listAgentFileChangeHints('workspace-a');
  expect(listAgentFileChangeHints('workspace-a')).toBe(initial);

  recordHintsFromToolCall({
    args: { path: 'src/example.ts' },
    runtimeKey: getRuntimeKey(),
    sessionId: 'session-a',
    toolCallId: 'tool-a',
    toolName: 'write',
    workspaceId: 'workspace-a',
    workspaceRoot: '/workspace',
  });

  const changed = listAgentFileChangeHints('workspace-a');
  expect(changed).not.toBe(initial);
  expect(changed).toHaveLength(1);
  expect(listAgentFileChangeHints('workspace-a')).toBe(changed);

  resetAgentFileChangeHints();
});
