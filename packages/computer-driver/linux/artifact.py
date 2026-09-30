#!/usr/bin/env python3
"""Inspect or read a desktop user's file without giving the Host root reads.

The Host invokes this component as the dedicated desktop account. Paths are
relative to that account's home; source files remain owned by the application.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


def home_root(home):
    return Path(home).resolve(strict=True)


def relative_path(home, relative):
    path = Path(relative)
    if path.is_absolute() or not relative or ".." in path.parts:
        raise ValueError("Artifact path must be relative to the desktop home")
    root = home_root(home)
    selected = root / path
    # Resolve the deepest existing ancestor (following symlinks) so a
    # symlinked directory cannot smuggle the write outside the home.
    ancestor = selected.parent
    while not ancestor.exists() and ancestor != ancestor.parent:
        ancestor = ancestor.parent
    if not ancestor.resolve().is_relative_to(root):
        raise ValueError("Artifact path escapes the desktop home")
    return selected


def selected_file(home, relative):
    selected = relative_path(home, relative)
    if not selected.is_file():
        raise ValueError("Artifact is not a regular file in the desktop home")
    return selected


def describe(source):
    digest = hashlib.sha256()
    stat = source.stat()
    with source.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return {"sha256": digest.hexdigest(), "byteLength": stat.st_size, "modifiedAt": str(stat.st_mtime_ns)}


def write_file(home, relative):
    """Atomically replace one file inside the desktop home from stdin bytes.

    A one-shot copy: the temp file lands next to the target so rename stays
    on the same filesystem, and the returned metadata describes the stored
    revision — no sync relationship is implied.
    """
    selected = relative_path(home, relative)
    selected.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    fd, temp_name = tempfile.mkstemp(prefix=".varin-artifact-", dir=str(selected.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            while block := sys.stdin.buffer.read(1024 * 1024):
                digest.update(block)
                stream.write(block)
        os.replace(temp_name, selected)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
    print(json.dumps(describe(selected)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["info", "read", "write"])
    parser.add_argument("--home", required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--sha256")
    args = parser.parse_args()
    if args.operation == "write":
        write_file(args.home, args.path)
        return
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
