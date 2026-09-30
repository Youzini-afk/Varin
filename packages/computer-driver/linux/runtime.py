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
    apps = []
    for index in range(child_count(root)):
        app = child_at(root, index)
        if app is not None and node_name(app):
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


def element_value(node, text_limit=DEFAULT_TEXT_LIMIT):
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


def render_tree(root, window_bounds, root_path, text_limit=DEFAULT_TEXT_LIMIT, max_tree_nodes=MAX_ELEMENTS, max_tree_depth=MAX_DEPTH):
    records = []
    lines = []

    def visit(node, depth, path):
        if len(records) >= max_tree_nodes or depth > max_tree_depth or node is None:
            return
        check_cancel("walked {} of up to {} tree nodes".format(len(records), max_tree_nodes))
        index = len(records)
        record = record_for(node, index, path, window_bounds, text_limit=text_limit)
        records.append(record)

        role = record["localizedControlType"] or record["controlType"] or "element"
        title = record["name"] or record["automationId"] or ""
        value_segment = ""
        if record["value"] and record["value"] != title:
            safe_value = record["value"].replace("\r", "\\r").replace("\n", "\\n")
            value_segment = " Value: " + safe_value
        actions_segment = ""
        if record["actions"]:
            actions_segment = " Secondary Actions: " + ", ".join(record["actions"])
        frame_segment = ""
        if record["frame"] is not None:
            f = record["frame"]
            frame_segment = " Frame: {{x: {0}, y: {1}, width: {2}, height: {3}}}".format(
                round(f["x"]),
                round(f["y"]),
                round(f["width"]),
                round(f["height"]),
            )
        lines.append(
            ("\t" * (depth + 1))
            + "{} {} {}{}{}{}".format(
                index, role, title, value_segment, actions_segment, frame_segment
            ).rstrip()
        )

        for child_index in range(child_count(node)):
            child = child_at(node, child_index)
            visit(child, depth + 1, path + [child_index])

    visit(root, 0, root_path)
    return records, lines


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


def focused_summary(app_pid, text_limit=DEFAULT_TEXT_LIMIT):
    try:
        root = desktop()
        for app in iter_apps():
            if node_pid(app) != app_pid:
                continue
            _, win = main_window(app)
            focused = find_first(
                win, lambda node: state_contains(node, Atspi.StateType.FOCUSED)
            )
            if focused is None:
                return None
            role = node_role(focused)
            name = limit_text(node_name(focused), text_limit=text_limit)
            return (role + " " + name).strip()
    except CancelledError:
        raise
    except Exception:
        return None


def selected_text(app_pid, text_limit=DEFAULT_TEXT_LIMIT):
    try:
        for app in iter_apps():
            if node_pid(app) != app_pid:
                continue
            _, win = main_window(app)
            focused = find_first(
                win, lambda node: state_contains(node, Atspi.StateType.FOCUSED)
            )
            if focused is None or not supports_interface(focused, "Text"):
                return None
            text_iface = safe(focused.get_text_iface)
            selections = safe(lambda: Atspi.Text.get_text_selections(text_iface), [])
            if selections:
                selection = selections[0]
                end_offset = selection.end_offset
                if text_limit is not None:
                    end_offset = min(end_offset, selection.start_offset + text_limit + 1)
                value = Atspi.Text.get_text(
                    text_iface, selection.start_offset, end_offset
                )
                return limit_text(value, text_limit=text_limit)
    except CancelledError:
        raise
    except Exception:
        return None
    return None


def build_snapshot(query, text_limit=DEFAULT_TEXT_LIMIT, max_tree_nodes=MAX_ELEMENTS, max_tree_depth=MAX_DEPTH, screenshot=True, window=None):
    app = resolve_app(query)
    window_index, window_node = select_window(app, window)
    check_cancel("resolved the target window")
    bounds = extents(window_node)
    records, lines = render_tree(
        window_node,
        bounds,
        [window_index],
        text_limit=text_limit,
        max_tree_nodes=max_tree_nodes,
        max_tree_depth=max_tree_depth,
    )
    check_cancel("rendered the accessibility tree")
    pid = node_pid(app)
    return {
        "app": {
            "name": node_name(app),
            "bundleIdentifier": node_name(app),
            "pid": pid,
        },
        "windowTitle": limit_text(node_name(window_node), text_limit=text_limit),
        # The AT-SPI child index is this platform's window handle (no stable
        # cross-process id exists); it is valid until the window set changes.
        "windowHandle": int(window_index),
        "windows": window_descriptors(app, window_index),
        "windowBounds": bounds,
        "screenshotPngBase64": capture_window_png(bounds) if screenshot else None,
        "treeLines": lines,
        "focusedSummary": focused_summary(pid, text_limit=text_limit),
        "selectedText": selected_text(pid, text_limit=text_limit),
        "elements": records,
    }


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


def find_first(root, predicate):
    if root is None:
        return None
    if predicate(root):
        return root
    for index in range(child_count(root)):
        found = find_first(child_at(root, index), predicate)
        if found is not None:
            return found
    return None


def iter_all(root):
    items = []

    def visit(node):
        if node is None or len(items) >= MAX_ELEMENTS:
            return
        check_cancel("walked {} tree nodes".format(len(items)))
        items.append(node)
        for index in range(child_count(node)):
            visit(child_at(node, index))

    visit(root)
    return items


def resolve_path(app, path):
    if not path:
        return None
    node = app
    for index in path:
        node = child_at(node, int(index))
        if node is None:
            return None
    return node


def same_frame(record_frame, node_frame):
    if record_frame is None or node_frame is None:
        return False
    for key in ("x", "y", "width", "height"):
        if abs(float(record_frame.get(key, 0)) - float(node_frame.get(key, 0))) > 3:
            return False
    return True


def find_element(app, record, window_selector=None):
    if not record:
        return None
    node = resolve_path(app, record.get("runtimeId") or [])
    if node is not None and node_role(node) == record.get("controlType") and (
        accessible_id(node) == record.get("automationId") if record.get("automationId") else node_name(node) == record.get("name")
    ):
        return node

    _, window = select_window(app, window_selector)
    target_name = str(record.get("name") or "")
    target_id = str(record.get("automationId") or "")
    target_role = str(record.get("controlType") or "")
    window_bounds = extents(window)
    matches = []
    for candidate in iter_all(window):
        if target_id and accessible_id(candidate) == target_id:
            matches.append(candidate)
        elif target_name and node_name(candidate) == target_name and node_role(candidate) == target_role:
            matches.append(candidate)
    return matches[0] if len(matches) == 1 else None


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


def do_action_by_index(node, index):
    if index is None:
        return False
    return bool(safe(lambda: node.do_action(int(index)), False))


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


def find_editable_text(root):
    def is_editable(node):
        return supports_interface(node, "EditableText") and supports_interface(
            node, "Text"
        )

    return find_first(root, is_editable)


def insert_text(root, text):
    node = find_first(root, lambda candidate: state_contains(candidate, Atspi.StateType.FOCUSED)
                      and supports_interface(candidate, "EditableText"))
    if node is None:
        return False
    editable = safe(node.get_editable_text_iface)
    text_iface = safe(node.get_text_iface)
    if editable is None or text_iface is None:
        return False
    offset = int(safe(lambda: Atspi.Text.get_character_count(text_iface), 0) or 0)
    return bool(
        safe(
            lambda: Atspi.EditableText.insert_text(
                editable, offset, str(text), len(str(text))
            ),
            False,
        )
    )


def set_element_value(node, value):
    if node is not None and supports_interface(node, "EditableText"):
        editable = safe(node.get_editable_text_iface)
        if editable is not None:
            return bool(
                safe(
                    lambda: Atspi.EditableText.set_text_contents(editable, str(value)),
                    False,
                )
            )
    value_iface = safe(node.get_value_iface) if node is not None else None
    if value_iface is not None:
        try:
            return bool(Atspi.Value.set_current_value(value_iface, float(value)))
        except Exception:
            pass
    return False


def invoke_secondary_action(node, action):
    if node is None:
        raise RuntimeError("unknown element_index")
    normalized = str(action).lower()
    count = int(safe(node.get_n_actions, 0) or 0)
    for index in range(count):
        name = str(safe(lambda i=index: node.get_action_name(i), "") or "")
        description = str(safe(lambda i=index: node.get_action_description(i), "") or "")
        if normalized in {name.lower(), description.lower()}:
            if do_action_by_index(node, index):
                return
            break
    raise RuntimeError("{} is not a valid secondary action for element".format(action))


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
        "observeTree": True,
        "screenshot": not wayland and Gdk is not None,
        "elementAction": True,
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
            PENDING_BROWSER_RELEASE = {key: operation[key] for key in ("tab", "profile", "cdp_port") if key in operation}
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
            ),
        }

    app = resolve_app(operation.get("app", ""))
    window_index, window = select_window(app, operation.get("window"))
    check_cancel("resolved the target window")
    bounds = extents(window)
    element_record = operation.get("element")
    element = find_element(app, element_record, operation.get("window"))
    if element_record and element is None:
        raise RuntimeError("Observed element no longer exists or is ambiguous; observe again")
    if element is not None:
        element_record = {**element_record, "frame": relative_frame(element, bounds)}

    if tool == "click":
        click_method = (operation.get("click_method") or "auto").lower()
        if click_method == "accessibility":
            if element is None:
                raise RuntimeError("click_method 'accessibility' requires element_index")
            if operation.get("mouse_button", "left") != "left":
                raise RuntimeError(
                    "click_method 'accessibility' only supports mouse_button 'left'"
                )
            if not do_action_by_index(element, preferred_action_index(element)):
                raise RuntimeError(
                    "click_method 'accessibility' could not click the requested element"
                )
        elif click_method == "app_post":
            raise RuntimeError("click_method 'app_post' is not supported on Linux")
        elif click_method == "sky_click":
            raise RuntimeError("click_method 'sky_click' is not supported on Linux")
        elif click_method == "global":
            x, y = screen_point(
                bounds,
                element_record,
                operation.get("x"),
                operation.get("y"),
            )
            send_mouse_click(
                x, y, operation.get("mouse_button", "left"), operation.get("click_count", 1)
            )
        elif click_method == "auto":
            handled = False
            if element is not None and operation.get("mouse_button", "left") == "left":
                handled = do_action_by_index(element, preferred_action_index(element))
            if not handled:
                x, y = screen_point(
                    bounds,
                    element_record,
                    operation.get("x"),
                    operation.get("y"),
                )
                send_mouse_click(
                    x,
                    y,
                    operation.get("mouse_button", "left"),
                    operation.get("click_count", 1),
                )
        else:
            raise RuntimeError("Invalid click_method '{}'".format(click_method))
    elif tool == "perform_secondary_action":
        invoke_secondary_action(element, operation.get("action", ""))
    elif tool == "scroll":
        focus_window(window)
        scroll_element(operation.get("direction", "down"), operation.get("pages", 1))
    elif tool == "drag":
        from_x, from_y = screen_point(
            bounds, None, operation.get("from_x"), operation.get("from_y")
        )
        to_x, to_y = screen_point(bounds, None, operation.get("to_x"), operation.get("to_y"))
        send_drag(from_x, from_y, to_x, to_y)
    elif tool == "type_text":
        if not insert_text(window, operation.get("text", "")):
            focus_window(window)
            send_text(operation.get("text", ""))
    elif tool == "press_key":
        focus_window(window)
        send_key(operation.get("key", ""))
    elif tool == "set_value":
        if element is None:
            raise RuntimeError("unknown element_index")
        if not set_element_value(element, operation.get("value", "")):
            raise RuntimeError("Cannot set a value for an element that is not settable")
    else:
        raise RuntimeError('unsupportedTool("{}")'.format(tool))

    time.sleep(0.12)
    try:
        return {
            "ok": True,
            "snapshot": build_snapshot(
                operation.get("app", ""),
                screenshot=bool(operation.get("screenshot", True)),
                window=operation.get("window"),
            ),
        }
    except Exception:
        return {"ok": True, "text": "Input was dispatched; post-action observation failed. Observe again before deciding another action."}
