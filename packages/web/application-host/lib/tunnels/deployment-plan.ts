import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { posix } from 'node:path';

/** Trusted Host-side input only. A browser must not manufacture preflight evidence. */
export interface DeploymentTarget {
  sshTargetId: string;
  hostKeyFingerprint: string;
}
export type DeploymentPathEvidence = { kind: 'missing'; safeAncestors: boolean } | {
  kind: 'file' | 'directory' | 'symlink' | 'other';
  sha256?: string;
  uid: number;
  /** The collector checked every ancestor with lstat, not just the leaf. */
  safeAncestors: boolean;
};
export interface DeploymentComponent {
  name: 'frps' | 'caddy' | 'nginx';
  version: string;
  path: string;
  sha256: string;
}
export interface DeploymentServiceEvidence {
  name: string;
  kind: 'frps' | 'caddy' | 'nginx' | 'other';
  unitPath: string;
  configPath: string;
  /** Already active, compatible, complete configuration was inspected. */
  compatible: boolean;
  /** Exact include directory, not permission to rewrite the shared root config. */
  includeDirectory?: string;
  requestLoggingDisabled?: boolean;
  frp?: {
    controlPort: number;
    proxyBindAddress: string;
    allowedPorts: number[];
    tlsServerName: string;
    tlsCaSha256: string;
    tlsForced: boolean;
    tokenRef: string;
  };
}
export interface DeploymentCertificateEvidence {
  certificateFile: string;
  privateKeyFile: string;
  names: string[];
  chainVerified: boolean;
  keyMatches: boolean;
  validAtInspection: boolean;
  /** TLS verification against this exact CA was performed, not TLS encryption alone. */
  caSha256: string;
  publiclyTrusted: boolean;
  renewalService: string;
  renewalHealthy: boolean;
  reloadsServices: string[];
  /** Required when TLS files are loaded with systemd LoadCredential (copies refresh on restart). */
  restartsServices: string[];
  readableByServices: string[];
}
export interface DeploymentPreflightEvidence {
  target: DeploymentTarget;
  platform: { id: string; systemd: boolean; systemdVersion: number };
  privileged: boolean;
  inventoryComplete: boolean;
  paths: Record<string, DeploymentPathEvidence>;
  components: DeploymentComponent[];
  services: DeploymentServiceEvidence[];
  listeners: { address: string; port: number; protocol: 'tcp' | 'udp'; serviceName?: string }[];
  sites: { hostname: string; configPath: string; serviceName: string }[];
  certificates: DeploymentCertificateEvidence[];
  dnsPointsToTarget: boolean;
  /** Host/cloud firewall state is read-only. Unknown must not become allowed. */
  reachability: { port: number; protocol: 'tcp'; state: 'allowed' | 'blocked' | 'unknown' }[];
  /** Authenticated root-owned record, not an ownership comment in a configuration. */
  manifest?: InstalledDeploymentManifest;
}
export interface SelfHostedDeploymentRequest {
  deploymentId: string;
  target: DeploymentTarget;
  publicOrigin: string;
  frp: {
    controlPort: number;
    remotePort: number;
    tokenRef: string;
    tls: { serverName: string; certificateFile: string; privateKeyFile: string; caSha256: string };
    /** Reuse never modifies the shared service's global bind/auth/TLS configuration. */
    reuseService?: string;
  };
  https: {
    kind: 'caddy' | 'nginx';
    reuseService?: string;
    /** Required for nginx and IP origins. Domain Caddy otherwise uses automatic HTTPS. */
    certificate?: { certificateFile: string; privateKeyFile: string };
  };
}
export type DeploymentArtifactKind = 'configuration' | 'service' | 'credential' | 'component' | 'certificate';
export type DeploymentArtifactAction = 'create' | 'replace' | 'reuse' | 'remove';
export interface DeploymentArtifact {
  id: string;
  kind: DeploymentArtifactKind;
  path: string;
  ownership: 'owned' | 'shared';
  action: DeploymentArtifactAction;
  mode?: '0600' | '0644' | '0755';
  /** Contains no secret placeholders masquerading as a runnable configuration. */
  content?: string;
  contentSha256?: string;
  expectedSha256?: string;
  /** Resolved by the credential owner via private stdin/files after approval. */
  secretRef?: string;
  serviceName?: string;
}
export interface DeploymentIssue {
  code: 'unsupported_platform' | 'insufficient_privilege' | 'incomplete_evidence' | 'target_mismatch'
    | 'path_conflict' | 'ownership_conflict' | 'port_conflict' | 'site_conflict' | 'component_required'
    | 'incompatible_service' | 'tls_evidence_required' | 'ip_tls_evidence_required' | 'dns_mismatch'
    | 'firewall_review_required' | 'manifest_not_installed';
  message: string;
  resource?: string;
}
export interface DeploymentStep {
  id: string;
  stage: 'install-frp' | 'configure-proxy' | 'issue-certificate' | 'configure-renewal'
    | 'configure-firewall' | 'configure-service' | 'verify-entrypoint' | 'remove-resources';
  artifactIds: string[];
  requiresApproval: true;
  description: string;
}
export interface DeploymentManifestArtifact {
  id: string;
  kind: DeploymentArtifactKind;
  path: string;
  ownership: 'owned' | 'shared';
  sha256?: string;
  serviceName?: string;
}
interface ManifestBase {
  schemaVersion: 1;
  deploymentId: string;
  target: DeploymentTarget;
  publicOrigin: string;
  artifacts: DeploymentManifestArtifact[];
}
export interface PlannedDeploymentManifest extends ManifestBase { status: 'planned' }
export interface InstalledDeploymentManifest extends ManifestBase { status: 'installed'; planId: string }
export interface DeploymentPlan {
  schemaVersion: 1;
  id: string;
  action: 'deploy' | 'uninstall';
  deploymentId: string;
  target: DeploymentTarget;
  publicOrigin: string;
  /** Ready for review, NOT authority to execute and NOT proof the endpoint works. */
  ready: boolean;
  blockers: DeploymentIssue[];
  artifacts: DeploymentArtifact[];
  steps: DeploymentStep[];
  manifest: PlannedDeploymentManifest;
  requiredPorts: { port: number; protocol: 'tcp'; purpose: 'https' | 'acme-http' | 'frp-control' }[];
  preview: string;
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const identifier = /^[a-z0-9][a-z0-9-]{0,47}$/;
const servicePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/;
const safePath = (value: string) => /^\/[a-zA-Z0-9_./-]+$/.test(value) && posix.normalize(value) === value && value !== '/';
const validPort = (value: number) => Number.isInteger(value) && value > 1023 && value <= 65535;
const targetEqual = (a: DeploymentTarget, b: DeploymentTarget) => a.sshTargetId === b.sshTargetId && a.hostKeyFingerprint === b.hostKeyFingerprint;
const validTarget = (target: DeploymentTarget) => /^[a-zA-Z0-9_.:-]+$/.test(target.sshTargetId)
  && /^SHA256:[a-zA-Z0-9+/]{43}=?$/.test(target.hostKeyFingerprint);
const dnsName = (value: string) => value.length <= 253 && value.split('.').length > 1
  && value.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
const offlineHtml = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Varin unavailable</title><h1>Unable to connect to Varin</h1><p>Try again when your Host is online.</p><a href="/">Retry</a></html>';
const offlineJson = '{"error":{"code":"external_access_unavailable","message":"Varin is temporarily unavailable"}}';

export function selfHostedDeploymentPaths(deploymentId: string) {
  if (!identifier.test(deploymentId)) throw new Error('Invalid deployment identifier');
  const directory = `/etc/varin/external-access/${deploymentId}`;
  return {
    directory,
    frpsConfig: `${directory}/frps.json`,
    token: `${directory}/frp-token`,
    caddyConfig: `${directory}/Caddyfile`,
    frpsService: `varin-frps-${deploymentId}.service`,
    caddyService: `varin-caddy-${deploymentId}.service`,
    manifest: `/var/lib/varin/external-access/${deploymentId}/manifest.json`,
  };
}

function normalizeRequest(input: SelfHostedDeploymentRequest): SelfHostedDeploymentRequest {
  if (!input || !identifier.test(input.deploymentId) || !input.target || !validTarget(input.target)
    || !validPort(input.frp?.controlPort) || !validPort(input.frp?.remotePort)
    || input.frp.controlPort === input.frp.remotePort
    || !/^VARIN_FRP_TOKEN(?:_[A-Z0-9_]+)?$/.test(input.frp.tokenRef)
    || !input.frp.tls || !dnsName(input.frp.tls.serverName)
    || !safePath(input.frp.tls.certificateFile) || !safePath(input.frp.tls.privateKeyFile)
    || !hashPattern.test(input.frp.tls.caSha256)
    || !['caddy', 'nginx'].includes(input.https?.kind)
    || (input.frp.reuseService && !servicePattern.test(input.frp.reuseService))
    || (input.https.reuseService && !servicePattern.test(input.https.reuseService))
    || (input.https.certificate && (!safePath(input.https.certificate.certificateFile) || !safePath(input.https.certificate.privateKeyFile)))) {
    throw new Error('Invalid self-hosted deployment request');
  }
  let url: URL;
  try { url = new URL(input.publicOrigin); } catch { throw new Error('Invalid public HTTPS origin'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(input.publicOrigin) || url.username || url.password || url.port
    || url.pathname !== '/' || (!isIP(hostname) && !dnsName(hostname))) throw new Error('Deployment requires an HTTPS origin on port 443');
  // Project fields, never copy arbitrary browser properties or credentials to preview.
  return {
    deploymentId: input.deploymentId,
    target: { sshTargetId: input.target.sshTargetId, hostKeyFingerprint: input.target.hostKeyFingerprint },
    publicOrigin: url.origin,
    frp: {
      controlPort: input.frp.controlPort, remotePort: input.frp.remotePort, tokenRef: input.frp.tokenRef,
      tls: { serverName: input.frp.tls.serverName, certificateFile: input.frp.tls.certificateFile,
        privateKeyFile: input.frp.tls.privateKeyFile, caSha256: input.frp.tls.caSha256 },
      ...(input.frp.reuseService ? { reuseService: input.frp.reuseService } : {}),
    },
    https: { kind: input.https.kind, ...(input.https.reuseService ? { reuseService: input.https.reuseService } : {}),
      ...(input.https.certificate ? { certificate: { certificateFile: input.https.certificate.certificateFile,
        privateKeyFile: input.https.certificate.privateKeyFile } } : {}) },
  };
}

/** Fixed allowlisted probe inputs. A first inspection discovers reuse/include paths for a second read-only pass. */
export function selfHostedDeploymentInspectionQuery(input: SelfHostedDeploymentRequest) {
  const request = normalizeRequest(input);
  const paths = selfHostedDeploymentPaths(request.deploymentId);
  return {
    ports: [80, 443, request.frp.controlPort, request.frp.remotePort].sort((a, b) => a - b),
    files: [...new Set([
      paths.frpsConfig, paths.token, paths.caddyConfig,
      `/etc/systemd/system/${paths.frpsService}`, `/etc/systemd/system/${paths.caddyService}`,
      '/usr/local/bin/frps', '/usr/bin/frps', '/usr/local/bin/caddy', '/usr/bin/caddy', '/usr/sbin/nginx',
      '/etc/caddy/Caddyfile', '/etc/nginx/nginx.conf',
      request.frp.tls.certificateFile, request.frp.tls.privateKeyFile,
      ...(request.https.certificate ? [request.https.certificate.certificateFile, request.https.certificate.privateKeyFile] : []),
    ])].sort(),
    services: [...new Set([paths.frpsService, paths.caddyService, 'caddy.service', 'nginx.service', 'frps.service',
      ...(request.frp.reuseService ? [request.frp.reuseService] : []), ...(request.https.reuseService ? [request.https.reuseService] : [])])].sort(),
    ownershipPath: paths.manifest,
  };
}

function versionAtLeast(version: string, major: number, minor: number) {
  const match = /^(\d+)\.(\d+)\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.exec(version);
  return !!match && (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor));
}

/**
 * Templates use FRP v0.65's file tokenSource and forced TLS, NOT its insecure defaults.
 * https://github.com/fatedier/frp/blob/v0.65.0/conf/frps_full_example.toml
 * Caddy forwards all methods/URIs, WS and streaming bodies without request buffering.
 * https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
 * Only known HTML navigation routes get an offline page. API/files/SSE/WS do not.
 */
function caddySite(origin: string, remotePort: number, certificate?: SelfHostedDeploymentRequest['https']['certificate']) {
  const reverseProxy = (offline: boolean) => `reverse_proxy 127.0.0.1:${remotePort} {
      header_up Host {http.request.host}
      header_up X-Forwarded-Host {http.request.host}
      header_up X-Forwarded-Proto https
      header_down Cache-Control "no-store"
      flush_interval -1
      transport http {
        versions 1.1
      }${offline ? `
      @unavailable status 502 503 504
      handle_response @unavailable {
        header Content-Type "text/html; charset=utf-8"
        respond ${JSON.stringify(offlineHtml)} 503
      }` : ''}
    }`;
  return `${origin} {
  log_skip
  ${certificate ? `tls ${certificate.certificateFile} ${certificate.privateKeyFile}` : '# Public DNS name: Caddy provisions and renews a public ACME certificate.'}
  header Cache-Control "no-store"
  @htmlNavigation {
    method GET HEAD
    path / /connect
    header Accept *text/html*
    header Sec-Fetch-Mode navigate
    header Sec-Fetch-Dest document
    not header Upgrade *
  }
  handle @htmlNavigation {
    ${reverseProxy(true)}
  }
  handle {
    ${reverseProxy(false)}
  }
  handle_errors 502 503 504 {
    handle @htmlNavigation {
      header Content-Type "text/html; charset=utf-8"
      respond ${JSON.stringify(offlineHtml)} 503
    }
    handle {
      header Content-Type application/json
      respond ${JSON.stringify(offlineJson)} 503
    }
  }
}
`;
}

/** HTTP-context fragment: maps plus an independent server; never replaces nginx.conf. */
function nginxSite(origin: string, remotePort: number, id: string, certificate: NonNullable<SelfHostedDeploymentRequest['https']['certificate']>) {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  const variable = `varin_${id.replaceAll('-', '_')}`;
  const quote = (text: string) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  return `map $http_upgrade $${variable}_connection {
  default upgrade;
  '' close;
}
map "$request_method|$uri|$http_accept|$http_sec_fetch_mode|$http_sec_fetch_dest|$http_upgrade" $${variable}_html {
  default 0;
  "~^(GET|HEAD)\\|(/|/connect)\\|[^|]*text/html[^|]*\\|navigate\\|document\\|$" 1;
}
map $${variable}_html $${variable}_type {
  default application/json;
  1 "text/html; charset=utf-8";
}
map $${variable}_html $${variable}_body {
  default ${quote(offlineJson)};
  1 ${quote(offlineHtml)};
}
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${host};
  ssl_certificate ${certificate.certificateFile};
  ssl_certificate_key ${certificate.privateKeyFile};
  access_log off;
  error_log /dev/null crit;
  client_max_body_size 0;
  location / {
    proxy_pass http://127.0.0.1:${remotePort};
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $${variable}_connection;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_next_upstream off;
    proxy_hide_header Cache-Control;
    add_header Cache-Control no-store always;
    # Preserve upstream API/WS error responses; only connection failures enter this handler.
    proxy_intercept_errors off;
    error_page 502 503 504 =503 @${variable}_offline;
  }
  location @${variable}_offline {
    internal;
    default_type "";
    add_header Content-Type $${variable}_type always;
    add_header Cache-Control no-store always;
    return 503 $${variable}_body;
  }
}
`;
}

function unitHeader(id: string) {
  return `# Varin external access ${id}; ownership is established by the installed manifest, not this comment.
[Unit]
Description=Varin external access
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
UMask=0077
Restart=on-failure
RestartSec=5s
`;
}
function unitFooter() { return '[Install]\nWantedBy=multi-user.target\n'; }

function finishPlan(plan: Omit<DeploymentPlan, 'id' | 'ready' | 'preview'>): DeploymentPlan {
  const artifacts = [...plan.artifacts].sort((a, b) => a.id.localeCompare(b.id));
  const blockers = [...plan.blockers].sort((a, b) => `${a.code}:${a.resource ?? ''}`.localeCompare(`${b.code}:${b.resource ?? ''}`));
  const manifest = { ...plan.manifest, artifacts: [...plan.manifest.artifacts].sort((a, b) => a.id.localeCompare(b.id)) };
  const body = { ...plan, artifacts, blockers, manifest };
  const preview = [
    `${plan.action === 'deploy' ? 'Deployment' : 'Uninstall'} preview: ${plan.publicOrigin}`,
    `SSH target: ${plan.target.sshTargetId}; verified host key: ${plan.target.hostKeyFingerprint}`,
    'Review only. No server configuration was changed. Fresh preflight and explicit approval are required before any write.',
    ...artifacts.map(a => `${a.action}: ${a.path} (${a.ownership}${a.secretRef ? '; private credential input, value omitted' : ''})`),
    ...plan.requiredPorts.map(p => `Required ingress: TCP ${p.port} (${p.purpose}); no firewall rule has been changed.`),
    ...blockers.map(issue => `Blocked: ${issue.message}${issue.resource ? ` [${issue.resource}]` : ''}`),
    'Existing shared services, certificates, package installations and device authorizations are preserved.',
  ].join('\n');
  return { ...body, id: digest(JSON.stringify(body)), ready: blockers.length === 0, preview };
}

/** Pure deterministic planning. Never reads files, spawns SSH, downloads or applies a firewall rule. */
export function createSelfHostedDeploymentPlan(input: SelfHostedDeploymentRequest, evidence: DeploymentPreflightEvidence): DeploymentPlan {
  const request = normalizeRequest(input);
  const paths = selfHostedDeploymentPaths(request.deploymentId);
  const blockers: DeploymentIssue[] = [];
  const artifacts: DeploymentArtifact[] = [];
  const steps: DeploymentStep[] = [];
  const issue = (code: DeploymentIssue['code'], message: string, resource?: string) => blockers.push({ code, message, ...(resource ? { resource } : {}) });
  const ownedManifest = evidence.manifest?.status === 'installed' && evidence.manifest.deploymentId === request.deploymentId
    && targetEqual(evidence.manifest.target, request.target) ? evidence.manifest : undefined;
  if (!targetEqual(request.target, evidence.target)) issue('target_mismatch', 'Preflight belongs to a different SSH target or host key');
  if (!['ubuntu', 'debian'].includes(evidence.platform.id) || !evidence.platform.systemd || evidence.platform.systemdVersion < 247) {
    issue('unsupported_platform', 'Deployment requires Ubuntu/Debian with systemd 247+ credential support');
  }
  if (!evidence.privileged) issue('insufficient_privilege', 'Root or verified sufficient sudo privileges are required');
  if (!evidence.inventoryComplete) issue('incomplete_evidence', 'Read-only port, service and site inspection is incomplete');

  const addArtifact = (artifact: Omit<DeploymentArtifact, 'action'>): DeploymentArtifact => {
    const current = evidence.paths[artifact.path];
    let action: DeploymentArtifactAction = artifact.ownership === 'shared' ? 'reuse' : 'create';
    let expectedSha256: string | undefined;
    if (!current) issue('incomplete_evidence', 'Path has not been inspected', artifact.path);
    else if (current.kind !== 'missing') {
      if (current.kind !== 'file' || current.uid !== 0 || !current.safeAncestors || !current.sha256 || !hashPattern.test(current.sha256)) {
        issue('path_conflict', 'Expected a root-owned regular file with safe ancestors and an observed digest', artifact.path);
      } else {
        expectedSha256 = current.sha256;
        if (artifact.ownership === 'owned') {
          const previous = ownedManifest?.artifacts.find(a => a.path === artifact.path && a.id === artifact.id && a.kind === artifact.kind
            && a.ownership === 'owned' && a.sha256 === current.sha256);
          if (!previous) issue('ownership_conflict', 'Existing file is not unchanged content owned by this deployment', artifact.path);
          action = artifact.contentSha256 === current.sha256 || artifact.kind === 'credential' ? 'reuse' : 'replace';
        } else if (artifact.contentSha256 && artifact.contentSha256 !== current.sha256) {
          issue('path_conflict', 'Shared resource changed since component inspection', artifact.path);
        }
      }
    } else {
      if (!current.safeAncestors) issue('path_conflict', 'An absent destination still requires verified safe parent directories', artifact.path);
      if (artifact.ownership === 'shared') issue('incomplete_evidence', 'Required shared resource is missing', artifact.path);
    }
    const result = { ...artifact, action, ...(expectedSha256 ? { expectedSha256 } : {}) };
    artifacts.push(result);
    return result;
  };
  const addText = (id: string, kind: DeploymentArtifactKind, path: string, content: string, serviceName?: string) => addArtifact({
    id, kind, path, ownership: 'owned', content, contentSha256: digest(content), mode: '0644', ...(serviceName ? { serviceName } : {}),
  });
  const shared = (id: string, kind: DeploymentArtifactKind, path: string, serviceName?: string, contentSha256?: string) => {
    if (!safePath(path)) { issue('incomplete_evidence', 'Unsafe path in preflight resource', id); return; }
    addArtifact({ id, kind, path, ownership: 'shared', ...(serviceName ? { serviceName } : {}), ...(contentSha256 ? { contentSha256 } : {}) });
  };
  const component = (name: DeploymentComponent['name'], major: number, minor: number) => {
    const candidates = evidence.components.filter(c => c.name === name).sort((a, b) => a.path.localeCompare(b.path));
    const found = candidates.find(c => safePath(c.path) && hashPattern.test(c.sha256) && versionAtLeast(c.version, major, minor));
    if (!found) { issue('component_required', `Install or select a verified compatible ${name} binary before preparing an executable plan`, name); return undefined; }
    shared(`component-${name}`, 'component', found.path, undefined, found.sha256);
    return found;
  };
  const reuse = (name: string | undefined, kind: DeploymentServiceEvidence['kind']) => {
    if (!name) return undefined;
    const service = evidence.services.find(s => s.name === name && s.kind === kind && s.compatible);
    if (!service || !safePath(service.unitPath) || !safePath(service.configPath)) {
      issue('incompatible_service', 'Selected shared service was not verified compatible', name); return undefined;
    }
    shared(`shared-unit-${kind}`, 'service', service.unitPath, name);
    shared(`shared-config-${kind}`, 'configuration', service.configPath);
    return service;
  };
  const frps = component('frps', 0, 65);
  const proxy = component(request.https.kind, request.https.kind === 'caddy' ? 2 : 1, request.https.kind === 'caddy' ? 8 : 0);
  const reusedFrp = reuse(request.frp.reuseService, 'frps');
  const reusedProxy = reuse(request.https.reuseService, request.https.kind);
  const frpService = request.frp.reuseService ?? paths.frpsService;
  const proxyService = request.https.reuseService ?? paths.caddyService;
  if (request.https.kind === 'nginx' && !request.https.reuseService) issue('incompatible_service', 'Nginx integration requires a verified existing HTTP-context include and service');
  if (reusedFrp) {
    const existing = reusedFrp.frp;
    if (!existing || existing.controlPort !== request.frp.controlPort || existing.proxyBindAddress !== '127.0.0.1'
      || !existing.allowedPorts.includes(request.frp.remotePort) || !existing.tlsForced
      || existing.tlsServerName !== request.frp.tls.serverName || existing.tlsCaSha256 !== request.frp.tls.caSha256
      || existing.tokenRef !== request.frp.tokenRef) issue('incompatible_service', 'Existing FRP must already provide this loopback-only mapping, credential and verified TLS; global settings will not be changed', frpService);
  }
  const certificateEvidence = (certificate: { certificateFile: string; privateKeyFile: string }, serverName: string, serviceName: string, publiclyTrusted: boolean) => {
    const found = evidence.certificates.find(c => c.certificateFile === certificate.certificateFile && c.privateKeyFile === certificate.privateKeyFile
      && c.names.includes(serverName) && c.chainVerified && c.keyMatches && c.validAtInspection && c.renewalHealthy
      && servicePattern.test(c.renewalService) && (c.reloadsServices.includes(serviceName) || c.restartsServices.includes(serviceName))
      && (!publiclyTrusted || c.publiclyTrusted));
    return found;
  };
  const frpCertificate = certificateEvidence(request.frp.tls, request.frp.tls.serverName, frpService, false);
  if (!frpCertificate || frpCertificate.caSha256 !== request.frp.tls.caSha256
    || (!request.frp.reuseService && !frpCertificate.restartsServices.includes(frpService))) {
    issue('tls_evidence_required', 'FRP requires an independently verified server certificate, matching key, exact client CA and renewal/reload evidence', request.frp.tls.certificateFile);
  }
  shared('frp-certificate', 'certificate', request.frp.tls.certificateFile);
  shared('frp-private-key', 'certificate', request.frp.tls.privateKeyFile);
  const url = new URL(request.publicOrigin);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const ipOrigin = isIP(hostname) !== 0;
  const publicCertificate = request.https.certificate && certificateEvidence(request.https.certificate, hostname, proxyService, true);
  if (request.https.certificate) {
    shared('https-certificate', 'certificate', request.https.certificate.certificateFile);
    shared('https-private-key', 'certificate', request.https.certificate.privateKeyFile);
    if (!publicCertificate || (request.https.reuseService
      ? !publicCertificate.readableByServices.includes(proxyService)
      : !publicCertificate.restartsServices.includes(proxyService))) {
      issue(ipOrigin ? 'ip_tls_evidence_required' : 'tls_evidence_required', 'HTTPS requires a valid publicly trusted certificate and healthy server-side renewal/reload readable by this proxy service');
    }
  } else if (ipOrigin || request.https.kind === 'nginx') {
    issue(ipOrigin ? 'ip_tls_evidence_required' : 'tls_evidence_required', 'This origin requires an explicit publicly trusted certificate and verified renewal; Caddy local-CA IP HTTPS is not public TLS');
  } else if (/(?:^|\.)(?:localhost|local|internal|test|invalid|example|home\.arpa)$/i.test(hostname)) {
    issue('tls_evidence_required', 'Internal or reserved hostnames require explicit public certificate evidence; automatic local-CA HTTPS is not public trust');
  } else if (!evidence.dnsPointsToTarget) issue('dns_mismatch', 'The public DNS name must resolve to this target before automatic HTTPS');

  if (!request.frp.reuseService) {
    const credential = `/run/credentials/${paths.frpsService}`;
    const frpsContent = `${JSON.stringify({
      bindAddr: '0.0.0.0', bindPort: request.frp.controlPort, proxyBindAddr: '127.0.0.1',
      allowPorts: [{ single: request.frp.remotePort }],
      auth: { method: 'token', tokenSource: { type: 'file', file: { path: `${credential}/frp-token` } } },
      transport: { tls: { force: true, certFile: `${credential}/frp-cert`, keyFile: `${credential}/frp-key` } },
      log: { to: 'console', level: 'warn', disablePrintColor: true }, detailedErrorsToClient: false,
    }, null, 2)}\n`;
    addText('frps-config', 'configuration', paths.frpsConfig, frpsContent);
    addArtifact({ id: 'frp-token', kind: 'credential', path: paths.token, ownership: 'owned', mode: '0600', secretRef: request.frp.tokenRef });
    if (frps) addText('frps-unit', 'service', `/etc/systemd/system/${paths.frpsService}`,
      `${unitHeader(request.deploymentId)}LoadCredential=frp-token:${paths.token}\nLoadCredential=frp-cert:${request.frp.tls.certificateFile}\nLoadCredential=frp-key:${request.frp.tls.privateKeyFile}\nExecStart=${frps.path} -c ${paths.frpsConfig}\n${unitFooter()}`, paths.frpsService);
  }
  let proxyConfig = paths.caddyConfig;
  if (request.https.reuseService) {
    if (!reusedProxy?.includeDirectory || !safePath(reusedProxy.includeDirectory) || !reusedProxy.requestLoggingDisabled) {
      issue('incompatible_service', 'Shared HTTPS service requires a verified include directory and disabled request/error logging for this site', proxyService);
    } else proxyConfig = `${reusedProxy.includeDirectory}/varin-${request.deploymentId}.${request.https.kind === 'caddy' ? 'caddy' : 'conf'}`;
  }
  for (const site of evidence.sites) {
    const sameName = site.hostname.toLowerCase() === hostname.toLowerCase();
    const wildcardName = site.hostname.startsWith('*.') && hostname.toLowerCase().endsWith(site.hostname.slice(1).toLowerCase());
    if ((sameName || wildcardName) && !(site.configPath === proxyConfig && ownedManifest?.artifacts.some(a => a.path === proxyConfig && a.ownership === 'owned'))) {
      issue('site_conflict', 'An existing site already handles this public hostname; choose a different origin or merge manually', site.configPath);
    }
  }
  if (request.https.kind === 'caddy') {
    const runtime = `varin-caddy-${request.deploymentId}`;
    const global = request.https.reuseService ? '' : `{
  admin unix//run/${runtime}/admin.sock
  persist_config off
  log default {
    exclude http.log.access http.log.error
  }
}
`;
    const certificate = !request.https.reuseService && request.https.certificate
      ? { certificateFile: `/run/credentials/${paths.caddyService}/https-cert`, privateKeyFile: `/run/credentials/${paths.caddyService}/https-key` }
      : request.https.certificate;
    addText('https-site', 'configuration', proxyConfig, global + caddySite(request.publicOrigin, request.frp.remotePort, certificate));
    if (!request.https.reuseService && proxy) addText('https-unit', 'service', `/etc/systemd/system/${paths.caddyService}`,
      `${unitHeader(request.deploymentId)}${request.https.certificate ? `LoadCredential=https-cert:${request.https.certificate.certificateFile}\nLoadCredential=https-key:${request.https.certificate.privateKeyFile}\n` : ''}RuntimeDirectory=${runtime}\nRuntimeDirectoryMode=0700\nStateDirectory=${runtime}\nEnvironment=XDG_DATA_HOME=/var/lib/${runtime}\nEnvironment=XDG_CONFIG_HOME=/var/lib/${runtime}\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\nExecStart=${proxy.path} run --config ${paths.caddyConfig} --adapter caddyfile\nExecReload=${proxy.path} reload --config ${paths.caddyConfig} --adapter caddyfile --address unix//run/${runtime}/admin.sock\n${unitFooter()}`, paths.caddyService);
  } else if (request.https.certificate) addText('https-site', 'configuration', proxyConfig,
    nginxSite(request.publicOrigin, request.frp.remotePort, request.deploymentId, request.https.certificate));

  for (const service of evidence.services) {
    const planned = artifacts.find(a => a.kind === 'service' && a.ownership === 'owned' && a.serviceName === service.name);
    if (planned && !ownedManifest?.artifacts.some(a => a.kind === 'service' && a.serviceName === service.name && a.path === planned.path && a.ownership === 'owned')) {
      issue('ownership_conflict', 'A service already uses the intended unit name', service.name);
    }
  }
  for (const listener of evidence.listeners) {
    if (listener.protocol !== 'tcp' || ![80, 443, request.frp.controlPort, request.frp.remotePort].includes(listener.port)) continue;
    const selected = listener.port === 80 || listener.port === 443 ? proxyService : frpService;
    const ownedService = ownedManifest?.artifacts.some(a => a.kind === 'service' && a.serviceName === selected && a.ownership === 'owned');
    const canReuse = selected === request.https.reuseService || selected === request.frp.reuseService || ownedService;
    if (listener.serviceName !== selected || !canReuse || (listener.port === request.frp.remotePort && listener.address !== '127.0.0.1')) {
      issue('port_conflict', 'Required port is held by another service or a non-loopback application mapping', `${listener.address}:${listener.port}`);
    }
  }
  const requiredPorts: DeploymentPlan['requiredPorts'] = [
    { port: 443, protocol: 'tcp' as const, purpose: 'https' as const },
    { port: request.frp.controlPort, protocol: 'tcp' as const, purpose: 'frp-control' as const },
    ...(!request.https.certificate ? [{ port: 80, protocol: 'tcp' as const, purpose: 'acme-http' as const }] : []),
  ].sort((a, b) => a.port - b.port);
  for (const port of requiredPorts) if (!evidence.reachability.some(p => p.port === port.port && p.protocol === 'tcp' && p.state === 'allowed')) {
    issue('firewall_review_required', 'External TCP reachability needs explicit firewall/provider review; no broad allow rule is generated', String(port.port));
  }
  const step = (id: string, stage: DeploymentStep['stage'], artifactIds: string[], description: string) => steps.push({ id, stage, artifactIds, requiresApproval: true, description });
  step('recheck-preflight', 'configure-service', [], 'Recheck target host key, privileges, exact file digests, symlinks, services and ports against this plan before any write.');
  step('prepare-private-input', 'install-frp', artifacts.filter(a => a.kind === 'credential').map(a => a.id), 'Resolve the existing credential reference through the private credential channel; never put values in argv, logs, previews or scripts.');
  step('stage-candidate', 'configure-proxy', artifacts.filter(a => a.ownership === 'owned').map(a => a.id), 'Stage candidates with recorded modes and digests, keeping the current effective configuration. Do not follow symlinks.');
  step('validate-candidate', 'configure-proxy', artifacts.filter(a => a.kind === 'configuration').map(a => a.id), 'Validate FRP and the complete Caddy/Nginx candidate configuration before atomic publication; retain the previous files on validation failure.');
  step('activate-owned-services', 'configure-service', artifacts.filter(a => a.kind === 'service' && a.ownership === 'owned').map(a => a.id), 'Record owned artifacts durably, reload systemd and enable/start only the recorded owned units. Reload the selected shared HTTPS service only after full validation.');
  if (!request.https.certificate) step('automatic-public-tls', 'issue-certificate', ['https-site'], 'Caddy obtains and renews a public domain certificate on the VPS. Wait for actual trusted TLS; never disable verification.');
  step('verify-entrypoint', 'verify-entrypoint', [], 'Verify trusted public HTTPS, current Host identity, FRP publication, API errors, SSE and WebSocket behavior. Service startup is not endpoint verification.');
  return finishPlan({ schemaVersion: 1, action: 'deploy', deploymentId: request.deploymentId, target: request.target, publicOrigin: request.publicOrigin,
    blockers, artifacts, steps, requiredPorts, manifest: { schemaVersion: 1, status: 'planned', deploymentId: request.deploymentId,
      target: request.target, publicOrigin: request.publicOrigin, artifacts: artifacts.map(a => ({ id: a.id, kind: a.kind, path: a.path,
        ownership: a.ownership, ...(a.contentSha256 || a.expectedSha256 ? { sha256: a.contentSha256 ?? a.expectedSha256 } : {}),
        ...(a.serviceName ? { serviceName: a.serviceName } : {}) })) } });
}

/** Called only with fresh, trusted post-write observations after the owner applied the approved plan. */
export function finalizeDeploymentManifest(plan: DeploymentPlan, observed: DeploymentPreflightEvidence): InstalledDeploymentManifest {
  if (plan.action !== 'deploy' || !plan.ready || !targetEqual(plan.target, observed.target)) throw new Error('Cannot finalize this deployment plan');
  const artifacts = plan.manifest.artifacts.map(artifact => {
    const current = observed.paths[artifact.path];
    if (current?.kind !== 'file' || current.uid !== 0 || !current.safeAncestors || !current.sha256 || !hashPattern.test(current.sha256)
      || (artifact.sha256 && artifact.sha256 !== current.sha256)) throw new Error('Installed artifact does not match the reviewed plan');
    return { ...artifact, sha256: current.sha256 };
  });
  return { ...plan.manifest, target: { ...plan.target }, status: 'installed', planId: plan.id, artifacts };
}

/** Missing/changed files are never guessed away, and no recursive directory/package/firewall deletion is generated. */
export function createSelfHostedUninstallPlan(manifest: InstalledDeploymentManifest | PlannedDeploymentManifest, evidence: DeploymentPreflightEvidence): DeploymentPlan {
  const blockers: DeploymentIssue[] = [];
  const artifacts: DeploymentArtifact[] = [];
  if (!identifier.test(manifest.deploymentId) || !validTarget(manifest.target)) throw new Error('Invalid deployment manifest');
  if (manifest.status !== 'installed') blockers.push({ code: 'manifest_not_installed', message: 'A planned manifest cannot authorize uninstall; reconnect and reconcile actual installed artifacts' });
  if (!targetEqual(manifest.target, evidence.target)) blockers.push({ code: 'target_mismatch', message: 'Uninstall target or host key differs from the installed manifest' });
  const recorded = evidence.manifest;
  if (!recorded || recorded.status !== 'installed' || manifest.status !== 'installed' || recorded.planId !== manifest.planId
    || recorded.deploymentId !== manifest.deploymentId || !targetEqual(recorded.target, manifest.target)) {
    blockers.push({ code: 'ownership_conflict', message: 'The trusted remote installed manifest does not match this uninstall request' });
  }
  for (const item of manifest.artifacts) {
    if (!safePath(item.path)) { blockers.push({ code: 'path_conflict', message: 'Manifest contains an unsafe path' }); continue; }
    if (item.ownership === 'shared') {
      artifacts.push({ id: item.id, kind: item.kind, path: item.path, ownership: 'shared', action: 'reuse', ...(item.serviceName ? { serviceName: item.serviceName } : {}) });
      continue;
    }
    const trusted = recorded?.artifacts.find(a => a.id === item.id && a.path === item.path && a.kind === item.kind
      && a.ownership === 'owned' && a.sha256 === item.sha256 && a.serviceName === item.serviceName);
    const current = evidence.paths[item.path];
    if (!trusted || !item.sha256 || !hashPattern.test(item.sha256)) {
      blockers.push({ code: 'ownership_conflict', message: 'Artifact has no matching installed ownership and content digest', resource: item.path }); continue;
    }
    if (current?.kind === 'missing') continue; // Already removed is safe; never replay an unknown write.
    if (!current || current.kind !== 'file' || current.uid !== 0 || !current.safeAncestors || current.sha256 !== item.sha256) {
      blockers.push({ code: 'ownership_conflict', message: 'Owned artifact changed or cannot be verified; preserve it and reconcile manually', resource: item.path }); continue;
    }
    if (item.kind === 'service') {
      const currentService = evidence.services.find(s => s.name === item.serviceName);
      if (currentService && currentService.unitPath !== item.path) {
        blockers.push({ code: 'ownership_conflict', message: 'Service now points to another unit; do not stop it', resource: item.path }); continue;
      }
    }
    artifacts.push({ id: item.id, kind: item.kind, path: item.path, ownership: 'owned', action: 'remove', expectedSha256: item.sha256,
      ...(item.serviceName ? { serviceName: item.serviceName } : {}) });
  }
  if (!evidence.privileged) blockers.push({ code: 'insufficient_privilege', message: 'Verified administration privileges are required' });
  if (!evidence.inventoryComplete) blockers.push({ code: 'incomplete_evidence', message: 'Fresh service and path inspection is required before uninstall' });
  const removals = artifacts.filter(a => a.action === 'remove');
  return finishPlan({ schemaVersion: 1, action: 'uninstall', deploymentId: manifest.deploymentId,
    target: { ...manifest.target }, publicOrigin: manifest.publicOrigin, artifacts, blockers, requiredPorts: [],
    steps: [{ id: 'remove-owned-artifacts', stage: 'remove-resources', artifactIds: removals.map(a => a.id), requiresApproval: true,
      description: 'Recheck exact digests, stop only matching owned units, atomically remove only listed files, validate then reload shared HTTPS service. Preserve shared binaries, certificates, firewall rules, state directories and Host/device configuration.' }],
    manifest: { schemaVersion: 1, status: 'planned', deploymentId: manifest.deploymentId, target: { ...manifest.target },
      publicOrigin: manifest.publicOrigin, artifacts: manifest.artifacts.map(a => ({ ...a })) } });
}
