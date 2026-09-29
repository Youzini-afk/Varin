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
| Linux | `linux/driver-host.py` (python3, stdin loop) | AT-SPI tree/actions + `Atspi.generate_*` input; Gdk pixbuf capture on X11; under Wayland capture goes through `org.freedesktop.portal.Screenshot` and input depends on the compositor accepting AT-SPI synthesis — `capabilities.detail` says which |
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
