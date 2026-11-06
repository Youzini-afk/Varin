import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildMessage, executeGmail, type Accounts, type MailInput, type ReplyInput } from './gmail.js';
const binding = { connectionId: 'connection', account: 'account' };
const input: MailInput = { binding, from: 'me@example.test', to: ['to@example.test'], cc: ['cc@example.test'], bcc: ['bcc@example.test'], subject: 'Hello 世界', body: 'First line\nSecond line 世界' };
const account = { ...binding, kind: 'oauth' as const, accountId: input.from, displayName: input.from, scopes: [] };

test('MIME preserves full content and fixed attachment bytes, rejecting header injection and changed content', () => {
  const bytes = Buffer.from('exact attachment\0binary');
  const attachment = { filename: '研究.txt', mimeType: 'text/plain', contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  const message = buildMessage({ ...input, attachments: [attachment] }, 'boundary');
  assert.match(message, /To: to@example.test\r\nCc: cc@example.test\r\nBcc: bcc@example.test/);
  assert.ok(message.includes(Buffer.from(input.body).toString('base64')));
  assert.ok(message.includes(attachment.contentBase64));
  assert.match(message, /filename\*=UTF-8''%E7%A0%94%E7%A9%B6.txt/);
  assert.throws(() => buildMessage({ ...input, subject: 'Hello\r\nBcc: evil@example.test' }), /header/);
  assert.throws(() => buildMessage({ ...input, attachments: [{ ...attachment, sha256: '0'.repeat(64) }] }), /SHA-256/);
  assert.throws(() => buildMessage({ ...input, to: ['Name <to@example.test>'] }), /bare email/);
});

test('send uses one credential broker request and exact confirmation input; no retry on unknown outcome', async () => {
  const requests: unknown[] = [];
  const accounts: Accounts = { confirm: async () => {}, list: async () => [account], request: async request => { requests.push(request); throw new Error('response lost'); } };
  await assert.rejects(executeGmail('gmail_send', input as unknown as Record<string, unknown>, accounts), /response lost/);
  assert.equal(requests.length, 1);

  assert.ok(!JSON.stringify(requests).includes('access_token'));
  await assert.rejects(executeGmail('gmail_send', { ...input, from: 'other@example.test' }, accounts), /sending account/);
  assert.equal(requests.length, 1);
});

test('reply verifies the already-confirmed original thread headers, never infers recipients or repairs mismatches', async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const reply: ReplyInput = { ...input, subject: 'Re: Original', messageId: 'message', threadId: 'thread', inReplyTo: '<original@example.test>', references: ['<parent@example.test>', '<original@example.test>'] };
  const accounts: Accounts = { confirm: async () => {}, list: async () => [account], request: async request => {
    calls.push(request);
    return { status: 200, contentType: 'application/json', body: JSON.stringify(request.method === 'POST' ? { id: 'sent', threadId: 'thread' } : { threadId: 'thread', payload: { headers: [
      { name: 'Message-ID', value: '<original@example.test>' }, { name: 'References', value: '<parent@example.test>' }, { name: 'Subject', value: 'Original' },
    ] } }) };
  } };
  assert.deepEqual(await executeGmail('gmail_reply', reply as unknown as Record<string, unknown>, accounts), { id: 'sent', threadId: 'thread' });
  const body = JSON.parse(calls[1]!.body!); assert.equal(body.threadId, 'thread');
  const mime = Buffer.from(body.raw, 'base64url').toString();
  assert.ok(mime.includes('In-Reply-To: <original@example.test>\r\nReferences: <parent@example.test> <original@example.test>'));
  assert.ok(mime.includes('To: to@example.test'));
  await assert.rejects(executeGmail('gmail_reply', { ...reply, references: ['<other@example.test>'] }, accounts), /confirmed original thread/);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('search escapes native query and attachment reads return fixed bytes without filesystem writes', async () => {
  const urls: string[] = [];
  const accounts: Accounts = { confirm: async () => {}, list: async () => [account], request: async request => { urls.push(request.url); return { status: 200, contentType: 'application/json', body: JSON.stringify(request.url.includes('/attachments/') ? { data: Buffer.from('file').toString('base64url') } : { messages: [] }) }; } };
  await executeGmail('gmail_search', { binding, query: 'from:a+b@example.test & x', pageToken: 'a/b' }, accounts);
  assert.equal(new URL(urls[0]!).searchParams.get('q'), 'from:a+b@example.test & x');
  const output = await executeGmail('gmail_attachment', { binding, messageId: 'id', attachmentId: 'a/b' }, accounts);
  assert.deepEqual(output, { contentBase64: Buffer.from('file').toString('base64'), size: 4, sha256: createHash('sha256').update('file').digest('hex') });
  assert.match(urls[1]!, /attachments\/a%2Fb$/);
});

test('read preserves HTML-only bodies as untrusted text, MIME charsets and inline attachment bytes', async () => {
  const accounts: Accounts = { confirm: async () => {}, list: async () => [account], request: async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'm', threadId: 't', payload: {
    mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/html', body: { data: Buffer.from('<b>Mail</b><script>untrusted</script>').toString('base64url') } },
      { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=windows-1252' }], body: { data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url') } },
      { filename: 'inline.txt', mimeType: 'text/plain', body: { data: Buffer.from('file').toString('base64url') } },
    ],
  } }) }) };
  const value = await executeGmail('gmail_read', { binding, messageId: 'm' }, accounts) as { html: string; text: string; attachments: Array<{ contentBase64: string; sha256: string }> };
  assert.equal(value.html, '<b>Mail</b><script>untrusted</script>'); assert.equal(value.text, 'café');
  assert.equal(value.attachments[0]!.contentBase64, 'ZmlsZQ=='); assert.equal(value.attachments[0]!.sha256, createHash('sha256').update('file').digest('hex'));
});

test('cancelled confirmation has no send; confirmation receives frozen content before one uncertain dispatch', async () => {
  let sends = 0;
  const accounts: Accounts = { list: async () => [account], confirm: async () => { throw new Error('cancelled'); }, request: async () => { sends++; return { status: 200, body: '{}' }; } };
  await assert.rejects(executeGmail('gmail_send', { ...input }, accounts), /cancelled/);
  assert.equal(sends, 0);
  let preview: unknown;
  accounts.confirm = async fixed => { preview = structuredClone(fixed); input.body = 'mutated after preview'; };
  accounts.request = async request => { sends++; assert.ok(Buffer.from(JSON.parse(request.body!).raw, 'base64url').toString().includes(Buffer.from('First line\nSecond line 世界').toString('base64'))); return { status: 200, body: '{}' }; };
  await assert.rejects(executeGmail('gmail_send', { ...input }, accounts), /uncertain/);
  assert.equal(sends, 1); assert.equal((preview as MailInput).body, 'First line\nSecond line 世界');
});
