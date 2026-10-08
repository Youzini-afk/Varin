import { expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { COMPUTER_FEEDBACK_HTML } from './computerFeedback';

it('maps negative desktop origins into the viewer, preserves dispatch feedback, and clears on revocation', () => {
  const { document } = parseHTML(COMPUTER_FEEDBACK_HTML);
  const window = {} as { computerFeedback(message: unknown): void };
  const finishTimer = vi.fn();
  runInNewContext(document.querySelector('script')!.textContent!, { window, document, innerWidth: 960, innerHeight: 600,
    setTimeout: finishTimer, clearTimeout: vi.fn(), addEventListener: vi.fn(), parent: {} });
  window.computerFeedback({ type: 'configure', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, labels: { type: 'Typing' } });
  const gesture = { id: 'click', kind: 'click', actorLabel: 'Agent', point: { x: -1600, y: 200 } };
  window.computerFeedback({ gesture: { ...gesture, phase: 'target' } });
  expect(finishTimer).not.toHaveBeenCalled();
  expect(document.getElementById('cursor')!.style.transform).toBe('translate(160px,130px)');
  window.computerFeedback({ gesture: { id: 'click', kind: 'click', phase: 'dispatched' } });
  window.computerFeedback({ gesture: { id: 'click', kind: 'click', phase: 'completed' } });
  expect(document.querySelectorAll('.ripple')).toHaveLength(1);
  window.computerFeedback({ gesture: { id: 'semantic', kind: 'click', mechanism: 'semantic', phase: 'target', point: gesture.point, target: { x: -1700, y: 100, width: 400, height: 100 } } });
  window.computerFeedback({ gesture: { id: 'semantic', kind: 'click', mechanism: 'semantic', phase: 'dispatched' } });
  expect(document.getElementById('cursor')!.style.opacity).toBe('0');
  expect(document.querySelectorAll('.ripple')).toHaveLength(1);
  window.computerFeedback({ gesture: { id: 'type', kind: 'type', phase: 'target', target: { x: -1700, y: 100, width: 400, height: 100 } } });
  expect(document.getElementById('badge')!.textContent).toBe('Typing');
  window.computerFeedback({ gesture: { id: 'type', kind: 'type', phase: 'failed' } });
  expect(document.getElementById('badge')!.textContent).toBe('×');
  expect(document.querySelectorAll('.ripple')).toHaveLength(1);
  window.computerFeedback({ gesture: { id: '*', kind: 'move', phase: 'cancelled' } });
  expect(document.getElementById('cursor')!.style.opacity).toBe('0');
  expect(document.querySelectorAll('.ripple')).toHaveLength(0);
});
