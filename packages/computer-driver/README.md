# Varin Computer Use drivers

Resident platform helpers for Computer Use (BC4). A driver runs inside the
target desktop session and speaks a line-delimited JSON protocol on
stdin/stdout:

```
in : {"id":"<request>","tool":"<op>", ...params}
out: {"id":"<request>","ok":true|false, "error"?:string, "snapshot"?:{...},
      "text"?:string, "apps"?:[{name,pid,windowTitle}], "capabilities"?:{...}}
```

Operations:

| tool | purpose |
| --- | --- |
| `ping` | liveness probe |
| `capabilities` | honest driver capability table (see `ComputerCapabilities` in `packages/protocol/src/harness-computer.ts`) |
| `list_apps` | running top-level apps on this desktop |
| `get_app_state` | snapshot: window bounds, UIA/AT-SPI tree lines + element records, optional screenshot |
| `click`, `perform_secondary_action`, `scroll`, `drag`, `type_text`, `press_key`, `set_value` | actions; return a fresh snapshot after the input settles |
| `release_input` | lift held buttons/keys — used on cancel and control handoff |

Action params mirror the Open Computer Use schema (`app`, `element`,
`x`/`y`, `from_x`/`from_y`/`to_x`/`to_y`, `click_count`, `mouse_button`,
`click_method`, `direction`, `pages`, `text`, `key`, `value`, `action`,
`windowBounds`, `text_limit`, `max_tree_nodes`, `max_tree_depth`). Two Varin
additions: `input: "global"` selects real session input (SendInput / AT-SPI
synthesis) where the backend message path cannot reach, and `screenshot:
false` skips image capture on an observation.

## Platform hosts

| platform | host entry | backend |
| --- | --- | --- |
| Windows | `windows/driver-host.ps1` (powershell.exe, stdin loop) | UIA tree/patterns + Win32 window messages; `SendInput` for `global`; `PrintWindow` capture with screen-copy fallback |
| Linux | `linux/driver-host.py` (python3, stdin loop) | AT-SPI tree/actions + `Atspi.generate_*` input; Gdk pixbuf capture (X11 sessions; Wayland needs a portal path and reports its limitation in `capabilities.detail`) |
| macOS | not yet packaged | The OCU Swift helper (`packages/OpenComputerUseKit`) is the intended source; until a bundled helper exists the service reports the desktop unavailable rather than pretending |

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
