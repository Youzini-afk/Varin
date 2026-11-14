#!/usr/bin/env python3
# Varin Computer Use — Linux driver runtime library.
#
# Adapted from open-codex-computer-use (MIT License, baseline 51f3a59):
#   apps/OpenComputerUseLinux/runtime.py
# The original spawned a python interpreter per action; driver-host.py keeps
# this module resident and feeds it one JSON operation per request. Adds the
# `capabilities` and `release_input` operations and a `screenshot` toggle on
# observations; the desktop-session requirement is enforced once at host
# startup instead of per call.

import base64
import json
import math
import os
import subprocess
import sys
import time
import traceback
import warnings
from datetime import datetime, timezone

PENDING_BROWSER_RELEASE = None
LAST_INPUT_TIMES = {}
SEMANTIC_TARGETS = None

warnings.filterwarnings("ignore", category=DeprecationWarning)

import gi

gi.require_version("Atspi", "2.0")

try:
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
except (ImportError, ValueError):
    Gdk = None

from gi.repository import Atspi


MAX_ELEMENTS = 1200
MAX_DEPTH = 64
DEFAULT_TEXT_LIMIT = 500

# ---------------------------------------------------------------------------
# Cancellation (BC4.A): stdin is serialized, so a cancel request cannot be
# read while a long operation runs. The Host writes
# "$VARIN_DRIVER_CANCEL_DIR/<requestId>.cancel" instead; long loops poll that
# file at their checkpoints. driver-host.py sets ACTIVE_REQUEST_ID around
# each request.
# ---------------------------------------------------------------------------

CANCEL_DIR = os.environ.get("VARIN_DRIVER_CANCEL_DIR") or None
ACTIVE_REQUEST_ID = None
GESTURE_OPERATION = {}


def semantic_targets():
    global SEMANTIC_TARGETS
    if SEMANTIC_TARGETS is None:
        from semantic import AtspiTargets
        SEMANTIC_TARGETS = AtspiTargets(sys.modules[__name__])
    return SEMANTIC_TARGETS


def emit_gesture(phase, point=None, to=None, target=None):
    if not GESTURE_OPERATION.get('visual_feedback'):
        return
    payload = {'id': GESTURE_OPERATION.get('id'), 'type': 'gesture', 'phase': phase}
    tool = GESTURE_OPERATION.get('tool')
    payload['mechanism'] = 'semantic' if tool in ('set_value', 'perform_secondary_action') or GESTURE_OPERATION.get('click_method') == 'accessibility' else 'keyboard' if tool in ('type_text', 'press_key', 'scroll') else 'pointer'
    for key, value in (('point', point), ('to', to), ('target', target)):
        if value is not None:
            payload[key] = value
    try:
        sys.stdout.write(json.dumps(payload, separators=(',', ':')) + '\n')
        sys.stdout.flush()
    except Exception:
        pass


class CancelledError(Exception):
    """Raised at an operation checkpoint when the Host wrote a cancel flag."""


def cancel_requested():
    if not CANCEL_DIR or not ACTIVE_REQUEST_ID:
        return False
    return os.path.exists(os.path.join(CANCEL_DIR, "{}.cancel".format(ACTIVE_REQUEST_ID)))


def check_cancel(progress=""):
    if cancel_requested():
        detail = "cancelled" + (" ({})".format(progress) if progress else "")
        raise CancelledError(detail)


def on_wayland():
    return os.environ.get("XDG_SESSION_TYPE") == "wayland" or bool(os.environ.get("WAYLAND_DISPLAY"))


def frame(x, y, width, height):
    if width is None or height is None or width < 0 or height < 0:
        return None
    return {
        "x": float(x),
        "y": float(y),
        "width": float(width),
        "height": float(height),
    }


def safe(call, default=None):
    try:
        value = call()
        if value is None:
            return default
        return value
    except Exception:
        return default


def supports_interface(node, interface_name):
    interfaces = safe(lambda: node.get_interfaces(), [])
    expected = str(interface_name).casefold()
    return any(str(interface).casefold() == expected for interface in interfaces)


def require_desktop_session():
    missing = []
    if not os.environ.get("XDG_RUNTIME_DIR"):
        missing.append("XDG_RUNTIME_DIR")
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        missing.append("DBUS_SESSION_BUS_ADDRESS")
    if missing:
        raise RuntimeError(
            "Linux runtime requires an active desktop session; missing "
            + ", ".join(missing)
        )


def desktop():
    return Atspi.get_desktop(0)


def child_count(node):
    return int(safe(node.get_child_count, 0) or 0)


def child_at(node, index):
    return safe(lambda: node.get_child_at_index(index))


def node_name(node):
    return str(safe(node.get_name, "") or "")


def limit_text(value, text_limit=DEFAULT_TEXT_LIMIT):
    text = str(value or "")
    if text_limit is None:
        return text
    if len(text) > text_limit:
        return text[:text_limit] + "..."
    return text


def node_role(node):
    return str(safe(node.get_role_name, "") or "")


def node_pid(node):
    value = safe(node.get_process_id, 0)
    try:
        return int(value or 0)
    except Exception:
        return 0


def state_contains(node, state):
    state_set = safe(node.get_state_set)
    if state_set is None:
        return False
    return bool(safe(lambda: state_set.contains(state), False))


def extents(node):
    component = safe(node.get_component_iface)
    if component is None:
        return None
    rect = safe(lambda: Atspi.Component.get_extents(component, Atspi.CoordType.SCREEN))
    if (
        rect is None
        or rect.width <= 0
        or rect.height <= 0
        or rect.width > 100000
        or rect.height > 100000
    ):
        return None
    return frame(rect.x, rect.y, rect.width, rect.height)


def relative_frame(node, window_bounds):
    bounds = extents(node)
    if bounds is None:
        return None
    if window_bounds is None:
        return bounds
    return frame(
        bounds["x"] - window_bounds["x"],
        bounds["y"] - window_bounds["y"],
        bounds["width"],
        bounds["height"],
    )


def iter_apps():
    root = desktop()
    if root is None:
        raise RuntimeError("The AT-SPI desktop is unavailable")
    apps = []
    for index in range(root.get_child_count()):
        check_cancel("reading the accessibility application inventory")
        app = root.get_child_at_index(index)
        if app is None:
            raise RuntimeError("The AT-SPI application inventory is incomplete")
        if app.get_name():
            apps.append(app)
    return apps


def app_windows(app):
    windows = []
    for index in range(child_count(app)):
        child = child_at(app, index)
        if child is None:
            continue
        role = node_role(child).lower()
        bounds = extents(child)
        if role in {"frame", "window", "dialog", "alert"} or bounds is not None:
            windows.append((index, child))
    return windows


def main_window(app):
    windows = app_windows(app)
    if not windows:
        raise RuntimeError(
            "No top-level AT-SPI window is available for " + node_name(app)
        )
    for index, window in windows:
        if state_contains(window, Atspi.StateType.ACTIVE):
            return index, window
    for index, window in windows:
        if state_contains(window, Atspi.StateType.SHOWING):
            return index, window
    return windows[0]


def select_window(app, selector):
    """Pick one of the app's top-level windows (BC4.B). selector is the
    AT-SPI child index the windows list reports as `handle`, or a window
    title; absent → the active/showing heuristic."""
    windows = app_windows(app)
    if not windows:
        raise RuntimeError(
            "No top-level AT-SPI window is available for " + node_name(app)
        )
    if selector is None:
        return main_window(app)
    if isinstance(selector, bool):
        raise RuntimeError("Invalid window selector")
    if isinstance(selector, (int, float)):
        wanted = int(selector)
        for index, window in windows:
            if index == wanted:
                return index, window
        raise RuntimeError(
            "Window {} is not one of the app's windows; list them again".format(wanted)
        )
    title = str(selector).strip().lower()
    for index, window in windows:
        if node_name(window).strip().lower() == title:
            return index, window
    for index, window in windows:
        if title and title in node_name(window).lower():
            return index, window
    raise RuntimeError('windowNotFound("{}")'.format(selector))


def window_descriptors(app, selected_index=None):
    """The app's top-level windows as reported windows; `handle` is the
    AT-SPI child index — Linux has no stable cross-process window id."""
    descriptors = []
    for index, window in app_windows(app):
        bounds = extents(window)
        descriptors.append({
            "handle": int(index),
            "title": node_name(window) or None,
            "bounds": bounds,
            "visible": state_contains(window, Atspi.StateType.SHOWING),
            "minimized": state_contains(window, Atspi.StateType.ICONIFIED),
            "main": index == selected_index if selected_index is not None else False,
        })
    return descriptors


def matches_query(app, query):
    normalized = query.strip().lower()
    if not normalized:
        return False
    if normalized.isdigit() and node_pid(app) == int(normalized):
        return True
    app_name = node_name(app).lower()
    if app_name == normalized or normalized in app_name:
        return True
    for _, window in app_windows(app):
        title = node_name(window).lower()
        if title == normalized or normalized in title:
            return True
    return False


def resolve_app(query):
    for app in iter_apps():
        if matches_query(app, query):
            return app
    raise RuntimeError('appNotFound("{}")'.format(query))


def action_names(node):
    names = []
    count = int(safe(node.get_n_actions, 0) or 0)
    for index in range(count):
        name = str(safe(lambda i=index: node.get_action_name(i), "") or "")
        description = str(
            safe(lambda i=index: node.get_action_description(i), "") or ""
        )
        label = name or description
        if label and label not in names:
            names.append(label)
    return names


def accessible_id(node):
    return str(safe(node.get_accessible_id, "") or "")


def text_value(node, text_limit=DEFAULT_TEXT_LIMIT):
    if not supports_interface(node, "Text"):
        return ""
    text_iface = safe(node.get_text_iface)
    if text_iface is None:
        return ""
    count = int(safe(lambda: Atspi.Text.get_character_count(text_iface), 0) or 0)
    if count <= 0:
        return ""
    end_offset = count if text_limit is None else min(count, text_limit + 1)
    value = str(safe(lambda: Atspi.Text.get_text(text_iface, 0, end_offset), "") or "")
    return limit_text(value, text_limit=text_limit)


def numeric_value(node):
    value_iface = safe(node.get_value_iface)
    if value_iface is None:
        return ""
    current = safe(lambda: Atspi.Value.get_current_value(value_iface))
    if current is None:
        return ""
    return str(current)


def protected_value(node):
    if node_role(node).lower() == "password text":
        return True
    protected = getattr(Atspi.StateType, "PROTECTED", None)
    return protected is not None and state_contains(node, protected)


def element_value(node, text_limit=DEFAULT_TEXT_LIMIT):
    if protected_value(node):
        return ""
    return text_value(node, text_limit=text_limit) or numeric_value(node)


def positive_int(value, fallback):
    if isinstance(value, bool):
        return fallback
    if isinstance(value, float) and not value.is_integer():
        return fallback
    try:
        integer = int(value)
    except (TypeError, ValueError):
        return fallback
    return integer if integer > 0 else fallback


def parse_text_limit(value, fallback=DEFAULT_TEXT_LIMIT):
    if isinstance(value, str) and value.lower() == "max":
        return None
    return positive_int(value, fallback)


def record_for(node, index, path, window_bounds, text_limit=DEFAULT_TEXT_LIMIT):
    bounds = relative_frame(node, window_bounds)
    role = node_role(node)
    return {
        "index": index,
        "runtimeId": path[:],
        "automationId": accessible_id(node),
        "name": limit_text(node_name(node), text_limit=text_limit),
        "controlType": role,
        "localizedControlType": role,
        "className": str(safe(node.get_toolkit_name, "") or ""),
        "value": element_value(node, text_limit=text_limit),
        "nativeWindowHandle": 0,
        "frame": bounds,
        "actions": action_names(node),
    }


def capture_window_png(bounds):
    if bounds is None:
        return None
    if on_wayland():
        # Screenshot portal chooses its own screen/window/area. Cropping that
        # image with AT-SPI window coordinates could silently show another app.
        return None
    if Gdk is None:
        return None
    try:
        screen = Gdk.Screen.get_default()
        if screen is None:
            return None
        root = screen.get_root_window()
        pixbuf = Gdk.pixbuf_get_from_window(
            root,
            int(round(bounds["x"])),
            int(round(bounds["y"])),
            max(1, int(round(bounds["width"]))),
            max(1, int(round(bounds["height"]))),
        )
        if pixbuf is None:
            return None
        if pixbuf_looks_black(pixbuf):
            return None
        ok, data = pixbuf.save_to_bufferv("png", [], [])
        if not ok:
            return None
        return base64.b64encode(bytes(data)).decode("ascii")
    except Exception:
        return None


def pixbuf_looks_black(pixbuf):
    try:
        pixels = pixbuf.get_pixels()
        channels = pixbuf.get_n_channels()
        rowstride = pixbuf.get_rowstride()
        width = pixbuf.get_width()
        height = pixbuf.get_height()
        if width <= 0 or height <= 0 or channels < 3:
            return True
        step_x = max(1, width // 16)
        step_y = max(1, height // 16)
        checked = 0
        for y in range(0, height, step_y):
            row = y * rowstride
            for x in range(0, width, step_x):
                offset = row + (x * channels)
                if (
                    pixels[offset] > 3
                    or pixels[offset + 1] > 3
                    or pixels[offset + 2] > 3
                ):
                    return False
                checked += 1
        return checked > 0
    except Exception:
        return False


def build_snapshot(query, text_limit=DEFAULT_TEXT_LIMIT, max_tree_nodes=MAX_ELEMENTS, max_tree_depth=MAX_DEPTH,
                   screenshot=True, window=None, within=None, platform_target=None, view=None):
    operation = {"app": query, "window": window, "text_limit": "max" if text_limit is None else text_limit,
                 "max_tree_nodes": max_tree_nodes, "max_tree_depth": max_tree_depth,
                 "screenshot": screenshot, "within": within, "platform_target": platform_target, "view": view}
    app, _index, _window, _token = semantic_targets().window(operation)
    previous_input = LAST_INPUT_TIMES.pop(node_pid(app), None)
    if previous_input is not None:
        remaining = 0.12 - (time.monotonic() - previous_input)
        if remaining > 0:
            time.sleep(remaining)
    operation["platform_target"] = _token
    return semantic_targets().snapshot(operation, resolved=(app, _index, _window, _token))["snapshot"]


def list_apps_text():
    lines = []
    for app in sorted(iter_apps(), key=lambda item: (node_name(item).lower(), node_pid(item))):
        windows = app_windows(app)
        if not windows:
            continue
        title = node_name(windows[0][1]) or "untitled"
        name = node_name(app)
        lines.append(
            "{} -- {} [running, pid={}, window={}]".format(
                name, name, node_pid(app), title
            )
        )
    return "\n".join(lines)


def preferred_action_index(node):
    preferred_exact = {
        "click",
        "press",
        "activate",
        "default.activate",
        "invoke",
        "select",
        "toggle",
        "open",
    }
    count = int(safe(node.get_n_actions, 0) or 0)
    fallback = None
    for index in range(count):
        name = str(safe(lambda i=index: node.get_action_name(i), "") or "")
        description = str(safe(lambda i=index: node.get_action_description(i), "") or "")
        lower = (name or description).lower()
        if lower in preferred_exact:
            return index
        if fallback is None and (
            "activate" in lower or "click" in lower or "press" in lower
        ):
            fallback = index
    return fallback


def screen_point(window_bounds, element=None, x=None, y=None):
    if element is not None:
        f = element.get("frame")
        if f is not None and window_bounds is not None:
            return (
                window_bounds["x"] + f["x"] + f["width"] / 2,
                window_bounds["y"] + f["y"] + f["height"] / 2,
            )
    if x is None or y is None or window_bounds is None:
        raise RuntimeError("coordinate action requires window bounds and x/y")
    return window_bounds["x"] + float(x), window_bounds["y"] + float(y)


def mouse_button_events(button):
    normalized = (button or "left").lower()
    if normalized == "right":
        return "b3p", "b3r"
    if normalized == "middle":
        return "b2p", "b2r"
    return "b1p", "b1r"


def send_mouse_click(x, y, button, count):
    down, up = mouse_button_events(button)
    repeat = max(1, int(count or 1))
    for i in range(repeat):
        check_cancel("sent {} of {} clicks".format(i, repeat))
        emit_mouse(int(round(x)), int(round(y)), "abs")
        emit_mouse(int(round(x)), int(round(y)), down)
        time.sleep(0.035)
        emit_mouse(int(round(x)), int(round(y)), up)
        time.sleep(0.05)


def send_drag(from_x, from_y, to_x, to_y):
    emit_mouse(int(round(from_x)), int(round(from_y)), "abs")
    emit_mouse(int(round(from_x)), int(round(from_y)), "b1p")
    steps = 12
    for step in range(1, steps + 1):
        check_cancel("dragged {} of {} steps; the button is still held".format(step, steps))
        x = from_x + ((to_x - from_x) * step / steps)
        y = from_y + ((to_y - from_y) * step / steps)
        emit_mouse(int(round(x)), int(round(y)), "abs")
        emit_gesture('dispatched', {'x': x, 'y': y})
        time.sleep(0.02)
    emit_mouse(int(round(to_x)), int(round(to_y)), "b1r")


KEY_ALIASES = {
    "return": "Return",
    "enter": "Return",
    "tab": "Tab",
    "escape": "Escape",
    "esc": "Escape",
    "backspace": "BackSpace",
    "back_space": "BackSpace",
    "delete": "Delete",
    "space": "space",
    "left": "Left",
    "up": "Up",
    "right": "Right",
    "down": "Down",
    "home": "Home",
    "end": "End",
    "page_up": "Page_Up",
    "prior": "Page_Up",
    "page_down": "Page_Down",
    "next": "Page_Down",
}

MODIFIER_KEYS = {
    "ctrl": "Control_L",
    "control": "Control_L",
    "shift": "Shift_L",
    "alt": "Alt_L",
    "super": "Super_L",
    "win": "Super_L",
    "cmd": "Super_L",
}


def keyval(name):
    if Gdk is not None:
        value = Gdk.keyval_from_name(name)
        if value:
            return int(value)
    if len(name) == 1:
        return ord(name)
    raise RuntimeError("Unsupported key: " + name)


def send_key(key):
    parts = [part for part in str(key).split("+") if part]
    if not parts:
        raise RuntimeError("Unsupported key: " + str(key))
    main = parts[-1]
    modifiers = parts[:-1]
    pressed = []
    for modifier in modifiers:
        name = MODIFIER_KEYS.get(modifier.lower())
        if name is None:
            continue
        value = keyval(name)
        emit_key(value, None, Atspi.KeySynthType.PRESS)
        pressed.append(value)
    normalized = KEY_ALIASES.get(main.lower(), main)
    if len(normalized) == 1:
        emit_key(0, normalized, Atspi.KeySynthType.STRING)
    else:
        emit_key(
            keyval(normalized), None, Atspi.KeySynthType.PRESSRELEASE
        )
    for value in reversed(pressed):
        emit_key(value, None, Atspi.KeySynthType.RELEASE)


def send_text(text):
    emit_key(0, str(text), Atspi.KeySynthType.STRING)


def scroll_element(direction, pages):
    key = "Page_Down"
    if direction == "up":
        key = "Page_Up"
    elif direction == "left":
        key = "Left"
    elif direction == "right":
        key = "Right"
    repeat = max(1, int(math.ceil(float(pages or 1))))
    for i in range(repeat):
        check_cancel("scrolled {} of {} steps".format(i, repeat))
        send_key(key)
        time.sleep(0.04)


DRIVER_VERSION = "0.1.0"

held_buttons = set()
held_keys = set()


def emit_mouse(x, y, event):
    if not Atspi.generate_mouse_event(x, y, event):
        raise RuntimeError("Desktop did not accept pointer input")
    if event in ("b1p", "b2p", "b3p"):
        held_buttons.add(event[:2])
    elif event in ("b1r", "b2r", "b3r"):
        held_buttons.discard(event[:2])


def emit_key(value, text, kind):
    if not Atspi.generate_keyboard_event(value, text, kind):
        raise RuntimeError("Desktop did not accept keyboard input")
    if kind == Atspi.KeySynthType.PRESS:
        held_keys.add(value)
    elif kind == Atspi.KeySynthType.RELEASE:
        held_keys.discard(value)


def focus_window(window):
    if state_contains(window, Atspi.StateType.ACTIVE):
        return
    component = window.get_component_iface()
    if not component or not component.grab_focus() or not state_contains(window, Atspi.StateType.ACTIVE):
        raise RuntimeError("Could not activate the requested window for keyboard input")


def driver_capabilities():
    displays = []
    if Gdk is not None:
        try:
            display = Gdk.Display.get_default()
            if display is not None:
                monitor_count = safe(display.get_n_monitors, 0) or 0
                for index in range(monitor_count):
                    monitor = display.get_monitor(index)
                    if monitor is None:
                        continue
                    geometry = monitor.get_geometry()
                    displays.append(
                        {
                            "x": float(geometry.x),
                            "y": float(geometry.y),
                            "width": float(geometry.width),
                            "height": float(geometry.height),
                            "primary": bool(safe(monitor.is_primary, False)),
                        }
                    )
        except Exception:
            pass
    wayland = on_wayland()
    detail = (
        "Wayland needs a consented RemoteDesktop/ScreenCast session for reliable "
        "capture and pointer input; AT-SPI element actions may still work."
        if wayland else None
    )
    return {
        "platform": "linux",
        "driver": "linux-atspi",
        "driverVersion": DRIVER_VERSION,
        "applicationTools": {"browser": True, "office": True},
        "observeTree": True,
        "screenshot": not wayland and Gdk is not None,
        "elementAction": True,
        "semanticQuery": True,
        "semanticActions": ["set_checked", "set_expanded", "select", "scroll_into_view", "set_value"],
        "semanticEvents": "polling",
        "coordinateInput": not wayland,
        "textInput": True,
        "drag": not wayland,
        # AT-SPI enumerates each app's top-level windows; the handle is the
        # app's child index since Linux has no cross-process window id.
        "multiWindow": True,
        # Long operations poll the cancel side-channel at internal
        # checkpoints; a cancel lands mid-operation, not after it.
        "interruptibleInput": True,
        # X11 root reads do not produce occluded-window content.
        "occludedCapture": False,
        "sessionType": "wayland" if wayland else ("x11" if os.environ.get("DISPLAY") else "headless"),
        "displays": displays,
        "status": "ready",
        "detail": detail,
    }


def release_input():
    failed = 0
    for button in list(held_buttons):
        try:
            emit_mouse(0, 0, button + "r")
        except Exception:
            failed += 1
    for value in list(held_keys):
        try:
            emit_key(value, None, Atspi.KeySynthType.RELEASE)
        except Exception:
            failed += 1
    if failed:
        raise RuntimeError("Desktop did not confirm release of {} managed inputs".format(failed))


def capture_desktop_frame():
    """Whole-screen X11 frame for the viewer contract (BC5)."""
    if on_wayland():
        return None
    if Gdk is None:
        return None
    try:
        screen = Gdk.Screen.get_default()
        if screen is None:
            return None
        root = screen.get_root_window()
        width = int(screen.get_width())
        height = int(screen.get_height())
        pixbuf = Gdk.pixbuf_get_from_window(root, 0, 0, width, height)
        if pixbuf is None or pixbuf_looks_black(pixbuf):
            return None
        ok, data = pixbuf.save_to_bufferv("png", [], [])
        if not ok:
            return None
        return {
            "mime": "image/png",
            "base64": base64.b64encode(bytes(data)).decode("ascii"),
            "bounds": {"x": 0.0, "y": 0.0, "width": float(width), "height": float(height)},
            "capturedAt": datetime.now(timezone.utc).isoformat(),
        }
    except Exception:
        return None


def inject_human_input(operation):
    """Human-control input (BC5): absolute screen coordinates, no app/window
    binding. Ownership is enforced by the Host; the driver emits the input."""
    kind = str(operation.get("kind") or "")
    x = int(round(float(operation.get("x") or 0)))
    y = int(round(float(operation.get("y") or 0)))
    button = str(operation.get("button") or "left")
    if kind == "click":
        send_mouse_click(x, y, button, int(operation.get("count") or 1))
    elif kind == "down":
        down, _up = mouse_button_events(button)
        emit_mouse(x, y, "abs")
        emit_mouse(x, y, down)
    elif kind == "up":
        _down, up = mouse_button_events(button)
        emit_mouse(x, y, "abs")
        emit_mouse(x, y, up)
    elif kind == "move":
        emit_mouse(x, y, "abs")
    elif kind == "scroll":
        direction = str(operation.get("direction") or "down")
        steps = max(1, int(round(float(operation.get("pages") or 1) * 3)))
        horizontal = direction in ("left", "right")
        if horizontal:
            shift = keyval(MODIFIER_KEYS["shift"])
            emit_key(shift, None, Atspi.KeySynthType.PRESS)
        try:
            wheel = "b4p" if direction in ("up", "left") else "b5p"
            release = "b4r" if wheel == "b4p" else "b5r"
            for _ in range(steps):
                check_cancel("scrolled")
                emit_mouse(x, y, "abs")
                emit_mouse(x, y, wheel)
                emit_mouse(x, y, release)
        finally:
            if horizontal:
                emit_key(shift, None, Atspi.KeySynthType.RELEASE)
    elif kind == "key":
        send_key(str(operation.get("key") or ""))
    elif kind == "text":
        send_text(str(operation.get("text") or ""))
    else:
        raise RuntimeError('unsupportedHumanInput("{}")'.format(kind))


def open_target(operation):
    """Open a URL, file path or application inside this desktop session.

    The request targets this machine only: xdg-open and the spawned command
    resolve localhost and filesystem paths on the desktop, never on the
    caller's Host. The child is detached from the driver — it must outlive
    individual requests and belong to the user's session like any app they
    started themselves.
    """
    url = operation.get("url")
    path = operation.get("path")
    command = operation.get("command")
    provided = [value for value in (url, path, command) if value]
    if len(provided) != 1:
        raise RuntimeError('open requires exactly one of "url", "path" or "command"')
    args = operation.get("args")
    if args is not None and (not isinstance(args, list) or not all(isinstance(item, str) for item in args)):
        raise RuntimeError('"args" must be a list of strings')
    if command:
        argv = [str(command)] + [str(item) for item in (args or [])]
    else:
        argv = ["xdg-open", str(url or path)]
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"ok": True, "pid": proc.pid}


def perform_operation(operation):
    from semantic import SemanticError
    try:
        return _perform_operation(operation)
    except SemanticError as error:
        return error.response()


def _perform_operation(operation):
    global GESTURE_OPERATION
    GESTURE_OPERATION = operation
    global PENDING_BROWSER_RELEASE
    tool = operation.get("tool")
    if tool == "ping":
        return {"ok": True}
    if tool == "open":
        return open_target(operation)
    if tool == "capabilities":
        return {"ok": True, "capabilities": driver_capabilities()}
    if tool == "release_input":
        release_input()
        if PENDING_BROWSER_RELEASE:
            import bridge_worker
            result = bridge_worker.run("browser", PENDING_BROWSER_RELEASE, lambda _progress: None)
            if not result.get("ok"):
                return {"ok": False, "error": "Browser button release was not confirmed; input state remains unknown"}
            PENDING_BROWSER_RELEASE = None
        return {"ok": True}
    if tool == "capture_frame":
        frame = capture_desktop_frame()
        if frame is None:
            return {"ok": False, "error": "desktop capture produced no frame"}
        return {"ok": True, "frame": frame}
    if tool == "inject_input":
        inject_human_input(operation)
        return {"ok": True}
    if tool in ("browser", "office"):
        import bridge_worker
        act = operation.get("act") or {}
        if tool == "browser" and operation.get("op") == "act" and act.get("kind") == "click":
            PENDING_BROWSER_RELEASE = {key: operation[key] for key in ("tab", "profile", "cdp_port", "expectedInstanceId") if key in operation}
            PENDING_BROWSER_RELEASE.update({"op": "act", "act": {"kind": "release", "x": act.get("x", 0), "y": act.get("y", 0)}})
        try:
            result = bridge_worker.run(tool, operation, check_cancel)
            if tool == "browser" and result.get("ok") and act.get("kind") == "click":
                PENDING_BROWSER_RELEASE = None
            return result
        except CancelledError as exc:
            return {"ok": False, "cancelled": True, "outcome": "unknown", "error": str(exc)}
    if tool == "list_apps":
        apps = []
        for app in iter_apps():
            windows = app_windows(app)
            if not windows:
                continue
            apps.append({
                "name": node_name(app),
                "pid": node_pid(app),
                "windowTitle": node_name(windows[0][1]),
                "windows": window_descriptors(app),
            })
        return {"ok": True, "apps": apps}
    if tool == "release_elements":
        semantic_targets().release(operation.get("elements") or [])
        return {"ok": True}
    if tool == "query_elements":
        return semantic_targets().query(operation)
    if tool == "get_app_state":
        return {
            "ok": True,
            "snapshot": build_snapshot(
                operation.get("app", ""),
                text_limit=parse_text_limit(operation.get("text_limit"), DEFAULT_TEXT_LIMIT),
                max_tree_nodes=positive_int(operation.get("max_tree_nodes"), MAX_ELEMENTS),
                max_tree_depth=positive_int(operation.get("max_tree_depth"), MAX_DEPTH),
                screenshot=bool(operation.get("screenshot", True)),
                window=operation.get("window"),
                within=operation.get("within"),
                platform_target=operation.get("platform_target"),
                view=operation.get("view"),
            ),
        }

    from semantic import SemanticError
    targets = semantic_targets()
    app, window_index, window, window_token = targets.window(operation)
    check_cancel("resolved the target window")
    bounds = extents(window)
    element_record = operation.get("element")
    element = targets.element(element_record, window, window_token)
    if element is not None:
        element_record = {**element_record, "frame": relative_frame(element, bounds)}
    if operation.get("input") == "app_post":
        raise SemanticError("unsupported", "Background window messages are not supported on Linux")
    click_method = (operation.get("click_method") or "auto").lower()
    ordinary_click = operation.get("mouse_button", "left") == "left" and operation.get("click_count", 1) == 1
    use_semantic = tool in ("set_checked", "set_expanded", "select", "scroll_into_view", "set_value", "perform_secondary_action")
    if tool == "click":
        if click_method == "accessibility" and not ordinary_click:
            raise SemanticError("unsupported", "Accessibility click supports only a single primary-button action")
        use_semantic = click_method == "accessibility" or (click_method == "auto" and ordinary_click
            and element is not None and preferred_action_index(element) is not None)
    if use_semantic:
        GESTURE_OPERATION = dict(operation, click_method="accessibility")
        emit_gesture("target", target=extents(element) if element is not None else None)
        receipt = targets.perform(element, operation)
        if receipt["effect"] != "none":
            LAST_INPUT_TIMES[node_pid(app)] = time.monotonic()
            emit_gesture("dispatched")
        result = {"ok": True, "receipt": receipt}
        if operation.get("return_state", "none") != "none":
            try:
                result["snapshot"] = build_snapshot(operation.get("app", ""),
                    screenshot=operation["return_state"] == "screenshot", platform_target=window_token)
            except Exception:
                result["text"] = "The semantic action completed; post-action observation failed."
        return result
    if operation.get("expected_bounds") and (bounds is None or any(bounds[key] != operation["expected_bounds"][key] for key in ("x", "y", "width", "height"))):
        return {"ok": False, "rejected": True, "error": "Window geometry changed since the screenshot; observe again"}
    if operation.get('visual_feedback'):
        target = extents(element) if element is not None and tool != 'scroll' else bounds
        point, to = None, None
        if tool in ('click', 'perform_secondary_action') and (element is not None or operation.get('x') is not None):
            x, y = screen_point(bounds, element_record, operation.get('x'), operation.get('y'))
            point = {'x': x, 'y': y}
        elif tool == 'drag':
            x, y = screen_point(bounds, None, operation.get('from_x'), operation.get('from_y'))
            tx, ty = screen_point(bounds, None, operation.get('to_x'), operation.get('to_y'))
            point, to = {'x': x, 'y': y}, {'x': tx, 'y': ty}
        emit_gesture('target', point, to, target)
    if tool == "click":
        click_method = (operation.get("click_method") or "auto").lower()
        if click_method == "auto":
            click_method = "global"
        if click_method == "app_post":
            raise RuntimeError("click_method 'app_post' is not supported on Linux")
        elif click_method == "sky_click":
            raise RuntimeError("click_method 'sky_click' is not supported on Linux")
        elif click_method == "global":
            focus_window(window)
            x, y = screen_point(
                bounds,
                element_record,
                operation.get("x"),
                operation.get("y"),
            )
            send_mouse_click(
                x, y, operation.get("mouse_button", "left"), operation.get("click_count", 1)
            )
        else:
            raise RuntimeError("Invalid click_method '{}'".format(click_method))
    elif tool == "scroll":
        focus_window(window)
        scroll_element(operation.get("direction", "down"), operation.get("pages", 1))
    elif tool == "drag":
        focus_window(window)
        from_x, from_y = screen_point(
            bounds, None, operation.get("from_x"), operation.get("from_y")
        )
        to_x, to_y = screen_point(bounds, None, operation.get("to_x"), operation.get("to_y"))
        send_drag(from_x, from_y, to_x, to_y)
    elif tool == "type_text":
        focus_window(window)
        if element is not None:
            component = element.get_component_iface()
            if not component or not component.grab_focus() or not state_contains(element, Atspi.StateType.FOCUSED):
                return {"ok": False, "rejected": True, "receipt": {"effect": "none", "reason": {"code": "focus-changed", "message": "The selected control did not obtain keyboard focus"}, "recovery": "observe"}}
        send_text(operation.get("text", ""))
    elif tool == "press_key":
        focus_window(window)
        if element is not None:
            component = element.get_component_iface()
            if not component or not component.grab_focus() or not state_contains(element, Atspi.StateType.FOCUSED):
                return {"ok": False, "rejected": True, "receipt": {"effect": "none", "reason": {"code": "focus-changed", "message": "The selected control did not obtain keyboard focus"}, "recovery": "observe"}}
        send_key(operation.get("key", ""))
    else:
        raise RuntimeError('unsupportedTool("{}")'.format(tool))

    emit_gesture('dispatched')
    LAST_INPUT_TIMES[node_pid(app)] = time.monotonic()
    if operation.get("return_state", "none") == "none":
        return {"ok": True}
    try:
        return {
            "ok": True,
            "snapshot": build_snapshot(
                operation.get("app", ""),
                screenshot=operation.get("return_state") == "screenshot",
                window=operation.get("window"),
                within=operation.get("within"),
                platform_target=window_token,
                view=operation.get("view"),
            ),
        }
    except Exception:
        return {"ok": True, "text": "Input was dispatched; post-action observation failed. Observe again before deciding another action."}
