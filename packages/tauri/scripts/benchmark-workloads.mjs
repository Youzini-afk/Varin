/** Concrete product selectors and committed UI outcomes, shared without any
 * animation or feature overrides. Physical-only paths remain explicit. */
import { validateWorkload } from './benchmark-contract.mjs';
export const manualScenarios = ['companion-drag', 'browser-interaction', 'local-hybrid-execution'];
const switcher = '[data-varin-workbench-switcher]';
const composer = '[data-chat-input] [contenteditable="true"]';
const primary = '[data-conversation-composer-primary-action]';
const ready = [{ selector: switcher, visible: true }];
const shown = selector => ({ selector, visible: true });
const mode = value => ({ selector: switcher, attribute: 'data-workbench-mode', equals: value });
function switchMode(target, id) {
  return [
    { id: `${id}-open`, action: 'click', selector: switcher, expect: [shown(`[data-workbench-mode-option="${target}"]`)] },
    { id: `${id}-commit`, action: 'click', selector: `[data-workbench-mode-option="${target}"]`, expect: [mode(target)], settleMs: 1200, milestone: `committed-${target}` },
  ];
}
function selectHistory(identity) {
  const row = `[data-thread-id="${identity.threadId}"]`;
  return [
    { id: 'open-seeded-history', action: 'click', selector: row, expect: [{ selector: row, focused: true }, { selector: row, attribute: 'aria-current', equals: 'page' }], settleMs: 300 },
    { id: 'history-materialized', action: 'wait', durationMs: 1000, expect: [shown('[data-thread-conversation]'), shown('[data-conversation-timeline]')] },
  ];
}
function compose(text, id) {
  return [
    { id: `${id}-focus`, action: 'click', selector: composer, expect: [{ selector: composer, focused: true }] },
    { id: `${id}-type`, action: 'text', selector: composer, text, expect: [{ selector: composer, textIncludes: text }] },
    { id: `${id}-submit`, action: 'click', selector: `${primary}[data-conversation-composer-primary-action="send"]`, expect: [shown(`${primary}[data-conversation-composer-primary-action="stop"]`)] },
  ];
}
export function productWorkloads(identity, { manualDurationMs = 120000 } = {}) {
  if (!/^[a-zA-Z0-9:_-]+$/u.test(identity?.threadId ?? '')) throw new Error('Expected a real product Thread identity');
  const steps = {
    'remote-idle': [{ id: 'remote-workbench-idle', action: 'wait', durationMs: 30000 }],
    'workspace-transitions': [...switchMode('ide', 'first-ide'), ...switchMode('bot', 'bot'), ...switchMode('workbench', 'workbench'), ...switchMode('ide', 'second-ide'), ...switchMode('workbench', 'return')],
    'long-chat-stream': [...selectHistory(identity),
      { id: 'scroll-history', action: 'scroll', selector: '[data-conversation-timeline]', deltaY: -650, settleMs: 300 },
      ...compose('VARIN_BENCHMARK_STREAM', 'stream'),
      { id: 'scroll-during-stream', action: 'scroll', selector: '[data-conversation-timeline]', deltaY: -400, settleMs: 300 },
      { id: 'stream-observation-window', action: 'wait', durationMs: 20000 },
      { id: 'return-to-live-tail', action: 'scroll', selector: '[data-conversation-timeline]', deltaY: 100000, settleMs: 500 },
      { id: 'stream-owner-completed', action: 'wait', durationMs: 500, timeoutMs: 60000,
        expect: [{ selector: '[data-thread-conversation]', textIncludes: 'VARIN_BENCHMARK_STREAM_COMPLETE' }, { selector: `${primary}[data-conversation-composer-primary-action="stop"]`, count: 0 }], milestone: 'stream-completed' },
    ],
    'companion-drag': [{ id: 'physical-companion-actions-and-cross-display-drag', action: 'manual', durationMs: manualDurationMs, expect: ready, milestone: 'operator-companion-evidence-required' }],
    'browser-interaction': [{ id: 'same-page-login-upload-download-and-native-input', action: 'manual', durationMs: manualDurationMs, expect: ready, milestone: 'operator-browser-evidence-required' }],
    'local-hybrid-execution': [...selectHistory(identity), { id: 'local-and-remote-tasks-stop-and-drain', action: 'manual', durationMs: manualDurationMs, expect: ready, milestone: 'operator-local-remote-owner-evidence-required' }],
    'repeated-lifecycle': [{ id: 'baseline', action: 'checkpoint', cycle: 0, settleMs: 3000 },
      ...Array.from({ length: 5 }, (_, index) => [...switchMode('ide', `cycle-${index}-ide`), ...switchMode('workbench', `cycle-${index}-workbench`),
        { id: `settled-${index}`, action: 'checkpoint', cycle: index + 1, settleMs: 3000, expect: [mode('workbench')], milestone: 'settled-cycle' }]).flat()],
  };
  return Object.fromEntries(Object.entries(steps).map(([name, steps]) => [name, validateWorkload({ name, motion: 'full', readyTimeoutMs: 90000, timeoutMs: 240000, ready, steps })]));
}
export function operatorInstructions(origin) {
  return {
    'companion-drag': ['Use a real multi-display desktop session and an installed complete companion pack.', 'Perform all pack actions, drag across physical monitors, verify transparent composition and click-through outside opaque pixels.', 'Record native input, display identities, DPI and action/drag outcomes separately; renderer activity alone cannot prove these.'],
    'browser-interaction': [`Open ${origin}/site through the product native Browser pane.`, 'Log in with the synthetic name benchmark and passphrase synthetic-only.', 'Use the native file chooser to upload the prepared upload.txt, then download benchmark-download.txt and verify its bytes.', 'Type, select text, scroll, resize the pane, and verify the original page remains interactive and aligned. Save native input/display evidence separately.'],
    'local-hybrid-execution': ['The desktop starts its own local Host and also has the isolated remote Host configured.', 'Submit VARIN_BENCHMARK_LOCAL_PROCESS to the local thread; observe actual local process completion. Switch to the remote Host and submit a controlled streaming task.', 'Cancel an additional VARIN_BENCHMARK_CANCEL task through the product, wait for the original Run/process owner to stop, and return to the workbench.', 'Record local and remote owner Run/process IDs and terminal outcomes separately; a submitted request is not completion.'],
    limitations: ['Mode switcher deliberately disables interaction while busy; these UI cycles do not certify reverse-in-flight transitions.', 'The fixed history workload does not yet certify image/texture release.', 'Repeated shell cycles are not by themselves a subscription/texture/native-window leak qualification.'],
  };
}
