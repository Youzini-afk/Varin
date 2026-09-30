"""Run a blocking app bridge under the driver's cancellation lifetime.

Only this helper is disposable. Chromium/LibreOffice remain the visible,
persistent applications. Killing a submitted helper cannot undo an app effect.
"""
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import ctypes


def run(tool, operation, check_cancel):
    check_cancel("before application bridge dispatch")
    child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), tool, str(os.getpid())],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    request = json.dumps(operation)
    try:
        while True:
            check_cancel("application request may already have reached the visible scene")
            try:
                stdout, stderr = child.communicate(input=request, timeout=0.1)
                if child.returncode:
                    raise RuntimeError("Application bridge exited without a receipt: " + stderr.strip())
                result = json.loads(stdout)
                if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                    raise RuntimeError("Application bridge returned an invalid receipt")
                return result
            except subprocess.TimeoutExpired:
                request = None
    except BaseException:
        if child.poll() is None:
            child.terminate()
        child.communicate()
        raise


if __name__ == "__main__":
    def cancelled(_signum, _frame):
        raise InterruptedError("Application helper cancelled; the app effect may already have happened")
    signal.signal(signal.SIGTERM, cancelled)
    # A driver crash must not leave this disposable helper writing to the
    # visible app after the Host has already admitted a new driver.
    parent_pid = int(sys.argv[2])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot bind bridge helper to driver lifetime")
    if os.getppid() != parent_pid:
        raise InterruptedError("Application driver exited before bridge dispatch")
    tool = sys.argv[1]
    if tool not in ("browser", "office"):
        raise ValueError("Unknown application bridge")
    bridge = importlib.import_module(tool + "_bridge")
    result = bridge.perform(json.load(sys.stdin))
    print(json.dumps(result, separators=(",", ":")))
