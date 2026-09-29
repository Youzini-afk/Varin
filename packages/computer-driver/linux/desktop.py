#!/usr/bin/env python3
"""Persistent Xvnc desktop component. systemd owns the desktop, not its viewers.

Runtime upgrades replace this component; profiles and downloads stay under data.
RFB is read-only at Xvnc itself. All human input uses the Host control lane.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import signal
import socket as unix_socket
import subprocess
import sys
import tempfile


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".next-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"{args[0]} failed")
    return result.stdout.strip()


def unit_name(data):
    return "varin-desktop-" + hashlib.sha256(str(data).encode()).hexdigest()[:16]


def systemctl(data, *args, check=True):
    config = json.loads((data / "config.json").read_text())
    command = ["systemctl"] + (["--user"] if config["userUnit"] else []) + list(args)
    environment = dict(os.environ)
    if config["userUnit"]:
        runtime = f'/run/user/{config["uid"]}'
        environment.update({"XDG_RUNTIME_DIR": runtime, "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + runtime + "/bus"})
    if check:
        return run(command, env=environment)
    return subprocess.run(command, text=True, capture_output=True, env=environment)


def unit_quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('\n', '\\n').replace('\r', '\\r') + '"'


def prepare(data, width, height):
    if width <= 0 or height <= 0:
        raise ValueError("Desktop dimensions must be positive")
    # Dependencies are installed by the packaged shell entry before Python is
    # started, including on a server that initially has no Python/GI runtime.
    xvnc = shutil.which("Xtigervnc") or shutil.which("Xvnc")
    browser = shutil.which("firefox-esr") or shutil.which("firefox")
    for name, executable in [("Xvnc", xvnc), ("Firefox", browser), ("xfce4-session", shutil.which("xfce4-session")),
                             ("dbus-run-session", shutil.which("dbus-run-session")), ("xauth", shutil.which("xauth"))]:
        if not executable:
            raise RuntimeError(f"Desktop component is missing: {name}")
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    config_path = data / "config.json"
    previous = json.loads(config_path.read_text()) if config_path.exists() else None
    user_unit = os.geteuid() != 0
    account = pwd.getpwuid(os.geteuid())
    if not user_unit:
        name = "varin-desktop-" + hashlib.sha256(str(data).encode()).hexdigest()[:8]
        owner = previous.get("owner") if previous else None
        try:
            account = pwd.getpwnam(name)
            if not owner or account.pw_gecos != "Varin desktop " + owner:
                raise RuntimeError("Desktop account already exists without this component's ownership record")
        except KeyError:
            owner = owner or secrets.token_hex(16)
            write_json(config_path, {"owner": owner, "user": name, "userUnit": False})
            run(["useradd", "--create-home", "--shell", "/bin/bash", "--comment", "Varin desktop " + owner, name])
            account = pwd.getpwnam(name)
    else:
        owner = None
        # Keep the user service alive after the last SSH login ends.
        if run(["loginctl", "show-user", account.pw_name, "--property=Linger", "--value"]) != "yes":
            run(["sudo", "-n", "loginctl", "enable-linger", account.pw_name])
    name = unit_name(data)
    session_dir = Path(account.pw_dir) / ".local/share/varin-desktops" / name
    if user_unit:
        session_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        run(["runuser", "-u", account.pw_name, "--", "mkdir", "-p", str(session_dir)])
        os.chmod(session_dir, 0o700)
    # Keep an executable component accessible to the desktop account even when
    # the coordinating Host is installed beneath /root. Publish by content hash.
    files = [Path(__file__), Path(__file__).with_name("driver-host.py"), Path(__file__).with_name("runtime.py"),
             Path(__file__).with_name("artifact.py")]
    component_id = hashlib.sha256(b"".join(file.read_bytes() for file in files)).hexdigest()
    component = session_dir / "components" / component_id
    component.mkdir(parents=True, exist_ok=True)
    os.chmod(component.parent, 0o755)
    os.chmod(component, 0o755)
    for file in files:
        destination = component / file.name
        if not destination.exists():
            destination.write_bytes(file.read_bytes())
        os.chmod(destination, 0o644)
    runtime_dir = (Path(f"/run/user/{account.pw_uid}") if user_unit else Path("/run")) / name
    config = {"user": account.pw_name, "uid": account.pw_uid, "gid": account.pw_gid, "owner": owner,
              "home": account.pw_dir, "userUnit": user_unit, "width": width, "height": height,
              "xvnc": xvnc, "browser": browser, "sessionDir": str(session_dir), "runtimeDir": str(runtime_dir),
              "driver": str(component / "driver-host.py"), "artifact": str(component / "artifact.py")}
    write_json(config_path, config)
    write_json(session_dir / "config.json", config)
    if not user_unit:
        os.chown(session_dir / "config.json", account.pw_uid, account.pw_gid)
    unit_dir = Path.home() / ".config/systemd/user" if user_unit else Path("/etc/systemd/system")
    unit_dir.mkdir(parents=True, exist_ok=True)
    unit = "\n".join([
        "[Unit]", "Description=Varin persistent desktop", "After=network.target", "",
        "[Service]", "Type=notify", "NotifyAccess=all", *([] if user_unit else ["User=" + account.pw_name]),
        "RuntimeDirectory=" + name, "RuntimeDirectoryMode=0700", "UMask=0077",
        "ExecStart=" + " ".join(unit_quote(part) for part in ["/usr/bin/dbus-run-session", "--", "/usr/bin/python3",
                                                            str(component / "desktop.py"), "session", "--data-dir", str(session_dir)]),
        "Restart=on-failure", "KillMode=control-group", "", "[Install]",
        "WantedBy=" + ("default.target" if user_unit else "multi-user.target"), "",
    ])
    (unit_dir / (name + ".service")).write_text(unit)
    systemctl(data, "daemon-reload")
    systemctl(data, "enable", name)
    # Preparing an already running desktop upgrades its next-start component;
    # it does not kill applications or discard an interactive login.
    systemctl(data, "start", name)
    return status(data)


def status(data):
    if not (data / "config.json").exists():
        return {"state": "unprepared"}
    config = json.loads((data / "config.json").read_text())
    active = systemctl(data, "is-active", unit_name(data), check=False).stdout.strip()
    if "sessionDir" not in config:
        return {"state": "unprepared", "detail": "Preparation did not finish; retry to resume"}
    runtime_path = Path(config["sessionDir"]) / "runtime.json"
    runtime = json.loads(runtime_path.read_text()) if runtime_path.exists() else None
    if active != "active":
        return {"state": "stopped" if active == "inactive" else "failed", "detail": active}
    expected_socket = str(Path(config["runtimeDir"]) / "view.sock")
    if not runtime or runtime.get("socket") != expected_socket or not Path(expected_socket).is_socket():
        return {"state": "starting"}
    return {"state": "running", "environment": runtime["environment"], "socket": expected_socket,
            "user": config["user"], "uid": config["uid"], "driver": config["driver"],
            **({"artifact": config["artifact"]} if config.get("artifact") else {}), "home": config["home"],
            "width": runtime["width"], "height": runtime["height"]}


def desktop_session(data):
    config = json.loads((data / "config.json").read_text())
    runtime = Path(os.environ["RUNTIME_DIRECTORY"])
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    socket = runtime / "view.sock"
    authority = runtime / "Xauthority"
    cookie = secrets.token_hex(16)
    run(["xauth", "-f", str(authority), "add", ":0", "MIT-MAGIC-COOKIE-1", cookie])
    read_fd, write_fd = os.pipe()
    processes = []
    stopped = False

    def stop(_signum=None, _frame=None):
        nonlocal stopped
        stopped = True
        for process in processes:
            if process.poll() is None:
                process.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        xvnc = subprocess.Popen([config["xvnc"], "-displayfd", str(write_fd), "-auth", str(authority),
            "-geometry", f'{config["width"]}x{config["height"]}', "-depth", "24", "-nolisten", "tcp",
            "-rfbport", "-1", "-rfbunixpath", str(socket), "-rfbunixmode", "0600", "-SecurityTypes", "None",
            "-AlwaysShared", "-AcceptKeyEvents=0", "-AcceptPointerEvents=0", "-AcceptCutText=0", "-SendCutText=0",
            "-AcceptSetDesktopSize=0", "-AllowOverride", ""], pass_fds=(write_fd,))
        processes.append(xvnc)
        os.close(write_fd)
        with os.fdopen(read_fd) as display_pipe:
            number = display_pipe.readline().strip()
        if not number.isdecimal() or stopped:
            raise RuntimeError("Xvnc did not create a graphical display")
        display = ":" + number
        run(["xauth", "-f", str(authority), "add", display, "MIT-MAGIC-COOKIE-1", cookie])
        environment = {**os.environ, "DISPLAY": display, "XAUTHORITY": str(authority), "XDG_SESSION_TYPE": "x11",
                       "NO_AT_BRIDGE": "0", "GTK_MODULES": "gail:atk-bridge", "HOME": config["home"]}
        persistent = data / "persistent"
        profile = persistent / "firefox"
        profile.mkdir(parents=True, exist_ok=True)
        # Preserve all user preferences; this file is only seeded for a new profile.
        user_js = profile / "user.js"
        if not user_js.exists():
            user_js.write_text('user_pref("accessibility.force_disabled", 0);\n')
        processes.append(subprocess.Popen(["xfce4-session"], env=environment))
        processes.append(subprocess.Popen([config["browser"], "--no-remote", "--profile", str(profile)], env=environment))
        write_json(data / "runtime.json", {"user": config["user"], "uid": config["uid"], "socket": str(socket),
            "width": config["width"], "height": config["height"], "pid": os.getpid(),
            "environment": {name: environment[name] for name in ["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "NO_AT_BRIDGE", "GTK_MODULES", "HOME"]}})
        notify_address = os.environ.get("NOTIFY_SOCKET")
        if notify_address:
            if notify_address.startswith("@"):
                notify_address = "\0" + notify_address[1:]
            with unix_socket.socket(unix_socket.AF_UNIX, unix_socket.SOCK_DGRAM) as notify:
                notify.sendto(b"READY=1", notify_address)
        # systemd reaps the entire cgroup on any component failure. The desktop
        # survives viewer disconnect and Host restarts, but not a failed X server.
        code = xvnc.wait()
        if code and not stopped:
            raise RuntimeError("Xvnc stopped unexpectedly")
    finally:
        stop()
        for process in processes:
            process.wait()
        (data / "runtime.json").unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["prepare", "start", "stop", "status", "session"])
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=800)
    args = parser.parse_args()
    data = Path(args.data_dir).resolve()
    if args.operation == "session":
        desktop_session(data)
        return
    if args.operation == "prepare":
        result = prepare(data, args.width, args.height)
    else:
        if args.operation in ["start", "stop"]:
            systemctl(data, args.operation, unit_name(data))
        result = status(data)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"state": "failed", "detail": str(error)}))
        sys.exit(1)
