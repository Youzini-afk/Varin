import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { exportDesktopFrontendEntries } from '@varin/application-client/desktop';
import { importDesktopFrontendState } from '../src/frontend-migration.js';
import type { DesktopNativeTransport } from '../src/bridge.js';
class MemoryStorage implements Storage {
  values = new Map<string, string>();
  failKey = '';
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) {
    if (key === this.failKey)
      throw new Error('quota'); this.values.set(key, value);
  }
}
function fixture() {
  const payload = exportDesktopFrontendEntries([['lastDirectory', '/work'], ['openInAppId', 'code']]); const stage = { schema: 1, id: 'fixture', sourceOrigin: 'varin-ui://app', sourceVersion: '1', stage: 'staged', payload, digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }; const calls: unknown[] = []; const transport: DesktopNativeTransport = {
    async invoke<T>(_method: string, args?: unknown) {
      calls.push(args); return ((args as {
        action: string;
      }).action === 'read' ? stage : null) as T;
    }, async listen() { return () => { }; }
  }; return { stage, calls, transport };
}
test('imports before consumers and retains already-authored destination preferences', async () => { const f = fixture(), storage = new MemoryStorage(); storage.setItem('openInAppId', 'terminal'); const receipt = await importDesktopFrontendState(storage, f.transport, webcrypto.subtle as SubtleCrypto); assert.equal(storage.getItem('lastDirectory'), '/work'); assert.equal(storage.getItem('openInAppId'), 'terminal'); assert.deepEqual(receipt?.importedKeys, ['lastDirectory']); assert.deepEqual(receipt?.retainedKeys, ['openInAppId']); assert.equal(f.calls.length, 2); });
test('partial write failure does not acknowledge or erase old data, and resumes without overwriting', async () => { const f = fixture(), storage = new MemoryStorage(); storage.failKey = 'openInAppId'; await assert.rejects(importDesktopFrontendState(storage, f.transport, webcrypto.subtle as SubtleCrypto), /quota/); assert.equal(f.calls.length, 1); storage.failKey = ''; storage.setItem('lastDirectory', '/new-user-choice'); await importDesktopFrontendState(storage, f.transport, webcrypto.subtle as SubtleCrypto); assert.equal(storage.getItem('lastDirectory'), '/new-user-choice'); assert.equal(storage.getItem('openInAppId'), 'code'); });
test('rejects modified payload before any local write', async () => { const f = fixture(), storage = new MemoryStorage(); f.stage.payload.entries.lastDirectory = '/tampered'; await assert.rejects(importDesktopFrontendState(storage, f.transport, webcrypto.subtle as SubtleCrypto), /integrity/); assert.equal(storage.length, 0); });
