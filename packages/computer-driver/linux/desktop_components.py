"""Publish one complete, immutable Python desktop generation."""
import hashlib
import os
from pathlib import Path


def publish(session_dir, source_dir):
    files = sorted(path for path in Path(source_dir).glob("*.py")
                   if not path.name.startswith("test_"))
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.name.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    component = Path(session_dir) / "components" / digest.hexdigest()
    component.mkdir(parents=True, exist_ok=True)
    os.chmod(component.parent, 0o755)
    os.chmod(component, 0o755)
    for path in files:
        destination = component / path.name
        if not destination.exists():
            destination.write_bytes(path.read_bytes())
        os.chmod(destination, 0o644)
    return component
