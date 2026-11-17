import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { expect, it } from 'vitest';
import { certificateLeafSha256, projectRenewalEvidence, type RenewalEvidence } from './deployment-renewal-evidence.js';

const oldLeaf = 'a'.repeat(64);
const newLeaf = 'b'.repeat(64);
const good: RenewalEvidence = {
  attemptId: 'test-renewal',
  certbot: { exitCode: 0, beforeLeafSha256: oldLeaf, storedLeafSha256: newLeaf },
  reload: { attemptId: 'test-renewal', leafSha256: newLeaf, status: 'succeeded' },
  served: { verified: true, leafSha256: newLeaf },
};

it('requires independent new-leaf, hook and trusted TLS evidence', () => {
  expect(projectRenewalEvidence(good)).toEqual({
    certbot: 'succeeded', certificate: 'changed', hook: 'succeeded', deployment: 'served', renewedAndServing: true,
  });
});

it('does not infer that an unchanged certificate was renewed or due', () => {
  expect(projectRenewalEvidence({
    ...good, certbot: { ...good.certbot, storedLeafSha256: oldLeaf },
    reload: null, served: { verified: true, leafSha256: oldLeaf },
  })).toEqual({ certbot: 'succeeded', certificate: 'unchanged', hook: 'unconfirmed', deployment: 'served', renewedAndServing: false });
});

it('keeps hook failure and the stale served certificate visible on exit zero', () => {
  expect(projectRenewalEvidence({
    ...good, reload: { ...good.reload!, status: 'failed' }, served: { verified: true, leafSha256: oldLeaf },
  })).toEqual({ certbot: 'succeeded', certificate: 'changed', hook: 'failed', deployment: 'mismatch', renewedAndServing: false });
});

it.each([
  { ...good, reload: { ...good.reload!, attemptId: 'another-run' } },
  { ...good, reload: { ...good.reload!, leafSha256: oldLeaf } },
  { ...good, served: { verified: false, leafSha256: newLeaf } },
  { ...good, certbot: { ...good.certbot, exitCode: 1 } },
  { ...good, certbot: { ...good.certbot, exitCode: null } },
  { ...good, certbot: { ...good.certbot, beforeLeafSha256: 'malformed' } },
])('rejects evidence that does not establish renewal and serving', evidence => {
  expect(projectRenewalEvidence(evidence).renewedAndServing).toBe(false);
});

it('normalizes stored PEM, served DER, and stored chains to the same leaf digest', () => {
  const pem = rootCertificates[0]!;
  const der = new X509Certificate(pem).raw;
  const chain = pem + '\n' + rootCertificates[1]!;
  const expected = certificateLeafSha256(der);
  expect(expected).toMatch(/^[a-f0-9]{64}$/);
  expect(certificateLeafSha256(pem)).toBe(expected);
  expect(certificateLeafSha256(chain)).toBe(expected);
  expect(certificateLeafSha256('not a certificate')).toBeNull();
});
