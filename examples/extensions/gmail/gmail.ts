import { createHash, randomUUID } from 'node:crypto';
import type { JsonValue } from '@varin/extension-contract';
export interface GmailBinding { connectionId: string; account: string }
export interface GmailConnection extends GmailBinding { accountId: string }
export interface GmailRequest { binding: GmailBinding; url: string; method?: string; headers?: Record<string, string>; body?: string }
export interface Accounts {
  list(input: { providerId: string }): Promise<GmailConnection[]>;
  request(input: GmailRequest): Promise<{ status: number; body: string }>;
  confirm(input: JsonValue): Promise<void>;
}
export interface Attachment { filename: string; mimeType: string; contentBase64: string; sha256: string }
export interface MailInput {
  binding: GmailBinding;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: Attachment[];
}
export interface ReplyInput extends MailInput { messageId: string; threadId: string; inReplyTo: string; references: string[] }
const api = 'https://gmail.googleapis.com/gmail/v1/users/me';
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function header(value: string): string {
  if (typeof value !== 'string' || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Invalid mail header');
  return value;
}
function address(value: string): string {
  // Deliberately accept bare addresses, not ambiguous display-name/group syntax.
  if (!/^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+\.[^\s<>(),;:"\\@]+$/.test(header(value))) throw new Error('Use a bare email address');
  return value;
}
function messageId(value: string): string {
  if (!/^<[^\s<>]+@[^\s<>]+>$/.test(header(value))) throw new Error('Invalid Message-ID');
  return value;
}
const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const lines = (value: string) => value.match(/.{1,76}/g)?.join('\r\n') ?? '';
function encodedHeader(value: string): string {
  // RFC 2047 encoded words are at most 75 characters, split only between Unicode code points.
  const parts: string[] = []; let part = '';
  for (const point of header(value)) {
    if (Buffer.byteLength(part + point) > 42) { parts.push(`=?UTF-8?B?${encoded(part)}?=`); part = ''; }
    part += point;
  }
  if (part || !parts.length) parts.push(`=?UTF-8?B?${encoded(part)}?=`);
  return parts.join('\r\n ');
}
function attachmentPart(item: Attachment): string {
  header(item.filename);
  if (!item.filename || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(item.mimeType)) throw new Error('Invalid attachment metadata');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.contentBase64)) throw new Error('Attachment must use canonical base64');
  const bytes = Buffer.from(item.contentBase64, 'base64');
  if (hash(bytes) !== item.sha256) throw new Error('Attachment content differs from the confirmed SHA-256');
  const filename = encodeURIComponent(item.filename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `Content-Type: ${item.mimeType}\r\nContent-Disposition: attachment; filename*=UTF-8''${filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(item.contentBase64)}`;
}
/** Deterministic semantic content: no filesystem reads, recipient inference or mutable draft lookup. */
export function buildMessage(input: MailInput | ReplyInput, boundary = `varin-${randomUUID()}`): string {
  if (!input.to.length) throw new Error('A recipient is required');
  const headers = [`From: ${address(input.from)}`, `To: ${input.to.map(address).join(', ')}`];
  if (input.cc?.length) headers.push(`Cc: ${input.cc.map(address).join(', ')}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.map(address).join(', ')}`);
  headers.push(`Subject: ${encodedHeader(input.subject)}`, 'MIME-Version: 1.0');
  if ('inReplyTo' in input) headers.push(`In-Reply-To: ${messageId(input.inReplyTo)}`, `References: ${input.references.map(messageId).join(' ')}`);
  const body = `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(encoded(input.body))}`;
  if (!input.attachments?.length) return [...headers, body].join('\r\n');
  if (!/^[A-Za-z0-9-]+$/.test(boundary)) throw new Error('Invalid MIME boundary');
  const parts = [body, ...input.attachments.map(attachmentPart)];
  return `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.map(part => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`;
}
async function request(accounts: Accounts, binding: GmailBinding, path: string, init: Partial<GmailRequest> = {}): Promise<Record<string, unknown>> {
  const response = await accounts.request({ binding, url: `${api}${path}`, ...init });
  // No retry, including 401 refresh failures, 429, 5xx, transport errors or invalid success bodies.
  if (response.status < 200 || response.status >= 300) throw new Error(`Gmail request failed (HTTP ${response.status}); a dispatched send may be uncertain. Inspect Sent before trying again.`);
  const value: unknown = JSON.parse(response.body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gmail returned an invalid response; do not repeat a send automatically');
  return value as Record<string, unknown>;
}
function headersOf(message: Record<string, unknown>): Record<string, string> {
  const headers = object(message.payload).headers;
  return Object.fromEntries((Array.isArray(headers) ? headers : []).map(object)
    .filter(h => typeof h.name === 'string' && typeof h.value === 'string').map(h => [String(h.name).toLowerCase(), String(h.value)]));
}
function projectMessage(message: Record<string, unknown>): Record<string, unknown> {
  const text: string[] = [], html: string[] = [], attachments: unknown[] = [];
  function walk(value: unknown) {
    const part = object(value), body = object(part.body);
    if (part.filename || body.attachmentId) {
      const bytes = typeof body.data === 'string' ? Buffer.from(body.data, 'base64url') : undefined;
      attachments.push({ filename: part.filename ?? '', mimeType: part.mimeType ?? '', attachmentId: body.attachmentId ?? null, size: body.size ?? bytes?.length ?? null,
        ...(bytes ? { contentBase64: bytes.toString('base64'), sha256: hash(bytes) } : {}) });
    } else if (typeof body.data === 'string' && (part.mimeType === 'text/plain' || part.mimeType === 'text/html')) {
      const contentType = headersOf({ payload: part })['content-type'] ?? '';
      const charset = contentType.match(/charset=["']?([^\s;"']+)/i)?.[1] ?? 'utf-8';
      const bytes = Buffer.from(body.data, 'base64url');
      let decoded: string;
      try { decoded = new TextDecoder(charset).decode(bytes); } catch { decoded = bytes.toString('utf8'); }
      (part.mimeType === 'text/html' ? html : text).push(decoded);
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(message.payload);
  return { id: message.id ?? null, threadId: message.threadId ?? null, labelIds: message.labelIds ?? [], snippet: message.snippet ?? '', headers: headersOf(message), text: text.join('\n'), html: html.join('\n'), attachments };
}
export async function executeGmail(name: string, input: Record<string, unknown>, accounts: Accounts): Promise<JsonValue> {
  input = structuredClone(input);
  const binding = input.binding as GmailBinding;
  const id = (key: string) => encodeURIComponent(String(input[key]));
  switch (name) {
    case 'gmail_accounts': return { accounts: await accounts.list({ providerId: 'gmail' }) } as unknown as JsonValue;
    case 'gmail_search': {
      const query = new URLSearchParams({ q: String(input.query), maxResults: String(input.maxResults ?? 20) });
      if (input.pageToken) query.set('pageToken', String(input.pageToken));
      return await request(accounts, binding, `/messages?${query}`) as JsonValue;
    }
    case 'gmail_read': return projectMessage(await request(accounts, binding, `/messages/${id('messageId')}?format=full`)) as JsonValue;
    case 'gmail_thread': {
      const value = await request(accounts, binding, `/threads/${id('threadId')}?format=full`);
      return { id: value.id ?? null, messages: (Array.isArray(value.messages) ? value.messages : []).map(v => projectMessage(object(v))) } as JsonValue;
    }
    case 'gmail_attachment': {
      const value = await request(accounts, binding, `/messages/${id('messageId')}/attachments/${id('attachmentId')}`);
      if (typeof value.data !== 'string') throw new Error('Gmail attachment data missing');
      const bytes = Buffer.from(value.data, 'base64url');
      return { contentBase64: bytes.toString('base64'), sha256: hash(bytes), size: bytes.length };
    }
    case 'gmail_send': case 'gmail_reply': {
      const mail = input as unknown as MailInput | ReplyInput;
      const account = (await accounts.list({ providerId: 'gmail' })).find(item => item.connectionId === binding.connectionId
        && item.account === binding.account);
      if (!account?.accountId || account.accountId !== mail.from) throw new Error('The confirmed sending account no longer matches the connection');
      const raw = Buffer.from(buildMessage(mail), 'utf8').toString('base64url');
      if (name === 'gmail_reply') {
        const reply = mail as ReplyInput;
        const original = await request(accounts, binding, `/messages/${id('messageId')}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`);
        const headers = headersOf(original);
        const references = [...(headers.references?.match(/<[^<>]+>/g) ?? []), headers['message-id']];
        if (original.threadId !== reply.threadId || headers['message-id'] !== reply.inReplyTo
          || JSON.stringify(references) !== JSON.stringify(reply.references)
          || (reply.subject !== headers.subject && reply.subject !== `Re: ${headers.subject}`)) throw new Error('Reply headers differ from the confirmed original thread');
      }
      await accounts.confirm(input as JsonValue);
      const result = await request(accounts, binding, '/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw, ...(name === 'gmail_reply' ? { threadId: (mail as ReplyInput).threadId } : {}) }) });
      if (typeof result.id !== 'string' || typeof result.threadId !== 'string') throw new Error('Send response is uncertain; inspect Sent and do not automatically resend');
      return { id: result.id, threadId: result.threadId };
    }
    default: throw new Error('Unknown Gmail tool');
  }
}
