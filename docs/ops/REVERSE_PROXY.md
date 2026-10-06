# Reverse proxy setup

Use this guide when exposing a Varin Web deployment through Nginx, Nginx Proxy Manager, Caddy, or
another trusted TLS reverse proxy. Containers already expose one HTTP service on port `3000`; the
proxy must forward the complete origin rather than selecting only ordinary REST requests.

## Before adding a proxy

1. Start Varin on loopback or a private interface and confirm `GET /health` succeeds.
2. Set a long random `VARIN_UI_PASSWORD` before allowing traffic from outside the local machine.
3. Keep `VARIN_DATA_DIR` and workspaces outside immutable release directories.
4. Terminate TLS at the proxy. Do not publish an unauthenticated plain-HTTP Varin server.

## Current realtime routes

Varin no longer exposes the former OpenCode `/api/event`, `/api/global/event`, or matching
WebSocket routes. A proxy for the current Pi-native product must preserve:

| Transport | Routes | Requirement |
| --- | --- | --- |
| WebSocket | `/api/varin/runtime/ws`, `/api/terminal/ws`, `/api/dictation/ws`, `/api/varin/realtime-proxy/ws` | Forward the HTTP/1.1 upgrade and keep long read timeouts |
| SSE | `/api/varin/events`, `/api/notifications/stream`, `/api/varin/runtime-manager/events`, `/api/varin/realtime-proxy/sse` | Disable proxy buffering, caching, and response transformation |
| HTTP | `/api/*`, `/auth/*`, `/health`, application assets | Preserve method, body, cookies, authorization, and normal forwarded headers |

The application authenticates these routes and checks WebSocket origins. Do not strip cookies,
`Authorization`, `Origin`, `Host`, or the query string. Do not add a proxy-side authentication bypass
for requests that happen to arrive from loopback.

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

    location ~ ^/api/(varin/runtime|varin/realtime-proxy|terminal|dictation)/ws$ {
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

    location ~ ^/api/(notifications/stream|varin/(events|runtime-manager/events|realtime-proxy/sse))$ {
        proxy_pass http://varin;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Accept text/event-stream;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        add_header X-Accel-Buffering no always;
        add_header Cache-Control 'no-cache, no-transform' always;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
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
and timeout directives in the host's Advanced configuration. Do not recreate the removed
`/api/event*` locations from older OpenChamber guides.

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
2. Open or create a Pi session and confirm live output reaches the timeline.
3. Open a terminal, send input, resize it, detach, and reattach.
4. Leave the page open long enough to receive a notification or scheduled-task SSE update.
5. Upload an attachment large enough to exercise the configured body limit.
6. Confirm failed authentication remains `401`/`403`; the proxy must not replace it with success.

If the page loads but realtime operations fail, inspect the browser network panel for `101 Switching
Protocols` on WebSockets and a long-lived `text/event-stream` response for SSE. `502`/`504` after an
idle period usually means a proxy timeout; updates arriving in bursts usually mean buffering.

For container persistence, health checks, immutable digests, and rollback behavior, see
[cloud deployment](cloud-deployment.md). For authentication and trust boundaries, see
[the security model](../design/security.md).
