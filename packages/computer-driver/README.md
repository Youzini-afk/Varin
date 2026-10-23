# Varin Computer Use drivers

Resident platform helpers for Computer Use (BC4). A driver runs inside the
target desktop session and speaks a line-delimited JSON protocol on
stdin/stdout:

Each desktop has one ordered input/observation lane. macOS and Wayland keep
one native session owner with a separate concurrent, read-only capture lane;
Windows and X11 use a separate capture process. Long native actions cannot
queue-block the viewer. Concurrent viewer requests share a frame read, never
replace the Agent's observation, and never acquire another physical controller.

```
in : {"id":"<request>","tool":"<op>", ...params}
out: {"id":"<request>","ok":true|false, "error"?:string, "cancelled"?:bool, "rejected"?:bool,
      "snapshot"?:{...}, "text"?:string,
      "apps"?:[{name,pid,windowTitle,windows}], "capabilities"?:{...}}
```

Operations:

For an automatic input request with `visual_feedback:true`, the same stdout stream may first emit
`{id,type:"gesture",phase:"target"|"dispatched",point?,to?,target?}`. These are native relocation/input
progress, not final receipts. They omit typed text. The Host correlates progress, rejects obsolete
execution generations, and feeds the existing viewer stream and Windows click-through feedback layer.
See [Computer admission and feedback](../web/application-host/lib/computer/DOCUMENTATION.md).

| tool | purpose |
| --- | --- |
| `ping` | liveness probe |
| `capabilities` | honest driver capability table (see `ComputerCapabilities` in `packages/protocol/src/harness-computer.ts`) |
| `list_apps` | running top-level apps on this desktop |
| `get_app_state` | snapshot: window bounds, UIA/AT-SPI tree lines + element records, optional screenshot |
| `click`, `perform_secondary_action`, `scroll`, `drag`, `type_text`, `press_key`, `set_value` | actions; return dispatch acceptance, optionally a fresh tree or screenshot |
| `release_input` | release the synthetic buttons/keys this driver pressed, rather than every desktop modifier |
| `capture_frame` / `inject_input` | viewer frames and human input; successful down/move/up requests preserve a gesture across frame requests until explicit release, cancellation, failure or EOF |

`applicationTools.browser` / `applicationTools.office` declare implemented application protocols,
independently of whether an application is running. The Host uses known target capabilities for tool
discovery, preserves unknown/custom/remote targets, and rejects unsupported application operations
before dispatch. Native Windows/macOS drivers currently report false; the Linux bridges report true.

Action params mirror the Open Computer Use schema (`app`, `element`,
`x`/`y`, `from_x`/`from_y`/`to_x`/`to_y`, `click_count`, `mouse_button`,
`click_method`, `direction`, `pages`, `text`, `key`, `value`, `action`,
`windowBounds`, `text_limit`, `max_tree_nodes`, `max_tree_depth`). Varin
additions: `input: "global"` selects real session input (SendInput / AT-SPI
synthesis / CGEvent) where the backend message path cannot reach, `screenshot:
false` skips image capture on an observation, and `window` selects one of the
app's windows by handle or title (see `windows` in `list_apps`/snapshots;
the handle is HWND on Windows, CGWindowNumber on macOS, and the AT-SPI child
index on Linux).

`return_state` defaults to `none`: a deterministic batch does not capture or
sleep after every action. `tree` and `screenshot` request an explicit post-action
read. The existing 120ms input-settle allowance now applies only at a subsequent
read, measured from the last input; it is not application-completion proof.

The public API accepts coordinates in the exact PNG's pixels. Host converts
those pixels to window units using PNG dimensions and the recorded bounds;
native helpers reject changed geometry before input. Windows also compares DPI
and checks point ownership for screen-copy captures. This does not establish
unchanged UI content: observe again when the next step depends on the previous
action's result. A tree-only read retains the latest raster, while element
indexes must use the newest tree for that window. Live viewer frames never
replace either Agent observation.

Windows relocates by runtime identity first, then a unique AutomationId/type,
then a unique name/type. Ambiguous matches do not choose the first control.
Text entry searches only the selected window's subtree; another window in the
same process holding global focus cannot redirect the bound application's text.
`rejected:true` means preflight proved no input was sent; other failed native
responses retain uncertain/partial semantics. Native Linux/macOS behavior
still needs validation on those platforms.

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
| Windows | `windows/driver-host.ps1` (powershell.exe, stdin loop) | UIA element patterns + real pointer/keyboard input by default; explicit `app_post` for Win32 messages; `PrintWindow` capture with screen-copy fallback; per-process `EnumWindows` inventory |
| Linux | `linux/driver-host.py` (python3, resident protocol reader) | X11 uses AT-SPI and Gdk. Wayland uses `portal_session.py`/`portal_backend.py`: one RemoteDesktop + ScreenCast authorization, retained GStreamer PipeWire capture, and negotiated D-Bus input. |
| macOS | `macos/Varin Computer.app/Contents/MacOS/VarinComputer` | Native Swift helper: Accessibility tree/actions, retained ScreenCaptureKit streams, and CGEvent input. Separate input/capture queues share the stable `com.varin.computer` application identity. Native build and real-machine behavior still require macOS verification. |

### Native platform sessions

macOS builds require Xcode command-line tools and the macOS SDK. The Application
Host build compiles the helper for the selected x64/arm64 target and stages it
inside that Host generation. For a source-only helper build, run
`node packages/computer-driver/macos/build-helper.mjs`. There is no JXA fallback.
The baseline is macOS 13, so both snapshots and live viewers use retained
ScreenCaptureKit streams; macOS 14 additionally suppresses window shadows via
its supported configuration. Output is cropped to the actual stream content
rectangle, and screenshot pixel dimensions are separate from AX/CG window units.
Window IDs, owning PID, geometry, display scale, AX identity and native focus are
rechecked before input. A covered click target is rejected. Permission probes do
not request consent, capture, focus or type; Accessibility and Screen Recording
are reported independently. An actual capture requests Screen Recording access.
Accessibility permission is granted by the user in macOS settings.

Development helper builds use an explicit ad-hoc signature. Set
`VARIN_COMPUTER_SIGN_IDENTITY` to sign a standalone Host helper with a named
identity. Electron packaging verifies the helper architecture/signature and its
normal signing pass signs the nested app with the distribution identity. An
explicit unsigned Electron build remains ad-hoc; a stable bundle ID alone does
not guarantee that macOS retains permission across unsigned builds or updates.

Wayland requires the session bus, the compositor's RemoteDesktop/ScreenCast
portal backend, Python GObject/Gio, GStreamer introspection, and the `pipewiresrc`,
`videoconvert`, `pngenc` and `appsink` plugins. Debian/Ubuntu packages include
`python3-gi`, `gir1.2-gstreamer-1.0`, `gstreamer1.0-pipewire`,
`gstreamer1.0-plugins-base` and `gstreamer1.0-plugins-good`, plus the desktop's
portal backend. Preparing the managed Xvnc desktop does not configure a local
Wayland compositor or install its portal backend.

Observe `Shared desktop` (PID 0), or open the viewer, to request the system
chooser. Its selected stream and actual granted device mask stay with the helper
across operations. This implementation negotiates the documented D-Bus Notify
transport before input; it does not establish EIS or mix the two transports.
A portal without those input methods remains observation-only. Coordinates bind
the original stream/node (and PipeWire serial when provided), logical size and
actual PNG size. A missing logical size disables absolute pointer input rather
than guessing a scale. No arbitrary AT-SPI app tree is merged with a portal image;
this backend exposes the authorized screen as its target. It does not promise
application-specific focus verification for a screen-only portal target.

Cancelling a job drains its original input and releases its virtual keys/buttons;
it does not close a valid capture session held by viewers. Portal closure or
stream failure fences later input with `session-closed`; a changed raster fences
old coordinates. Viewer polling does not keep reopening a closed chooser. A new
explicit observation can request a new session, whose target handles differ
from the old session. Host takeover/handback still invalidates stored observations
and queued input; a new controller observation is required after handback.

Linux protocol/session tests do not establish compositor, PipeWire or macOS
native behavior. Real permission dialogs, source/scale changes, multiple monitors,
accessibility matching, Unicode input and distribution signing remain platform
acceptance work; no real-machine validation was run for this implementation.

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

The Host's desktop assignment admits Windows input. Auto clicks, typing, keys and drags use real input.
Explicit accessibility clicks invoke UIA actions. Typing inserts at the selected/focused control's
selection, while `set_value` replaces its value and checks readback. Activation restores a minimized
window and validates foreground/native keyboard focus before each input batch. Lost focus interrupts
later input without declaring human takeover. `app_post` retains directed messages for native controls;
background text requires an actual Edit/RichEdit handle in the selected window. `set_value` uses UIA;
UIA focus/value actions require no additional environment flag. `VARIN_COMPUTER_ALLOW_APP_LAUNCH`
still controls implicit process-name launching; the explicit `open` operation is separate.

Windows app selection prefers a PID or exact process name (with an optional
`.exe` suffix), then an exact window title, then a title substring. A folder or
document title containing an app's name must not override that running app.

## Provenance

Substantial portions of `windows/runtime.ps1` and `linux/runtime.py` are
adapted from [open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use),
MIT License (baseline `51f3a59`, 2026-09-28). Changes: persistent host loop,
global SendInput paths, `PrintWindow` capture, `release_input`,
`capabilities`, Varin flag names.

The complete upstream notice is retained in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

Host cancellation drops queued input and signals the in-flight op. On Windows,
`native-win32.cs` declares the native API and `input-controller.cs` owns input,
held-key tracking and a release channel independently of the MTA PowerShell UIA
worker. A `<id>.release` command fences the owner and writes an atomic release
acknowledgement before the Host closes the helper. Linux/macOS use the request
cancel flag followed by `release_input`, keeping the original shared capture
session alive during ordinary job cancellation. A crashed helper loses its
tracking state; a replacement cannot safely send blanket key-up events because
they could release a person's held keys or mouse buttons. A lost driver response
therefore leaves the action effect and any held-input state unknown. Post-action
capture failure preserves the input acceptance. Inspect the desktop before
retrying.
Drivers are staged inside the compiled Application Host generation at `server/computer-driver`, so publication replaces code and scripts together. Environment overrides remain explicit. On Debian and Ubuntu, the explicit Prepare Desktop operation installs the graphical session and its native packages. Existing local console desktops still require their own graphical session and platform packages.

Packaged Electron Hosts pass the physical `app.asar.unpacked` driver directory
to external interpreters. The Windows launcher configures UTF-8 input, output
and error output before loading the driver, so both multilingual operations and
startup failures use the same transport encoding.

Windows automatic selection excludes hidden, cloaked, shell/helper and 1×1 placeholder windows;
it prefers the foreground application window, then a non-minimized titled window. Explicit handles
retain their exact targets; ambiguous title selectors report the need to choose a handle.

See [current platform limits](../../docs/resources.md#computer-use-与平台边界)
and [runtime acceptance](../../docs/runtime-acceptance.md) for native/installed-product boundaries.
