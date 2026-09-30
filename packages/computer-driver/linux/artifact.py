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
from contextlib import contextmanager
import signal
import stat


def home_root(home):
    return Path(home).resolve(strict=True)


def relative_path(home, relative):
    path = Path(relative)
    if path.is_absolute() or not relative or ".." in path.parts or "\\" in relative or "\0" in relative:
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
    selected = relative_path(home, relative).resolve(strict=True)
    if not selected.is_relative_to(home_root(home)):
        raise ValueError("Artifact path escapes the desktop home")
    if not selected.is_file():
        raise ValueError("Artifact is not a regular file in the desktop home")
    return selected


@contextmanager
def parent_fd(home, selected, create=False):
    """Walk the canonical path through pinned directory descriptors.

    In-home links resolve before this walk; a concurrent replacement with a
    symlink cannot redirect an open or rename outside the recorded home.
    """
    root = home_root(home)
    parent = selected.parent.resolve(strict=not create)
    relative = parent.relative_to(root)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in relative.parts:
            if create:
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd, selected.name
    finally:
        os.close(fd)


def write_file(home, relative):
    """Atomically replace one file inside the desktop home from stdin bytes.

    A one-shot copy: the temp file lands next to the target so rename stays
    on the same filesystem, and the returned metadata describes the stored
    revision — no sync relationship is implied.
    """
    selected = relative_path(home, relative)
    with parent_fd(home, selected, create=True) as (directory, name):
        temp_name = ".varin-artifact-" + os.urandom(16).hex()
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            digest = hashlib.sha256()
            with os.fdopen(fd, "wb") as stream:
                while block := sys.stdin.buffer.read(1024 * 1024):
                    digest.update(block)
                    stream.write(block)
                stream.flush()
                os.fsync(stream.fileno())
                written = os.fstat(stream.fileno())
            os.replace(temp_name, name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            try:
                os.unlink(temp_name, dir_fd=directory)
            except FileNotFoundError:
                pass
    print(json.dumps({"sha256": digest.hexdigest(), "byteLength": written.st_size,
                      "modifiedAt": str(written.st_mtime_ns)}))


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
    with parent_fd(args.home, source) as (directory, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Artifact is not a regular file")
        digest = hashlib.sha256()
        while block := stream.read(1024 * 1024):
            digest.update(block)
        after = os.fstat(stream.fileno())
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
    def cancelled(_signum, _frame):
        raise InterruptedError("Artifact operation cancelled; inspect the file before retrying a write")
    signal.signal(signal.SIGTERM, cancelled)
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
