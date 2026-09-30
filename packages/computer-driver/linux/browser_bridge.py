#!/usr/bin/env python3
"""Chromium DevTools bridge for the managed Linux desktop.

Attaches to the SAME visible browser session a human sees — Chromium launched
with --remote-debugging-port on the managed profile. Pure stdlib: the CDP
socket is a loopback WebSocket implemented directly, so no playwright/selenium
dependency is required. All operations are short-lived; the driver lane
serializes and the control gate decides who may act.

Ops (perform(operation) dispatch):
  status    -> {running, browser?, wsUrl?}
  launch    -> spawn chromium --remote-debugging-port on the profile dir
  tabs      -> [{id, title, url}]
  snapshot  -> compact accessibility tree of a tab (Accessibility.getFullAXTree)
  act       -> kind: navigate | evaluate | click | type | screenshot
"""
import base64
import hashlib
import http.client
import json
import os
import secrets
import shutil
import socket
import struct
import subprocess
import time
from browser_session import endpoint_for, launch_args, profile_for

CDP_PORT = 9222
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_BROWSER_CANDIDATES = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable")


def _http(port, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path)
        response = conn.getresponse()
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f"CDP HTTP {response.status} for {path}")
        return json.loads(body.decode("utf-8"))
    finally:
        conn.close()


class _CdpSocket:
    """Minimal RFC6455 client for loopback CDP sessions."""

    def __init__(self, ws_url):
        # ws://127.0.0.1:PORT/path
        rest = ws_url.split("://", 1)[1]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=15)
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        response = self._read_until(b"\r\n\r\n")
        head = response.decode("latin1")
        if " 101 " not in head.split("\r\n", 1)[0] + " ":
            raise RuntimeError("CDP websocket upgrade refused")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        if accept not in head:
            raise RuntimeError("CDP websocket handshake integrity failed")
        self._next_id = 0
        self.events = []

    def _read_until(self, marker):
        data = b""
        while marker not in data:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("CDP websocket closed")
            data += chunk
        return data

    def _recv_exact(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise RuntimeError("CDP websocket closed mid-frame")
            data += chunk
        return data

    def _send_frame(self, payload):
        header = bytearray([0x81])  # FIN + text
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = secrets.token_bytes(4)
        header += mask
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _recv_message(self):
        message = b""
        while True:
            first, second = self._recv_exact(2)
            fin = first & 0x80
            opcode = first & 0x0F
            masked = second & 0x80
            length = second & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length)
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:  # ping — answer, keep reading
                pong = bytearray([0x8A])
                pong.append(0x80 | len(payload))
                key2 = secrets.token_bytes(4)
                pong += key2
                pong += bytes(b ^ key2[i % 4] for i, b in enumerate(payload))
                self.sock.sendall(bytes(pong))
                continue
            if opcode == 0x8:
                raise RuntimeError("CDP websocket closed by browser")
            message += payload
            if fin:
                return json.loads(message.decode("utf-8"))

    def command(self, method, params=None, timeout=30):
        self._next_id += 1
        request_id = self._next_id
        self.sock.settimeout(timeout)
        self._send_frame(json.dumps({"id": request_id, "method": method, "params": params or {}},
                                    separators=(",", ":")).encode("utf-8"))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self._recv_message()
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"CDP {method}: {message['error'].get('message', 'error')}")
                return message.get("result", {})
            self.events.append(message)
        raise RuntimeError(f"CDP {method} timed out")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


_sessions = {}


def _target_ws(tab_id, port):
    key = f"{port}:{tab_id}"
    session = _sessions.get(key)
    if session is not None:
        return session
    targets = _http(port, "/json/list")
    for target in targets:
        if target.get("id") == tab_id and target.get("webSocketDebuggerUrl"):
            session = _CdpSocket(target["webSocketDebuggerUrl"])
            _sessions[key] = session
            return session
    raise RuntimeError(f"no CDP target for tab {tab_id}")


def _browser_binary():
    for name in _BROWSER_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def _endpoint(operation):
    port, browser_path = endpoint_for(operation)
    version = _http(port, "/json/version")
    if browser_path and not (version.get("webSocketDebuggerUrl") or "").endswith(browser_path):
        raise RuntimeError("The profile's browser endpoint no longer identifies this session")
    return port, version


def _status(operation):
    try:
        _, version = _endpoint(operation)
        return {"running": True, "browser": version.get("Browser"), "wsUrl": version.get("webSocketDebuggerUrl")}
    except Exception as exc:
        return {"running": False, "detail": str(exc)}


def _default_tab(port):
    for target in _http(port, "/json/list"):
        if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
            return target["id"]
    raise RuntimeError("no browser tab to attach")


def _flatten_ax(nodes, depth=0, limit=600, out=None):
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    for node in nodes:
        if len(out) >= limit:
            break
        role = next((p.get("value", {}).get("value") for p in node.get("properties", []) if p.get("name") == "role"), None)
        role = role or (node.get("role") or {}).get("value", "")
        name = (node.get("name") or {}).get("value", "")
        ignored = node.get("ignored")
        if not ignored and (role or name):
            out.append(f"{'  ' * min(depth, 8)}{role or 'node'} {name}".rstrip())
        _flatten_ax(node.get("children") or [], depth + 1, limit, out)
    return out


def perform(operation):
    try:
        return _perform(operation)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _perform(operation):
    op = operation.get("op") or "status"

    if op == "status":
        return {"ok": True, "status": _status(operation)}

    if op == "launch":
        current = _status(operation)
        if current["running"]:
            return {"ok": True, "status": current, "alreadyRunning": True}
        binary = operation.get("binary") or _browser_binary()
        if not binary:
            return {"ok": False, "error": "no Chromium-family browser on this machine (firefox cannot attach CDP)"}
        profile = profile_for(operation)
        os.makedirs(profile, exist_ok=True)
        subprocess.Popen(
            launch_args(binary, profile, operation.get("cdp_port") or 0),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            status = _status(operation)
            if status["running"]:
                return {"ok": True, "status": status}
            time.sleep(0.4)
        return {"ok": False, "error": "browser did not expose CDP within 20s"}

    port, _ = _endpoint(operation)

    if op == "tabs":
        tabs = [{"id": t.get("id"), "title": t.get("title"), "url": t.get("url"),
                 "attached": f"{port}:{t.get('id')}" in _sessions}
                for t in _http(port, "/json/list") if t.get("type") == "page"]
        return {"ok": True, "tabs": tabs}

    if op == "snapshot":
        tab = operation.get("tab") or _default_tab(port)
        ws = _target_ws(tab, port)
        ws.command("Accessibility.enable")
        result = ws.command("Accessibility.getFullAXTree")
        lines = _flatten_ax(result.get("nodes", []), limit=int(operation.get("limit") or 600))
        return {"ok": True, "tab": tab, "lines": lines}

    if op == "act":
        tab = operation.get("tab") or _default_tab(port)
        ws = _target_ws(tab, port)
        ws.command("Page.enable")
        act = operation.get("act") or {}
        kind = act.get("kind")
        if kind == "navigate":
            url = act.get("url")
            if not isinstance(url, str) or not url:
                return {"ok": False, "error": "navigate requires url"}
            result = ws.command("Page.navigate", {"url": url})
            return {"ok": True, "tab": tab, "frameId": result.get("frameId")}
        if kind == "evaluate":
            expression = act.get("expression")
            if not isinstance(expression, str) or not expression:
                return {"ok": False, "error": "evaluate requires expression"}
            result = ws.command("Runtime.evaluate", {"expression": expression, "returnByValue": True})
            value = result.get("result", {})
            return {"ok": True, "tab": tab, "result": value.get("value"), "type": value.get("type"),
                    "exception": bool(result.get("exceptionDetails"))}
        if kind == "click":
            x, y = act.get("x"), act.get("y")
            if not (isinstance(x, (int, float)) and isinstance(y, (int, float))):
                return {"ok": False, "error": "click requires viewport x/y (use snapshot bounds or observe)"}
            for event_type, extra in (("mousePressed", {"button": "left", "clickCount": 1}),
                                      ("mouseReleased", {"button": "left", "clickCount": 1})):
                ws.command("Input.dispatchMouseEvent", {"type": event_type, "x": x, "y": y, **extra})
            return {"ok": True, "tab": tab}
        if kind == "type":
            text = act.get("text")
            if not isinstance(text, str) or not text:
                return {"ok": False, "error": "type requires text"}
            ws.command("Input.insertText", {"text": text})
            return {"ok": True, "tab": tab}
        if kind == "screenshot":
            result = ws.command("Page.captureScreenshot", {"format": "jpeg", "quality": 70})
            data = result.get("data")
            if not data:
                return {"ok": False, "error": "no frame data"}
            return {"ok": True, "tab": tab, "image": "data:image/jpeg;base64," + data}
        return {"ok": False, "error": f"unknown browser act kind: {kind}"}

    return {"ok": False, "error": f"unknown browser op: {op}"}
