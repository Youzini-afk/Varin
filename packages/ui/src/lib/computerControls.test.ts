import { expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { COMPUTER_CONTROLS_HTML } from './computerControls';

it('keeps native actions narrow and shows the actual pending/failed control outcome', () => {
  const { document } = parseHTML(COMPUTER_CONTROLS_HTML);
  const window = {} as { setComputerControl(state: Record<string, unknown>): void };
  runInNewContext(document.querySelector('script')!.textContent!, { window, document });
  const state = { locale: 'en', text: 'Varin is using <script>this computer</script>', handoff: 'Take over', command: 'takeover', cancel: 'Stop', cancelVisible: true, busy: false };
  window.setComputerControl(state);
  expect(document.getElementById('state')!.textContent).toBe(state.text);
  expect(document.getElementById('state')!.querySelector('script')).toBeNull();
  expect(document.getElementById('handoff')!.getAttribute('href')).toBe('varin-computer-control:takeover');
  expect(document.getElementById('cancel')!.getAttribute('href')).toBe('varin-computer-control:cancel');
  window.setComputerControl({ ...state, busy: true, text: 'Transferring control…' });
  expect(document.getElementById('handoff')!.getAttribute('aria-disabled')).toBe('true');
  expect(document.getElementById('cancel')!.getAttribute('aria-disabled')).toBe('true');
  window.setComputerControl({ ...state, command: 'handback', handoff: 'Hand back', cancelVisible: false, error: 'Original input release is unconfirmed' });
  expect(document.getElementById('handoff')!.getAttribute('href')).toBe('varin-computer-control:handback');
  expect(document.getElementById('handoff')!.getAttribute('aria-disabled')).toBe('false');
  expect(document.getElementById('cancel')!.style.display).toBe('none');
  expect(document.getElementById('error')!.style.display).toBe('block');
  expect(document.getElementById('error')!.textContent).toBe('Original input release is unconfirmed');
  expect(COMPUTER_CONTROLS_HTML).not.toMatch(/__TAURI__|invoke\(|holderId|clientToken|fetch\(/u);
});
