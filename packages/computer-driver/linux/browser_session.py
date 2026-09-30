"""The managed visible browser and CDP bridge share this persistent profile."""
import os
from pathlib import Path


def profile_for(operation):
    return os.path.abspath(os.path.expanduser(operation.get("profile")
        or os.environ.get("VARIN_BROWSER_PROFILE") or "~/.varin-browser-profile"))


def launch_args(binary, profile, port=0):
    return [binary, f"--remote-debugging-port={port}", "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile}", "--no-first-run", "--start-maximized"]


def endpoint_for(operation):
    explicit = operation.get("cdp_port")
    if explicit is not None:
        if isinstance(explicit, bool) or not isinstance(explicit, int) or not 1 <= explicit <= 65535:
            raise ValueError("CDP port must be between 1 and 65535")
        return explicit, None
    lines = (Path(profile_for(operation)) / "DevToolsActivePort").read_text().splitlines()
    port = int(lines[0])
    if not 1 <= port <= 65535 or not lines[1].startswith("/devtools/browser/"):
        raise ValueError("Invalid browser profile endpoint")
    return port, lines[1]
