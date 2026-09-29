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

import json
import sys


def write_response(request_id, response):
    payload = {"id": request_id}
    payload.update(response)
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


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
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            operation = json.loads(line)
            request_id = operation.get("id")
            write_response(request_id, runtime.perform_operation(operation))
        except Exception as exc:
            write_response(request_id, {"ok": False, "error": str(exc)})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        write_response(None, {"ok": False, "error": sys.exc_info()[1].__str__()})
        sys.exit(1)
