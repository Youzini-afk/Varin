#!/usr/bin/env python3
"""Bridge protocol test: a fake CDP endpoint exercises the real HTTP + RFC6455
client path of browser_bridge without a browser."""
import base64
import hashlib
import http.server
import json
import socket
import struct
import threading
import unittest

import browser_bridge

REAL_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class FakeCdpWs:
    def __init__(self, sock, server):
        self.sock = sock
        self.server = server
        self.requests = server.requests

    def recv_frame(self):
        first, second = self._exact(2)
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
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise EOFError()
            data += chunk
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

    def serve(self, key):
        accept = base64.b64encode(hashlib.sha1((key + REAL_GUID).encode()).digest()).decode()
        event = json.dumps({"method": "Test.initialEvent"}).encode()
        self.sock.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode() + bytes([0x81, len(event)]) + event)
        while True:
            opcode, payload = self.recv_frame()
            if opcode == 0x8:
                return
            if opcode == 0xA:  # pong — ignore
                continue
            request = json.loads(payload)
            self.requests.append(request)
            if request["method"] == "Runtime.evaluate":
                result = {"result": {"type": "string", "value": "hello page"}}
            elif request["method"] == "Accessibility.getFullAXTree":
                result = {"nodes": [{"nodeId": "1", "childIds": ["2"], "role": {"value": "RootWebArea"}, "name": {"value": "T"}},
                                    {"nodeId": "2", "parentId": "1", "role": {"value": "button"}, "name": {"value": "OK"}}]}
            elif request["method"] == "Input.dispatchMouseEvent":
                result = {}
            elif request["method"] == "Input.insertText":
                result = {}
            elif request["method"] == "Page.navigate":
                result = {"frameId": "f1"}
            elif request["method"] == "Page.getFrameTree":
                result = {"frameTree": {"frame": {"id": "frame-1", "loaderId": self.server.loader, "url": self.server.page_url}}}
            elif request["method"] == "Page.getLayoutMetrics":
                result = {"cssVisualViewport": {"clientWidth": 800, "clientHeight": 600, "scale": 1}}
            elif request["method"] == "Target.createTarget":
                result = {"targetId": "new-real-target"}
            elif request["method"] == "Page.captureScreenshot":
                data = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + struct.pack(">II", 1600, 1200)
                result = {"data": base64.b64encode(data).decode()}
            else:
                result = {}
            self.send_text(json.dumps({"id": request["id"], "result": result}))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ws_url = f"ws://127.0.0.1:{self.server.server_port}/devtools"
        if self.path.startswith("/devtools/"):
            try:
                FakeCdpWs(self.connection, self.server).serve(self.headers["Sec-WebSocket-Key"])
            except (EOFError, OSError):
                pass
            return
        if self.path == "/json/version":
            body = json.dumps({"Browser": "Fake/1.0", "webSocketDebuggerUrl": f"{ws_url}/browser"}).encode()
        elif self.path == "/json/list":
            body = json.dumps([
                {"id": "tab-1", "type": "page", "title": "Example", "url": "https://example.com/",
                 "webSocketDebuggerUrl": f"{ws_url}/page/tab-1"},
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


class BrowserBridge(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.requests = []
        self.server.loader = "loader-1"
        self.server.page_url = "https://example.com/"
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def perform(self, operation):
        return browser_bridge.perform({**operation, "cdp_port": self.server.server_port})

    def test_cdp_protocol_over_loopback(self):
        status = self.perform({"op": "status"})
        self.assertTrue(status["ok"] and status["status"]["running"])
        self.assertEqual(status["status"]["browser"], "Fake/1.0")
        # Reserve an unused endpoint so another process cannot take its port.
        with socket.socket() as offline:
            offline.bind(("127.0.0.1", 0))
            status_down = browser_bridge.perform({"op": "status", "cdp_port": offline.getsockname()[1]})
            self.assertTrue(status_down["ok"])
            self.assertFalse(status_down["status"]["running"])

        tabs = self.perform({"op": "tabs"})
        self.assertTrue(tabs["ok"])
        self.assertEqual([tab["id"] for tab in tabs["tabs"]], ["tab-1"])
        snapshot = self.perform({"op": "snapshot", "tab": "tab-1"})
        self.assertTrue(snapshot["ok"])
        self.assertEqual(snapshot["lines"], ["RootWebArea T", "  button OK"])
        self.assertFalse(snapshot["truncated"])
        short = self.perform({"op": "snapshot", "tab": "tab-1", "limit": 1})
        self.assertEqual(short["lines"], ["RootWebArea T"])
        self.assertTrue(short["truncated"])

        nav = self.perform({"op": "act", "tab": "tab-1", "act": {"kind": "navigate", "url": "https://x/"}})
        self.assertTrue(nav["ok"])
        self.assertEqual(nav["frameId"], "f1")
        evaluated = self.perform({"op": "act", "tab": "tab-1", "act": {"kind": "evaluate", "expression": "1+1"}})
        self.assertTrue(evaluated["ok"])
        self.assertEqual(evaluated["result"], "hello page")
        click = self.perform({"op": "act", "tab": "tab-1", "act": {"kind": "click", "x": 10, "y": 20}})
        self.assertTrue(click["ok"])
        mouse = [request["params"] for request in self.server.requests if request["method"] == "Input.dispatchMouseEvent"]
        self.assertEqual([(event["type"], event["x"], event["y"]) for event in mouse],
                         [("mousePressed", 10, 20), ("mouseReleased", 10, 20)])

        bad = self.perform({"op": "act", "tab": "tab-1", "act": {"kind": "evaluate"}})
        self.assertFalse(bad["ok"])
        self.assertIn("expression", bad["error"])
        missing = self.perform({"op": "snapshot", "tab": "nope"})
        self.assertFalse(missing["ok"])

    def test_actual_instance_identity_and_owner_side_restart_fence(self):
        identity = self.perform({"op": "status"})["status"]["instanceId"]
        self.assertEqual(len(identity), 64)
        result = self.perform({"op": "act", "expectedInstanceId": identity, "act": {"kind": "new_tab", "url": "https://new/"}})
        self.assertEqual(result["instanceId"], identity)
        self.assertEqual(result["tab"], "new-real-target")
        self.server.requests.clear()
        rejected = self.perform({"op": "act", "expectedInstanceId": "previous-browser", "tab": "tab-1", "act": {"kind": "type", "text": "must not send"}})
        self.assertFalse(rejected["ok"])
        self.assertTrue(rejected["rejected"])
        self.assertNotIn("outcome", rejected)
        self.assertEqual(self.server.requests, [])

    def test_structured_observation_and_stale_document_rejection(self):
        observed = self.perform({"op": "snapshot", "tab": "tab-1", "structured": True, "screenshot": True})
        self.assertTrue(observed["ok"])
        observation = observed["observation"]
        self.assertEqual(observation["viewport"], {"width": 800, "height": 600, "scale": 1})
        self.assertEqual(observation["image"]["width"], 1600)
        self.assertEqual(observation["elements"][1], {"role": "button", "name": "OK"})
        self.assertNotIn("ref", observation["elements"][1])
        for change in ("loader", "same-document"):
            self.server.requests.clear()
            if change == "loader":
                self.server.loader = "new-loader"
            else:
                self.server.loader = "loader-1"
                self.server.page_url += "#changed"
            rejected = self.perform({"op": "act", "tab": "tab-1", "expectedDocumentId": observation["documentId"],
                                     "act": {"kind": "click", "x": 20, "y": 30}})
            self.assertFalse(rejected["ok"])
            self.assertTrue(rejected["rejected"])
            self.assertNotIn("outcome", rejected)
            self.assertFalse(any(command["method"].startswith("Input.") for command in self.server.requests))


if __name__ == "__main__":
    unittest.main()
