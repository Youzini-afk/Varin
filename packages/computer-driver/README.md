# Varin Computer Use drivers

Resident platform helpers for Computer Use (BC4). A driver runs inside the
target desktop session and speaks a line-delimited JSON protocol on
stdin/stdout:

Each desktop has one ordered input/observation helper and a separate read-only
capture helper for live viewers. Long native actions cannot queue-block the
viewer. The Host coalesces concurrent startup of each helper; the capture helper
never changes the Agent's stored observations or input ownership.

```
in : {"id":"<request>","tool":"<op>", ...params}
out: {"id":"<request>","ok":true|false, "error"?:string, "cancelled"?:bool,
      "snapshot"?:{...}, "text"?:string,
      "apps"?:[{name,pid,windowTitle,windows}], "capabilities"?:{...}}
```

Operations:

| tool | purpose |
| --- | --- |
| `ping` | liveness probe |
| `capabilities` | honest driver capability table (see `ComputerCapabilities` in `packages/protocol/src/harness-computer.ts`) |
| `list_apps` | running top-level apps on this desktop |
| `get_app_state` | snapshot: window bounds, UIA/AT-SPI tree lines + element records, optional screenshot |
| `click`, `perform_secondary_action`, `scroll`, `drag`, `type_text`, `press_key`, `set_value` | actions; return a fresh snapshot after the input settles |
| `release_input` | release the synthetic buttons/keys this driver pressed, rather than every desktop modifier |
| `capture_frame` / `inject_input` | viewer frames and human input; successful down/move/up requests preserve a gesture across frame requests until explicit release, cancellation, failure or EOF |

Action params mirror the Open Computer Use schema (`app`, `element`,
`x`/`y`, `from_x`/`from_y`/`to_x`/`to_y`, `click_count`, `mouse_button`,
`click_method`, `direction`, `pages`, `text`, `key`, `value`, `action`,
`windowBounds`, `text_limit`, `max_tree_nodes`, `max_tree_depth`). Two Varin
additions: `input: "global"` selects real session input (SendInput / AT-SPI
synthesis / CGEvent) where the backend message path cannot reach, `screenshot:
false` skips image capture on an observation, and `window` selects one of the
app's windows by handle or title (see `windows` in `list_apps`/snapshots;
the handle is HWND on Windows, CGWindowNumber on macOS, and the AT-SPI child
index on Linux).

Cancellation (BC4.A): stdin stays sequential, so the Host cannot interrupt a
running op through it. Instead it writes
`$VARIN_DRIVER_CANCEL_DIR/<requestId>.cancel`; long operations (tree walks,
multi-click, drags, scrolls, key chords, type bursts) poll the flag at their
internal checkpoints and abort with `{ok:false, cancelled:true, error}` whose
message reports how much input already reached the desktop. A `cancelled`
response is a partial outcome, not a clean rejection.

## Platform hosts

| platform | host entry | backend |
| --- | --- | --- |
| Windows | `windows/driver-host.ps1` (powershell.exe, stdin loop) | UIA tree/patterns + Win32 window messages; `SendInput` for `global`; `PrintWindow` capture with screen-copy fallback; per-process `EnumWindows` inventory |
| Linux | `linux/driver-host.py` (python3, stdin loop) | AT-SPI tree/actions + `Atspi.generate_*` input; Gdk pixbuf capture on X11. Wayland reports no reliable screenshot/coordinate input until a consented RemoteDesktop/ScreenCast session exists; element actions may still work. |
| macOS | `macos/driver-host.js` (osascript -l JavaScript, stdin loop) | JXA driver: CGWindowList windows + System Events AX tree + CGEvent input + `CGWindowListCreateImage` capture. **Unverified** — no real-machine evidence yet; `capabilities.detail` says so |

The **Prepare Desktop** action on a Debian or Ubuntu Linux Host installs its
native graphical dependencies and creates a systemd-managed Xvnc session.
Package installation requires root or non-interactive sudo on that Host. A root
Host creates a dedicated desktop account; a regular Host creates a lingering
user service. The user profile, downloads and browser state live under the
desktop account and survive Host or viewer restarts. RFB listens on a private
Unix socket with server-side input disabled; noVNC uses the authenticated Host
media route for viewing. Human input remains in the existing control lane.

Preparation is explicit and can be repeated to upgrade the component at its
next session start. A running session is left running so applications and edits
are not interrupted. Stop and Start in Computer settings apply the new
component. Only Debian and Ubuntu apt preparation is implemented; the service
reports a clear error on unsupported distributions.

## Managed libvirt guest

On a Linux x64 Host with local `qemu:///system`, Create VM can prepare a Debian
13 guest automatically. The Host resolves an official dated generic cloud
image, verifies its SHA-512 digest, creates a UUID-owned disk and read-only
NoCloud seed, boots the domain, and waits for the guest Host and Xvnc desktop
to become usable. The release build supplies a version-matched Linux x64
runtime bundle with Node, Bun, and verified SHA-256 asset digests. Guest
bootstrap installs native dependencies and a systemd Host service. The
coordinator registers this Host through the existing desktop connection
settings and shows its desktop in the normal Computer catalog.

The VM disk keeps `/var/lib/varin`, the dedicated desktop account, browser
profile, and downloads. The Host runtime lives under `/opt/varin/runtime`.
To update it, shut down the VM, select **Upgrade runtime** in Computer
settings, then start it. This replaces the recorded seed ISO while the VM is
off; the guest verifies and installs the new runtime before its Host starts.
An interrupted ISO upload can be retried against the same recorded volume.
Deleting the VM retains its volumes unless **Delete disks** is selected.

This recipe requires local libvirt, an apt-based guest, and network access to
Debian and package repositories. Other machines can still be connected as
remote Hosts. Native KVM boot, desktop operation, and installer behavior must
be checked on an actual Linux hypervisor; scripted provider tests do not
establish those results.

## Composable environment additions

The desktop component publishes all production Python modules together; app
bridges must remain importable from the generation accessible to its dedicated
account, including when the Host lives under `/root`.

The default desktop has one visible persistent Chromium profile. Its URL
handler and CDP bridge use that same profile; the bridge resolves the actual
endpoint from `DevToolsActivePort` and checks the browser identity. An explicit
port selects a caller-provided endpoint. Existing installed browsers and their
profiles are retained. `components.json` is the recipe used by both preparation
and additional software installation. The general guest also requests dev/docs;
failed optional groups remain visible in the persisted software status.

Software installation results are separate from desktop and bridge readiness.
The Host imports bootstrap results and reports the packages for each component.
Concurrent install requests serialize and retain their own requested groups.
LibreOffice/UNO and Chromium/CDP native session behavior still require Linux
validation; import and protocol tests alone do not establish desktop operation.

The `computer` tool's `artifact` action registers a file beneath that desktop
user's home on the calling Thread. The dedicated account reads and hashes the
file; the coordinator saves only its version and location in the kernel
catalog. Bot work can download the recorded revision while the source Host is
reachable. A changed file needs a new registration. The browser verifies the
received bytes before offering the download.

Windows background-capable actions avoid stealing foreground focus by
default; the escape hatches `VARIN_COMPUTER_ALLOW_FOCUS_ACTIONS`,
`VARIN_COMPUTER_ALLOW_APP_LAUNCH`, and
`VARIN_COMPUTER_ALLOW_UIA_TEXT_FALLBACK` are evaluated inside the driver
session.

## Provenance

Substantial portions of `windows/runtime.ps1` and `linux/runtime.py` are
adapted from [open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use),
MIT License (baseline `51f3a59`, 2026-09-28). Changes: persistent host loop,
global SendInput paths, `PrintWindow` capture, `release_input`,
`capabilities`, Varin flag names.

The complete upstream notice is retained in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

Host cancellation drops queued input, signals the in-flight op through the
cancel-flag side-channel, and follows with `release_input` so an interrupted
gesture releases input tracked by that helper. A crashed helper loses its
tracking state; a replacement cannot safely send blanket key-up events because
they could release a person's held keys or mouse buttons. A lost driver response
therefore leaves the action effect and any held-input state unknown. Post-action
capture failure preserves the input acceptance. Inspect the desktop before
retrying.
Drivers are staged inside the compiled Application Host generation at `server/computer-driver`, so publication replaces code and scripts together. Environment overrides remain explicit. On Debian and Ubuntu, the explicit Prepare Desktop operation installs the graphical session and its native packages. Existing local console desktops still require their own graphical session and platform packages.

See the [BC acceptance record](../../docs/plan/bot-computer-use-review.md)
for remaining native platform and packaging work.
