import { defineHostExtension, provideAgentPolicy } from '@varin/extension-sdk';

/** No model request, tool call, private history write or private resume endpoint. Core commits
 * both deliveries and the Wait. Only the public Run resume command can produce `resumed`. */
export default defineHostExtension({
  activate(context) {
    provideAgentPolicy(context, {
      identity: { name: 'delivery-pause', version: '1' },
      configuration: null,
      decide({ event, state }, signal) {
        signal.throwIfAborted();
        if (state === null) return {
          action: { kind: 'deliver', text: 'The first result is ready. Review it before continuing.' }, state: 'first_delivery',
        };
        if (state === 'first_delivery' && event.kind === 'delivered') return {
          action: { kind: 'pause', reason: 'Review the first result, then choose Resume run.' }, state: 'awaiting_resume',
        };
        if (state === 'awaiting_resume' && event.kind === 'resumed') return {
          action: { kind: 'deliver', text: 'You explicitly resumed this run. The second result is ready.' }, state: 'second_delivery',
        };
        // Core retains an unconsumed delivery/resume receipt across concurrent queued input.
        // The next private state becomes authoritative only when its action commits.
        if (state === 'second_delivery' && event.kind === 'delivered') return { action: { kind: 'complete' }, state: 'completed' };
        return { action: { kind: 'fail', reason: 'Unexpected delivery or pause checkpoint boundary' }, state };
      },
    });
  },
});
