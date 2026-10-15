"""RemoteDesktop/ScreenCast driver; no X11 or AT-SPI coordinate synthesis."""
import math
import os
import subprocess
import threading
import time
from portal_session import PortalSession, SessionError

ACTIVE_REQUEST_ID = None
SESSION = None
BACKEND = None
INITIALIZATION = threading.Lock()
STOPPING = threading.Event()
PENDING_BROWSER_RELEASE = None
LAST_INPUT = 0.0
CANCEL_DIR = os.environ.get("VARIN_DRIVER_CANCEL_DIR")
CancelledError = SessionError


def check_shutdown():
    if STOPPING.is_set():
        raise SessionError("cancelled", "The desktop helper is stopping")


def check_cancel():
    check_shutdown()
    if CANCEL_DIR and ACTIVE_REQUEST_ID and os.path.exists(os.path.join(CANCEL_DIR, ACTIVE_REQUEST_ID + ".cancel")):
        raise SessionError("cancelled", "The computer operation was cancelled")


def owner():
    global SESSION, BACKEND
    with INITIALIZATION:
        if SESSION is None:
            try:
                from portal_backend import PortalBackend
                BACKEND = PortalBackend()
            except (ImportError, ValueError) as error:
                raise SessionError("unsupported", "Wayland capture requires Python GObject, GStreamer introspection and the PipeWire/PNG plugins") from error
            SESSION = PortalSession(BACKEND)
        return SESSION


def release_input():
    global PENDING_BROWSER_RELEASE
    if SESSION:
        SESSION.release_input()
    if PENDING_BROWSER_RELEASE:
        import bridge_worker
        result = bridge_worker.run("browser", PENDING_BROWSER_RELEASE, lambda _progress: None)
        if not result.get("ok"):
            raise SessionError("connection-lost", "The browser did not confirm release of its input", "unknown")
        PENDING_BROWSER_RELEASE = None


def dispose():
    if SESSION:
        SESSION.close()
    if BACKEND:
        BACKEND.dispose()


def require_desktop_session():
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS") or not os.environ.get("WAYLAND_DISPLAY"):
        raise SessionError("target-unavailable", "Wayland Computer Use must run inside the user's graphical session")


def capabilities():
    try:
        session = owner()
        available = session.backend.capabilities()
        with session.lock:
            active = session.state == "active"
            pointer = active and bool(session.devices & 2) and any(target["logical"] for target in session.streams.values())
            keyboard = active and bool(session.devices & 1)
            state = session.state
        return {"platform": "linux", "driver": "linux-portal", "driverVersion": "1",
                "observeTree": False, "elementAction": False, "screenshot": active,
                "coordinateInput": pointer, "textInput": keyboard, "drag": pointer,
                "multiWindow": True, "interruptibleInput": True, "occludedCapture": True,
                "sessionType": "wayland", "status": "ready" if active else "unprobed",
                "authorization": state, "inputTransport": session.transport,
                "availableDevices": available["devices"],
                **({} if active else {"detail": "Observe Shared desktop or open the viewer to request screen and input authorization"})}
    except Exception:
        return {"platform": "linux", "driver": "linux-portal", "driverVersion": "1",
                "observeTree": False, "elementAction": False, "screenshot": False,
                "coordinateInput": False, "textInput": False, "drag": False,
                "sessionType": "wayland", "status": "unavailable",
                "detail": "The session bus, desktop portals or GStreamer PipeWire capture dependencies are unavailable"}


def windows(session):
    return [{"handle": target["handle"], "title": "Shared desktop", "visible": True,
             **({"bounds": target["observed"]["bounds"]} if target["observed"] else {})}
            for target in session.streams.values()] if session.state == "active" else []


def snapshot(operation):
    remaining = 0.12 - (time.monotonic() - LAST_INPUT)
    if remaining > 0:
        time.sleep(remaining)
    check_cancel()
    if str(operation.get("app", "")).lower() not in ("", "0", "desktop", "screen", "shared desktop"):
        # Portal streams do not identify arbitrary AT-SPI windows. Never attach
        # that tree or its window-relative coordinates to an unrelated stream.
        raise SessionError("unsupported", "Observe Shared desktop; the portal does not establish an accessibility-window identity for this source")
    session = owner()
    frame, target = session.frame(operation.get("window"), observe=True, check=check_cancel)
    result = {"app": {"name": "Shared desktop", "pid": 0, "windowTitle": "Shared desktop"},
              "windowTitle": "Shared desktop", "windowHandle": target["handle"],
              "windows": windows(session), "windowBounds": frame["bounds"],
              "treeLines": ["The authorized portal screen has no verified accessibility-tree mapping."],
              "elements": [], "capturedAt": frame["capturedAt"]}
    if operation.get("screenshot"):
        result["screenshotPngBase64"] = frame["base64"]
        result["screenshotSource"] = "screen"
    return result


KEYS = {"enter": 0xff0d, "return": 0xff0d, "tab": 0xff09, "escape": 0xff1b, "esc": 0xff1b,
        "backspace": 0xff08, "delete": 0xffff, "space": 0x20, "left": 0xff51, "up": 0xff52,
        "right": 0xff53, "down": 0xff54, "home": 0xff50, "end": 0xff57,
        "pageup": 0xff55, "pagedown": 0xff56, "shift": 0xffe1, "ctrl": 0xffe3,
        "control": 0xffe3, "alt": 0xffe9, "super": 0xffeb, "meta": 0xffeb}
KEYS.update({"f" + str(i): 0xffbd + i for i in range(1, 36)})


def keysym(value):
    if value.lower() in KEYS:
        return KEYS[value.lower()]
    if len(value) == 1:
        code = ord(value)
        return code if code <= 0xff else 0x01000000 | code
    raise SessionError("unsupported", "The requested key name is not supported")


def input_operation(operation, emit):
    session = owner()
    target = session.target(operation.get("window"))
    human = operation["tool"] == "inject_input"
    session.validate(target, operation.get("expected_bounds"), require_observed=not human)
    if not human and str(operation.get("app", "")).lower() not in ("0", "shared desktop", "desktop", "screen"):
        raise SessionError("target-changed", "Input is not bound to the authorized screen target")
    if operation.get("element") or operation.get("input") == "app_post" or operation.get("click_method") in ("accessibility", "app_post"):
        raise SessionError("unsupported", "The portal screen has no verified semantic element target")
    tool = operation["tool"]
    kind = operation.get("kind") if human else {"click": "click", "drag": "drag", "scroll": "scroll",
        "type_text": "text", "press_key": "key"}.get(tool)
    if kind is None:
        raise SessionError("unsupported", "The portal does not support this semantic operation")
    events = 0
    def send(method, *args):
        global LAST_INPUT
        nonlocal events
        check_cancel()
        session.validate(target, operation.get("expected_bounds"), require_observed=not human)
        session.notify(target, method, *args)
        LAST_INPUT = time.monotonic()
        events += 1
    def point(x, y):
        if target["logical"] is None or any(not isinstance(v, (float, int)) or not math.isfinite(v) for v in (x, y)):
            raise SessionError("unsupported", "Coordinate input requires a known portal logical size and finite coordinates")
        width, height = target["logical"]
        if not 0 <= x < width or not 0 <= y < height:
            raise SessionError("input-rejected", "The input point is outside the authorized screen")
        return float(x), float(y)
    def move(x, y):
        send("PointerMotionAbsolute", *point(x, y))
    button_name = operation.get("button" if human else "mouse_button", "left")
    if button_name not in ("left", "right", "middle"):
        raise SessionError("input-rejected", "The requested pointer button is invalid")
    button = {"left": 0x110, "right": 0x111, "middle": 0x112}[button_name]
    feedback = bool(operation.get("visual_feedback"))
    mechanism = "keyboard" if kind in ("text", "key") else "pointer"
    if feedback:
        progress = {"type": "gesture", "phase": "target", "mechanism": mechanism}
        if kind in ("click", "move", "down", "up", "scroll"):
            progress["point"] = dict(zip(("x", "y"), point(operation.get("x"), operation.get("y"))))
        if kind == "drag":
            progress["point"] = dict(zip(("x", "y"), point(operation.get("from_x"), operation.get("from_y"))))
            progress["to"] = dict(zip(("x", "y"), point(operation.get("to_x"), operation.get("to_y"))))
        emit(operation.get("id"), progress)
    try:
        if kind in ("click", "move", "down", "up"):
            move(operation.get("x"), operation.get("y"))
            if kind == "click":
                count = operation.get("count" if human else "click_count", 1)
                if not isinstance(count, int) or count < 1:
                    raise SessionError("input-rejected", "Click count must be a positive integer")
                for _ in range(count):
                    send("PointerButton", button, 1)
                    send("PointerButton", button, 0)
            elif kind != "move":
                send("PointerButton", button, int(kind == "down"))
        elif kind == "drag":
            start = point(operation.get("from_x"), operation.get("from_y"))
            finish = point(operation.get("to_x"), operation.get("to_y"))
            move(*start)
            send("PointerButton", button, 1)
            # Interpolate at the display cadence over a normal drag gesture.
            for step in range(1, 19):
                move(start[0] + (finish[0] - start[0]) * step / 18,
                     start[1] + (finish[1] - start[1]) * step / 18)
                time.sleep(1 / 60)
            send("PointerButton", button, 0)
        elif kind == "scroll":
            if operation.get("x") is not None:
                move(operation["x"], operation["y"])
            direction = operation.get("direction", "down")
            pages = operation.get("pages", 1)
            if direction not in ("up", "down", "left", "right") or not isinstance(pages, (int, float)) or not math.isfinite(pages) or pages <= 0:
                raise SessionError("input-rejected", "Scroll direction and distance are invalid")
            logical = target["logical"]
            if not logical:
                raise SessionError("unsupported", "The portal did not report a logical screen size")
            distance = pages * logical[0 if direction in ("left", "right") else 1]
            for index in range(math.ceil(distance / 100)):
                delta = min(100, distance - index * 100) * (-1 if direction in ("up", "left") else 1)
                send("PointerAxis", delta if direction in ("left", "right") else 0.0,
                     delta if direction in ("up", "down") else 0.0)
        elif kind == "text":
            text = operation.get("text", "")
            if not isinstance(text, str):
                raise SessionError("input-rejected", "Text input must be a string")
            for character in text:
                key = keysym("enter" if character == "\n" else "tab" if character == "\t" else character)
                send("KeyboardKeysym", key, 1)
                send("KeyboardKeysym", key, 0)
        elif kind == "key":
            parts = str(operation.get("key", "")).split("+")
            chord = [keysym(part.strip()) for part in parts]
            for key in chord:
                send("KeyboardKeysym", key, 1)
            for key in reversed(chord):
                send("KeyboardKeysym", key, 0)
        else:
            raise SessionError("unsupported", "The requested input operation is not supported")
        if feedback:
            emit(operation.get("id"), {"type": "gesture", "phase": "dispatched", "mechanism": mechanism})
        return {"ok": True, "receipt": {"effect": "dispatched", "dispatchedEvents": events}}
    except SessionError as error:
        return error.response(events)
    except Exception:
        return SessionError("connection-lost", "The portal did not confirm the input event; observe before retrying", "unknown").response(events)


def perform_operation(operation, emit=lambda *_args: None):
    global PENDING_BROWSER_RELEASE
    tool = operation.get("tool")
    if tool == "ping":
        return {"ok": True}
    if tool == "capabilities":
        return {"ok": True, "capabilities": capabilities()}
    if tool == "release_input":
        release_input()
        return {"ok": True}
    if tool == "capture_frame":
        # Viewer capture is independent of ACTIVE_REQUEST_ID and job cancellation.
        frame, _target = owner().frame(check=check_shutdown)
        return {"ok": True, "frame": frame}
    if tool == "list_apps":
        return {"ok": True, "apps": [{"name": "Shared desktop", "pid": 0, "windows": windows(owner())}]}
    if tool == "get_app_state":
        return {"ok": True, "snapshot": snapshot(operation)}
    if tool in ("browser", "office"):
        import bridge_worker
        act = operation.get("act") or {}
        if tool == "browser" and act.get("kind") == "click":
            PENDING_BROWSER_RELEASE = {key: operation[key] for key in ("tab", "profile", "cdp_port") if key in operation}
            PENDING_BROWSER_RELEASE.update({"op": "act", "act": {"kind": "release", "x": act.get("x", 0), "y": act.get("y", 0)}})
        result = bridge_worker.run(tool, operation, lambda _progress: check_cancel())
        if tool == "browser" and result.get("ok") and act.get("kind") == "click":
            PENDING_BROWSER_RELEASE = None
        return result
    if tool == "open":
        values = [operation.get(key) for key in ("url", "path", "command") if operation.get(key)]
        args = operation.get("args", [])
        if len(values) != 1 or not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise SessionError("input-rejected", "Open requires exactly one URL, path or command and string arguments")
        check_cancel()
        argv = [values[0], *args] if operation.get("command") else ["xdg-open", values[0]]
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        return {"ok": True, "pid": process.pid}
    result = input_operation(operation, emit)
    if result["ok"] and operation.get("return_state", "none") != "none":
        try:
            result["snapshot"] = snapshot(dict(operation, screenshot=operation["return_state"] == "screenshot"))
        except Exception:
            result["text"] = "Input was dispatched; a new observation is needed before the next action."
    return result
