/**
 * Host-owned outbound egress policy — one place that decides how an HTTP(S)
 * request leaves the process and why it failed when it does.
 *
 * Policy modes:
 * - `auto` (default): inspect this Host's `HTTPS_PROXY`/`HTTP_PROXY`/
 *   `ALL_PROXY` and `NO_PROXY` (lowercase accepted). Desktop falls back to
 *   Electron's system proxy/PAC network stack when none is configured.
 * - `direct`: never use a proxy.
 * - explicit proxy: caller-supplied proxy URL.
 *
 * Invariants:
 * - A malformed or unsupported proxy setting never silently falls back to
 *   direct: the policy snapshot carries `invalid` and requests fail with
 *   `proxy-config-invalid`.
 * - Each request freezes its own policy version; env edits apply to the next
 *   resolution, never mid-request.
 * - Non-desktop private-address enforcement happens inside the connector
 *   lookup so the classified answer is the address actually dialed. A proxy
 *   resolves the target itself; diagnostics label that `proxy-side` honestly.
 * - Proxy endpoint hosts may be loopback/LAN (that is the whole point of a
 *   local proxy). Every route checks the URL scheme. Desktop requests may
 *   intentionally reach local resources; the configured proxy owns final DNS
 *   and routing, which the Host cannot independently verify.
 * - Credentials embedded in a proxy URL are used for CONNECT auth and are
 *   never copied into errors, logs, or diagnostics.
 */

import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { classifyHostname, classifyIp, type EgressAddressClass } from "./ssrf-policy.js";

export type EgressErrorKind =
  | "dns"
  | "scheme-denied"
  | "private-network"
  | "special-purpose"
  | "proxy-unavailable"
  | "proxy-auth"
  | "proxy-config-invalid"
  | "tls"
  | "connect"
  | "timeout"
  | "cancelled"
  | "unknown";

/** Error with a stable machine-readable classification. */
export class EgressError extends Error {
  readonly kind: EgressErrorKind;
  constructor(kind: EgressErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EgressError";
    this.kind = kind;
  }
}

export type EgressMode = "auto" | "direct" | "proxy";

export interface EgressOverride {
  mode?: EgressMode;
  /** Explicit proxy URL — only used with mode "proxy". */
  proxyUrl?: string;
  /** Comma-separated NO_PROXY semantics, in addition to env. */
  noProxy?: string;
}

/** Stored by the executing Application Host, never inherited from a client device or project. */
export interface EgressHostConfiguration extends EgressOverride {
  mode: EgressMode;
  /** Secret used only by the Host's CONNECT dispatcher. */
  proxyAuth?: { username: string; password: string };
  invalid?: string;
}

export interface EgressPolicy {
  /** Frozen policy revision; every resolution stamps a new version. */
  version: number;
  mode: "direct" | "proxy" | "system";
  /** Sanitized proxy origin (scheme://host:port) — never carries credentials. */
  proxyOrigin?: string;
  /** Proxy has CONNECT credentials configured (type only, never the secret). */
  proxyAuth?: "basic";
  noProxy: string[];
  source: "env" | "override" | "app" | "none";
  /** Stable digest of the complete frozen route, including secret rotation. */
  fingerprint: string;
  /** Non-empty when configuration is malformed — requests must fail, not go direct. */
  invalid?: string;
}

export interface EgressResolution {
  policy: EgressPolicy;
  /** Resolved dispatcher or a typed failure the caller must surface. */
  dispatcher?: Dispatcher;
  failure?: EgressError;
  /** True when a configured proxy is bypassed for this target (NO_PROXY/loopback). */
  bypassedProxy?: boolean;
}

export type EgressFetch = (
  url: string,
  init?: RequestInit & { dispatcher?: never },
  override?: EgressOverride,
) => Promise<Response>;

export interface EgressRuntime {
  /** Frozen policy for one request (env re-read per call — new version). */
  resolvePolicy(override?: EgressOverride): EgressPolicy;
  /** Live Host setting snapshot for cache identity and UI diagnosis. */
  policySnapshot(url?: string): Promise<EgressPolicy>;
  /** Freeze Host setting and environment for all hops of a logical request. */
  prepare(url: string, override?: EgressOverride): Promise<{ policy: EgressPolicy; fetch: (url: string, init?: RequestInit & { dispatcher?: never }) => Promise<Response> }>;
  /** Policy + dispatcher for a concrete target URL. */
  resolve(url: string, override?: EgressOverride): EgressResolution;
  fetch: EgressFetch;
  /** Read-only diagnosis of a target: policy, decision, resolution class. */
  diagnose(url: string, override?: EgressOverride): Promise<NetworkDiagnosis>;
  /** Release pooled sockets when the owning Host shuts down. */
  close(): Promise<void>;
}

export interface NetworkDiagnosis {
  url: string;
  policy: Omit<EgressPolicy, "fingerprint">;
  /** Current diagnostic decision, including locally sampled DNS when applicable. */
  decision: "allowed" | "blocked";
  reason?: string;
  /** Diagnostic address sample, never a guarantee about a later connection. */
  addressCheck: "not-run" | "public" | "blocked" | "dns-error" | "proxy-side-unverified" | "system-managed";
  /** How the target gets resolved for this request. */
  resolution: "not-run" | "local" | "proxy-side" | "static-literal" | "system";
  /** Locally resolved addresses with their classes (diagnostic only). */
  addresses?: Array<{ address: string; class: EgressAddressClass }>;
  lookupError?: string;
}

let policyVersionCounter = 0;

const parseProxyUrl = (
  raw: string,
): { uri: string; auth?: "basic"; origin: string } | { error: string } => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: `unparseable proxy URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `unsupported proxy scheme "${url.protocol}" (http/https only)` };
  }
  if (!url.hostname || url.pathname !== "/" || url.search || url.hash) {
    return { error: "proxy URL must be an origin without path, query, or fragment" };
  }
  const origin = `${url.protocol}//${url.host}`;
  if (url.username || url.password) {
    try {
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
    } catch {
      return { error: "invalid proxy credential encoding" };
    }
    return { uri: origin, auth: "basic", origin };
  }
  return { uri: origin, origin };
};

const envProxyCandidate = (env: NodeJS.ProcessEnv, protocol: "http:" | "https:"): { raw: string; name: string } | null => {
  const names = protocol === "https:"
    ? ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
    : ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { raw: value, name };
  }
  return null;
};

const envNoProxy = (env: NodeJS.ProcessEnv): string[] => {
  const raw = env.NO_PROXY ?? env.no_proxy ?? "";
  return raw.split(",").map((e) => e.trim()).filter(Boolean);
};

/**
 * Resolve the egress policy for one request. `override` wins over env; a
 * malformed proxy never degrades into direct mode.
 */
export const resolveEgressPolicy = (
  override?: EgressOverride,
  env: NodeJS.ProcessEnv = process.env,
  protocol: "http:" | "https:" = "https:",
  version = ++policyVersionCounter,
  hostConfiguration?: EgressHostConfiguration,
  systemNetworkAvailable = false,
): EgressPolicy => {
  const selected = override ?? hostConfiguration;
  const isHostSelection = !override && hostConfiguration !== undefined;
  const proxyRaw = selected?.mode === "proxy" ? selected.proxyUrl ?? "" : envProxyCandidate(env, protocol)?.raw ?? "";
  const source = selected?.mode === "proxy" || selected?.mode === "direct"
    ? isHostSelection ? "app" : "override"
    : proxyRaw ? "env" : "none";
  const noProxy = selected?.mode === "proxy"
    ? selected.noProxy?.split(",").map((e) => e.trim()).filter(Boolean) ?? []
    : envNoProxy(env);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    mode: selected?.mode ?? "auto", proxyRaw, noProxy,
    envProxyRoutes: selected?.mode === "proxy" || selected?.mode === "direct" ? undefined : [
      envProxyCandidate(env, "http:")?.raw, envProxyCandidate(env, "https:")?.raw,
    ],
    auth: isHostSelection ? hostConfiguration?.proxyAuth : undefined,
    systemNetworkAvailable,
  })).digest("hex").slice(0, 24);
  const base: Omit<EgressPolicy, "mode"> & { mode: EgressPolicy["mode"] } = {
    version,
    mode: "direct",
    noProxy,
    source,
    fingerprint,
  };
  if (isHostSelection && hostConfiguration.invalid) return { ...base, invalid: hostConfiguration.invalid };
  if (selected?.mode === "direct") {
    return base;
  }
  if (!proxyRaw) {
    if (selected?.mode === "proxy") {
      return { ...base, source, invalid: "proxy mode requires a proxy URL" };
    }
    const anyEnvProxy = Boolean(envProxyCandidate(env, "http:") || envProxyCandidate(env, "https:"));
    return { ...base, mode: systemNetworkAvailable && !anyEnvProxy ? "system" : "direct", source };
  }

  const parsed = parseProxyUrl(proxyRaw);
  if ("error" in parsed) {
    return { ...base, source, invalid: parsed.error };
  }
  return {
    ...base,
    mode: "proxy",
    proxyOrigin: parsed.origin,
    ...(parsed.auth || (isHostSelection && hostConfiguration?.proxyAuth) ? { proxyAuth: "basic" as const } : {}),
    source,
  };
};

/** Normalized hostname for target checks and NO_PROXY comparison. */
const hostOf = (url: URL): string => url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

const canonicalNoProxyHost = (raw: string): string => {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (isIP(host) === 6) return hostOf(new URL(`http://[${host}]/`));
  if (isIP(host) === 4) return new URL(`http://${host}/`).hostname;
  return host;
};

const matchesNoProxy = (url: URL, entries: string[]): boolean => {
  const host = hostOf(url);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawEntry of entries) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
    const ported = !bracketed && isIP(entry) !== 6 ? entry.match(/^(.*):(\d+)$/) : null;
    const entryHost = canonicalNoProxyHost(bracketed?.[1] ?? ported?.[1] ?? entry);
    const entryPort = bracketed?.[2] ?? ported?.[2];
    if (entryPort !== undefined && entryPort !== port) continue;
    const suffix = entryHost.startsWith("*.") ? entryHost.slice(2) : entryHost.startsWith(".") ? entryHost.slice(1) : entryHost;
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
};

const extractCauseCodes = (error: unknown): { codes: Set<string>; messages: string[] } => {
  const codes = new Set<string>();
  const messages: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    const err = value as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof err.code === "string") codes.add(err.code);
    if (typeof err.message === "string") messages.push(err.message);
    if (err.cause !== undefined && err.cause !== value) walk(err.cause, depth + 1);
    if (Array.isArray(err.errors)) for (const e of err.errors) walk(e, depth + 1);
  };
  walk(error, 0);
  return { codes, messages };
};

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL", "EBADNAME"]);
const TLS_CODES = [
  "CERT_", "ERR_TLS", "UNABLE_TO_", "DEPTH_ZERO", "SELF_SIGNED",
  "SSL_", "TLS_", "EPROTO", "X509",
];
const CONNECT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT",
]);

/**
 * Map an arbitrary fetch failure into a typed egress error. `mode` decides
 * whether a socket-level connect failure means "proxy-unavailable" or
 * "connect" — in proxy mode every dial targets the proxy endpoint, so a
 * refusal there is the proxy being down.
 */
export const classifyEgressError = (error: unknown, mode: "direct" | "proxy" = "direct"): EgressError => {
  if (error instanceof EgressError) return error;
  // undici wraps connector-callback failures — a typed EgressError raised in
  // secureLookup survives only inside the cause chain.
  {
    let cursor: unknown = error;
    for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === "object"; depth += 1) {
      if (cursor instanceof EgressError) return cursor;
      cursor = (cursor as { cause?: unknown }).cause;
    }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new EgressError("cancelled", "request aborted");
  }
  const { codes, messages } = extractCauseCodes(error);
  const joined = messages.join(" ").toLowerCase();
  for (const code of codes) {
    if (DNS_CODES.has(code)) return new EgressError("dns", `DNS resolution failed (${code})`, { cause: error });
    if (TLS_CODES.some((t) => code.includes(t))) {
      return new EgressError("tls", `TLS failure (${code})`, { cause: error });
    }
  }
  if (joined.includes("proxy") && (joined.includes("407") || joined.includes("authentication"))) {
    return new EgressError("proxy-auth", "proxy authentication failed (407)", { cause: error });
  }
  for (const code of codes) {
    if (CONNECT_CODES.has(code)) {
      return new EgressError(
        mode === "proxy" ? "proxy-unavailable" : "connect",
        mode === "proxy" ? `proxy connection failed (${code})` : `connection failed (${code})`,
        { cause: error },
      );
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new EgressError("cancelled", "request aborted");
  }
  // Arbitrary dependency errors can echo URLs or proxy credentials. Keep the
  // cause in-process, but never project its uncontrolled text to tools/UI.
  return new EgressError("unknown", "outbound request failed", { cause: error });
};

export const EGRESS_TIMEOUT = "egress-timeout";

export const createEgressRuntime = (options: {
  env?: NodeJS.ProcessEnv;
  /** Desktop may address local services. Remote server deployments keep connect-time address checks. */
  allowLocalTargets?: boolean;
  /** Desktop transport backed by Electron's system proxy/PAC network stack. */
  systemFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Live serialized settings owned by this executing Host. */
  getHostConfiguration?: () => Promise<EgressHostConfiguration | undefined>;
  /** DNS resolver override — tests only; production uses `dns.promises.lookup`. */
  resolveAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** Proxy-endpoint resolver override for connector tests only. */
  resolveProxyAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
} = {}): EgressRuntime => {
  const env = options.env ?? process.env;
  const getHostConfiguration = options.getHostConfiguration ?? (async () => undefined);
  const allowLocalTargets = options.allowLocalTargets === true;
  const resolveAll = options.resolveAll ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const resolveProxyAll = options.resolveProxyAll ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));

  // SSRF on the connect path: the classified answer is the address the
  // socket actually dials. Any private/special answer refuses the connect;
  // DNS failure propagates as a typed "dns" error instead of a policy block.
  type ConnectLookupCallback = (
    err: Error | null,
    address?: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void;
  const secureLookup = (hostname: string, lookupOptions: { all?: boolean }, callback: ConnectLookupCallback): void => {
    void resolveAll(hostname).then(
      (addresses) => {
        if (!addresses.length) {
          callback(new EgressError("dns", `DNS resolution returned no addresses for ${hostname}`));
          return;
        }
        for (const addr of addresses) {
          const cls = classifyIp(addr.address);
          if (cls !== "public") {
            callback(new EgressError(
              cls === "private" ? "private-network" : "special-purpose",
              `target resolves to a ${cls === "private" ? "private" : "special-purpose"} address (${addr.address})`,
            ));
            return;
          }
        }
        if ("all" in lookupOptions && lookupOptions.all) {
          callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
          return;
        }
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error) => callback(classifyEgressError(error)),
    );
  };

  const directDispatcher = new Agent(allowLocalTargets ? {} : { connect: { lookup: secureLookup as never } });

  const proxyDispatchers = new Map<string, Dispatcher>();
  // A fetch can use either protocol after redirects. Lease both candidate
  // routes until it settles, then gracefully retire pools from old settings.
  const activeProxySnapshots = new Map<string, number>();
  const retiringDispatchers = new Set<Promise<void>>();
  let currentProxyKeys = new Set<string>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const proxyKey = (raw: string, hostConfig?: EgressHostConfiguration): string =>
    `${raw}|${hostConfig?.proxyAuth?.username ?? ''}|${hostConfig?.proxyAuth?.password ?? ''}`;
  const proxyKeysFor = (selected: EgressHostConfiguration | EgressOverride | undefined, requestEnv: NodeJS.ProcessEnv): Set<string> => {
    if (selected?.mode === "direct") return new Set();
    if (selected?.mode === "proxy") return new Set(selected.proxyUrl ? [proxyKey(selected.proxyUrl, selected as EgressHostConfiguration)] : []);
    return new Set([envProxyCandidate(requestEnv, "http:")?.raw, envProxyCandidate(requestEnv, "https:")?.raw]
      .filter((raw): raw is string => Boolean(raw)).map((raw) => proxyKey(raw)));
  };
  const retireOutdatedDispatchers = (keys: Set<string>): void => {
    if (closed) return;
    currentProxyKeys = keys;
    for (const [key, dispatcher] of proxyDispatchers) {
      if (keys.has(key) || (activeProxySnapshots.get(key) ?? 0) > 0) continue;
      proxyDispatchers.delete(key);
      const retiring = dispatcher.close();
      retiringDispatchers.add(retiring);
      void retiring.finally(() => retiringDispatchers.delete(retiring)).catch(() => {});
    }
  };
  const leaseProxySnapshot = (keys: Set<string>): void => {
    for (const key of keys) activeProxySnapshots.set(key, (activeProxySnapshots.get(key) ?? 0) + 1);
  };
  const releaseProxySnapshot = (keys: Set<string>): void => {
    for (const key of keys) {
      const count = activeProxySnapshots.get(key) ?? 0;
      if (count <= 1) activeProxySnapshots.delete(key);
      else activeProxySnapshots.set(key, count - 1);
    }
    retireOutdatedDispatchers(currentProxyKeys);
  };
  const proxyDispatcherFor = (policy: EgressPolicy, rawUrl: string, hostConfig?: EgressHostConfiguration): Dispatcher => {
    const key = proxyKey(rawUrl, hostConfig);
    const cached = proxyDispatchers.get(key);
    if (cached) return cached;
    const parsed = new URL(rawUrl);
    const token = hostConfig?.proxyAuth
      ? `Basic ${Buffer.from(`${hostConfig.proxyAuth.username}:${hostConfig.proxyAuth.password}`).toString("base64")}`
      : parsed.username || parsed.password
        ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`
        : undefined;
    // Proxy endpoint DNS belongs to this Host. It is resolved by the actual
    // proxy connector, independently of target DNS (which the proxy owns).
    const proxyLookup = (hostname: string, lookupOptions: { all?: boolean }, callback: ConnectLookupCallback): void => {
      void resolveProxyAll(hostname).then(
        (addresses) => {
          if (!addresses.length) return callback(new EgressError("dns", "proxy endpoint DNS returned no addresses"));
          if (lookupOptions.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
        (error) => callback(classifyEgressError(error)),
      );
    };
    const dispatcher = new ProxyAgent({
      uri: policy.proxyOrigin!,
      // Undici 8 forwards plain HTTP by default; retain the existing CONNECT path.
      proxyTunnel: true,
      ...(token ? { token } : {}),
      proxyTls: { lookup: proxyLookup as never },
    });
    proxyDispatchers.set(key, dispatcher);
    return dispatcher;
  };

  const resolveWithEnv = (
    targetUrl: string,
    override: EgressOverride | undefined,
    requestEnv: NodeJS.ProcessEnv,
    version?: number,
    allocateDispatcher = true,
    hostConfig?: EgressHostConfiguration,
  ): EgressResolution => {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      const policy = resolveEgressPolicy(override, requestEnv, "https:", version, hostConfig, Boolean(options.systemFetch));
      return { policy, failure: new EgressError("scheme-denied", "unparseable URL") };
    }
    const protocol = url.protocol === "http:" ? "http:" : "https:";
    const policy = resolveEgressPolicy(override, requestEnv, protocol, version, hostConfig, Boolean(options.systemFetch));
    const failure = (kind: EgressErrorKind, message: string): EgressResolution => ({
      policy,
      failure: new EgressError(kind, message),
    });

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return failure("scheme-denied", `unsupported scheme "${url.protocol}"`);
    }
    // Static hostname screening applies in every mode — literal/private
    // targets are refused before any socket opens.
    const staticClass = allowLocalTargets ? null : classifyHostname(url.hostname);
    if (staticClass) return failure(staticClass === "scheme" ? "scheme-denied" : staticClass, `hostname is ${staticClass}`);

    if (policy.invalid) {
      return failure("proxy-config-invalid", `proxy configuration invalid: ${policy.invalid}`);
    }
    if (closed) return failure("connect", "egress runtime is closed");
    if (policy.mode === "system") return { policy };
    if (policy.mode !== "proxy") {
      return { policy, ...(allocateDispatcher ? { dispatcher: directDispatcher } : {}) };
    }
    if (matchesNoProxy(url, policy.noProxy)) {
      return { policy, ...(allocateDispatcher ? { dispatcher: directDispatcher } : {}), bypassedProxy: true };
    }
    if (!allocateDispatcher) return { policy };
    // NOTE: explicit proxy URI keeps credentials — dispatcher cache is
    // keyed on the raw URL so rotated credentials build a fresh agent.
    const selected = override ?? hostConfig;
    const rawProxy = selected?.mode === "proxy" ? selected.proxyUrl! : envProxyCandidate(requestEnv, protocol)?.raw ?? "";
    return { policy, dispatcher: proxyDispatcherFor(policy, rawProxy, !override ? hostConfig : undefined) };
  };

  const resolve = (targetUrl: string, override?: EgressOverride): EgressResolution =>
    resolveWithEnv(targetUrl, override, env);

  const policySnapshot = async (targetUrl = "https://example.com/"): Promise<EgressPolicy> => {
    const requestEnv = { ...env };
    const hostConfig = await getHostConfiguration();
    return resolveWithEnv(targetUrl, undefined, requestEnv, undefined, false, hostConfig).policy;
  };

  const fetchThroughSystem = async (
    targetUrl: string,
    init: RequestInit,
    override: EgressOverride | undefined,
    requestEnv: NodeJS.ProcessEnv,
    hostConfig: EgressHostConfiguration | undefined,
    version: number,
  ): Promise<Response> => {
    const systemFetch = options.systemFetch!;
    const { body: _originalBody, ...otherInit } = init;
    const headers = new Headers(init.headers);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let url = targetUrl;
    for (let redirects = 0; ; redirects += 1) {
      const hop = resolveWithEnv(url, override, requestEnv, version, false, hostConfig);
      if (hop.failure) throw hop.failure;
      if (hop.policy.mode !== "system") throw new EgressError("connect", "network route changed during redirect");
      const response = await systemFetch(url, { ...otherInit, method, ...(body === undefined ? {} : { body }), headers, redirect: "manual" });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location || init.redirect === "manual") return response;
      if (init.redirect === "error") throw new EgressError("connect", "redirect was disallowed by the caller");
      if (redirects >= 20) throw new EgressError("connect", "too many redirects");
      const next = new URL(location, url).href;
      // Do not forward origin credentials across a redirect. A later hop is
      // checked before Electron opens a socket, including its URL scheme.
      if (new URL(next).origin !== new URL(url).origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      if (response.status === 303 && method !== "HEAD" || [301, 302].includes(response.status) && method === "POST") {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      await response.body?.cancel();
      url = next;
    }
  };

  const fetchWithSnapshot = async (
    targetUrl: string,
    init: RequestInit & { dispatcher?: never } = {},
    override: EgressOverride | undefined,
    requestEnv: NodeJS.ProcessEnv,
    hostConfig: EgressHostConfiguration | undefined,
    version: number,
  ): Promise<Response> => {
    // Proxy credentials belong to the CONNECT hop configured by ProxyAgent.
    // A caller-supplied hop header must never reach the origin on a direct or
    // redirected request.
    if (init.headers && new Headers(init.headers).has("proxy-authorization")) {
      throw new EgressError("proxy-config-invalid", "Proxy-Authorization must be configured in the proxy URL");
    }
    // Keep one env snapshot and policy version across redirects. The target
    // protocol still selects its own HTTP_PROXY/HTTPS_PROXY value on each hop.
    const selected = override ?? hostConfig;
    const proxyKeys = proxyKeysFor(selected, requestEnv);
    const resolved = resolveWithEnv(targetUrl, override, requestEnv, version, true, hostConfig);
    leaseProxySnapshot(proxyKeys);
    retireOutdatedDispatchers(proxyKeys);
    if (resolved.failure) {
      releaseProxySnapshot(proxyKeys);
      throw resolved.failure;
    }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      releaseProxySnapshot(proxyKeys);
      throw signal.reason === EGRESS_TIMEOUT
        ? new EgressError("timeout", "request timed out")
        : new EgressError("cancelled", "request aborted");
    }
    try {
      if (resolved.policy.mode === "system") {
        return await fetchThroughSystem(targetUrl, init, override, requestEnv, hostConfig, version);
      }
      // undici's fetch follows redirects internally. Its dispatcher receives
      // every hop's origin, so screen each new literal and select its route
      // before undici can open a socket. undici retains its normal redirect
      // method, credential stripping, and response semantics.
      const redirectDispatcher = {
        dispatch: (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean => {
          const hop = resolveWithEnv(String(opts.origin ?? targetUrl), override, requestEnv, resolved.policy.version, true, hostConfig);
          if (hop.failure || hop.policy.mode === "system") {
            throw hop.failure ?? new EgressError("connect", "network route changed during redirect");
          }
          return hop.dispatcher!.dispatch(opts, handler);
        },
      } as Dispatcher;
      return await undiciFetch(targetUrl, {
        ...init,
        signal: signal as never,
        dispatcher: redirectDispatcher,
      } as never) as unknown as Response;
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason === EGRESS_TIMEOUT
          ? new EgressError("timeout", "request timed out")
          : classifyEgressError(signal.reason ?? error, resolved.policy.mode === "proxy" ? "proxy" : "direct");
      }
      const classified = classifyEgressError(error, resolved.policy.mode === "proxy" ? "proxy" : "direct");
      // A 407 surfaced by the proxy CONNECT handshake is proxy auth.
      if (classified.kind === "unknown" && /407/.test(classified.message)) {
        throw new EgressError("proxy-auth", "proxy authentication failed (407)", { cause: error });
      }
      throw classified;
    } finally {
      releaseProxySnapshot(proxyKeys);
    }
  };

  const prepare: EgressRuntime['prepare'] = async (targetUrl, override) => {
    const requestEnv = { ...env };
    const hostConfig = await getHostConfiguration();
    const policy = resolveWithEnv(targetUrl, override, requestEnv, undefined, false, hostConfig).policy;
    return {
      policy,
      fetch: (url, init) => fetchWithSnapshot(url, init, override, requestEnv, hostConfig, policy.version),
    };
  };

  const fetch: EgressFetch = async (targetUrl, init, override) => {
    const snapshot = await prepare(targetUrl, override);
    return snapshot.fetch(targetUrl, init);
  };

  const diagnose = async (targetUrl: string, override?: EgressOverride): Promise<NetworkDiagnosis> => {
    const requestEnv = { ...env };
    const hostConfig = await getHostConfiguration();
    const resolved = resolveWithEnv(targetUrl, override, requestEnv, undefined, false, hostConfig);
    const { fingerprint: _fingerprint, ...policy } = resolved.policy;
    if (resolved.failure) {
      let literal = false;
      try {
        literal = isIP(hostOf(new URL(targetUrl))) > 0;
      } catch { /* malformed URL has no address to classify */ }
      return {
        url: targetUrl,
        policy,
        decision: "blocked",
        reason: `${resolved.failure.kind}: ${resolved.failure.message}`,
        resolution: literal ? "static-literal" : "not-run",
        addressCheck: literal && (resolved.failure.kind === "private-network" || resolved.failure.kind === "special-purpose") ? "blocked" : "not-run",
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return { url: targetUrl, policy, decision: "blocked", reason: "unparseable URL", resolution: "not-run", addressCheck: "not-run" };
    }
    const host = hostOf(parsed);
    if (isIP(host) > 0) {
      return {
        url: targetUrl,
        policy,
        decision: "allowed",
        resolution: "static-literal",
        addressCheck: classifyIp(host) === "public" ? "public" : "system-managed",
        addresses: [{ address: host, class: classifyIp(host) }],
      };
    }
    if (policy.mode === "system") {
      return { url: targetUrl, policy, decision: "allowed", resolution: "system", addressCheck: "system-managed" };
    }
    if (policy.mode === "proxy" && !resolved.bypassedProxy) {
      // Target DNS happens inside the proxy — report that honestly instead of
      // pretending local answers prove the fetch path.
      return {
        url: targetUrl,
        policy,
        decision: "allowed",
        resolution: "proxy-side",
        addressCheck: "proxy-side-unverified",
      };
    }
    try {
      const addresses = await resolveAll(host);
      const blockedAddress = allowLocalTargets ? undefined : addresses.find((address) => classifyIp(address.address) !== "public");
      return {
        url: targetUrl,
        policy,
        decision: addresses.length > 0 && !blockedAddress ? "allowed" : "blocked",
        ...(blockedAddress ? { reason: `target resolves to a ${classifyIp(blockedAddress.address)} address (${blockedAddress.address})` }
          : addresses.length === 0 ? { reason: "DNS resolution returned no addresses" } : {}),
        resolution: "local",
        addressCheck: addresses.length === 0 ? "dns-error"
          : blockedAddress ? "blocked"
            : addresses.some((a) => classifyIp(a.address) !== "public") ? "system-managed" : "public",
        addresses: addresses.map((a) => ({ address: a.address, class: classifyIp(a.address) })),
        ...(addresses.length === 0 ? { lookupError: "DNS resolution returned no addresses" } : {}),
      };
    } catch (error) {
      const knownDnsCode = [...extractCauseCodes(error).codes].find((code) => DNS_CODES.has(code));
      return {
        url: targetUrl,
        policy,
        decision: "blocked",
        reason: knownDnsCode ? `DNS resolution failed (${knownDnsCode})` : "DNS resolution failed",
        resolution: "local",
        addressCheck: "dns-error",
        lookupError: knownDnsCode ? `DNS resolution failed (${knownDnsCode})` : "DNS resolution failed",
      };
    }
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = Promise.all([
      directDispatcher.close(),
      ...[...proxyDispatchers.values()].map((dispatcher) => dispatcher.close()),
      ...retiringDispatchers,
    ]).then(() => {
      proxyDispatchers.clear();
      activeProxySnapshots.clear();
      retiringDispatchers.clear();
    });
    return closePromise;
  };

  return { resolvePolicy: (override) => resolveEgressPolicy(override, env, "https:", undefined, undefined, Boolean(options.systemFetch)), policySnapshot, prepare, resolve, fetch, diagnose, close };
};
