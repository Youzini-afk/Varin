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


def write_response(request_id, response):
    payload = {"id": request_id}
    payload.update(response)
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
    import runtime
except Exception as exc:
    # pyatspi/GObject missing or not importable — report over the protocol so
    # the Host can mark the desktop honestly instead of seeing a bare crash.
    write_response(None, {"ok": False, "error": str(exc)})
    sys.exit(1)


def main():
    runtime.require_desktop_session()
    runtime.Atspi.init()
    try:
        runtime.release_input()
    except Exception:
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            operation = json.loads(line)
            request_id = operation.get("id")
            runtime.ACTIVE_REQUEST_ID = request_id
            response = None
            try:
                response = runtime.perform_operation(operation)
            except runtime.CancelledError as exc:
                response = {"ok": False, "cancelled": True, "error": str(exc)}
            finally:
                # Human down/move/up requests form one gesture across frames.
                # Successful observation/stream reads must not release it.
                if not observation_only(operation) and (response is None or not response.get("ok") or operation.get("tool") != "inject_input"):
                    runtime.release_input()
                runtime.ACTIVE_REQUEST_ID = None
            write_response(request_id, response)
        except Exception as exc:
            write_response(request_id, {"ok": False, "error": str(exc)})
    runtime.release_input()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        write_response(None, {"ok": False, "error": sys.exc_info()[1].__str__()})
        sys.exit(1)
