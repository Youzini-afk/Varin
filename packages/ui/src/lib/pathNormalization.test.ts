import { expect, test } from 'vitest';
import { normalizePath } from './pathNormalization';

// Directory comparison normalization is not filesystem resolution. Preserve its
// root/drive behavior without restating every replacement step as a separate test.
test.each([
  [null, null], [undefined, null], ['', null], ['   ', null], ['///', null], ['\\\\', null],
  ['/', '/'], ['\\', '/'], ['C:/', 'C:'],
  [' c:\\Users\\me\\project/// ', 'C:/Users/me/project'],
  ['/home/user/project/', '/home/user/project'],
  ['abc:def', 'abc:def'], ['/foo/c:\\bar', '/foo/c:/bar'],
])('normalizes directory identity %j to %j', (input, expected) => {
  expect(normalizePath(input)).toBe(expected);
});
