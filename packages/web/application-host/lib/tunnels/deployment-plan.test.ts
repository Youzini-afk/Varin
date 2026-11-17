import { describe, expect, it } from 'vitest';
import {
  createSelfHostedDeploymentPlan, createSelfHostedUninstallPlan, finalizeDeploymentManifest,
  selfHostedDeploymentInspectionQuery, selfHostedDeploymentPaths,
  type DeploymentCertificateEvidence, type DeploymentPreflightEvidence, type SelfHostedDeploymentRequest,
} from './deployment-plan.js';

const hash = 'a'.repeat(64);
const oldHash = 'b'.repeat(64);
const target = { sshTargetId: 'home-vps', hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` };
const paths = selfHostedDeploymentPaths('home');
const request: SelfHostedDeploymentRequest = {
  deploymentId: 'home', target, publicOrigin: 'https://varin.example.com',
  frp: { controlPort: 7000, remotePort: 7300, tokenRef: 'VARIN_FRP_TOKEN_HOME', tls: {
    serverName: 'relay.example.com', certificateFile: '/etc/ssl/relay.pem', privateKeyFile: '/etc/ssl/private/relay.key', caSha256: hash,
  } }, https: { kind: 'caddy' },
};
const file = (sha256 = hash) => ({ kind: 'file' as const, uid: 0, safeAncestors: true, sha256 });
const missing = () => ({ kind: 'missing' as const, safeAncestors: true });
function certificate(overrides: Partial<DeploymentCertificateEvidence> = {}): DeploymentCertificateEvidence {
  return { certificateFile: request.frp.tls.certificateFile, privateKeyFile: request.frp.tls.privateKeyFile,
    names: ['relay.example.com'], chainVerified: true, keyMatches: true, validAtInspection: true, caSha256: hash,
    publiclyTrusted: false, renewalService: 'renew-frp.service', renewalHealthy: true,
    reloadsServices: [], restartsServices: [paths.frpsService], readableByServices: [paths.frpsService], ...overrides };
}
function fixture(): DeploymentPreflightEvidence {
  return { target: { ...target }, platform: { id: 'debian', systemd: true, systemdVersion: 252 }, privileged: true, inventoryComplete: true,
    paths: { [paths.frpsConfig]: missing(), [paths.token]: missing(), [paths.caddyConfig]: missing(),
      [`/etc/systemd/system/${paths.frpsService}`]: missing(), [`/etc/systemd/system/${paths.caddyService}`]: missing(),
      '/usr/bin/frps': file(), '/usr/bin/caddy': file(), [request.frp.tls.certificateFile]: file(), [request.frp.tls.privateKeyFile]: file() },
    components: [{ name: 'frps', version: '0.65.0', path: '/usr/bin/frps', sha256: hash },
      { name: 'caddy', version: '2.8.4', path: '/usr/bin/caddy', sha256: hash }],
    services: [], listeners: [], sites: [], certificates: [certificate()], dnsPointsToTarget: true,
    reachability: [80, 443, 7000].map(port => ({ port, protocol: 'tcp', state: 'allowed' })) };
}
function installed() {
  const evidence = fixture();
  const plan = createSelfHostedDeploymentPlan(request, evidence);
  for (const artifact of plan.artifacts) evidence.paths[artifact.path] = file(artifact.contentSha256 ?? artifact.expectedSha256 ?? hash);
  evidence.services.push({ name: paths.frpsService, kind: 'frps', unitPath: `/etc/systemd/system/${paths.frpsService}`, configPath: paths.frpsConfig, compatible: true },
    { name: paths.caddyService, kind: 'caddy', unitPath: `/etc/systemd/system/${paths.caddyService}`, configPath: paths.caddyConfig, compatible: true });
  const manifest = finalizeDeploymentManifest(plan, evidence);
  evidence.manifest = manifest;
  return { plan, evidence, manifest };
}
const codes = (evidence: DeploymentPreflightEvidence, input = request) => createSelfHostedDeploymentPlan(input, evidence).blockers.map(i => i.code);

describe('self-hosted deployment planning', () => {
  it('returns a deterministic, credential-redacted review instead of execution authority', () => {
    const evidence = fixture();
    const plan = createSelfHostedDeploymentPlan(request, evidence);
    expect(plan.ready).toBe(true);
    expect(plan.manifest.status).toBe('planned');
    expect(plan.id).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.steps.every(step => step.requiresApproval)).toBe(true);
    expect(plan.preview).toContain('No server configuration was changed');
    expect(createSelfHostedDeploymentPlan(request, { ...evidence, components: [...evidence.components].reverse(),
      paths: Object.fromEntries(Object.entries(evidence.paths).reverse()) })).toEqual(plan);
    const secretInput = { ...request, password: 'NEVER-PRINT-ME', frp: { ...request.frp, token: 'NEVER-PRINT-ME' } };
    expect(JSON.stringify(createSelfHostedDeploymentPlan(secretInput, evidence))).not.toContain('NEVER-PRINT-ME');
    expect(plan.artifacts.find(a => a.kind === 'credential')).toEqual({ id: 'frp-token', kind: 'credential', path: paths.token,
      ownership: 'owned', mode: '0600', secretRef: 'VARIN_FRP_TOKEN_HOME', action: 'create' });
    expect(plan.artifacts.every(a => a.ownership !== 'shared' || a.action === 'reuse')).toBe(true);
  });

  it('plans a loopback-only FRP mapping, forced verified TLS and private systemd credentials', () => {
    const plan = createSelfHostedDeploymentPlan(request, fixture());
    const config = JSON.parse(plan.artifacts.find(a => a.id === 'frps-config')!.content!);
    expect(config).toMatchObject({ bindPort: 7000, proxyBindAddr: '127.0.0.1', allowPorts: [{ single: 7300 }],
      auth: { method: 'token', tokenSource: { type: 'file' } }, transport: { tls: { force: true } } });
    expect(config.auth.token).toBeUndefined();
    expect(config.webServer).toBeUndefined();
    expect(plan.requiredPorts.map(p => p.port)).toEqual([80, 443, 7000]);
    const unit = plan.artifacts.find(a => a.id === 'frps-unit')!.content!;
    expect(unit).toContain(`LoadCredential=frp-token:${paths.token}`);
    expect(unit).toContain('DynamicUser=yes');
    expect(unit).not.toContain('VARIN_FRP_TOKEN_HOME=');
    expect(plan.artifacts.find(a => a.id === 'https-unit')!.content).toContain('RuntimeDirectoryMode=0700');
    expect(plan.artifacts.find(a => a.id === 'https-site')!.content).toContain('admin unix//run/varin-caddy-home/admin.sock');
  });

  it('proxies the entire origin and streams, with real 503 HTML only for known document navigation', () => {
    const config = createSelfHostedDeploymentPlan(request, fixture()).artifacts.find(a => a.id === 'https-site')!.content!;
    for (const value of ['reverse_proxy 127.0.0.1:7300', 'flush_interval -1', 'versions 1.1', 'header_up Host {http.request.host}',
      'exclude http.log.access http.log.error', 'log_skip', 'path / /connect', 'method GET HEAD',
      'header Sec-Fetch-Mode navigate', 'header Sec-Fetch-Dest document', 'not header Upgrade *',
      'handle_errors 502 503 504', 'header Content-Type application/json', 'external_access_unavailable']) expect(config).toContain(value);
    expect(config).not.toMatch(/header_up (Origin|Cookie|Authorization)/);
    expect(config).not.toContain('request_buffers');
    expect(config.match(/respond .* 503/g)?.length).toBe(3);
  });

  it('fails closed for platform, privilege, incomplete inspection and changed SSH identity', () => {
    const evidence = fixture();
    evidence.target.hostKeyFingerprint = `SHA256:${'B'.repeat(43)}`;
    evidence.platform = { id: 'alpine', systemd: false, systemdVersion: 0 };
    evidence.privileged = false;
    evidence.inventoryComplete = false;
    expect(codes(evidence)).toEqual(expect.arrayContaining(['target_mismatch', 'unsupported_platform', 'insufficient_privilege', 'incomplete_evidence']));
    expect(codes({ ...fixture(), platform: { id: 'ubuntu', systemd: true, systemdVersion: 245 } })).toContain('unsupported_platform');
  });

  it('does not invent components, public reachability, certificate trust or renewal safety', () => {
    const evidence = fixture();
    evidence.components = [];
    evidence.certificates = [];
    evidence.reachability = [];
    evidence.dnsPointsToTarget = false;
    expect(codes(evidence)).toEqual(expect.arrayContaining(['component_required', 'tls_evidence_required', 'dns_mismatch', 'firewall_review_required']));
    const noRestart = fixture();
    noRestart.certificates[0]!.restartsServices = [];
    noRestart.certificates[0]!.reloadsServices = [paths.frpsService];
    expect(codes(noRestart)).toContain('tls_evidence_required');
    const wrongCA = fixture();
    wrongCA.certificates[0]!.caSha256 = oldHash;
    expect(codes(wrongCA)).toContain('tls_evidence_required');
    expect(codes(fixture(), { ...request, publicOrigin: 'https://varin.local' })).toContain('tls_evidence_required');
  });

  it.each([
    { kind: 'symlink', uid: 0, safeAncestors: true }, { kind: 'directory', uid: 0, safeAncestors: true },
    { kind: 'file', uid: 1000, safeAncestors: true, sha256: hash }, { kind: 'file', uid: 0, safeAncestors: false, sha256: hash },
    { kind: 'missing', safeAncestors: false },
  ] as const)('preserves an unsafe destination: %j', path => {
    const evidence = fixture(); evidence.paths[paths.caddyConfig] = path;
    expect(codes(evidence)).toContain('path_conflict');
  });

  it('does not adopt unrelated files with identical content or assume omitted paths are absent', () => {
    const evidence = fixture();
    const first = createSelfHostedDeploymentPlan(request, evidence);
    evidence.paths[paths.caddyConfig] = file(first.artifacts.find(a => a.id === 'https-site')!.contentSha256);
    expect(codes(evidence)).toContain('ownership_conflict');
    delete evidence.paths[paths.caddyConfig];
    expect(codes(evidence)).toContain('incomplete_evidence');
  });

  it('recognizes an idempotent owned deployment but refuses drift', () => {
    const { evidence } = installed();
    const repeat = createSelfHostedDeploymentPlan(request, evidence);
    expect(repeat.ready).toBe(true);
    expect(repeat.artifacts.filter(a => a.ownership === 'owned').every(a => a.action === 'reuse')).toBe(true);
    evidence.paths[paths.caddyConfig] = file(oldHash);
    expect(codes(evidence)).toContain('ownership_conflict');
  });

  it('detects occupied ports and existing wildcard sites', () => {
    const evidence = fixture();
    evidence.listeners = [{ address: '0.0.0.0', port: 443, protocol: 'tcp', serviceName: 'other.service' },
      { address: '0.0.0.0', port: 7300, protocol: 'tcp', serviceName: 'frps.service' }];
    evidence.sites = [{ hostname: '*.example.com', configPath: '/etc/caddy/existing.caddy', serviceName: 'caddy.service' }];
    const plan = createSelfHostedDeploymentPlan(request, evidence);
    expect(plan.blockers.filter(b => b.code === 'port_conflict')).toHaveLength(2);
    expect(plan.blockers.find(b => b.code === 'site_conflict')?.resource).toBe('/etc/caddy/existing.caddy');
  });

  it('reuses each selected shared service without rewriting global FRP or proxy settings', () => {
    const evidence = fixture(), input = structuredClone(request);
    input.frp.reuseService = 'frps.service'; input.https.reuseService = 'caddy.service';
    evidence.services = [
      { name: 'frps.service', kind: 'frps', unitPath: '/usr/lib/systemd/system/frps.service', configPath: '/etc/frp/frps.toml', compatible: true,
        frp: { controlPort: 7000, proxyBindAddress: '127.0.0.1', allowedPorts: [7300, 7400], tlsServerName: 'relay.example.com', tlsCaSha256: hash, tlsForced: true, tokenRef: request.frp.tokenRef } },
      { name: 'caddy.service', kind: 'caddy', unitPath: '/usr/lib/systemd/system/caddy.service', configPath: '/etc/caddy/Caddyfile', compatible: true,
        includeDirectory: '/etc/caddy/sites', requestLoggingDisabled: true } ];
    for (const service of evidence.services) { evidence.paths[service.unitPath] = file(); evidence.paths[service.configPath] = file(); }
    evidence.paths['/etc/caddy/sites/varin-home.caddy'] = missing();
    evidence.certificates[0]!.reloadsServices = ['frps.service'];
    evidence.listeners = [{ address: '0.0.0.0', port: 443, protocol: 'tcp', serviceName: 'caddy.service' },
      { address: '127.0.0.1', port: 7300, protocol: 'tcp', serviceName: 'frps.service' }];
    const plan = createSelfHostedDeploymentPlan(input, evidence);
    expect(plan.blockers).toEqual([]);
    expect(plan.artifacts.filter(a => a.ownership === 'owned').map(a => a.id)).toEqual(['https-site']);
    expect(plan.artifacts.find(a => a.id === 'https-site')?.path).toBe('/etc/caddy/sites/varin-home.caddy');
    evidence.services[0]!.frp!.proxyBindAddress = '0.0.0.0';
    expect(codes(evidence, input)).toContain('incompatible_service');
    evidence.services[0]!.frp!.proxyBindAddress = '127.0.0.1'; evidence.services[1]!.requestLoggingDisabled = false;
    expect(codes(evidence, input)).toContain('incompatible_service');
  });

  it('requires explicit public trust and renewal for IP HTTPS, not Caddy local CA TLS', () => {
    const input = structuredClone(request), evidence = fixture(); input.publicOrigin = 'https://203.0.113.10';
    expect(codes(evidence, input)).toContain('ip_tls_evidence_required');
    input.https.certificate = { certificateFile: '/etc/ssl/ip.pem', privateKeyFile: '/etc/ssl/private/ip.key' };
    evidence.paths['/etc/ssl/ip.pem'] = file(); evidence.paths['/etc/ssl/private/ip.key'] = file();
    const publicCert = certificate({ ...input.https.certificate, names: ['203.0.113.10'], publiclyTrusted: true,
      renewalService: 'certbot-renew.service', restartsServices: [paths.caddyService], readableByServices: [] });
    evidence.certificates.push(publicCert);
    const plan = createSelfHostedDeploymentPlan(input, evidence);
    expect(plan.ready).toBe(true);
    expect(plan.artifacts.find(a => a.id === 'https-site')!.content).toContain(`tls /run/credentials/${paths.caddyService}/https-cert`);
    expect(plan.artifacts.find(a => a.id === 'https-unit')!.content).toContain('LoadCredential=https-key:/etc/ssl/private/ip.key');
    expect(plan.steps.map(s => s.stage)).not.toContain('issue-certificate');
    publicCert.publiclyTrusted = false; expect(codes(evidence, input)).toContain('ip_tls_evidence_required');
    publicCert.publiclyTrusted = true; publicCert.renewalHealthy = false;
    expect(codes(evidence, input)).toContain('ip_tls_evidence_required');
  });

  it('generates an nginx HTTP-context fragment without buffering or replacing upstream API errors', () => {
    const input = structuredClone(request), evidence = fixture();
    input.https = { kind: 'nginx', reuseService: 'nginx.service', certificate: { certificateFile: '/etc/ssl/web.pem', privateKeyFile: '/etc/ssl/private/web.key' } };
    evidence.components.push({ name: 'nginx', path: '/usr/sbin/nginx', version: '1.24.0', sha256: hash });
    evidence.services.push({ name: 'nginx.service', kind: 'nginx', unitPath: '/usr/lib/systemd/system/nginx.service', configPath: '/etc/nginx/nginx.conf', compatible: true,
      includeDirectory: '/etc/nginx/conf.d', requestLoggingDisabled: true });
    for (const path of ['/usr/sbin/nginx', '/usr/lib/systemd/system/nginx.service', '/etc/nginx/nginx.conf', '/etc/ssl/web.pem', '/etc/ssl/private/web.key']) evidence.paths[path] = file();
    evidence.paths['/etc/nginx/conf.d/varin-home.conf'] = missing();
    evidence.certificates.push(certificate({ ...input.https.certificate, names: ['varin.example.com'], publiclyTrusted: true,
      reloadsServices: ['nginx.service'], readableByServices: ['nginx.service'] }));
    const plan = createSelfHostedDeploymentPlan(input, evidence); expect(plan.blockers).toEqual([]);
    const config = plan.artifacts.find(a => a.id === 'https-site')!.content!;
    for (const value of ['proxy_request_buffering off;', 'proxy_buffering off;', 'proxy_set_header Connection $varin_home_connection;',
      'proxy_next_upstream off;', 'proxy_intercept_errors off;', 'return 503 $varin_home_body;']) expect(config).toContain(value);
    expect(config).not.toContain('rewrite ');
  });

  it('rejects credentials, unsafe template input and non-origin URLs before planning probe inputs', () => {
    for (const invalid of [{ ...request, deploymentId: '../other' }, { ...request, publicOrigin: 'https://user:password@varin.example.com' },
      { ...request, publicOrigin: 'https://varin.example.com:8443' }, { ...request, publicOrigin: 'https://varin.example.com/x' },
      { ...request, frp: { ...request.frp, tokenRef: 'raw-secret' } }, { ...request, frp: { ...request.frp, remotePort: request.frp.controlPort } },
      { ...request, frp: { ...request.frp, tls: { ...request.frp.tls, privateKeyFile: '/tmp/key\nExecStart=evil' } } },
      { ...request, https: { kind: 'caddy' as const, reuseService: 'x.service;evil' } }]) expect(() => selfHostedDeploymentInspectionQuery(invalid)).toThrow();
    const query = selfHostedDeploymentInspectionQuery(request);
    expect(query.ports).toEqual([80, 443, 7000, 7300]); expect(query.ownershipPath).toBe(paths.manifest);
    expect(query.files).toContain(request.frp.tls.privateKeyFile); expect(JSON.stringify(query)).not.toContain(request.frp.tokenRef);
  });
});

describe('manifest and ownership-scoped uninstall', () => {
  it('requires actual post-write artifact identities, including secret digests, before installing ownership', () => {
    const evidence = fixture(), plan = createSelfHostedDeploymentPlan(request, evidence);
    expect(() => finalizeDeploymentManifest(plan, evidence)).toThrow('Installed artifact');
    const { manifest } = installed(); expect(manifest.status).toBe('installed');
    expect(manifest.artifacts.find(a => a.id === 'frp-token')?.sha256).toBe(hash);
    expect(JSON.stringify(manifest)).not.toContain('content'); expect(JSON.stringify(manifest)).not.toContain(request.frp.tokenRef);
    expect(() => finalizeDeploymentManifest(plan, { ...evidence, target: { ...target, sshTargetId: 'other' } })).toThrow('Cannot finalize');
  });

  it('removes only unchanged owned files while preserving shared binaries, certificates and state', () => {
    const { manifest, evidence } = installed(); const plan = createSelfHostedUninstallPlan(manifest, evidence);
    expect(plan.ready).toBe(true);
    expect(plan.artifacts.filter(a => a.action === 'remove').map(a => a.id)).toEqual(['frp-token', 'frps-config', 'frps-unit', 'https-site', 'https-unit']);
    expect(plan.artifacts.filter(a => a.ownership === 'shared').every(a => a.action === 'reuse')).toBe(true);
    expect(plan.steps[0]!.description).toContain('Preserve shared binaries, certificates, firewall rules, state directories');
    evidence.paths[paths.caddyConfig] = missing();
    const partial = createSelfHostedUninstallPlan(manifest, evidence);
    expect(partial.ready).toBe(true); expect(partial.artifacts.find(a => a.id === 'https-site')).toBeUndefined();
  });

  it('blocks drift, symlinks, retargeted services and changed server identities', () => {
    const { manifest, evidence } = installed();
    evidence.paths[paths.frpsConfig] = file(oldHash); evidence.paths[paths.token] = { kind: 'symlink', uid: 0, safeAncestors: true };
    evidence.services[1]!.unitPath = '/etc/systemd/system/replacement.service';
    evidence.target = { ...target, hostKeyFingerprint: `SHA256:${'B'.repeat(43)}` };
    const plan = createSelfHostedUninstallPlan(manifest, evidence); expect(plan.ready).toBe(false);
    expect(plan.blockers.map(b => b.code)).toContain('target_mismatch');
    for (const id of ['frps-config', 'frp-token', 'https-unit']) expect(plan.artifacts.some(a => a.id === id && a.action === 'remove')).toBe(false);
  });

  it('rejects planned, invented and mismatching ownership instead of deleting unrelated data', () => {
    const { plan: original, evidence, manifest } = installed();
    expect(createSelfHostedUninstallPlan(original.manifest, evidence).ready).toBe(false);
    const forged = structuredClone(manifest);
    forged.artifacts.push({ id: 'unrelated', kind: 'configuration', path: '/etc/ssh/sshd_config', ownership: 'owned', sha256: hash });
    evidence.paths['/etc/ssh/sshd_config'] = file();
    const uninstall = createSelfHostedUninstallPlan(forged, evidence);
    expect(uninstall.ready).toBe(false); expect(uninstall.artifacts.some(a => a.path === '/etc/ssh/sshd_config')).toBe(false);
    evidence.manifest = { ...manifest, planId: oldHash };
    expect(createSelfHostedUninstallPlan(manifest, evidence).ready).toBe(false);
  });
});
