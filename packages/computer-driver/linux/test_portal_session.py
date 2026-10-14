import threading
import time
import unittest
from unittest.mock import patch
from portal_session import PortalSession, SessionError
import wayland_runtime


class Capture:
    def __init__(self):
        self.closed = False
        self.size = (2000, 1200)
    def frame(self, check):
        check()
        if self.closed:
            raise SessionError("session-closed", "Capture closed")
        return {"png": b"PNG fixture", "width": self.size[0], "height": self.size[1], "capturedAt": "2026-10-14T00:00:00Z"}
    def geometry(self):
        return self.size
    def close(self):
        self.closed = True


class Backend:
    def __init__(self):
        self.calls = []
        self.closures = {}
        self.captures = []
        self.available = {"devices": 3, "sources": 3, "dbus_input": True}
        self.properties = {"size": (1000, 600), "pipewire-serial": 456}
        self.granted = 3
        self.fail_release = False
        self.on_notify = None
    def capabilities(self):
        return self.available
    def create_session(self, check):
        check()
        self.calls.append(("CreateSession",))
        return "session-" + str(len(self.calls))
    def watch_closed(self, session, callback):
        self.closures[session] = callback
    def select_devices(self, session, devices, check):
        self.calls.append(("SelectDevices", session, devices))
    def select_sources(self, session, sources, check):
        self.calls.append(("SelectSources", session, sources))
    def start(self, session, check):
        check()
        self.calls.append(("Start", session))
        return {"devices": self.granted, "streams": [(7, self.properties)]}
    def capture(self, session, node, properties, invalidated):
        self.calls.append(("OpenPipeWireRemote", session, node, properties))
        capture = Capture()
        self.captures.append(capture)
        return capture
    def notify(self, session, method, *args):
        self.calls.append((method, session, *args))
        if self.on_notify:
            self.on_notify(method, args)
        if self.fail_release and method in ("KeyboardKeysym", "PointerButton") and args[-1] == 0:
            raise RuntimeError("transport lost")
    def close_session(self, session):
        self.calls.append(("Close", session))


class PortalSessionTests(unittest.TestCase):
    def setUp(self):
        self.backend = Backend()
        self.session = PortalSession(self.backend)
    def observed(self):
        return self.session.frame(observe=True)[1]
    def test_authorization_is_retained_and_frames_do_not_replace_observation(self):
        self.assertEqual(self.backend.calls, [])
        target = self.observed()
        identity = target["observed"]
        self.session.frame()
        self.session.frame(observe=True)
        self.assertEqual(sum(call[0] == "CreateSession" for call in self.backend.calls), 1)
        self.assertEqual(len(self.backend.captures), 1)
        self.session.frame()
        self.assertEqual(target["observed"], identity)
    def test_logical_coordinates_and_negotiated_device_grant(self):
        self.backend.granted = 2
        target = self.observed()
        self.session.notify(target, "PointerMotionAbsolute", 250.0, 125.0)
        self.assertEqual(self.backend.calls[-1][2:], (7, 250.0, 125.0))
        with self.assertRaisesRegex(SessionError, "authorize"):
            self.session.notify(target, "KeyboardKeysym", 65, 1)
        self.assertEqual(self.session.transport, "dbus")
        self.assertFalse(any(call[0] == "ConnectToEIS" for call in self.backend.calls))
    def test_unknown_logical_scale_is_not_guessed_from_raster(self):
        self.backend.properties = {}
        target = self.observed()
        with self.assertRaisesRegex(SessionError, "logical"):
            self.session.notify(target, "PointerMotionAbsolute", 1.0, 2.0)
    def test_release_drains_only_owned_inputs_without_revoking_capture(self):
        target = self.observed()
        self.session.notify(target, "KeyboardKeysym", 65, 1)
        self.session.notify(target, "PointerButton", 0x110, 1)
        self.session.release_input()
        self.assertFalse(self.session.held)
        self.assertEqual(self.session.state, "active")
        self.assertFalse(any(call[0] == "Close" for call in self.backend.calls))
        self.assertTrue(self.session.frame()[0]["base64"])
    def test_failed_release_keeps_original_input_identity_for_retry(self):
        target = self.observed()
        self.session.notify(target, "KeyboardKeysym", 65, 1)
        self.backend.fail_release = True
        with self.assertRaises(RuntimeError):
            self.session.release_input()
        self.assertTrue(self.session.held)
        self.backend.fail_release = False
        self.session.release_input()
        self.assertFalse(self.session.held)
    def test_closed_portal_blocks_input_and_polling_until_explicit_observation(self):
        target = self.observed()
        old_session = self.session.session
        self.backend.closures[old_session]()
        count = len(self.backend.calls)
        with self.assertRaisesRegex(SessionError, "authorization"):
            self.session.notify(target, "PointerButton", 0x110, 1)
        for _ in range(3):
            with self.assertRaisesRegex(SessionError, "observe again"):
                self.session.frame()
        self.assertEqual(len(self.backend.calls), count)
        renewed = self.observed()
        self.assertNotEqual(renewed["handle"], target["handle"])
        self.assertTrue(self.backend.captures[0].closed)
        with self.assertRaisesRegex(SessionError, "earlier session"):
            self.session.target(target["handle"])
        self.backend.closures[old_session]()
        self.assertEqual(self.session.state, "active")
    def test_source_geometry_change_fences_input_and_requires_new_selection(self):
        target = self.observed()
        self.backend.captures[0].size = (1000, 1200)
        with self.assertRaisesRegex(SessionError, "geometry"):
            self.session.validate(target)
        self.assertEqual(self.session.state, "closed")
        self.assertFalse(any(call[0].startswith("Pointer") for call in self.backend.calls))
    def test_cancelled_input_does_not_close_a_chooser_owned_by_a_viewer(self):
        entered, proceed, cancelled = threading.Event(), threading.Event(), threading.Event()
        original = self.backend.start
        def start(session, check):
            entered.set()
            proceed.wait(2)
            return original(session, check)
        self.backend.start = start
        viewer = threading.Thread(target=lambda: self.session.frame())
        viewer.start()
        self.assertTrue(entered.wait(1))
        errors = []
        def check():
            if cancelled.is_set(): raise SessionError("cancelled", "cancelled")
        def observe():
            try: self.session.frame(observe=True, check=check)
            except SessionError as error: errors.append(error.code)
        waiting_input = threading.Thread(target=observe)
        waiting_input.start()
        cancelled.set()
        waiting_input.join(1)
        self.assertFalse(waiting_input.is_alive())
        self.assertEqual(errors, ["cancelled"])
        self.assertFalse(any(call[0] == "Close" for call in self.backend.calls))
        proceed.set()
        viewer.join(1)
        self.assertEqual(self.session.state, "active")

    def test_concurrent_observers_share_one_authorization_and_capture(self):
        errors = []
        def read():
            try:
                self.session.frame()
            except Exception as error:
                errors.append(error)
        workers = [threading.Thread(target=read) for _ in range(8)]
        for worker in workers: worker.start()
        for worker in workers: worker.join()
        self.assertEqual(errors, [])
        self.assertEqual(sum(call[0] == "Start" for call in self.backend.calls), 1)
    def test_cancel_during_text_stops_later_input_keeps_viewer_and_omits_text(self):
        target = self.observed()
        cancelled = threading.Event()
        progress = []
        def notify(method, args):
            if method == "KeyboardKeysym": cancelled.set()
        self.backend.on_notify = notify
        def check():
            if cancelled.is_set(): raise SessionError("cancelled", "The computer operation was cancelled")
        operation = {"id": "test", "tool": "type_text", "app": "0", "window": target["handle"],
                     "text": "private input body", "visual_feedback": True}
        with patch.object(wayland_runtime, "SESSION", self.session), patch.object(wayland_runtime, "check_cancel", check):
            response = wayland_runtime.input_operation(operation, lambda _id, event: progress.append(event))
        self.assertTrue(response["cancelled"])
        self.assertEqual(response["receipt"]["effect"], "partial")
        self.assertEqual(response["receipt"]["dispatchedEvents"], 1)
        self.session.release_input()
        self.assertEqual(self.session.state, "active")
        self.session.frame()
        self.assertNotIn("private input body", repr((response, progress)))
    def test_missing_dbus_capability_negotiates_observation_only(self):
        self.backend.available["dbus_input"] = False
        target = self.observed()
        self.assertIsNone(self.session.transport)
        self.assertEqual(next(call[2] for call in self.backend.calls if call[0] == "SelectDevices"), 0)
        with self.assertRaises(SessionError): self.session.notify(target, "PointerButton", 0x110, 1)
    def test_lost_down_reply_keeps_original_virtual_input_for_release(self):
        target = self.observed()
        def fail(method, args):
            raise RuntimeError("reply lost")
        self.backend.on_notify = fail
        with self.assertRaises(RuntimeError):
            self.session.notify(target, "KeyboardKeysym", 65, 1)
        self.assertIn(("KeyboardKeysym", 65), self.session.held)
        self.backend.on_notify = None
        self.session.release_input()
        self.assertFalse(self.session.held)

    def test_lost_event_response_remains_unknown_after_earlier_events(self):
        response = SessionError("connection-lost", "Input acceptance is unknown", "unknown").response(2)
        self.assertEqual(response["receipt"]["effect"], "unknown")


if __name__ == "__main__":
    unittest.main()
