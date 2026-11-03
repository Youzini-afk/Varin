"""Read package metadata and hash its tar streams. Never extract or execute payloads."""
import hashlib
import json
import subprocess
import sys
import tarfile


def archive(package, kind):
    process = subprocess.Popen(["dpkg-deb", kind, package], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    result = []
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as stream:
            for member in stream:
                name = member.name.removeprefix("./").rstrip("/")
                if not name:
                    continue
                entry = {"path": name, "uid": member.uid, "gid": member.gid, "mode": member.mode}
                if member.isdir():
                    entry["type"] = "directory"
                elif member.issym():
                    entry.update(type="symlink", link=member.linkname)
                elif member.isfile():
                    entry.update(type="file", size=member.size)
                    digest, prefix, tail, markers = hashlib.sha256(), b"", b"", set()
                    capture = name in ("control", "usr/share/applications/Varin.desktop", "usr/lib/Varin/runtime/runtime-manifest.json")
                    contents = bytearray()
                    with stream.extractfile(member) as source:
                        while chunk := source.read(1024 * 1024):
                            digest.update(chunk)
                            if len(prefix) < 64:
                                prefix += chunk[:64 - len(prefix)]
                            if name == "usr/share/Varin/varin":
                                search = tail + chunk
                                for marker in (b"UNK", b"DEB"):
                                    if b"__TAURI_BUNDLE_TYPE_VAR_" + marker in search:
                                        markers.add(marker.decode())
                                tail = search[-64:]
                            if capture:
                                if len(contents) + len(chunk) > 32 * 1024 * 1024:
                                    raise ValueError("Package metadata exceeds inspection budget")
                                contents.extend(chunk)
                    entry["sha256"] = digest.hexdigest()
                    if prefix[:4] == b"\x7fELF":
                        if len(prefix) < 20 or prefix[5] not in (1, 2):
                            raise ValueError("Malformed ELF header")
                        entry["elfMachine"] = int.from_bytes(prefix[18:20], "little" if prefix[5] == 1 else "big")
                    if name == "usr/share/Varin/varin":
                        entry["bundleMarkers"] = sorted(markers)
                    if capture:
                        entry["text"] = contents.decode("utf-8")
                else:
                    raise ValueError("Package contains a hard link or special entry")
                if member.pax_headers:
                    raise ValueError("Package contains unexpected extended archive attributes")
                result.append(entry)
        process.stdout.close()
        error = process.stderr.read()
        if process.wait() != 0:
            raise ValueError("dpkg-deb archive inspection failed")
        return result
    except Exception:
        process.kill()
        process.wait()
        raise


def inspect(package):
    return {"control": archive(package, "--ctrl-tarfile"), "entries": archive(package, "--fsys-tarfile")}


if __name__ == "__main__":
    print(json.dumps(inspect(sys.argv[1]), separators=(",", ":")))
