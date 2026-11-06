import { expect, it } from 'vitest';
import { withToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import { requireConfirmedToolInvocation, withToolConfirmation } from './tool-confirmation.js';
import type { HostCapabilityCallContext } from '@varin/extension-host';
const owner = { extensionId: 'example.mail', extensionVersion: '1', entrypointId: 'host', instanceKey: 'instance', generation: 1 };
const authority: ToolInvocationAuthority = { invocationId: 'invoke', runId: 'run', threadId: 'thread', operationId: 'request:tool:send', callId: 'send', origin: { kind: 'model_step', request_id: 'request' }, executorOwner: { kind: 'kernel' }, source: null, toolName: 'mail_send', operation: 'effect', completion: 'result', arguments: { to: ['a@example.test'], body: 'Original' } };
it('proof is tied to actual scope, full arguments and original owner, and can be consumed only once', async () => {
  const signal = new AbortController().signal;
  let retained!: HostCapabilityCallContext;
  await withToolInvocation({ authority, owner, signal }, async scope => {
    retained = { owner, signal, invocation: scope };
    expect(() => requireConfirmedToolInvocation(retained, authority.arguments)).toThrow('tool_confirmation_unavailable');
    await withToolConfirmation(scope, owner, authority, async () => {
      expect(() => requireConfirmedToolInvocation({ ...retained, invocation: { id: scope.id, value: null } }, authority.arguments)).toThrow('tool_invocation_unavailable');
      expect(() => requireConfirmedToolInvocation(retained, { ...authority.arguments as object, body: 'Changed' })).toThrow('tool_confirmation_unavailable');
      expect(() => requireConfirmedToolInvocation({ ...retained, owner: { ...owner, generation: 2 } }, authority.arguments)).toThrow('tool_invocation_unavailable');
      const dependency = { ...owner, extensionId: 'example.dependency' };
      await scope.invokeDependency!(owner, dependency, async () => {
        expect(() => requireConfirmedToolInvocation({ ...retained, owner: dependency }, authority.arguments)).toThrow('tool_confirmation_unavailable');
      });
      expect(requireConfirmedToolInvocation(retained, authority.arguments).toolName).toBe('mail_send');
      expect(() => requireConfirmedToolInvocation(retained, authority.arguments)).toThrow('tool_confirmation_unavailable');
    });
  });
  expect(() => requireConfirmedToolInvocation(retained, authority.arguments)).toThrow('tool_invocation_unavailable');
});

it('direct service calls and cancelled invocations cannot consume confirmation', async () => {
  const controller = new AbortController();
  expect(() => requireConfirmedToolInvocation({ owner, signal: controller.signal }, authority.arguments)).toThrow('tool_invocation_unavailable');
  await withToolInvocation({ authority, owner, signal: controller.signal }, scope =>
    withToolConfirmation(scope, owner, authority, async () => {
      controller.abort();
      expect(() => requireConfirmedToolInvocation({ owner, signal: controller.signal, invocation: scope }, authority.arguments)).toThrow('tool_invocation_unavailable');
    }));
});

it('confirmation expires with its callback even while the enclosing invocation lives', async () => {
  const signal = new AbortController().signal;
  await withToolInvocation({ authority, owner, signal }, async scope => {
    await withToolConfirmation(scope, owner, authority, async () => undefined);
    expect(() => requireConfirmedToolInvocation({ owner, signal, invocation: scope }, authority.arguments)).toThrow('tool_confirmation_unavailable');
  });
});
