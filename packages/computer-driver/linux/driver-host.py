#!/usr/bin/env python3
# Varin Computer Use — persistent Linux driver host.
#
# Runs resident inside the desktop session and speaks a line-delimited JSON
# protocol on stdin/stdout:
#   in : {"id":"<request>","tool":"<op>", ...params}
#   out: {"id":"<request>","ok":true|false, ...}
#
# AT-SPI is initialized once at startup; operations never restart the
# interpreter. Managed by the Varin Host computer service — do not run
# interactively.
#
# Cancellation is out-of-band: while a request executes the Host writes
# "$VARIN_DRIVER_CANCEL_DIR/<requestId>.cancel"; long operations poll it at
# their internal checkpoints and abort with {ok:false, cancelled:true}.
# Startup releases only input tracked by this process. Input injected by a
# crashed predecessor cannot be attributed reliably to it after restart.

import json
import sys
import os
import threading
from concurrent.futures import ThreadPoolExecutor

WAYLAND = os.environ.get("XDG_SESSION_TYPE") == "wayland" or bool(os.environ.get("WAYLAND_DISPLAY"))
OUTPUT_LOCK = threading.Lock()


def write_response(request_id, response):
    payload = {"id": request_id}
    payload.update(response)
    with OUTPUT_LOCK:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def observation_only(operation):
    tool = operation.get("tool")
    if tool in ("capture_frame", "get_app_state", "list_apps", "capabilities", "ping"):
        return True
    if tool == "browser":
        return operation.get("op") in ("status", "tabs", "snapshot") or (operation.get("op") == "act" and (operation.get("act") or {}).get("kind") == "screenshot")
    if tool == "office":
        return operation.get("op") in ("status", "docs") or (operation.get("op") == "act" and (operation.get("act") or {}).get("kind") == "read")
    return False


try:
    if WAYLAND:
        import wayland_runtime as runtime
    else:
        import runtime
except Exception as exc:
    # pyatspi/GObject missing or not importable — report over the protocol so
    # the Host can mark the desktop honestly instead of seeing a bare crash.
    write_response(None, {"ok": False, "error": str(exc)})
    sys.exit(1)


def execute(operation, capture=False):
    request_id = operation.get("id")
    if not capture:
        runtime.ACTIVE_REQUEST_ID = request_id
    response = None
    try:
        response = runtime.perform_operation(operation, write_response) if WAYLAND else runtime.perform_operation(operation)
    except runtime.CancelledError as exc:
        response = exc.response() if WAYLAND else {"ok": False, "cancelled": True, "error": str(exc)}
    except Exception:
        response = {"ok": False, "error": "The desktop driver could not complete the request; observe before retrying",
                    "receipt": {"effect": "unknown", "reason": {"code": "driver-error", "message": "The desktop driver could not complete the request"}, "recovery": "observe"}}
    finally:
        if not capture:
            try:
                if not observation_only(operation) and (response is None or not response.get("ok") or operation.get("tool") != "inject_input"):
                    runtime.release_input()
            except Exception:
                response = {"ok": False, "error": "Release of the original synthetic input was not confirmed",
                            "receipt": {"effect": "unknown", "reason": {"code": "connection-lost", "message": "Release of the original synthetic input was not confirmed"}, "recovery": "reconnect"}}
            runtime.ACTIVE_REQUEST_ID = None
    write_response(request_id, response)


def main():
    runtime.require_desktop_session()
    if not WAYLAND:
        runtime.Atspi.init()
    runtime.release_input()
    if not WAYLAND:
        # AT-SPI stays on the same initialized thread. X11 still gets its
        # independent capture process from the existing Host pool.
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                operation = json.loads(line)
                if not isinstance(operation, dict) or not isinstance(operation.get("id"), str):
                    raise ValueError("Invalid request")
            except (ValueError, TypeError):
                write_response(None, {"ok": False, "error": "Invalid desktop request"})
                continue
            execute(operation)
        runtime.release_input()
        return
    # The protocol reader stays available while input runs. Wayland capture
    # shares its portal owner, but never the ordered input worker or cancellation.
    with ThreadPoolExecutor(max_workers=1) as inputs, ThreadPoolExecutor(max_workers=1) as captures:
        try:
            for line in sys.stdin:
                if not line.strip():
                    continue
                try:
                    operation = json.loads(line)
                    if not isinstance(operation, dict) or not isinstance(operation.get("id"), str):
                        raise ValueError("Invalid request")
                except (ValueError, TypeError):
                    write_response(None, {"ok": False, "error": "Invalid desktop request"})
                    continue
                if WAYLAND and operation.get("tool") == "capture_frame":
                    captures.submit(execute, operation, True)
                else:
                    inputs.submit(execute, operation)
        finally:
            if WAYLAND:
                runtime.STOPPING.set()
    runtime.release_input()
    if WAYLAND:
        runtime.dispose()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        write_response(None, {"ok": False, "error": sys.exc_info()[1].__str__()})
        sys.exit(1)
