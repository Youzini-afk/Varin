import { createHash, X509Certificate } from 'node:crypto';

/** Three independent observations: certbot's process, the owned reload hook,
 * and a normally validated TLS connection to the configured authority.
 *
 * A zero exit can mean "not due" and ignores an independent hook error:
 * https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates
 * Never pass console output, certificate PEM, or private paths to consumers.
 */
interface CertbotObservation {
  exitCode: number | null;
  beforeLeafSha256: string | null;
  storedLeafSha256: string | null;
}

interface HookObservation {
  /** The independently owned hook receipt identifies both exact run and leaf. */
  attemptId: string;
  leafSha256: string;
  status: 'succeeded' | 'failed';
}

interface TlsObservation {
  /** Set only after chain, configured name/IP, and validity verification. */
  verified: boolean;
  leafSha256: string | null;
}

export interface RenewalEvidence {
  attemptId: string;
  certbot: CertbotObservation;
  reload: HookObservation | null;
  served: TlsObservation | null;
}

const digest = /^[a-f0-9]{64}$/u;
const hash = (value: string | null | undefined) => typeof value === 'string' && digest.test(value) ? value : null;

/** Hash the DER leaf, not the PEM serialization or concatenated chain. */
export function certificateLeafSha256(pemOrDer: string | Buffer): string | null {
  try {
    return createHash('sha256').update(new X509Certificate(pemOrDer).raw).digest('hex');
  } catch {
    return null;
  }
}

export function projectRenewalEvidence(evidence: RenewalEvidence) {
  const before = hash(evidence.certbot.beforeLeafSha256);
  const stored = hash(evidence.certbot.storedLeafSha256);
  const served = evidence.served?.verified ? hash(evidence.served.leafSha256) : null;
  const certbot = evidence.certbot.exitCode === null ? 'unknown'
    : evidence.certbot.exitCode === 0 ? 'succeeded' : 'failed';
  const certificate = before && stored ? (before === stored ? 'unchanged' : 'changed') : 'unknown';
  const hook = evidence.reload && evidence.reload.attemptId === evidence.attemptId
    && stored && hash(evidence.reload.leafSha256) === stored ? evidence.reload.status : 'unconfirmed';
  const deployment = !served || !stored ? 'unverified' : (served === stored ? 'served' : 'mismatch');

  // Current served evidence is separate from actually proving a specific
  // renewal. A previous leaf can still be valid and correctly served.
  const renewedAndServing = certbot === 'succeeded' && certificate === 'changed'
    && hook === 'succeeded' && deployment === 'served';
  return { certbot, certificate, hook, deployment, renewedAndServing };
}
