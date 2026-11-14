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
  act       -> kind: new_tab | navigate | evaluate | click | type | screenshot
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
from urllib.parse import urlsplit
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
        url = urlsplit(ws_url)
        if url.scheme != "ws" or not url.hostname:
            raise ValueError("Invalid CDP WebSocket endpoint")
        self.sock = socket.create_connection((url.hostname, url.port or 80), timeout=15)
        self._buffer = b""
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = (
            f"GET {url.path or '/'}{('?' + url.query) if url.query else ''} HTTP/1.1\r\nHost: {url.netloc}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        response = self._read_until(b"\r\n\r\n")
        head = response.decode("latin1")
        if " 101 " not in head.split("\r\n", 1)[0] + " ":
            raise RuntimeError("CDP websocket upgrade refused")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        headers = dict(line.split(":", 1) for line in head.split("\r\n")[1:] if ":" in line)
        headers = {name.lower(): value.strip() for name, value in headers.items()}
        if headers.get("sec-websocket-accept") != accept:
            self.sock.close()
            raise RuntimeError("CDP websocket handshake integrity failed")
        self._next_id = 0

    def _read_until(self, marker):
        data = b""
        while marker not in data:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("CDP websocket closed")
            data += chunk
        end = data.index(marker) + len(marker)
        self._buffer = data[end:]
        return data[:end]

    def _recv_exact(self, n):
        data = self._buffer[:n]
        self._buffer = self._buffer[n:]
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
        started = False
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
                if not fin or length > 125:
                    raise RuntimeError("Invalid WebSocket control frame")
                pong = bytearray([0x8A])
                pong.append(0x80 | len(payload))
                key2 = secrets.token_bytes(4)
                pong += key2
                pong += bytes(b ^ key2[i % 4] for i, b in enumerate(payload))
                self.sock.sendall(bytes(pong))
                continue
            if opcode == 0x8:
                raise RuntimeError("CDP websocket closed by browser")
            if opcode == 0xA:
                continue
            if opcode == 1 and not started:
                started = True
            elif opcode != 0 or not started:
                raise RuntimeError("Unexpected CDP WebSocket frame")
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
            # Unrelated events do not belong to this command's receipt. Keeping
            # every event in a resident helper would retain page data forever.
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


class BeforeDispatchError(ValueError):
    """The provider has proved no browser input was sent."""


def _instance_id(version):
    endpoint = version.get("webSocketDebuggerUrl")
    if not isinstance(endpoint, str) or not endpoint:
        raise BeforeDispatchError("Browser did not report its actual CDP instance identity")
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


def _endpoint(operation):
    port, browser_path = endpoint_for(operation)
    version = _http(port, "/json/version")
    if browser_path and not (version.get("webSocketDebuggerUrl") or "").endswith(browser_path):
        raise BeforeDispatchError("The profile's browser endpoint no longer identifies this session")
    expected = operation.get("expectedInstanceId")
    if expected is not None and expected != _instance_id(version):
        raise BeforeDispatchError("The original browser instance ended; discover its current pages")
    return port, version


def _status(operation):
    try:
        _, version = _endpoint(operation)
        return {"running": True, "browser": version.get("Browser"), "wsUrl": version.get("webSocketDebuggerUrl"), "instanceId": _instance_id(version)}
    except Exception as exc:
        return {"running": False, "detail": str(exc)}


def _default_tab(port):
    pages = [target for target in _http(port, "/json/list")
             if target.get("type") == "page" and target.get("webSocketDebuggerUrl")]
    if len(pages) != 1:
        raise RuntimeError("Select a tab id from tabs; there is not exactly one page")
    return pages[0]["id"]


def _flatten_ax(nodes, limit=600):
    # CDP getFullAXTree returns a flat array. Hierarchy is encoded by
    # nodeId/childIds (and sometimes parentId), not nested children.
    by_id = {node["nodeId"]: node for node in nodes if node.get("nodeId")}
    roots = [node for node in nodes if not node.get("parentId") or node["parentId"] not in by_id]
    stack = [(node, 0) for node in reversed(roots)]
    seen = set()
    lines = []
    while stack:
        node, depth = stack.pop()
        key = node.get("nodeId") or id(node)
        if key in seen:
            continue
        seen.add(key)
        role = (node.get("role") or {}).get("value", "")
        name = (node.get("name") or {}).get("value", "")
        if not node.get("ignored") and (role or name):
            if len(lines) >= limit:
                return lines, True
            lines.append(f"{'  ' * min(depth, 8)}{role or 'node'} {name}".rstrip())
        children = [by_id[child] for child in node.get("childIds", []) if child in by_id]
        stack.extend((child, depth + 1) for child in reversed(children))
    # Preserve nodes not connected to any declared root, such as a partial
    # CDP tree. They remain visible, without inventing a parent relation.
    for node in nodes:
        key = node.get("nodeId") or id(node)
        if key not in seen and not node.get("ignored"):
            if len(lines) >= limit:
                return lines, True
            lines.append(f"{(node.get('role') or {}).get('value', 'node')} {(node.get('name') or {}).get('value', '')}".rstrip())
    return lines, False


def _document(ws):
    tree = ws.command("Page.getFrameTree").get("frameTree") or {}
    frame = tree.get("frame") or {}
    if not frame.get("id") or not frame.get("loaderId"):
        raise BeforeDispatchError("The browser did not report a live document identity")
    identity = hashlib.sha256(json.dumps([frame["id"], frame["loaderId"], frame.get("url", "")], separators=(",", ":")).encode()).hexdigest()
    frames = []
    stack = [tree]
    while stack:
        current = stack.pop()
        child = current.get("frame") or {}
        if child.get("id"):
            frames.append({"frameId": child["id"], "url": child.get("url", ""), "available": True,
                           **({"parentId": child["parentId"]} if child.get("parentId") else {})})
        stack.extend(reversed(current.get("childFrames", [])))
    return identity, frames


def perform(operation):
    try:
        result = _perform(operation)
        if operation.get("_instanceId"):
            result["instanceId"] = operation["_instanceId"]
        return result
    except BeforeDispatchError as exc:
        return {"ok": False, "rejected": True, "error": str(exc)}
    except Exception as exc:
        writes = operation.get("op") == "launch" or (operation.get("op") == "act"
                 and (operation.get("act") or {}).get("kind") != "screenshot")
        return {"ok": False, "error": str(exc), **({"outcome": "unknown"} if writes else {})}
    finally:
        for session in _sessions.values():
            session.close()
        _sessions.clear()


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

    port, version = _endpoint(operation)
    operation["_instanceId"] = _instance_id(version)

    if op == "tabs":
        tabs = [{"id": t.get("id"), "title": t.get("title"), "url": t.get("url")}
                for t in _http(port, "/json/list") if t.get("type") == "page"]
        return {"ok": True, "tabs": tabs}

    if op == "snapshot":
        tab = operation.get("tab") or _default_tab(port)
        ws = _target_ws(tab, port)
        ws.command("Accessibility.enable")
        before = _document(ws) if operation.get("structured") else None
        result = ws.command("Accessibility.getFullAXTree")
        nodes = result.get("nodes", [])
        limit = int(operation.get("limit") or 600)
        lines, truncated = _flatten_ax(nodes, limit=limit)
        response = {"ok": True, "tab": tab, "lines": lines, "truncated": truncated}
        if operation.get("structured"):
            metrics = ws.command("Page.getLayoutMetrics")
            viewport = metrics.get("cssVisualViewport") or metrics.get("visualViewport") or {}
            width, height = viewport.get("clientWidth"), viewport.get("clientHeight")
            if not isinstance(width, (int, float)) or not isinstance(height, (int, float)) or width <= 0 or height <= 0:
                raise BeforeDispatchError("The browser did not report a usable viewport")
            observation = {"documentId": before[0], "frames": before[1],
                           "viewport": {"width": width, "height": height, "scale": viewport.get("scale", 1)},
                           "elements": [{"role": (node.get("role") or {}).get("value", "node"),
                                         **{key: str(node[key].get("value", "")) for key in ("name", "value", "description") if node.get(key)}}
                                        for node in nodes if not node.get("ignored")][:limit]}
            if operation.get("screenshot"):
                image = ws.command("Page.captureScreenshot", {"format": "png"}).get("data")
                if not image:
                    raise BeforeDispatchError("The browser did not return its screenshot")
                # PNG IHDR is the actual raster size, not CSS viewport dimensions.
                raster = base64.b64decode(image, validate=True)
                if raster[:8] != b"\x89PNG\r\n\x1a\n" or len(raster) < 24:
                    raise BeforeDispatchError("The browser returned an invalid PNG")
                image_width, image_height = struct.unpack(">II", raster[16:24])
                observation["image"] = {"mimeType": "image/png", "base64": image, "width": image_width, "height": image_height}
            if _document(ws)[0] != before[0]:
                raise BeforeDispatchError("The page navigated during observation; read it again")
            response["observation"] = observation
        return response

    if op == "act":
        act = operation.get("act") or {}
        if act.get("kind") == "new_tab":
            url = act.get("url")
            if not isinstance(url, str) or not url:
                raise BeforeDispatchError("new_tab requires url")
            ws = _CdpSocket(version["webSocketDebuggerUrl"])
            try:
                target = ws.command("Target.createTarget", {"url": url})
                return {"ok": True, "tab": target["targetId"]}
            finally:
                ws.close()
        tab = operation.get("tab") or _default_tab(port)
        ws = _target_ws(tab, port)
        ws.command("Page.enable")
        act = operation.get("act") or {}
        kind = act.get("kind")
        expected_document = operation.get("expectedDocumentId")
        if expected_document is not None and _document(ws)[0] != expected_document:
            raise BeforeDispatchError("The page changed since observation; read it again before input")
        if kind == "release":
            ws.command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": act.get("x", 0), "y": act.get("y", 0), "button": "left", "clickCount": 1})
            return {"ok": True, "tab": tab}
        if kind == "navigate":
            url = act.get("url")
            if not isinstance(url, str) or not url:
                return {"ok": False, "error": "navigate requires url"}
            result = ws.command("Page.navigate", {"url": url})
            if result.get("errorText"):
                return {"ok": False, "tab": tab, "error": result["errorText"]}
            return {"ok": True, "tab": tab, "frameId": result.get("frameId")}
        if kind == "evaluate":
            expression = act.get("expression")
            if not isinstance(expression, str) or not expression:
                return {"ok": False, "error": "evaluate requires expression"}
            result = ws.command("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
            value = result.get("result", {})
            return {"ok": not bool(result.get("exceptionDetails")), "tab": tab, "result": value.get("value"), "type": value.get("type"),
                    **({"error": "Page evaluation raised an exception; inspect its state", "outcome": "unknown"} if result.get("exceptionDetails") else {}),
                    "exception": bool(result.get("exceptionDetails"))}
        if kind == "click":
            x, y = act.get("x"), act.get("y")
            if not (isinstance(x, (int, float)) and isinstance(y, (int, float))):
                return {"ok": False, "error": "click requires viewport x/y (use snapshot bounds or observe)"}
            try:
                ws.command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
            finally:
                ws.command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
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
