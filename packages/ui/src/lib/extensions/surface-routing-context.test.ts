import { expect, it } from 'vitest';
import { resolveVarinExtensionServiceRouting, defaultVarinExtensionServiceRoutingDocument } from '@varin/extension-contract';
import { surfaceServiceRoutingContext } from './surface-routing-context';

it('surface selection routes by the real Thread and history branch while keeping workspace namespaces independent', () => {
  const surface = { surface: 'web' as const, runtimeId: 'host-a', configurationDirectory: '/project', documentWorkspaceId: 'documents-workspace' };
  const first = surfaceServiceRoutingContext({ ...surface, threadId: 'thread-a', branchId: 'history-a' });
  const second = surfaceServiceRoutingContext({ ...surface, threadId: 'thread-a', branchId: 'history-b' });
  const candidates = [{ providerId: 'a', providerKey: 'example.a:surface:editor@1' }, { providerId: 'b', providerKey: 'example.b:surface:editor@1' }];
  const document = defaultVarinExtensionServiceRoutingDocument();
  document.rules = candidates.map((candidate, index) => ({ serviceId: 'editor', version: 1, allowFallback: false,
    scope: { threadId: 'thread-a', branchId: index === 0 ? 'history-a' : 'history-b' }, providerKeys: [candidate.providerKey] }));
  const route = (context: typeof first) => resolveVarinExtensionServiceRouting({ candidates, document, context, serviceId: 'editor', version: 1 });
  expect(route(first).providerIds).toEqual(['a']);
  expect(route(second).providerIds).toEqual(['b']);
  expect(first).toEqual({ userId: 'default', runtimeId: 'host-a', threadId: 'thread-a', branchId: 'history-a',
    configurationDirectory: '/project', workspaceId: 'documents-workspace' });
  const cleared = surfaceServiceRoutingContext(surface);
  expect(cleared).not.toHaveProperty('threadId');
  expect(cleared).not.toHaveProperty('branchId');
  expect(cleared).not.toHaveProperty('sourceRunId');
  expect(route(cleared).status).toBe('ambiguous');
});
