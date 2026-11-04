import type { BrowserInputRequest, BrowserClipboardRequest } from '@varin/protocol';
import { object, text } from './device-wire.js';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => finite(value) && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export function parseBrowserInput(value: unknown): BrowserInputRequest {
  const request = object(value), input = object(request.input);
  for (const key of ['pageId', 'pageGeneration', 'streamId', 'controlEpoch']) text(request[key]);
  if (!integer(request.frameSequence)) throw new Error('Invalid browser input frame sequence');
  let valid = false;
  const modifiers = () => integer(input.modifiers, 0, 15);
  const point = () => finite(input.x) && finite(input.y);
  const content = () => typeof input.text === 'string' && Buffer.byteLength(input.text) <= 64 * 1024;
  switch (input.type) {
    case 'pointer': valid = ['move', 'down', 'up'].includes(String(input.phase)) && point() && ['none', 'left', 'middle', 'right'].includes(String(input.button)) && integer(input.buttons, 0, 31) && integer(input.clickCount, 0, 3) && modifiers(); break;
    case 'wheel': valid = point() && finite(input.deltaX) && finite(input.deltaY) && modifiers(); break;
    case 'key': valid = ['down', 'up'].includes(String(input.phase)) && typeof input.key === 'string' && typeof input.code === 'string' && input.key.length < 256 && input.code.length < 256 && integer(input.windowsVirtualKeyCode, 0, 65535) && integer(input.location, 0, 3) && typeof input.autoRepeat === 'boolean' && modifiers(); break;
    case 'text': valid = content(); break;
    case 'composition': valid = content() && integer(input.selectionStart, 0, String(input.text).length) && integer(input.selectionEnd, Number(input.selectionStart), String(input.text).length); break;
    case 'touch': valid = ['start', 'move', 'end', 'cancel'].includes(String(input.phase)) && modifiers() && Array.isArray(input.points) && input.points.length <= 16 && input.points.every(value => { const p = object(value); return integer(p.id) && finite(p.x) && finite(p.y) && finite(p.radiusX) && p.radiusX >= 0 && finite(p.radiusY) && p.radiusY >= 0 && finite(p.force) && p.force >= 0 && p.force <= 1; }); break;
    case 'release': valid = true; break;
  }
  if (!valid) throw new Error('Invalid browser user input');
  return request as unknown as BrowserInputRequest;
}


export function parseBrowserClipboard(value: unknown): BrowserClipboardRequest {
  const request = object(value);
  // The clipboard operation has the exact same observed-frame/control identity.
  parseBrowserInput({ ...request, input: { type: 'release' } });
  if (request.action !== 'capture' && request.action !== 'cut' && request.action !== 'release') throw new Error('Invalid browser clipboard operation');
  if (request.action !== 'capture') text(request.selectionId);
  return request as unknown as BrowserClipboardRequest;
}
