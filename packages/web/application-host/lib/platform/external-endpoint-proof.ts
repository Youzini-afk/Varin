import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { ExternalAccessCheck } from '@varin/application-client';

const prefix = '/.well-known/varin-entrance/';
const validId = /^[a-f0-9]{64}$/u;
const ipv4Denied = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) ipv4Denied.addSubnet(address, bits);
const ipv6Global = new BlockList();
ipv6Global.addSubnet('2000::', 3, 'ipv6');
const ipv6Denied = new BlockList();
for (const [address, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  ipv6Denied.addSubnet(address, bits, 'ipv6');
}

export function publicProofAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !ipv4Denied.check(address);
  return family === 6 && !address.includes('%')
    && ipv6Global.check(address, 'ipv6') && !ipv6Denied.check(address, 'ipv6');
}

interface ProofChallenge { ticket: string; expected: string; expiresAt: number }

export function createEndpointProof() {
  let open: ProofChallenge | null = null;
  return {
    issue() {
      const ticket = randomBytes(32).toString('hex');
      const expected = randomBytes(32).toString('hex');
      const challenge = { ticket, expected, expiresAt: Date.now() + 7_000 };
      open = challenge;
      return {
        path: prefix + ticket,
        expected,
        clear() { if (open === challenge) open = null; },
      };
    },
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      if (!req.url?.startsWith(prefix)) return false;
      const ticket = req.url.slice(prefix.length);
      const challenge = open;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method !== 'GET' || !challenge || challenge.expiresAt <= Date.now() || !validId.test(ticket)
        || !timingSafeEqual(Buffer.from(ticket), Buffer.from(challenge.ticket))) {
        res.writeHead(404).end();
      } else {
        open = null;
        res.writeHead(200).end(challenge.expected);
      }
      return true;
    },
  };
}

type Resolved = { address: string; family: number };
type ProofTransport = (url: URL, address: Resolved, signal: AbortSignal) => Promise<string | null>;

const requestProof: ProofTransport = (url, pinned, signal) => new Promise((resolve, reject) => {
  // Retain the configured authority for Host, SNI and certificate identity.
  // Socket lookup can return only the previously screened literal address.
  const req = request(url, {
    agent: false, method: 'GET', rejectUnauthorized: true, signal, family: pinned.family,
    lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    headers: { 'Cache-Control': 'no-store', Accept: 'text/plain' },
    maxHeaderSize: 4096,
  }, res => {
    if (res.statusCode !== 200 || !res.headers['content-type']?.startsWith('text/plain') || res.headers['content-encoding']) {
      res.destroy();
      resolve(null);
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64) { res.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    res.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.once('aborted', () => resolve(null));
    res.once('error', reject);
  });
  req.once('error', reject);
  req.end();
});

type ProofResult = 'verified' | NonNullable<ExternalAccessCheck['reason']>;
type ProofRequest = {
  origin: string;
  challenge: { path: string; expected: string };
  signal: AbortSignal;
  resolve?: (hostname: string) => Promise<Resolved[]>;
  transport?: ProofTransport;
};

const isTlsFailure = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^(ERR_(TLS|SSL)_|CERT_|UNABLE_TO_|SELF_SIGNED_CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|INVALID_CA|HOSTNAME_MISMATCH)/u.test(code);
};

export async function inspectPublicEndpoint(input: ProofRequest): Promise<ProofResult> {
  const done = new AbortController();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5_000), done.signal]);
  const work = async (): Promise<ProofResult> => {
    const origin = new URL(input.origin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== input.origin
      || !input.challenge.path.startsWith(prefix) || !validId.test(input.challenge.path.slice(prefix.length))
      || !validId.test(input.challenge.expected)) return 'different_endpoint';
    const hostname = origin.hostname.replace(/^\[|\]$/gu, '');
    const family = isIP(hostname);
    let addresses: Resolved[];
    try {
      addresses = family ? [{ address: hostname, family }]
        : await (input.resolve ?? (name => lookup(name, { all: true })))(hostname);
    } catch { return 'dns'; }
    signal.throwIfAborted();
    if (!addresses.length) return 'dns';
    if (addresses.some(address => isIP(address.address) !== address.family || !publicProofAddress(address.address))) return 'not_public';
    const url = new URL(input.challenge.path, origin);
    // Try both families without permitting a fresh DNS lookup or a redirect.
    try {
      return await Promise.any(addresses.slice(0, 4).map(async (address): Promise<'verified'> => {
        let proof: string | null;
        try { proof = await (input.transport ?? requestProof)(url, address, signal); } catch (error) {
          throw isTlsFailure(error) ? 'tls' : 'unreachable';
        }
        if (proof === null || !validId.test(proof)
          || !timingSafeEqual(Buffer.from(proof), Buffer.from(input.challenge.expected))) throw 'different_endpoint';
        return 'verified';
      }));
    } catch (error) {
      signal.throwIfAborted();
      const failures = error instanceof AggregateError ? error.errors as unknown[] : [];
      if (failures.includes('different_endpoint')) return 'different_endpoint';
      if (failures.includes('tls')) return 'tls';
      return 'unreachable';
    }
  };
  if (signal.aborted) return 'timeout';
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'timeout'>(resolve => {
    onAbort = () => resolve('timeout');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work().catch(() => signal.aborted ? 'timeout' as const : 'unreachable' as const), aborted]); }
  finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    done.abort();
  }
}

export async function verifyPublicEndpoint(input: ProofRequest): Promise<boolean> {
  return await inspectPublicEndpoint(input) === 'verified';
}
