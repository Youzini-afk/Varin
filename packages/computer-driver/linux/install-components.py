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

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9+._:-]*$")


def load_manifest():
    with open(os.path.join(HERE, "components.json"), "r", encoding="utf-8") as handle:
        return {entry["id"]: entry for entry in json.load(handle)["components"]}


def privilege_prefix():
    return [] if os.geteuid() == 0 else ["sudo", "-n"]


def apt(args):
    return subprocess.run(
        privilege_prefix() + ["apt-get", *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=None,
        env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})


def main():
    parser = argparse.ArgumentParser(description="Install Varin environment components")
    parser.add_argument("--data-dir", required=True)
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

    update = apt(["update"])
    results = []
    for component_id, packages in requests:
        if update.returncode != 0:
            detail = (update.stderr or update.stdout).strip().splitlines()[-1][:400] if (update.stderr or update.stdout).strip() else "apt-get update failed"
            results.append({"id": component_id, "state": "failed", "detail": detail})
            continue
        install = apt(["install", "-y", *packages])
        if install.returncode == 0:
            results.append({"id": component_id, "state": "installed", "packages": packages})
        else:
            detail = install.stderr.strip().splitlines()
            results.append({"id": component_id, "state": "failed",
                            "detail": (detail[-1][:400] if detail else "apt-get install failed")})

    payload = {"ok": all(item["state"] == "installed" for item in results),
               "results": results, "at": int(time.time() * 1000)}
    os.makedirs(args.data_dir, exist_ok=True)
    status_path = os.path.join(args.data_dir, "software.status.json")
    tmp = status_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(tmp, status_path)
    print(json.dumps(payload))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
