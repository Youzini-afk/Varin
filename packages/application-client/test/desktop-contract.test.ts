import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isVarinDesktopCommand,
  isVarinDesktopEvent,
} from '../src/desktop.js';

test('desktop command guard accepts known commands and rejects unknown commands', () => {
  assert.equal(isVarinDesktopCommand('desktop_get_app_version'), true);
  assert.equal(isVarinDesktopCommand('desktop_nonexistent'), false);
});

test('desktop event guard accepts known events and rejects unknown events', () => {
  assert.equal(isVarinDesktopEvent('varin:open-thread'), true);
  assert.equal(isVarinDesktopEvent('varin:open-session'), false);
  assert.equal(isVarinDesktopEvent('varin:unknown'), false);
});
