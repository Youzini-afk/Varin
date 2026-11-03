/** Concrete product selectors and committed UI outcomes, shared without any
 * animation or feature overrides. Physical-only paths remain explicit. */
import { createHash } from 'node:crypto';
import { validateWorkload } from './benchmark-contract.mjs';
export const manualScenarios = ['companion-drag'];
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
function compose(text, id, admittedOnly = false) {
  return [
    { id: `${id}-focus`, action: 'click', selector: composer, expect: [{ selector: composer, focused: true }] },
    { id: `${id}-type`, action: 'text', selector: composer, text, expect: [{ selector: composer, textIncludes: text }] },
    { id: `${id}-submit`, action: 'click', selector: `${primary}[data-conversation-composer-primary-action="send"]`, expect: admittedOnly ? [{ selector: composer, textEquals: '' }] : [shown(`${primary}[data-conversation-composer-primary-action="stop"]`)] },
  ];
}
export function productWorkloads(identity, { manualDurationMs = 120000, workspace, browserOrigin, remoteOrigin }  = {}) {
  if (!/^[a-zA-Z0-9:_-]+$/u.test(identity?.threadId ?? '')) throw new Error('Expected a real product Thread identity');
  const browserUrl = browserOrigin ? `${browserOrigin}/site` : 'http://127.0.0.1:1/site';
  const browser = { name: 'browser-interaction', surface: 'fixture-browser', motion: 'full', url: browserUrl, readyTimeoutMs: 60000, timeoutMs: 90000,
    downloadSha256: createHash('sha256').update('Varin synthetic native-browser download.\n').digest('hex'),
    ready: [shown('body[data-varin-browser-fixture]')], steps: [
      { id: 'native-login-name-focus', action: 'click', selector: '#login-name', expect: [{ selector: '#login-name', focused: true }] },
      { id: 'native-login-name', action: 'text', selector: '#login-name', text: 'benchmark', expect: [{ selector: '#login-name', value: 'benchmark' }] },
      { id: 'native-login-password-focus', action: 'click', selector: '#login-password', expect: [{ selector: '#login-password', focused: true }] },
      { id: 'native-login-password', action: 'text', selector: '#login-password', text: 'synthetic-only', expect: [{ selector: '#login-password', value: 'synthetic-only' }] },
      { id: 'native-login-submit', action: 'click', selector: '#login-submit', expect: [{ selector: 'body', attribute: 'data-authenticated', equals: 'true' }] },
      { id: 'automation-select-fixture-file', action: 'file', selector: '#upload-input', expect: [{ selector: '#upload-input', fileCount: 1 }] },
      { id: 'native-upload-submit', action: 'click', selector: '#upload-submit', expect: [{ selector: '#upload-result', attribute: 'data-sha256', equals: createHash('sha256').update('Varin synthetic native-browser upload.\n').digest('hex') }] },
      { id: 'native-scroll', action: 'scroll', selector: '#scroll-content', deltaY: 200, settleMs: 100 },
      { id: 'native-download-click', action: 'click', selector: '#download-link', expect: [{ selector: '#download-status', attribute: 'data-state', equals: 'requested' }] },
      { id: 'native-page-settled', action: 'wait', durationMs: 1000 },
    ] };
  const remoteWindow = 'div:has(> button[aria-label="Switch to Benchmark remote Host"]) button[aria-label="Open in new window"]';
  const remote = { name: 'local-hybrid-execution', origin: remoteOrigin ?? 'http://127.0.0.1:1', motion: 'full', readyTimeoutMs: 90000, timeoutMs: 120000, ready,
    ownerIdentity: identity, workspace, steps: [...selectHistory(identity), ...compose('VARIN_BENCHMARK_STREAM', 'remote-stream'),
      { id: 'remote-original-run-completed', action: 'wait', durationMs: 15000, owner: 'run-completed', timeoutMs: 60000 },
      ...compose('VARIN_BENCHMARK_CANCEL', 'remote-cancel'),
      { id: 'remote-stream-observed', action: 'wait', durationMs: 1000 },
      { id: 'remote-stop-from-composer', action: 'click', selector: `${primary}[data-conversation-composer-primary-action="stop"]`, expect: [{ selector: `${primary}[data-conversation-composer-primary-action="stop"]`, count: 0 }] },
      { id: 'remote-original-cancellation-confirmed', action: 'wait', durationMs: 500, owner: 'run-cancelled', timeoutMs: 30000 },
    ] };
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
    'browser-interaction': [
      { id: 'reveal-context-rail', action: 'click', selector: 'button[aria-label="contextRail.actions.expand"]', expect: [shown('button[data-rail-surface="browser"]')] },
      { id: 'open-original-native-pane', action: 'click', selector: 'button[data-rail-surface="browser"]', expect: [shown('input[aria-label="Browser address"]')] },
      { id: 'focus-browser-address', action: 'click', selector: 'input[aria-label="Browser address"]', expect: [{ selector: 'input[aria-label="Browser address"]', focused: true }] },
      { id: 'select-browser-address', action: 'key', key: 'a', modifiers: process.platform === 'darwin' ? 4 : 2, expect: [{ selector: 'input[aria-label="Browser address"]', focused: true }] },
      { id: 'enter-fixture-address', action: 'text', selector: 'input[aria-label="Browser address"]', text: browserUrl, expect: [{ selector: 'input[aria-label="Browser address"]', value: browserUrl }] },
      { id: 'navigate-from-original-address-ui', action: 'key', key: 'Enter', owner: 'browser-page-opened', expect: [{ selector: 'input[aria-label="Browser address"]', value: browserUrl }] },
      { id: 'original-download-owner-file-confirmed', action: 'wait', durationMs: 5000, owner: 'browser-download-completed', timeoutMs: 90000, milestone: 'original-download-completed-and-bytes-read' },
    ],
    'local-hybrid-execution': [
      { id: 'open-remote-host-dialog', action: 'click', selector: '[data-varin-host-switcher]', expect: [shown(remoteWindow)] },
      { id: 'open-real-remote-window', action: 'click', selector: remoteWindow, expect: [{ selector: remoteWindow, focused: true }] },
      { id: 'dismiss-local-host-dialog', action: 'key', key: 'Escape', expect: [{ selector: '[role="dialog"]', count: 0 }] },
      ...selectHistory(identity), ...compose('VARIN_BENCHMARK_LOCAL_PROCESS', 'local-completion', true),
      { id: 'allow-bounded-local-process', action: 'click', optional: true, durationMs: 10000, selector: '[data-permission-tool="process_spawn"] [data-permission-choice="allow_once"]', expect: [{ selector: '[data-permission-tool="process_spawn"] [data-permission-choice="allow_once"]', count: 0 }] },
      { id: 'original-process-completed', action: 'wait', durationMs: 1000, owner: 'process-completed', timeoutMs: 30000, milestone: 'local-writer-exited' },
      ...compose('VARIN_BENCHMARK_LOCAL_PROCESS_HOLD', 'local-cancellation', true),
      { id: 'allow-bounded-held-process', action: 'click', optional: true, durationMs: 10000, selector: '[data-permission-tool="process_spawn"] [data-permission-choice="allow_once"]', expect: [{ selector: '[data-permission-tool="process_spawn"] [data-permission-choice="allow_once"]', count: 0 }] },
      { id: 'original-held-process-running', action: 'wait', durationMs: 500, owner: 'process-running', timeoutMs: 30000 },
      { id: 'reveal-original-process-controls', action: 'click', selector: '[data-process-summary][data-process-live="true"]', expect: [shown('[data-process-stop]')] },
      { id: 'stop-original-process-from-ui', action: 'click', selector: '[data-process-stop]', expect: [{ selector: '[data-process-stop]:not([disabled])', count: 0 }] },
      { id: 'original-stop-and-drain-confirmed', action: 'wait', durationMs: 1000, owner: 'process-stopped', timeoutMs: 30000, milestone: 'local-original-writer-stopped' },
      { id: 'remote-window-original-task-and-stop-confirmed', action: 'wait', durationMs: 1000, owner: 'remote-completed', timeoutMs: 90000 },
    ],
    'repeated-lifecycle': [{ id: 'baseline', action: 'checkpoint', cycle: 0, settleMs: 3000 },
      ...Array.from({ length: 5 }, (_, index) => [...switchMode('ide', `cycle-${index}-ide`), ...switchMode('workbench', `cycle-${index}-workbench`),
        { id: `settled-${index}`, action: 'checkpoint', cycle: index + 1, settleMs: 3000, expect: [mode('workbench')], milestone: 'settled-cycle' }]).flat()],
  };
  return Object.fromEntries(Object.entries(steps).map(([name, steps]) => [name, validateWorkload({ name, motion: 'full', readyTimeoutMs: 90000, timeoutMs: 240000, ready, steps, ...(name === 'local-hybrid-execution' ? { ownerIdentity: identity, workspace, remote } : {}), ...(name === 'browser-interaction' ? { browser } : {}) })]));
}
export function operatorInstructions(origin) {
  return {
    'companion-drag': ['Use a real multi-display desktop session and an installed complete companion pack.', 'Perform all pack actions, drag across physical monitors, verify transparent composition and click-through outside opaque pixels.', 'Record native input, display identities, DPI and action/drag outcomes separately; renderer activity alone cannot prove these.'],
    'browser-interaction': [`Automatic replay uses the original native page at ${origin}/site, including owner-verified completed download bytes.`, 'Supplemental physical evidence must separately exercise OS file chooser, selection/IME, native resizing and display alignment; Chromium file automation is not OS chooser evidence.'],
    'local-hybrid-execution': ['Automatic replay uses actual local and remote workbench windows, original composer submissions and UI stop controls.', 'Read-only owner evidence verifies original process writer exit and remote Run cancellation; no task is dispatched by the observation API.'],
    limitations: ['Mode switcher deliberately disables interaction while busy; these UI cycles do not certify reverse-in-flight transitions.', 'The fixed history workload does not yet certify image/texture release.', 'Repeated shell cycles are not by themselves a subscription/texture/native-window leak qualification.'],
  };
}
