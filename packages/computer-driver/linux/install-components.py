#!/usr/bin/env python3
"""Install recipe components or explicit packages into a Varin environment.

Runs on the managed machine (Debian/Ubuntu, apt). Reports one JSON line to
stdout and persists the same result to <data-dir>/software.status.json so the
Host can re-read the last install outcome. Install success and control
interface availability are separate facts — this script only reports the
former.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import tempfile
import signal

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9+._:-]*$")


def load_manifest():
    with open(os.path.join(HERE, "components.json"), "r", encoding="utf-8") as handle:
        return {entry["id"]: entry for entry in json.load(handle)["components"]}


def privilege_prefix():
    return [] if os.geteuid() == 0 else ["sudo", "-n"]


def apt(args, cancel_file=None):
    if cancel_file and os.path.exists(cancel_file):
        raise InterruptedError("Installation cancelled before package manager dispatch")
    process = subprocess.Popen(
        privilege_prefix() + ["apt-get", *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=True,
        env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
    try:
        while True:
            if cancel_file and os.path.exists(cancel_file):
                raise InterruptedError("Installation cancelled; some packages may already have changed")
            try:
                stdout, stderr = process.communicate(timeout=0.1)
                return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
            except subprocess.TimeoutExpired:
                continue
    except BaseException:
        # sudo forwards termination to its command; root can terminate every
        # descendant directly. Do not acknowledge cancellation before exit.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        process.communicate()
        raise


def main():
    parser = argparse.ArgumentParser(description="Install Varin environment components")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--cancel-file")
    parser.add_argument("--group", action="append", default=[], dest="groups")
    parser.add_argument("--package", action="append", default=[], dest="packages")
    args = parser.parse_args()

    manifest = load_manifest()
    requests = []
    unknown = [group for group in args.groups if group not in manifest]
    if unknown:
        print(json.dumps({"ok": False, "error": f"unknown component groups: {', '.join(sorted(unknown))}"}))
        return 2
    for group in dict.fromkeys(args.groups):
        requests.append((group, list(manifest[group]["packages"])))
    explicit = [pkg for pkg in args.packages]
    for pkg in explicit:
        if not PACKAGE_RE.match(pkg):
            print(json.dumps({"ok": False, "error": f"invalid package name: {pkg}"}))
            return 2
    if explicit:
        requests.append(("packages", explicit))
    if not requests:
        print(json.dumps({"ok": False, "error": "no components or packages requested"}))
        return 2

    if not os.path.isdir("/etc/apt"):
        print(json.dumps({"ok": False, "error": "component install currently supports apt (Debian/Ubuntu) targets"}))
        return 1

    update_error = None
    try:
        update = apt(["update"], args.cancel_file)
        if update.returncode:
            update_error = f"apt-get update exited with status {update.returncode}"
    except Exception as exc:
        update_error = str(exc)
    results = []
    for component_id, packages in requests:
        if update_error:
            results.append({"id": component_id, "state": "failed", "detail": update_error, "packages": packages})
            continue
        try:
            install = apt(["install", "-y", "--no-install-recommends", *packages], args.cancel_file)
        except Exception as exc:
            results.append({"id": component_id, "state": "failed", "detail": str(exc), "packages": packages})
            continue
        if install.returncode == 0:
            results.append({"id": component_id, "state": "installed", "packages": packages})
        else:
            results.append({"id": component_id, "state": "failed",
                            "detail": f"apt-get install exited with status {install.returncode}", "packages": packages})

    payload = {"ok": all(item["state"] == "installed" for item in results),
               "results": results, "at": int(time.time() * 1000)}
    os.makedirs(args.data_dir, exist_ok=True)
    status_path = os.path.join(args.data_dir, "software.status.json")
    prior = {}
    if os.path.exists(status_path):
        with open(status_path, "r", encoding="utf-8") as handle:
            prior = json.load(handle)
    merged = {item["id"]: item for item in prior.get("results", [])}
    for item in results:
        item["at"] = payload["at"]
        merged[item["id"]] = item
    fd, tmp = tempfile.mkstemp(prefix=".software-", dir=args.data_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"results": list(merged.values()), "at": payload["at"]}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, status_path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print(json.dumps(payload))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
