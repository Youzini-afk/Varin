# Reverse proxy setup

Use this guide when exposing a Varin Web deployment through Nginx, Nginx Proxy Manager, Caddy, or
another trusted TLS reverse proxy. Containers already expose one HTTP service on port `3000`; the
proxy must forward the complete origin rather than selecting only ordinary REST requests.

The user or their separately instructed agent configures the VPS, frps, DNS, firewall and HTTPS service
independently. Varin connects to existing services; it does not provide VPS deployment, SSH deployment
inspection/preview, deployment plans/receipts, certificate management or remote uninstall.

Use **Settings → External Access → Get deployment files** for the downloadable
[Varin FRP + HTTPS kit](../../deploy/external-access/README.md) and existing-service snippets.
The archive contains only distributable templates; it never includes your Host settings or secrets.

## Before adding a proxy

1. Start Varin on loopback or a private interface and confirm `GET /health` succeeds.
2. Set a long random `VARIN_UI_PASSWORD` before allowing traffic from outside the local machine.
3. Keep `VARIN_DATA_DIR` and workspaces outside immutable release directories.
4. Terminate TLS at the proxy. Do not publish an unauthenticated plain-HTTP Varin server.

## Dedicated external HTTP backend

For a self-managed TLS proxy on the same machine (or a trusted private link),
open **Settings → External Access** on the local Host and save an HTTPS origin
and a fixed IP address and port for the guarded HTTP listener. Saving does not
restart an existing listener; **Enable** starts it and **Retry** applies changes
to an enabled entry. A failed replacement attempts to restore the previous
running listener without overwriting the saved draft. **Disable** is persisted
before the listener is fenced; shutting down the Host does not clear enabled
intent or device authorization. An active legacy Cloudflare/ngrok tunnel must
be stopped before another managed entry can start.

Headless operators can also set the following variables on the Application Host
before starting it. An explicitly configured environment listener takes precedence
over the saved entry, which remains untouched and is not restored in this mode:

```text
VARIN_EXTERNAL_ORIGIN=https://varin.example.com
VARIN_EXTERNAL_LISTEN_PORT=3100
# Optional. Defaults to loopback. Do not publish this plain-HTTP socket.
VARIN_EXTERNAL_LISTEN_HOST=127.0.0.1
```

Point the proxy at that backend instead of the local Application Host port,
preserving the exact public `Host` (including its port, if nonstandard),
`Origin`, cookies and WebSocket upgrades. Do not cache the pairing page or
requests. The guard rejects requests for a different origin, and disabling this
listener does not make it a local entry. The original local listener and managed
tunnel modes are unchanged. Use **Check access** (or `varin external-access check --json`) when
you want one bounded HTTPS check. The guarded listener answers a one-time proof; the request
uses normal TLS certificate validation, no redirects, and no private or special-use addresses.
A bind does not verify public HTTPS. A failed check leaves enabled forwarding unchanged;
the Host may not have a network path back through its public address. This diagnostic does not
inspect the server or manage certificates. Invalid environment configuration or a bind failure leaves
the ordinary local listener unaffected; do not fall back to proxying it.

For an independently managed frpc or other forwarding process, select **External forwarding**.
Supply only the public origin and guarded backend. Keep the control port, token,
mapping and process in your own configuration; Varin neither starts nor stops that process.

An authenticated Host owner can issue a browser-only device link through
`POST /api/client-auth/pairing/sessions` using `allowedClientKinds: ["browser"]`
and `clientExpiresAt` (an absolute time or `null` for remembered access). Use the
returned `browserUrl` from the HTTPS origin. The browser opens a confirmation
page before exchanging its one-use secret. It receives a host-only Secure
HttpOnly cookie backed by the existing device store. Remove the browser's
record through the normal device management operation to revoke it. The paired
browser can also send a same-origin `DELETE /auth/browser-session` to revoke its
own grant and clear its cookies. Clearing the browser's site data still
requires pairing again.

The local settings screen can generate the same browser pairing link or QR.
Do not route remote HTTP clients directly to the ordinary local listener as a
substitute for this guarded backend. This mode does not provision a VPS or
manage TLS certificates.

## Existing FRP (operator-managed)

**Settings → External Access** or the local management API can save an FRP
entry pointing to a separately configured frps server. On supported Linux/macOS Hosts, Varin can
select an existing `frpc` binary via absolute `VARIN_FRPC_PATH` or an absolute directory on `PATH`.
You can also explicitly download Varin's pinned, checksummed component into the Host's own data directory.
This does not install anything on the VPS or restart a running entry. Provide the existing token in
`VARIN_FRP_TOKEN` (or a named `VARIN_FRP_TOKEN_*` environment variable).
The saved config refers to the variable; the value never appears in the
management API response. A trusted CA file and verified TLS server name
are required; the backend is fixed to Host loopback.

On the local Host, with the same authentication and Origin normally used
for the local settings UI, send a `PUT /api/varin/external-access` with
`expectedRevision` from GET (`null` only for a new entry) and a
`configuration` object. For example:

```json
{
  "expectedRevision": null,
  "configuration": {
    "name": "Home VPS",
    "provider": "frp",
    "publicOrigin": "https://varin.example.com",
    "backend": { "host": "127.0.0.1", "port": 3100 },
    "frp": {
      "server": {
        "address": "forwarding.example.com",
        "port": 7000,
        "tls": { "caFile": "/path/to/vps-ca.pem", "serverName": "forwarding.example.com" }
      },
      "proxy": { "name": "varin-home", "remotePort": 7300 },
      "tokenEnv": "VARIN_FRP_TOKEN"
    }
  }
}
```

Then send `POST /api/varin/external-access/enable` with the returned revision
in `expectedRevision`. The Host opens business admission only after frpc
reports the named TCP mapping published. The VPS HTTPS proxy should forward
to that mapping's private VPS address, not make the TCP mapping public.
Publication means that the FRP session is connected, not that public HTTPS
has been verified. Run **Check access** when needed; split DNS, private trust and missing
hairpin routing can block the Host's check even when another browser can reach the site.
Host-side retry is
bounded and does not retry credentials rejected by the provider. Stop waits
for the child to exit and cleans up its private configuration files.

Windows does not yet have a supported private
credential-file path for this FRP mode. Saving an FRP configuration does not install binaries
or mutate the target server.

For headless use, run `varin external-access status --json`. Save an entry
with `varin external-access config --config entry.json --expected-revision new`
(or use the current revision for replacements). Run
`varin external-access enable --expected-revision N`, `disable` or `retry` with
the latest revision. `varin external-access remove --expected-revision N` stops and removes only
the local entry; device grants and external services remain. The CLI talks only to the local Host.

Cloudflare/ngrok keep their existing configuration and credentials. Switching to an FRP or reverse-proxy
entry does not update an externally managed origin or convert an old in-memory tunnel session into a
remembered browser device. For a managed-remote Cloudflare migration, stop the legacy connection,
enable the guarded backend and update the provider's origin to its actual Host/port within your
trusted network. Verify public HTTPS and create a fresh browser pairing link. Existing mobile/desktop
device grants remain with their original owner; a legacy in-memory browser session cannot migrate.

## Current realtime routes

Varin no longer exposes the former OpenCode `/api/event`, `/api/global/event`, or matching
WebSocket routes. A proxy for the native product must preserve:

| Transport | Routes | Requirement |
| --- | --- | --- |
| WebSocket | `/api/terminal/ws`, `/api/dictation/ws`, `/api/varin/observations/ws`, `/api/varin/realtime-proxy/ws` | Forward the HTTP/1.1 upgrade and keep long read timeouts |
| SSE / streaming HTTP | `/api/threads/observe`, `/api/external-agents/observe`, `/api/documents/watch`, `/api/interactive-ui/view/observe`, event routes and `/api/varin/realtime-proxy/sse` | Disable proxy buffering, caching, and response transformation |
| HTTP | `/api/*`, `/auth/*`, `/health`, application assets | Preserve method, body, cookies, authorization, and normal forwarded headers |

The application authenticates these routes and checks WebSocket origins. Do not strip cookies,
`Authorization`, `Origin`, `Host`, or the query string. Do not add a proxy-side authentication bypass
for requests that happen to arrive from loopback.

`/api/varin/observations/ws` multiplexes permitted observation requests over one connection;
it is not an unrestricted HTTP proxy. Preserve its upgrade even when the underlying Thread or
notification API is also listed as SSE. Its endpoint and allowed requests are defined by
[the observation protocol](../../packages/application-client/src/transport/observation-protocol.ts).
The streaming examples are not an exhaustive route list. The Nginx example disables response
buffering for all `/api/` requests, so other direct event/desktop streams and long-lived observations
do not accidentally fall through to a buffered ordinary-HTTP rule. It preserves the client's `Accept`
header rather than forcing every API request to SSE.

Attachments and file operations can contain large request bodies. Choose a deployment-appropriate
limit instead of relying on a proxy's small default. Only one layer should compress a response; SSE
must not be compressed or buffered by an intermediary that delays chunks.

## Nginx

```nginx
map $http_upgrade $varin_connection_upgrade {
    default upgrade;
    ''      close;
}

upstream varin {
    server 127.0.0.1:3000;
    keepalive 16;
}

server {
    listen 443 ssl http2;
    server_name varin.example.com;

    # Configure ssl_certificate / ssl_certificate_key for your deployment.
    client_max_body_size 100m;

    location ~ ^/api/(varin/(realtime-proxy|observations)|terminal|dictation)/ws$ {
        proxy_pass http://varin;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $varin_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    location /api/ {
        proxy_pass http://varin;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_request_buffering off;
    }

    location / {
        proxy_pass http://varin;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_request_buffering off;
    }
}
```

For Nginx Proxy Manager, enable **Websockets Support** and place the equivalent buffering, body-size,
and timeout directives in the host's Advanced configuration. Varin has no separate `/api/event*`
locations; do not add them from older guides.

## Caddy

Caddy forwards WebSocket upgrades automatically. `flush_interval -1` ensures SSE chunks are emitted
without proxy buffering:

```caddy
varin.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        transport http {
            read_timeout 1h
            write_timeout 1h
        }
    }
}
```

## Verification

After configuring the proxy, verify more than the HTML page:

1. Sign in through the public HTTPS origin and reload the page.
2. Open or create a Thread and confirm live output reaches the timeline. Check the observation
   WebSocket upgrade as well as direct SSE; a working terminal alone does not validate both paths.
3. Open a terminal, send input, resize it, detach, and reattach.
4. Leave the page open long enough to receive a notification or scheduled-task SSE update.
5. Upload an attachment large enough to exercise the configured body limit.
6. Confirm failed authentication remains `401`/`403`; the proxy must not replace it with success.

If the page loads but realtime operations fail, inspect the browser network panel for `101 Switching
Protocols` on WebSockets and a long-lived `text/event-stream` response for SSE. `502`/`504` after an
idle period usually means a proxy timeout; updates arriving in bursts usually mean buffering.

For container persistence, health checks, immutable digests, and rollback behavior, see
[cloud deployment](cloud-deployment.md). For authentication and trust boundaries, see
[the security model](../security.md).
