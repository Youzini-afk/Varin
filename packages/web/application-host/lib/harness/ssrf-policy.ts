/**
 * SSRF policy for web fetch — blocks private, loopback, and reserved network ranges.
 *
 * Reuses the same IP classification logic as the preview proxy runtime
 * (lib/preview/proxy-runtime.ts `isBlockedExternalHost`) and tunnel auth
 * (lib/platform/tunnel-auth.ts `isPrivateOrLoopbackIp`), extracted here
 * for use by the harness web fetch service.
 *
 * The URL check is intentionally static: scheme rules and hostname/literal
 * classification only. DNS answers are classified on the actual connection
 * path (see lib/harness/egress.ts `secureLookup`) so the checked result is
 * the same address the socket dials — no check-then-fetch gap. `checkSsrf`
 * therefore never reports a DNS failure as "private-network".
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SsrfBlockReason = "private-network" | "scheme" | "special-purpose";

export interface SsrfCheckResult {
  blocked: boolean;
  reason?: SsrfBlockReason;
}

export type EgressAddressClass = "public" | "private" | "special-purpose";

/**
 * Normalize an IP literal as it may appear inside a URL hostname:
 * strip IPv6 brackets, drop zone ids (`fe80::1%eth0`), lowercase.
 */
const normalizeIpLiteral = (host: string): string => {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  return h;
};

const classifyIpv4 = (ip: string): EgressAddressClass => {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return "public";
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 127 || a === 10) return "private";
  if (a === 169 && b === 254) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  // Special-purpose ranges a consumer sees when a resolver answers with
  // synthetic mappings (Clash/v2ray fake-IP uses 198.18.0.0/15) or that can
  // never route publicly. Reported separately so the failure surfaces the
  // real reason instead of a misleading "private network" label.
  if (a === 198 && (b === 18 || b === 19)) return "special-purpose";
  if (a >= 224) return "special-purpose"; // multicast and reserved space
  if (a === 192 && b === 0 && Number(v4[3]) === 2) return "special-purpose";
  if (a === 198 && b === 51 && Number(v4[3]) === 100) return "special-purpose";
  if (a === 203 && b === 0 && Number(v4[3]) === 113) return "special-purpose";
  return "public";
};

/** Expand a validated IPv6 literal to bytes so equivalent text forms share policy. */
const ipv6Bytes = (ip: string): number[] => {
  const v4Tail = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)?.[1];
  const expanded = v4Tail
    ? ip.slice(0, -v4Tail.length) + (() => {
      const octets = v4Tail.split(".").map(Number);
      return `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    })()
    : ip;
  const [left, right] = expanded.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = right !== undefined
    ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail]
    : head;
  return groups.flatMap((group) => {
    const n = parseInt(group, 16);
    return [n >> 8, n & 0xff];
  });
};

const embeddedIpv4Class = (bytes: number[], offset: number): EgressAddressClass =>
  classifyIpv4(bytes.slice(offset, offset + 4).join("."));

const classifyIpv6 = (ip: string): EgressAddressClass => {
  const b = ipv6Bytes(normalizeIpLiteral(ip));
  if (b.slice(0, 15).every((n) => n === 0) && (b[15] === 0 || b[15] === 1)) return "private";
  if (b[0] === 0xfc || b[0] === 0xfd) return "private"; // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "private"; // fe80::/10 link-local
  if (b[0] === 0xff) return "special-purpose"; // ff00::/8 multicast
  // Mapped, translated and compatible IPv4 forms retain the v4 destination.
  if (b.slice(0, 10).every((n) => n === 0) && b[10] === 0xff && b[11] === 0xff) {
    return embeddedIpv4Class(b, 12);
  }
  if (b.slice(0, 8).every((n) => n === 0) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return embeddedIpv4Class(b, 12);
  }
  if (b.slice(0, 12).every((n) => n === 0)) return embeddedIpv4Class(b, 12);
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((n) => n === 0)) {
    return embeddedIpv4Class(b, 12); // 64:ff9b::/96 NAT64
  }
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) {
    return "special-purpose"; // 64:ff9b:1::/48 local-use translation
  }
  if (b[0] === 0x20 && b[1] === 0x02) return embeddedIpv4Class(b, 2); // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 2 && b[4] === 0 && b[5] === 0) return "special-purpose"; // 2001:2::/48 benchmarking
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "special-purpose"; // documentation
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0) return "special-purpose"; // 3fff::/20 documentation
  if (b[0] === 0x01 && b.slice(1, 8).every((n) => n === 0)) return "special-purpose"; // 100::/64 discard
  return "public";
};

/** Classify a resolved IP address. */
export const classifyIp = (ip: string): EgressAddressClass => {
  const normalized = normalizeIpLiteral(ip);
  const kind = isIP(normalized);
  if (kind === 4) return classifyIpv4(normalized);
  if (kind === 6) return classifyIpv6(normalized);
  return "public";
};

/**
 * Static hostname classification — names and literals only, no DNS.
 * Returns the block reason when the hostname itself is forbidden.
 */
export const classifyHostname = (hostname: string): SsrfBlockReason | null => {
  const host = normalizeIpLiteral(hostname).replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "private-network";
  }
  if (isIP(host) === 0) return null; // ordinary DNS name — resolved on connect
  const cls = classifyIp(host);
  if (cls === "private") return "private-network";
  if (cls === "special-purpose") return "special-purpose";
  return null;
};

/**
 * Resolve a hostname and report the class of every answer. Used by the
 * read-only diagnostics surface; the enforcement path classifies inside the
 * connector lookup instead.
 */
export const resolveAddressClasses = async (
  hostname: string,
): Promise<Array<{ address: string; class: EgressAddressClass }>> => {
  const host = normalizeIpLiteral(hostname);
  if (isIP(host) > 0) return [{ address: host, class: classifyIp(host) }];
  const addresses = await lookup(host, { all: true, verbatim: true });
  return addresses.map((addr) => ({ address: addr.address, class: classifyIp(addr.address) }));
};

/**
 * Check if a URL is safe to fetch — static decision only.
 * - Must be http: or https:
 * - Hostname literals/names must not be private or special-purpose.
 *   DNS results are enforced on the connect path (egress runtime).
 */
export const checkSsrf = async (url: string): Promise<SsrfCheckResult> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: true, reason: "scheme" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { blocked: true, reason: "scheme" };
  }

  const hostnameClass = classifyHostname(parsed.hostname);
  if (hostnameClass) {
    return { blocked: true, reason: hostnameClass };
  }

  return { blocked: false };
};

/** A local desktop request uses the user's network and may intentionally reach
 * LAN/loopback services. The scheme boundary still excludes file/data URLs. */
export const checkDesktopHttpUrl = async (url: string): Promise<SsrfCheckResult> => {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" ? { blocked: false } : { blocked: true, reason: "scheme" };
  } catch {
    return { blocked: true, reason: "scheme" };
  }
};

/**
 * Check if a URL's hostname matches the same origin as another URL.
 * Used for redirect following — only same-hostname redirects are auto-followed.
 */
export const isSameHost = (url1: string, url2: string): boolean => {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    return u1.hostname === u2.hostname;
  } catch {
    return false;
  }
};
