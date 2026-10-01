import { describe, expect, it } from 'vitest';
import { readContentPage, readTextPage, READ_PAGE_CHUNK_BYTES } from './read-page.js';

const page = { offset: 1, limit: 2, maxBytes: 50 * 1024 };
describe('bounded source pages', () => {
  it('reads a small page from a multi-GB source without materializing its body', async () => {
    const requests: number[] = [];
    const value = await readContentPage(async (offset, length) => {
      expect(offset).toBe(0); requests.push(length);
      return Buffer.from('first\nsecond\n' + 'rest\n'.repeat(10000)).subarray(0, length);
    }, 3 * 1024 ** 3, page);
    expect(value).toMatchObject({ kind: 'text', text: 'first\nsecond', nextOffset: 3, eof: false });
    expect(requests).toEqual([READ_PAGE_CHUNK_BYTES]);
  });
  it('rejects parquet before decoding or reading its full body', async () => {
    let calls = 0;
    const value = await readContentPage(async () => { calls++; return Buffer.from('PAR1payload'); }, 3 * 1024 ** 3, page);
    expect(value).toEqual({ kind: 'binary', format: 'parquet', byteLength: 3 * 1024 ** 3 });
    expect(calls).toBe(1);
  });
  it('skips long preceding lines, pages Unicode drafts and bounds an overlong selected line', async () => {
    const text = 'x'.repeat(200000) + '\n你好😀\nlast\n';
    expect(await readTextPage(text, { ...page, offset: 2, limit: 1 })).toMatchObject({ kind: 'text', text: '你好😀', nextOffset: 3 });
    expect(await readTextPage(text, page)).toMatchObject({ kind: 'text', text: '', firstLineExceedsLimit: true, truncatedBy: 'bytes' });
    expect(await readTextPage('one\ntwo\n', { ...page, limit: 10 })).toMatchObject({ kind: 'text', text: 'one\ntwo\n', eof: true });
  });
  it('cancels while skipping lines before the requested page', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(readContentPage(async () => {
      if (++calls === 2) controller.abort();
      return Buffer.from('line\n'.repeat(13000));
    }, 3 * 1024 ** 3, { ...page, offset: 1000000 }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(2);
  });
});
