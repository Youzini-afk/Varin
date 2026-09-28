import { describe, expect, it, afterEach, vi } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { createEgressRuntime, classifyEgressError, resolveEgressPolicy } from "./egress.js";
import { checkDesktopHttpUrl, checkSsrf, classifyHostname, classifyIp } from "./ssrf-policy.js";

const PUBLIC_ADDR = { address: "93.184.216.34", family: 4 };
const hostProxy = (proxyUrl: string, extra: { noProxy?: string; proxyAuth?: { username: string; password: string } } = {}) => ({
  getHostConfiguration: async () => ({ mode: "proxy" as const, proxyUrl, ...extra }),
});

/** Minimal CONNECT proxy stub: records both proxy and tunneled HTTP headers. */
const stubConnectProxy = async (innerReply: string | null | ((authority: string) => string)) => {
  const authorities: string[] = [];
  const connectRequests: string[] = [];
  const tunneledRequests: Array<{ authority: string; headers: string }> = [];
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const line = head.subarray(0, end).toString("utf8").split("\r\n")[0] ?? "";
      const authority = line.match(/^CONNECT\s+(\S+)/)?.[1];
      if (!authority) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      authorities.push(authority);
      connectRequests.push(head.subarray(0, end + 4).toString("latin1"));
      if (innerReply === null) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"proxy\"\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let tunneledHead = Buffer.alloc(0);
      const onTunnelData = (data: Buffer): void => {
        // TLS tests only need to prove CONNECT routing; their tunnel payload
        // is binary and cannot be inspected as target HTTP headers here.
        if (tunneledHead.length === 0 && data[0] === 0x16) {
          socket.off("data", onTunnelData);
          socket.end(typeof innerReply === "function" ? innerReply(authority) : innerReply);
          return;
        }
        tunneledHead = Buffer.concat([tunneledHead, data]);
        const headerEnd = tunneledHead.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        socket.off("data", onTunnelData);
        tunneledRequests.push({ authority, headers: tunneledHead.subarray(0, headerEnd + 4).toString("latin1") });
        socket.end(typeof innerReply === "function" ? innerReply(authority) : innerReply);
      };
      socket.on("data", onTunnelData);
    };
    socket.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, authorities, connectRequests, tunneledRequests, close: () => new Promise<void>((r) => server.close(() => r())) };
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("egress policy", () => {
  it("resolves direct when no proxy env is set", () => {
    const p = resolveEgressPolicy(undefined, {});
    expect(p.mode).toBe("direct");
    expect(p.source).toBe("none");
    expect(p.invalid).toBeUndefined();
  });

  it("resolves env proxy and honors precedence + NO_PROXY", () => {
    const p = resolveEgressPolicy(undefined, {
      HTTPS_PROXY: "http://proxy.local:8080",
      NO_PROXY: "internal.example,.corp.test",
    });
    expect(p.mode).toBe("proxy");
    expect(p.proxyOrigin).toBe("http://proxy.local:8080");
    expect(p.noProxy).toEqual(["internal.example", ".corp.test"]);
  });

  it("never degrades an invalid proxy to direct", () => {
    const p = resolveEgressPolicy(undefined, { HTTPS_PROXY: "socks5://127.0.0.1:1080" });
    expect(p.mode).toBe("direct");
    expect(p.invalid).toMatch(/unsupported proxy scheme/);
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: "socks5://127.0.0.1:1080" } });
    const r = rt.resolve("https://example.com/");
    expect(r.failure?.kind).toBe("proxy-config-invalid");
  });

  it("requires an address in explicit proxy mode", async () => {
    const rt = createEgressRuntime({ env: {} });
    expect(rt.resolve("https://example.com/", { mode: "proxy" }).failure?.kind).toBe("proxy-config-invalid");
    await expect(rt.fetch("https://example.com/", {}, { mode: "proxy" })).rejects.toMatchObject({ kind: "proxy-config-invalid" });
    await rt.close();
  });

  it("selects HTTP_PROXY and HTTPS_PROXY for their respective targets", async () => {
    const env = { HTTP_PROXY: "http://http-proxy.test:81", HTTPS_PROXY: "http://https-proxy.test:82" };
    expect(resolveEgressPolicy(undefined, env, "http:").proxyOrigin).toBe("http://http-proxy.test:81");
    expect(resolveEgressPolicy(undefined, env, "https:").proxyOrigin).toBe("http://https-proxy.test:82");
    const rt = createEgressRuntime({ env });
    expect(rt.resolve("http://target.example/").policy.proxyOrigin).toBe("http://http-proxy.test:81");
    expect(rt.resolve("https://target.example/").policy.proxyOrigin).toBe("http://https-proxy.test:82");
    expect(rt.resolve("https://target.example/").failure).toBeUndefined();
    expect(resolveEgressPolicy(undefined, { HTTPS_PROXY: env.HTTPS_PROXY }, "http:").mode).toBe("direct");
    expect(resolveEgressPolicy(undefined, { ALL_PROXY: "http://fallback.test:83" }, "http:").proxyOrigin).toBe("http://fallback.test:83");
    await rt.close();
  });

  it("matches NO_PROXY across IPv6 spellings and respects a bracketed port", async () => {
    const rt = createEgressRuntime({ env: {
      HTTP_PROXY: "http://127.0.0.1:3128",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: "[2606:4700:0000:0000:0000:0000:0000:1111]:443,[::ffff:93.184.216.34]",
    } });
    expect(rt.resolve("https://[2606:4700::1111]/").bypassedProxy).toBe(true);
    expect(rt.resolve("https://[2606:4700::1111]:444/").bypassedProxy).toBeUndefined();
    expect(rt.resolve("http://[::ffff:5db8:d822]/").bypassedProxy).toBe(true);
    await rt.close();
  });

  it("sanitizes proxy credentials out of policy", () => {
    const p = resolveEgressPolicy({ mode: "proxy", proxyUrl: "http://user:s3cret@10.0.0.1:3128" });
    expect(p.proxyOrigin).toBe("http://10.0.0.1:3128");
    expect(p.proxyAuth).toBe("basic");
    expect(JSON.stringify(p)).not.toContain("s3cret");
  });

  it("classifies malformed proxy credentials before creating a dispatcher", async () => {
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: "http://user:%zz@127.0.0.1:3128" } });
    expect(rt.resolve("https://example.com/").failure?.kind).toBe("proxy-config-invalid");
    const d = await rt.diagnose("https://example.com/");
    expect(d.decision).toBe("blocked");
    expect(d.reason).toContain("proxy-config-invalid");
    await rt.close();
  });

  it("rejects path, query, and fragment on credential-bearing proxy URLs", async () => {
    for (const suffix of ['/unexpected', '?token=SECRET-123', '#fragment']) {
      const rt = createEgressRuntime({ env: { HTTPS_PROXY: `http://user:pass@127.0.0.1:3128${suffix}` } });
      expect(rt.resolve('https://example.com/').failure?.kind).toBe('proxy-config-invalid');
      const diagnosis = await rt.diagnose('https://example.com/');
      expect(diagnosis.decision).toBe('blocked');
      expect(JSON.stringify(diagnosis)).not.toContain('SECRET-123');
      expect(JSON.stringify(diagnosis)).not.toContain('pass');
      await rt.close();
    }
  });
});

describe("ssrf classification", () => {
  it("classifies fake-IP and reserved ranges as special-purpose", () => {
    expect(classifyIp("198.18.0.5")).toBe("special-purpose");
    expect(classifyIp("198.19.255.255")).toBe("special-purpose");
    expect(classifyIp("240.1.2.3")).toBe("special-purpose");
    expect(classifyIp("255.255.255.255")).toBe("special-purpose");
  });

  it("normalizes IPv6 bracket/zone literals before classification", async () => {
    expect(classifyHostname("[::1]")).toBe("private-network");
    expect(classifyHostname("[fe80::1%eth0]")).toBe("private-network");
    const r = await checkSsrf("http://[::1]:8080/admin");
    expect(r).toEqual({ blocked: true, reason: "private-network" });
    expect(await checkSsrf("http://0x7f.1/")).toEqual({ blocked: true, reason: "private-network" });
    expect(await checkSsrf("http://localhost./")).toEqual({ blocked: true, reason: "private-network" });
  });

  it("classifies IPv4-embedded IPv6 by the embedded address", () => {
    expect(classifyIp("::ffff:127.0.0.1")).toBe("private");
    expect(classifyIp("::ffff:93.184.216.34")).toBe("public");
    expect(classifyIp("64:ff9b::7f00:1")).toBe("private");
    expect(classifyIp("64:ff9b::5db8:d822")).toBe("public");
    expect(classifyIp("0:0:0:0:0:ffff:7f00:1")).toBe("private");
    expect(classifyIp("::ffff:0:7f00:1")).toBe("private");
    expect(classifyIp("2002:7f00:1::")).toBe("private");
    expect(classifyIp("fe90::1")).toBe("private");
    expect(classifyIp("febf::1")).toBe("private");
    expect(classifyIp("2001:db8::1")).toBe("special-purpose");
    expect(classifyIp("64:ff9b:1::7f00:1")).toBe("special-purpose");
    expect(classifyIp("2001:2::1")).toBe("special-purpose");
    expect(classifyIp("3fff::1")).toBe("special-purpose");
    expect(classifyIp("224.0.0.1")).toBe("special-purpose");
    expect(classifyHostname("localhost.")).toBe("private-network");
    expect(classifyHostname("service.local.")).toBe("private-network");
  });

  it("blocks ftp and non-URL input at the scheme check", async () => {
    expect(await checkSsrf("ftp://example.com/")).toEqual({ blocked: true, reason: "scheme" });
    expect(await checkSsrf("not a url")).toEqual({ blocked: true, reason: "scheme" });
    expect(await checkDesktopHttpUrl("http://127.0.0.1/")).toEqual({ blocked: false });
    expect(await checkDesktopHttpUrl("file:///secrets.txt")).toEqual({ blocked: true, reason: "scheme" });
  });
});

describe("connect-path enforcement", () => {
  it("refuses a DNS answer that resolves private — on the dial path", async () => {
    const rt = createEgressRuntime({ env: {}, resolveAll: async () => [{ address: "192.168.1.9", family: 4 }] });
    await expect(rt.fetch("http://internal-name.test/")).rejects.toMatchObject({ kind: "private-network" });
  });

  it("lets desktop direct mode reach a local service through ordinary OS routing", async () => {
    const server = net.createServer((socket) => socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const rt = createEgressRuntime({ env: {}, allowLocalTargets: true,
      getHostConfiguration: async () => ({ mode: "direct" }) });
    cleanups.push(() => rt.close());
    const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`;
    expect(await (await rt.fetch(url)).text()).toBe("ok");
    expect(await rt.diagnose(url)).toMatchObject({ decision: "allowed" });
  });

  it("uses the desktop system transport for auto routing and checks every redirect URL", async () => {
    const requests: Array<{ url: string; redirect: RequestInit['redirect']; authorization: string | null }> = [];
    const systemFetch = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, redirect: init.redirect, authorization: new Headers(init.headers).get("authorization") });
      if (url === "https://public.example/start") return new Response(null, { status: 302, headers: { location: "https://other.example/final" } });
      return new Response("ok");
    };
    const rt = createEgressRuntime({ env: {}, allowLocalTargets: true, systemFetch,
      resolveAll: async () => { throw new Error("Node DNS must not resolve desktop system routes"); } });
    cleanups.push(() => rt.close());
    expect(await (await rt.fetch("https://public.example/start", { headers: { authorization: "secret" } })).text()).toBe("ok");
    expect(requests).toEqual([
      { url: "https://public.example/start", redirect: "manual", authorization: "secret" },
      { url: "https://other.example/final", redirect: "manual", authorization: null },
    ]);
    expect(await rt.diagnose("https://public.example/start")).toMatchObject({ policy: { mode: "system" }, resolution: "system", addressCheck: "system-managed" });

    const fileRedirect = createEgressRuntime({ env: {}, allowLocalTargets: true,
      systemFetch: async () => new Response(null, { status: 302, headers: { location: "file:///private.txt" } }) });
    cleanups.push(() => fileRedirect.close());
    await expect(fileRedirect.fetch("https://public.example/start")).rejects.toMatchObject({ kind: "scheme-denied" });
  });

  it("reports DNS failure distinctly from a policy block", async () => {
    const rt = createEgressRuntime({
      env: {},
      resolveAll: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }); },
    });
    await expect(rt.fetch("http://missing.test/")).rejects.toMatchObject({ kind: "dns" });
  });

  it("rejects a link-local IPv6 DNS answer before any socket is dialed", async () => {
    const rt = createEgressRuntime({ env: {}, resolveAll: async () => [{ address: "fe90::1", family: 6 }] });
    await expect(rt.fetch("http://public-name.test/")).rejects.toMatchObject({ kind: "private-network" });
    await rt.close();
  });
});

describe("proxy data path", () => {
  it("resolves an HTTP proxy endpoint on the real connector path", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    cleanups.push(proxy.close);
    const names: string[] = [];
    const rt = createEgressRuntime({
      ...hostProxy(proxy.url.replace("127.0.0.1", "proxy.test")),
      resolveProxyAll: async (hostname) => { names.push(hostname); return [{ address: "127.0.0.1", family: 4 }]; },
    });
    expect(await (await rt.fetch("http://public.example/")).text()).toBe("ok");
    expect(names).toEqual(["proxy.test"]);
    expect(proxy.authorities).toEqual(["public.example:80"]);
    await rt.close();
  });

  it("resolves an HTTPS proxy endpoint before TLS on the real connector path", async () => {
    const server = net.createServer((socket) => socket.once("data", () => socket.destroy()));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const names: string[] = [];
    const rt = createEgressRuntime({
      ...hostProxy(`https://proxy.test:${port}`),
      resolveProxyAll: async (hostname) => { names.push(hostname); return [{ address: "127.0.0.1", family: 4 }]; },
    });
    await expect(rt.fetch("http://public.example/")).rejects.toThrow();
    expect(names).toEqual(["proxy.test"]);
    await rt.close();
  });

  it("routes https targets through CONNECT to the configured proxy", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({ ...hostProxy(proxy.url), resolveAll: async () => [PUBLIC_ADDR] });
    // TLS to example.com will fail after CONNECT — but the CONNECT authority
    // proves the request went through the proxy endpoint.
    await expect(rt.fetch("https://target.example/")).rejects.toThrow();
    expect(proxy.authorities).toEqual(["target.example:443"]);
  });

  it("classifies a proxy 407 CONNECT as proxy-auth", async () => {
    const proxy = await stubConnectProxy(null);
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({ ...hostProxy(proxy.url), resolveAll: async () => [PUBLIC_ADDR] });
    await expect(rt.fetch("https://target.example/")).rejects.toMatchObject({ kind: "proxy-auth" });
  });

  it("classifies an unreachable proxy as proxy-unavailable, not connect", async () => {
    const rt = createEgressRuntime({ ...hostProxy("http://127.0.0.1:1"), resolveAll: async () => [PUBLIC_ADDR] });
    await expect(rt.fetch("https://target.example/")).rejects.toMatchObject({ kind: "proxy-unavailable" });
  });

  it("bypasses the proxy for NO_PROXY targets", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\n\r\n");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({
      env: { HTTPS_PROXY: proxy.url, NO_PROXY: "target.example" },
      resolveAll: async () => [PUBLIC_ADDR],
    });
    const r = rt.resolve("https://target.example/");
    expect(r.bypassedProxy).toBe(true);
    await expect(rt.fetch("https://target.example/")).rejects.toThrow();
    expect(proxy.authorities).toEqual([]);
  });

  it("honors the Host's explicit NO_PROXY through the direct checked connector", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({ ...hostProxy(proxy.url, { noProxy: 'public.example' }),
      resolveAll: async () => [{ address: '192.168.1.8', family: 4 }] });
    await expect(rt.fetch('http://public.example/')).rejects.toMatchObject({ kind: 'private-network' });
    expect(proxy.authorities).toEqual([]);
    await rt.close();
  });

  it("uses an environment proxy without a second trust switch or local target DNS", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    cleanups.push(proxy.close);
    const resolveAll = vi.fn(async () => [{ address: '198.18.7.7', family: 4 }]);
    const rt = createEgressRuntime({ env: { HTTP_PROXY: proxy.url }, resolveAll });
    expect(await (await rt.fetch('http://public.example/')).text()).toBe('ok');
    expect(proxy.authorities).toEqual(['public.example:80']);
    expect(resolveAll).not.toHaveBeenCalled();
    await rt.close();
  });

  it("still refuses literal private targets in proxy mode", () => {
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: "http://127.0.0.1:3128" } });
    expect(rt.resolve("http://192.168.0.1/").failure?.kind).toBe("private-network");
    expect(rt.resolve("http://198.18.2.2/").failure?.kind).toBe("special-purpose");
  });

  it("screens the redirected target before opening a second proxy tunnel", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:8080/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime(hostProxy(proxy.url));
    await expect(rt.fetch("http://public.example/")).rejects.toMatchObject({ kind: "private-network" });
    expect(proxy.authorities).toEqual(["public.example:80"]);
    await rt.close();
  });

  it("screens an IPv4-mapped IPv6 redirect before opening a second tunnel", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 302 Found\r\nLocation: http://[::ffff:7f00:1]:8080/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime(hostProxy(proxy.url));
    await expect(rt.fetch("http://public.example/")).rejects.toMatchObject({ kind: "private-network" });
    expect(proxy.authorities).toEqual(["public.example:80"]);
    await rt.close();
  });

  it("keeps an explicit Host proxy across an HTTP to HTTPS redirect", async () => {
    const proxy = await stubConnectProxy((authority) => authority === "public.example:80"
      ? "HTTP/1.1 302 Found\r\nLocation: https://secure.example/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      : "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime(hostProxy(proxy.url));
    await expect(rt.fetch("http://public.example/")).rejects.toThrow();
    expect(proxy.authorities).toEqual(["public.example:80", "secure.example:443"]);
    await rt.close();
  });
});

describe("diagnose", () => {
  it("reports resolution and classes without fetching", async () => {
    const rt = createEgressRuntime({
      env: {},
      resolveAll: async () => [PUBLIC_ADDR, { address: "93.184.216.35", family: 4 }],
    });
    const d = await rt.diagnose("https://example.com/x");
    expect(d.decision).toBe("allowed");
    expect(d.addressCheck).toBe("public");
    expect(d.resolution).toBe("local");
    expect(d.addresses).toEqual([
      { address: "93.184.216.34", class: "public" },
      { address: "93.184.216.35", class: "public" },
    ]);
  });

  it("reports environment proxy-side DNS without claiming to verify its addresses", async () => {
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: "http://127.0.0.1:3128" } });
    const d = await rt.diagnose("https://example.com/");
    expect(d.decision).toBe("allowed");
    expect(d.addressCheck).toBe("proxy-side-unverified");
    expect(d.resolution).toBe("proxy-side");
    expect(d.policy.proxyOrigin).toBe("http://127.0.0.1:3128");
    expect(JSON.stringify(d)).not.toContain("fingerprint");
  });

  it("reports configured proxy-side DNS without claiming to verify its addresses", async () => {
    const rt = createEgressRuntime(hostProxy("http://127.0.0.1:3128"));
    const d = await rt.diagnose("https://example.com/");
    expect(d.decision).toBe("allowed");
    expect(d.addressCheck).toBe("proxy-side-unverified");
    expect(d.resolution).toBe("proxy-side");
    await rt.close();
  });

  it("classifies a public target literal without claiming proxy-side DNS", async () => {
    const rt = createEgressRuntime(hostProxy("http://127.0.0.1:3128"));
    const d = await rt.diagnose("https://93.184.216.34/");
    expect(d.resolution).toBe("static-literal");
    expect(d.addressCheck).toBe("public");
    expect(d.addresses).toEqual([{ address: "93.184.216.34", class: "public" }]);
    await rt.close();
  });

  it("reports a blocked literal decision with the reason", async () => {
    const rt = createEgressRuntime({ env: {} });
    const d = await rt.diagnose("http://127.0.0.1:9/");
    expect(d.decision).toBe("blocked");
    expect(d.addressCheck).toBe("blocked");
    expect(d.reason).toContain("private-network");
  });

  it("does not claim an address check for a statically blocked hostname", async () => {
    const rt = createEgressRuntime({ env: {} });
    const d = await rt.diagnose("http://service.local/");
    expect(d.decision).toBe("blocked");
    expect(d.resolution).toBe("not-run");
    expect(d.addressCheck).toBe("not-run");
    await rt.close();
  });

  it("blocks a trailing-dot local hostname before a configured proxy can resolve it", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({ env: { HTTP_PROXY: proxy.url } });
    await expect(rt.fetch("http://service.local./")).rejects.toMatchObject({ kind: "private-network" });
    expect(proxy.authorities).toEqual([]);
    await rt.close();
  });

  it("separates a static allow from a DNS answer that would be blocked on connect", async () => {
    const rt = createEgressRuntime({ env: {}, resolveAll: async () => [{ address: "fe90::1", family: 6 }] });
    const d = await rt.diagnose("http://public-name.test/");
    expect(d.decision).toBe("blocked");
    expect(d.addressCheck).toBe("blocked");
    expect(d.addresses).toEqual([{ address: "fe90::1", class: "private" }]);
    await rt.close();
  });

  it("reports diagnostic DNS failures separately from policy blocks", async () => {
    const rt = createEgressRuntime({ env: {}, resolveAll: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); } });
    const d = await rt.diagnose("http://missing.test/");
    expect(d.decision).toBe("blocked");
    expect(d.addressCheck).toBe("dns-error");
    expect(d.lookupError).toContain("ENOTFOUND");
    await rt.close();
  });

  it("does not echo arbitrary resolver error messages in diagnostics", async () => {
    const rt = createEgressRuntime({ env: {}, resolveAll: async () => {
      throw Object.assign(new Error('resolver secret TOKEN-123'), { code: 'ENOTFOUND' });
    } });
    const diagnosis = await rt.diagnose('http://missing.test/');
    expect(diagnosis.addressCheck).toBe('dns-error');
    expect(diagnosis.lookupError).toBe('DNS resolution failed (ENOTFOUND)');
    expect(JSON.stringify(diagnosis)).not.toContain('TOKEN-123');
    await rt.close();
  });
});

describe("classifyEgressError", () => {
  it("maps TLS and timeout codes", () => {
    expect(classifyEgressError(Object.assign(new Error("x"), { cause: Object.assign(new Error("bad"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) })).kind).toBe("tls");
    expect(classifyEgressError(Object.assign(new Error("x"), { cause: Object.assign(new Error("t"), { code: "UND_ERR_CONNECT_TIMEOUT" }) })).kind).toBe("connect");
    expect(classifyEgressError(Object.assign(new Error("x"), { cause: Object.assign(new Error("t"), { code: "ECONNREFUSED" }) }), "proxy").kind).toBe("proxy-unavailable");
  });
});

describe("dispatcher lifecycle", () => {
  it("closes pooled dispatchers once and refuses new requests", async () => {
    const rt = createEgressRuntime(hostProxy("http://127.0.0.1:3128"));
    await rt.prepare("https://example.com/");
    const closing = rt.close();
    expect(rt.close()).toBe(closing);
    await closing;
    await expect(rt.fetch("https://example.com/")).rejects.toMatchObject({ kind: "connect" });
  });

  it("retires an old Host proxy route after rotation", async () => {
    const first = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    const second = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nnew");
    cleanups.push(first.close, second.close);
    let proxyUrl = first.url;
    const rt = createEgressRuntime({ getHostConfiguration: async () => ({ mode: "proxy", proxyUrl }) });
    expect(await (await rt.fetch("http://public.example/one")).text()).toBe("ok");
    proxyUrl = second.url;
    expect(await (await rt.fetch("http://public.example/two")).text()).toBe("new");
    expect(first.authorities).toEqual(["public.example:80"]);
    expect(second.authorities).toEqual(["public.example:80"]);
    await rt.close();
  });

  it("strips target Authorization across origins and keeps proxy auth out of tunneled requests", async () => {
    const proxy = await stubConnectProxy((authority) => authority === "a.example:80"
      ? "HTTP/1.1 302 Found\r\nLocation: http://b.example/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime(hostProxy(proxy.url, { proxyAuth: { username: "proxy-user", password: "proxy-pass" } }));
    const response = await rt.fetch("http://a.example/start", {
      headers: { Authorization: "Bearer target-only" },
    });
    expect(await response.text()).toBe("ok");
    expect(proxy.authorities).toEqual(["a.example:80", "b.example:80"]);
    const basic = `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;
    for (const connect of proxy.connectRequests) {
      expect(connect).toMatch(new RegExp(`^Proxy-Authorization: ${basic}$`, "im"));
      expect(connect).not.toContain("target-only");
    }
    expect(proxy.tunneledRequests).toHaveLength(2);
    expect(proxy.tunneledRequests[0]!.headers).toMatch(/^authorization: Bearer target-only$/im);
    expect(proxy.tunneledRequests[1]!.headers).not.toMatch(/^authorization:/im);
    for (const tunneled of proxy.tunneledRequests) {
      expect(tunneled.headers).not.toMatch(/^proxy-authorization:/im);
      expect(tunneled.headers).not.toContain(basic);
    }
    await rt.close();
  });

  it("rejects caller-supplied Proxy-Authorization before direct or proxy transport", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({ env: { HTTP_PROXY: proxy.url } });
    await expect(rt.fetch("http://a.example/", {
      headers: { "pRoXy-AuThOrIzAtIoN": "Basic caller-secret" },
    })).rejects.toMatchObject({ kind: "proxy-config-invalid" });
    await expect(rt.fetch("http://a.example/", {
      headers: new Headers({ "Proxy-Authorization": "Basic caller-secret" }),
    }, { mode: "direct" })).rejects.toMatchObject({ kind: "proxy-config-invalid" });
    expect(proxy.connectRequests).toEqual([]);
    expect(proxy.tunneledRequests).toEqual([]);
    await rt.close();
  });
});
