#!/usr/bin/env python3
"""Bridge protocol test: a fake CDP endpoint exercises the real HTTP + RFC6455
client path of browser_bridge without a browser."""
import base64
import hashlib
import http.server
import json
import os
import socket
import struct
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import browser_bridge

WS_GUID = "258EAFAA-0000-0000-0000-000000000000"
REAL_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class FakeCdpWs:
    def __init__(self, sock):
        self.sock = sock
        self.commands = []

    def recv_frame(self):
        first, second = self.sock.recv(2)
        masked = second & 0x80
        length = second & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._exact(8))[0]
        mask = self._exact(4) if masked else b""
        payload = self._exact(length)
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return first & 0x0F, payload

    def _exact(self, n):
        data = b""
        while len(data) < n:
            data += self.sock.recv(n - len(data))
        return data

    def send_text(self, text):
        payload = text.encode("utf-8")
        header = bytearray([0x81])
        if len(payload) < 126:
            header.append(len(payload))
        else:
            header.append(126)
            header += struct.pack(">H", len(payload))
        self.sock.sendall(bytes(header) + payload)

    def serve(self):
        # upgrade handshake
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        key = next(line.split(":", 1)[1].strip() for line in buf.decode("latin1").split("\r\n") if line.lower().startswith("sec-websocket-key"))
        accept = base64.b64encode(hashlib.sha1((key + REAL_GUID).encode()).digest()).decode()
        self.sock.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode())
        while True:
            opcode, payload = self.recv_frame()
            if opcode == 0x8:
                return
            if opcode == 0xA:  # pong — ignore
                continue
            request = json.loads(payload)
            self.commands.append(request["method"])
            if request["method"] == "Runtime.evaluate":
                result = {"result": {"type": "string", "value": "hello page"}}
            elif request["method"] == "Accessibility.getFullAXTree":
                result = {"nodes": [{"role": {"value": "RootWebArea"}, "name": {"value": "T"},
                                    "children": [{"role": {"value": "button"}, "name": {"value": "OK"}}]}]}
            elif request["method"] == "Input.dispatchMouseEvent":
                result = {}
            elif request["method"] == "Input.insertText":
                result = {}
            elif request["method"] == "Page.navigate":
                result = {"frameId": "f1"}
            elif request["method"] == "Page.captureScreenshot":
                result = {"data": base64.b64encode(b"img").decode()}
            else:
                result = {}
            self.send_text(json.dumps({"id": request["id"], "result": result}))


PORT = 19323
ws_server = socket.socket()
ws_server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
ws_server.bind(("127.0.0.1", PORT + 1))
ws_server.listen(5)
ws_sessions = []


def ws_loop():
    while True:
        conn, _ = ws_server.accept()
        session = FakeCdpWs(conn)
        ws_sessions.append(session)
        try:
            session.serve()
        except Exception:
            return


threading.Thread(target=ws_loop, daemon=True).start()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/json/version":
            body = json.dumps({"Browser": "Fake/1.0", "webSocketDebuggerUrl": f"ws://127.0.0.1:{PORT + 1}/devtools/browser"}).encode()
        elif self.path == "/json/list":
            body = json.dumps([
                {"id": "tab-1", "type": "page", "title": "Example", "url": "https://example.com/",
                 "webSocketDebuggerUrl": f"ws://127.0.0.1:{PORT + 1}/devtools/page/tab-1"},
                {"id": "bg-1", "type": "background_page", "title": "ext"},
            ]).encode()
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


httpd = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()


def check(name, condition):
    if not condition:
        print(f"FAIL {name}")
        sys.exit(1)
    print(f"pass {name}")


status = browser_bridge.perform({"op": "status", "cdp_port": PORT})
check("status reports running browser", status["ok"] and status["status"]["running"] and status["status"]["browser"] == "Fake/1.0")

status_down = browser_bridge.perform({"op": "status", "cdp_port": 19999})
check("status is honest when nothing listens", status_down["ok"] and status_down["status"]["running"] is False)

tabs = browser_bridge.perform({"op": "tabs", "cdp_port": PORT})
check("tabs lists only page targets", tabs["ok"] and len(tabs["tabs"]) == 1 and tabs["tabs"][0]["id"] == "tab-1")

snapshot = browser_bridge.perform({"op": "snapshot", "tab": "tab-1", "cdp_port": PORT})
check("snapshot flattens the AX tree", snapshot["ok"] and any("button OK" in line for line in snapshot["lines"]))

nav = browser_bridge.perform({"op": "act", "tab": "tab-1", "cdp_port": PORT, "act": {"kind": "navigate", "url": "https://x/"}})
check("navigate returns the frame id", nav["ok"] and nav["frameId"] == "f1")

ev = browser_bridge.perform({"op": "act", "tab": "tab-1", "cdp_port": PORT, "act": {"kind": "evaluate", "expression": "1+1"}})
check("evaluate returns the page value", ev["ok"] and ev["result"] == "hello page")

click = browser_bridge.perform({"op": "act", "tab": "tab-1", "cdp_port": PORT, "act": {"kind": "click", "x": 10, "y": 20}})
check("click dispatches viewport input", click["ok"])

bad = browser_bridge.perform({"op": "act", "tab": "tab-1", "cdp_port": PORT, "act": {"kind": "evaluate"}})
check("missing expression is rejected honestly", bad["ok"] is False and "expression" in bad["error"])

missing_tab = browser_bridge.perform({"op": "snapshot", "tab": "nope", "cdp_port": PORT})
check("unknown tab is rejected honestly", missing_tab["ok"] is False)

print("browser_bridge: all checks passed")
