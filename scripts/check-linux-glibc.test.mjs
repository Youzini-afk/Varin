import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGlibcSymbols } from './check-linux-glibc.mjs';

test('checks numeric GLIBC symbol versions including patch releases', () => {
  assert.deepEqual(checkGlibcSymbols('GLIBC_2.2.5 GLIBC_2.9 GLIBC_2.35'), ['2.2.5', '2.9', '2.35']);
  assert.throws(() => checkGlibcSymbols('GLIBC_2.36'), /2.36.*above 2.35/);
  assert.throws(() => checkGlibcSymbols('GLIBC_2.35.1'), /2.35.1.*above 2.35/);
  assert.throws(() => checkGlibcSymbols('not an ELF symbol table'), /No GLIBC requirements/);
});
