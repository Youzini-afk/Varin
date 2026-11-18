import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useThreadWorkFocus } from './useThreadWorkFocus';

type Source = NonNullable<ThreadSnapshot['launch']>['selection']['source'];
it('selects the saved work focus from the admitted Host, not a local project with the same path', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node = document.getElementById('root')!;
  const root = createRoot(node);
  const projects = useProjectsStore.getState().projects, drafts = useThreadDraftStore.getState().drafts;
  const remote = { kind: 'managed_host' as const, hostId: 'remote', connectionId: 'pair', endpointIdentity: 'remote-identity' };
  const admitted: NonNullable<Source> = { resource_owner: remote, mode: 'live_root', workspace_id: 'same', execution_workspace_id: 'same',
    branch_id: null, revision: null, live_root: { rootId: 'root-b', hostId: 'remote', canonicalRoot: '/studio' } };
  const View = ({ id, source }: { id: string; source: Source }) => <>{useThreadWorkFocus(id, '/studio', undefined, true, source)}</>;
  try {
    useProjectsStore.setState({ projects: [
      { id: 'local-study', path: '/studio', defaultWorkFocus: 'office' },
      { id: 'remote-study', path: '/studio', source: { resourceOwner: remote, workspaceId: 'same' }, defaultWorkFocus: 'research' },
    ] });
    await act(async () => root.render(<View id="resume-b" source={admitted} />));
    expect(node.textContent).toBe('research');
    expect(useThreadDraftStore.getState().drafts['resume-b']?.workFocus).toBe('research');
    await act(async () => root.render(<View id="chat" source={null} />));
    expect(node.textContent).toBe('general');
    await act(async () => root.render(<View id="repaired" source={{ ...admitted, resource_owner: { ...remote, connectionId: 'replacement' } }} />));
    expect(node.textContent).toBe('general');
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState({ projects }); useThreadDraftStore.setState({ drafts }); vi.unstubAllGlobals();
  }
});
