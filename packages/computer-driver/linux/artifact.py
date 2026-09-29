#!/usr/bin/env python3
"""Inspect or read a desktop user's file without giving the Host root reads.

The Host invokes this component as the dedicated desktop account. Paths are
relative to that account's home; source files remain owned by the application.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def selected_file(home, relative):
    path = Path(relative)
    if path.is_absolute() or not relative or ".." in path.parts:
        raise ValueError("Artifact path must be relative to the desktop home")
    root = Path(home).resolve(strict=True)
    selected = (root / path).resolve(strict=True)
    if not selected.is_relative_to(root) or not selected.is_file():
        raise ValueError("Artifact is not a regular file in the desktop home")
    return selected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["info", "read"])
    parser.add_argument("--home", required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--sha256")
    args = parser.parse_args()
    source = selected_file(args.home, args.path)
    with source.open("rb") as stream:
        before = source.stat()
        digest = hashlib.sha256()
        while block := stream.read(1024 * 1024):
            digest.update(block)
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError("Artifact changed during inspection")
        sha = digest.hexdigest()
        if args.sha256 and sha != args.sha256:
            raise RuntimeError("Artifact version changed; inspect and register the new version")
        if args.operation == "info":
            print(json.dumps({"sha256": sha, "byteLength": after.st_size, "modifiedAt": str(after.st_mtime_ns)}))
        else:
            print("VARIN_ARTIFACT_READY", file=sys.stderr, flush=True)
            stream.seek(0)
            while block := stream.read(1024 * 1024):
                sys.stdout.buffer.write(block)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
