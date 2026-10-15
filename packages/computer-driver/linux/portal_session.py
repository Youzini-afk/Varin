"""One consented desktop session. No GI imports: lifecycle is testable off-desktop.

The session, not a request, owns authorization, captures and held input. Only
explicit observation may renew a closed session; viewer polling never repeatedly
opens the chooser. Ordinary cancellation drains input without closing capture.
"""
import base64
import math
import threading
from contextlib import contextmanager


class SessionError(Exception):
    def __init__(self, code, message, effect="none"):
        super().__init__(message)
        self.code, self.effect = code, effect

    def response(self, events=0):
        effect = self.effect if not events or self.effect == "unknown" else "partial"
        return {"ok": False, "error": str(self), "rejected": effect == "none",
                "cancelled": self.code == "cancelled",
                "receipt": {"effect": effect, "dispatchedEvents": events,
                            "reason": {"code": self.code, "message": str(self)},
                            "recovery": "reconnect" if self.code == "session-closed" else "observe"}}


def no_cancel():
    pass


class PortalSession:
    def __init__(self, backend):
        self.backend = backend
        self.lock = threading.RLock()
        self.start_lock = threading.Lock()
        self.state = "idle"
        self.session = None
        self.generation = 0
        self.streams = {}
        self.next_handle = 1
        self.devices = 0
        self.transport = None
        self.held = set()

    @contextmanager
    def starting(self, check):
        # An input request may wait on a chooser opened by a viewer. Cancelling
        # that request must not cancel the viewer's authorization attempt.
        while not self.start_lock.acquire(timeout=0.025):
            check()
        try:
            check()
            yield
        finally:
            self.start_lock.release()

    def ensure(self, renew=False, check=no_cancel):
        with self.starting(check):
            with self.lock:
                if self.state == "active":
                    return
                if self.state == "closed" and not renew:
                    raise SessionError("session-closed", "Desktop authorization or capture ended; observe again to request a new session")
                old_session, old_streams = self.session, self.streams
                self.release_input()
                self.state = "closed"
            # Retain the old owner until its actual closure is confirmed. A
            # failed Close must not discard the only identity able to clean up.
            for stream in old_streams.values():
                stream["capture"].close()
            if old_session:
                self.backend.close_session(old_session)
            with self.lock:
                self.session, self.streams = None, {}
                self.state = "starting"
                self.generation += 1
                generation = self.generation
            session = None
            prepared = {}
            try:
                check()
                capabilities = self.backend.capabilities()
                # This implementation negotiates the documented D-Bus input
                # transport before starting. It never establishes EIS and then
                # falls back to Notify, which the portal forbids.
                devices = capabilities["devices"] & 3
                if not capabilities["dbus_input"]:
                    devices = 0
                session = self.backend.create_session(check)
                with self.lock:
                    self.session = session
                self.backend.watch_closed(session, lambda: self.invalidate(generation, revoked=True))
                self.backend.select_devices(session, devices, check)
                self.backend.select_sources(session, capabilities["sources"] & 3, check)
                result = self.backend.start(session, check)
                for node, properties in result.get("streams", []):
                    check()
                    capture = self.backend.capture(session, node, properties,
                        lambda: self.invalidate(generation))
                    size = properties.get("logical_size", properties.get("size"))
                    logical = tuple(size) if isinstance(size, (tuple, list)) and len(size) == 2 and all(isinstance(n, (int, float)) and math.isfinite(n) and n > 0 for n in size) else None
                    handle = self.next_handle
                    self.next_handle += 1
                    prepared[handle] = {"handle": handle, "node": node, "properties": properties,
                                        "logical": logical, "capture": capture, "observed": None}
                if not prepared:
                    raise SessionError("target-unavailable", "The portal did not grant a screen source")
                with self.lock:
                    if self.generation != generation or self.state != "starting":
                        raise SessionError("session-closed", "Desktop authorization closed during preparation")
                    self.streams = prepared
                    self.devices = int(result.get("devices", 0)) & devices
                    self.transport = "dbus" if self.devices else None
                    self.state = "active"
            except Exception:
                with self.lock:
                    if self.generation == generation:
                        self.state = "closed"
                        self.streams = prepared
                for stream in prepared.values():
                    stream["capture"].close()
                if session:
                    self.backend.close_session(session)
                with self.lock:
                    if self.generation == generation:
                        self.session, self.streams = None, {}
                raise

    def invalidate(self, generation=None, revoked=False):
        with self.lock:
            if generation is not None and generation != self.generation:
                return
            self.state = "closed"
            self.devices = 0
            for stream in self.streams.values():
                stream["observed"] = None
            # Session closure revokes its input at the compositor. Do not send
            # releases via a new session or an unrelated desktop mechanism.
            if revoked:
                self.held.clear()

    def close(self):
        with self.start_lock:
            with self.lock:
                self.release_input()
                session, streams = self.session, self.streams
                self.invalidate()
            for stream in streams.values():
                stream["capture"].close()
            if session:
                self.backend.close_session(session)
            with self.lock:
                self.session, self.streams = None, {}
                self.held.clear()

    def target(self, handle=None):
        with self.lock:
            if self.state != "active":
                raise SessionError("session-closed", "Desktop authorization or capture is no longer active")
            if handle is None:
                return next(iter(self.streams.values()))
            target = self.streams.get(handle)
            if target is None:
                raise SessionError("target-changed", "The captured target belongs to an earlier session; observe again")
            return target

    def frame(self, handle=None, observe=False, check=no_cancel):
        self.ensure(renew=observe, check=check)
        target = self.target(handle)
        frame = target["capture"].frame(check)
        with self.lock:
            if self.target(target["handle"]) is not target:
                raise SessionError("target-changed", "The captured screen source changed")
            geometry = (frame["width"], frame["height"])
            if target["observed"] and target["observed"]["pixels"] != geometry:
                # A changed stream may also have new compositor coordinates.
                # Obtain a new portal selection rather than guessing its scale.
                self.invalidate()
                raise SessionError("target-changed", "The screen stream geometry changed; select and observe its source again")
            logical = target["logical"]
            bounds = {"x": 0, "y": 0, "width": logical[0] if logical else geometry[0],
                      "height": logical[1] if logical else geometry[1]}
            if observe:
                target["observed"] = {"pixels": geometry, "bounds": bounds}
            return {"mime": "image/png", "base64": base64.b64encode(frame["png"]).decode("ascii"),
                    "bounds": bounds, "capturedAt": frame["capturedAt"]}, target

    def validate(self, target, bounds=None, require_observed=True):
        with self.lock:
            if self.target(target["handle"]) is not target:
                raise SessionError("target-changed", "The captured screen source changed")
            observed = target["observed"]
            if require_observed and not observed:
                raise SessionError("target-changed", "Observe the authorized screen before sending input")
            if bounds is not None and (not observed or bounds != observed["bounds"]):
                raise SessionError("target-changed", "The input coordinates do not match the captured screen")
            if observed:
                geometry = target["capture"].geometry()
                if geometry is not None and tuple(geometry) != observed["pixels"]:
                    self.invalidate()
                    raise SessionError("target-changed", "The captured screen geometry changed; observe again")

    def notify(self, target, method, *args):
        with self.lock:
            self.validate(target, require_observed=False)
            device = 1 if method.startswith("Keyboard") else 2
            if self.transport != "dbus" or not self.devices & device:
                raise SessionError("input-rejected", "The portal did not authorize this input device")
            tracked = (method, args[0]) if method in ("PointerButton", "KeyboardKeysym") else None
            if tracked and args[1]:
                # A lost down-event reply may still have affected the portal's
                # virtual device. Keep it in the original release set.
                self.held.add(tracked)
            if method == "PointerMotionAbsolute":
                if target["logical"] is None:
                    raise SessionError("unsupported", "The portal did not report the logical screen size required for coordinate input")
                self.backend.notify(self.session, method, target["node"], *args)
            else:
                self.backend.notify(self.session, method, *args)
            if tracked and not args[1]:
                self.held.discard(tracked)

    def release_input(self):
        with self.lock:
            if self.session is None:
                if self.held:
                    raise SessionError("connection-lost", "The original input session is unavailable; release is unconfirmed", "unknown")
                return
            # A successful API reply is the release evidence. Retain any failed
            # release in the owned set, so a later drain can retry it.
            for method, code in tuple(self.held):
                self.backend.notify(self.session, method, code, 0)
                self.held.discard((method, code))
