# Varin Computer Use 鈥?Windows driver runtime library.
#
# Dot-sourced by driver-host.ps1, which keeps this code resident in the
# interactive desktop session and feeds it one JSON operation per request.
#
# Adapted from open-codex-computer-use (MIT License, baseline 51f3a59):
#   apps/OpenComputerUseWindows/runtime.ps1
# The original spawned powershell.exe per action and could not perform real
# global-coordinate input. This runtime keeps the UIA tree walk and
# background-capable window-message input, and adds:
#   - SendInput/SetCursorPos global pointer, key, and Unicode text input
#     (click_method "global", drag input "global", text/key input "global").
#   - PrintWindow-based window capture with CopyFromScreen fallback; fidelity
#     still depends on the application's rendering/capture support.
#   - release_input, which lifts any held buttons/keys after a cancel.
#   - capabilities, reporting the honest driver feature table.
#
# Background-capable operations deliberately avoid stealing foreground focus
# by default, matching the product rule that local-console work should prefer
# semantic and directed input over seizing the user's pointer.

$ErrorActionPreference = "Stop"
$script:VarinComputerDriverVersion = "0.1.0"
$DefaultTextLimit = 500
$AccessibilityTreeMaxNodeCount = 1200
$AccessibilityTreeMaxDepth = 64

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class VarinWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public INPUTUNION union;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x01000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public const uint PW_RENDERFULLCONTENT = 0x00000002;

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool PostMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    public static INPUT MouseInput(int dx, int dy, uint flags, uint data) {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.union = new INPUTUNION();
        input.union.mi = new MOUSEINPUT();
        input.union.mi.dx = dx;
        input.union.mi.dy = dy;
        input.union.mi.dwFlags = flags;
        input.union.mi.mouseData = data;
        return input;
    }

    public static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.union = new INPUTUNION();
        input.union.ki = new KEYBDINPUT();
        input.union.ki.wVk = vk;
        input.union.ki.wScan = scan;
        input.union.ki.dwFlags = flags;
        return input;
    }
}
"@

$WM_SETTEXT = 0x000C
$WM_MOUSEMOVE = 0x0200
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202
$WM_RBUTTONDOWN = 0x0204
$WM_RBUTTONUP = 0x0205
$WM_MBUTTONDOWN = 0x0207
$WM_MBUTTONUP = 0x0208
$WM_MOUSEWHEEL = 0x020A
$WM_MOUSEHWHEEL = 0x020E
$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$WM_CHAR = 0x0102
$EM_SETSEL = 0x00B1
$EM_REPLACESEL = 0x00C2

function Test-EnvFlagEnabled([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $false
    }
    $normalized = $value.Trim().ToLowerInvariant()
    return @("1", "true", "yes", "on") -contains $normalized
}

# ---------------------------------------------------------------------------
# Out-of-band cancellation. The stdin protocol is strictly sequential, so a
# long native operation (multi-line typing, tree walks, drag paths) cannot be
# interrupted by a cancel request arriving on stdin 鈥?it would only be read
# after the operation finished. Instead the Host writes
# "$VARIN_DRIVER_CANCEL_DIR/<requestId>.cancel", and long loops poll that file
# at operation checkpoints. driver-host.ps1 sets $script:ActiveRequestId
# around each request.
# ---------------------------------------------------------------------------

$script:CancelDirectory = $env:VARIN_DRIVER_CANCEL_DIR
$script:ActiveRequestId = $null

function Test-CancelRequested {
    if ([string]::IsNullOrWhiteSpace($script:CancelDirectory) -or [string]::IsNullOrWhiteSpace($script:ActiveRequestId)) {
        return $false
    }
    return [System.IO.File]::Exists([System.IO.Path]::Combine($script:CancelDirectory, "$($script:ActiveRequestId).cancel"))
}

# $progress describes how far the operation got, e.g. "typed 12 of 40
# characters"; it becomes the caller-visible detail so a cancelled action can
# honestly report its partial effect. Call sites in tight loops (per
# character, per tree node) may pass an empty string.
function Assert-NotCancelled([string]$progress = "") {
    if (Test-CancelRequested) {
        $detail = "cancelled"
        if (-not [string]::IsNullOrWhiteSpace($progress)) { $detail = "cancelled ($progress)" }
        throw (New-Object System.OperationCanceledException $detail)
    }
}

# PS 5.1 throws "参数类型不匹配" (ArgumentException) when @() wraps a
# Generic.List, at statement level and inside hashtable literals alike.
# Generic.List enumerates everywhere else, so only normalize to object[] at
# boundaries that need a real array.
function ConvertTo-ObjectArray($value) {
    if ($null -eq $value) { return @() }
    if ($value -is [System.Collections.IList]) { return $value.ToArray() }
    return @($value)
}

function New-Frame($x, $y, $width, $height) {
    if ($width -lt 0 -or $height -lt 0) {
        return $null
    }
    [pscustomobject]@{
        x = [double]$x
        y = [double]$y
        width = [double]$width
        height = [double]$height
    }
}

function ConvertTo-LParam([int]$x, [int]$y) {
    $packed = (($y -band 0xffff) -shl 16) -bor ($x -band 0xffff)
    [IntPtr]$packed
}

function ConvertTo-WheelWParam([int]$delta) {
    $packed = (($delta -band 0xffff) -shl 16)
    [IntPtr]$packed
}

function Send-PostedMessage([IntPtr]$hwnd, [uint32]$message, [IntPtr]$wParam, [IntPtr]$lParam) {
    if (-not [VarinWin32]::PostMessage($hwnd, $message, $wParam, $lParam)) {
        throw "Windows did not accept the window input message"
    }
}

function Get-WindowRectFrame([IntPtr]$hwnd) {
    $rect = New-Object VarinWin32+RECT
    if ([VarinWin32]::GetWindowRect($hwnd, [ref]$rect)) {
        return New-Frame $rect.Left $rect.Top ($rect.Right - $rect.Left) ($rect.Bottom - $rect.Top)
    }
    return $null
}

function Get-ElementFrame($element, $windowBounds) {
    try {
        $rect = $element.Current.BoundingRectangle
        if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) {
            return $null
        }
        if ($null -ne $windowBounds) {
            return New-Frame ($rect.X - $windowBounds.x) ($rect.Y - $windowBounds.y) $rect.Width $rect.Height
        }
        return New-Frame $rect.X $rect.Y $rect.Width $rect.Height
    } catch {
        return $null
    }
}

function Get-ScreenPoint($localFrame, $windowBounds) {
    if ($null -eq $localFrame -or $null -eq $windowBounds) {
        return $null
    }
    [pscustomobject]@{
        x = [int][math]::Round($windowBounds.x + $localFrame.x + ($localFrame.width / 2))
        y = [int][math]::Round($windowBounds.y + $localFrame.y + ($localFrame.height / 2))
    }
}

function Send-MouseClick([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$button, [int]$count) {
    $point = New-Object VarinWin32+POINT
    $point.X = $screenX
    $point.Y = $screenY
    [void][VarinWin32]::ScreenToClient($hwnd, [ref]$point)
    $lParam = ConvertTo-LParam $point.X $point.Y

    $down = $WM_LBUTTONDOWN
    $up = $WM_LBUTTONUP
    $downFlag = 0x0001
    if ($button -eq "right") {
        $down = $WM_RBUTTONDOWN
        $up = $WM_RBUTTONUP
        $downFlag = 0x0002
    } elseif ($button -eq "middle") {
        $down = $WM_MBUTTONDOWN
        $up = $WM_MBUTTONUP
        $downFlag = 0x0010
    }

    $repeat = [math]::Max(1, $count)
    for ($i = 0; $i -lt $repeat; $i++) {
        Assert-NotCancelled ("sent $i of $repeat clicks")
        Send-PostedMessage $hwnd $WM_MOUSEMOVE ([IntPtr]::Zero) $lParam
        Send-PostedMessage $hwnd $down ([IntPtr]$downFlag) $lParam
        Start-Sleep -Milliseconds 35
        Send-PostedMessage $hwnd $up ([IntPtr]::Zero) $lParam
        Start-Sleep -Milliseconds 50
    }
}

function Send-Drag([IntPtr]$hwnd, [int]$fromX, [int]$fromY, [int]$toX, [int]$toY) {
    $start = New-Object VarinWin32+POINT
    $start.X = $fromX
    $start.Y = $fromY
    [void][VarinWin32]::ScreenToClient($hwnd, [ref]$start)
    $end = New-Object VarinWin32+POINT
    $end.X = $toX
    $end.Y = $toY
    [void][VarinWin32]::ScreenToClient($hwnd, [ref]$end)

    $steps = 12
    $startParam = ConvertTo-LParam $start.X $start.Y
    Send-PostedMessage $hwnd $WM_MOUSEMOVE ([IntPtr]::Zero) $startParam
    Send-PostedMessage $hwnd $WM_LBUTTONDOWN ([IntPtr]1) $startParam
    try {
        for ($i = 1; $i -le $steps; $i++) {
            Assert-NotCancelled ("dragged $i of $steps steps; the button may still be held")
            $x = [int][math]::Round($start.X + (($end.X - $start.X) * $i / $steps))
            $y = [int][math]::Round($start.Y + (($end.Y - $start.Y) * $i / $steps))
            Send-PostedMessage $hwnd $WM_MOUSEMOVE ([IntPtr]1) (ConvertTo-LParam $x $y)
            Start-Sleep -Milliseconds 20
        }
    } finally {
        # The posted button is not part of SendInput's held-input table.
        Send-PostedMessage $hwnd $WM_LBUTTONUP ([IntPtr]::Zero) (ConvertTo-LParam $end.X $end.Y)
    }
}

function Send-Scroll([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$direction, [double]$pages) {
    $point = New-Object VarinWin32+POINT
    $point.X = $screenX
    $point.Y = $screenY
    [void][VarinWin32]::ScreenToClient($hwnd, [ref]$point)
    $lParam = ConvertTo-LParam $point.X $point.Y
    $delta = [int][math]::Round(120 * $pages)
    $message = $WM_MOUSEWHEEL
    if ($direction -eq "down" -or $direction -eq "right") {
        $delta = -1 * $delta
    }
    if ($direction -eq "left" -or $direction -eq "right") {
        $message = $WM_MOUSEHWHEEL
    }
    Send-PostedMessage $hwnd $message (ConvertTo-WheelWParam $delta) $lParam
}

function Send-Text([IntPtr]$hwnd, [string]$text) {
    $sent = 0
    foreach ($char in $text.ToCharArray()) {
        Assert-NotCancelled ("typed $sent of $($text.Length) characters")
        Send-PostedMessage $hwnd $WM_CHAR ([IntPtr][int][char]$char) ([IntPtr]::Zero)
        $sent++
        Start-Sleep -Milliseconds 8
    }
}

function Send-TextToEditHandle([IntPtr]$hwnd, [string]$text, $element) {
    if ($hwnd -eq [IntPtr]::Zero) {
        return $false
    }

    try {
        [void][VarinWin32]::SendMessage($hwnd, $EM_SETSEL, [IntPtr](-1), [IntPtr](-1))
        [void][VarinWin32]::SendMessage($hwnd, $EM_REPLACESEL, [IntPtr]1, $text)
        return $true
    } catch {
    }

    try {
        $current = ""
        if ($null -ne $element) {
            $current = Get-ElementValue $element
        }
        [void][VarinWin32]::SendMessage($hwnd, $WM_SETTEXT, [IntPtr]::Zero, ($current + $text))
        return $true
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# Real global input (SendInput). Unlike the PostMessage paths above these act
# on the session's shared pointer and keyboard state, so they are used only
# when the caller explicitly requests the `global` input path.
# ---------------------------------------------------------------------------

$script:HeldInputs = @{}
$script:InputWindow = [IntPtr]::Zero

function Send-ManagedInput($input) {
    $release = $null
    $key = $null
    $isUp = $false
    if ($input.type -eq [VarinWin32]::INPUT_KEYBOARD) {
        $keyboard = $input.union.ki
        $key = "key:$($keyboard.wVk):$($keyboard.wScan)"
        $isUp = ($keyboard.dwFlags -band [VarinWin32]::KEYEVENTF_KEYUP) -ne 0
        $release = [VarinWin32]::KeyInput($keyboard.wVk, $keyboard.wScan, ($keyboard.dwFlags -bor [VarinWin32]::KEYEVENTF_KEYUP))
    } else {
        foreach ($pair in @(@(2, 4), @(8, 16), @(32, 64))) {
            if (($input.union.mi.dwFlags -band ($pair[0] -bor $pair[1])) -ne 0) {
                $key = "mouse:$($pair[0])"
                $isUp = ($input.union.mi.dwFlags -band $pair[1]) -ne 0
                $release = [VarinWin32]::MouseInput(0, 0, $pair[1], 0)
            }
        }
    }
    if (-not $isUp -and $script:InputWindow -ne [IntPtr]::Zero -and [VarinWin32]::GetForegroundWindow() -ne $script:InputWindow) {
        throw "The target window lost foreground focus; input was stopped"
    }
    $sent = [VarinWin32]::SendInput(1, @($input), [System.Runtime.InteropServices.Marshal]::SizeOf([type][VarinWin32+INPUT]))
    if ($sent -ne 1) { throw "Windows did not accept the input event" }
    if ($key) {
        if ($isUp) { $script:HeldInputs.Remove($key) }
        else { $script:HeldInputs[$key] = $release }
    }
}

function Send-GlobalMouseInput([int]$screenX, [int]$screenY, [uint[]]$flags) {
    [void][VarinWin32]::SetCursorPos($screenX, $screenY)
    Start-Sleep -Milliseconds 15
    foreach ($flag in $flags) {
        $input = [VarinWin32]::MouseInput($screenX, $screenY, $flag, 0)
        Send-ManagedInput $input
        Start-Sleep -Milliseconds 40
    }
}

function Send-GlobalMouseClick([int]$screenX, [int]$screenY, [string]$button, [int]$count) {
    $downFlag = [VarinWin32]::MOUSEEVENTF_LEFTDOWN
    $upFlag = [VarinWin32]::MOUSEEVENTF_LEFTUP
    if ($button -eq "right") {
        $downFlag = [VarinWin32]::MOUSEEVENTF_RIGHTDOWN
        $upFlag = [VarinWin32]::MOUSEEVENTF_RIGHTUP
    } elseif ($button -eq "middle") {
        $downFlag = [VarinWin32]::MOUSEEVENTF_MIDDLEDOWN
        $upFlag = [VarinWin32]::MOUSEEVENTF_MIDDLEUP
    }
    $repeat = [math]::Max(1, $count)
    for ($i = 0; $i -lt $repeat; $i++) {
        Assert-NotCancelled ("sent $i of $repeat clicks")
        Send-GlobalMouseInput $screenX $screenY @($downFlag, $upFlag)
        Start-Sleep -Milliseconds 40
    }
}

function Send-GlobalDrag([int]$fromX, [int]$fromY, [int]$toX, [int]$toY) {
    [void][VarinWin32]::SetCursorPos($fromX, $fromY)
    Start-Sleep -Milliseconds 30
    $down = [VarinWin32]::MouseInput($fromX, $fromY, [VarinWin32]::MOUSEEVENTF_LEFTDOWN, 0)
    Send-ManagedInput $down
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
        Assert-NotCancelled ("dragged $i of $steps steps; the button is still held")
        $x = [int][math]::Round($fromX + (($toX - $fromX) * $i / $steps))
        $y = [int][math]::Round($fromY + (($toY - $fromY) * $i / $steps))
        $move = [VarinWin32]::MouseInput($x, $y, ([VarinWin32]::MOUSEEVENTF_MOVE -bor [VarinWin32]::MOUSEEVENTF_ABSOLUTE), 0)
        # Absolute moves need 0..65535-normalized coordinates; use relative here.
        [void][VarinWin32]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 20
    }
    $up = [VarinWin32]::MouseInput($toX, $toY, [VarinWin32]::MOUSEEVENTF_LEFTUP, 0)
    Send-ManagedInput $up
}

function Send-GlobalScroll([int]$screenX, [int]$screenY, [string]$direction, [double]$pages) {
    [void][VarinWin32]::SetCursorPos($screenX, $screenY)
    $delta = [int][math]::Round(120 * $pages)
    $flag = [VarinWin32]::MOUSEEVENTF_WHEEL
    if ($direction -eq "down" -or $direction -eq "left") {
        $delta = -1 * $delta
    }
    if ($direction -eq "left" -or $direction -eq "right") {
        $flag = [VarinWin32]::MOUSEEVENTF_HWHEEL
    }
    $data = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$delta), 0)
    $input = [VarinWin32]::MouseInput($screenX, $screenY, $flag, $data)
    Send-ManagedInput $input
}

function Send-GlobalText([string]$text) {
    $sent = 0
    foreach ($char in $text.ToCharArray()) {
        Assert-NotCancelled ("typed $sent of $($text.Length) characters")
        $code = [uint16][char]$char
        $down = [VarinWin32]::KeyInput(0, $code, [VarinWin32]::KEYEVENTF_UNICODE)
        $up = [VarinWin32]::KeyInput(0, $code, ([VarinWin32]::KEYEVENTF_UNICODE -bor [VarinWin32]::KEYEVENTF_KEYUP))
        Send-ManagedInput $down
        Send-ManagedInput $up
        $sent++
        Start-Sleep -Milliseconds 8
    }
}

function Send-GlobalKey([string]$key) {
    Assert-NotCancelled "before key chord $key"
    $parts = $key -split "\+"
    $main = $parts[$parts.Length - 1]
    $modifiers = @()
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        switch ($parts[$i].ToLowerInvariant()) {
            "ctrl" { $modifiers += 0x11 }
            "control" { $modifiers += 0x11 }
            "shift" { $modifiers += 0x10 }
            "alt" { $modifiers += 0x12 }
            "super" { $modifiers += 0x5B }
            "win" { $modifiers += 0x5B }
            "cmd" { $modifiers += 0x5B }
        }
    }
    foreach ($modifier in $modifiers) {
        $down = [VarinWin32]::KeyInput([uint16]$modifier, 0, 0)
        Send-ManagedInput $down
    }
    $vk = Get-VirtualKey $main
    Send-ManagedInput ([VarinWin32]::KeyInput([uint16]$vk, 0, 0))
    Start-Sleep -Milliseconds 30
    Send-ManagedInput ([VarinWin32]::KeyInput([uint16]$vk, 0, [VarinWin32]::KEYEVENTF_KEYUP))
    [array]::Reverse($modifiers)
    foreach ($modifier in $modifiers) {
        Send-ManagedInput ([VarinWin32]::KeyInput([uint16]$modifier, 0, [VarinWin32]::KEYEVENTF_KEYUP))
    }
}

function Send-ReleaseInput {
    # Release only inputs tracked by this driver. After a crash there is no
    # reliable way to distinguish old injected state from human-held input.
    $failed = 0
    foreach ($key in @($script:HeldInputs.Keys)) {
        try { Send-ManagedInput $script:HeldInputs[$key] } catch { $failed++ }
    }
    if ($failed -gt 0) { throw "Windows did not confirm release of $failed managed inputs" }
}

function Get-VirtualKey([string]$key) {
    $normalized = $key.ToLowerInvariant()
    $map = @{
        "return" = 0x0D; "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B
        "backspace" = 0x08; "back_space" = 0x08; "delete" = 0x2E; "space" = 0x20
        "left" = 0x25; "up" = 0x26; "right" = 0x27; "down" = 0x28
        "home" = 0x24; "end" = 0x23; "page_up" = 0x21; "prior" = 0x21; "page_down" = 0x22; "next" = 0x22
    }
    if ($map.ContainsKey($normalized)) {
        return $map[$normalized]
    }
    if ($normalized -match "^f([1-9]|1[0-2])$") {
        return 0x70 + [int]$Matches[1] - 1
    }
    if ($normalized -match "^kp_([0-9])$") {
        return 0x60 + [int]$Matches[1]
    }
    if ($normalized.Length -eq 1) {
        $code = [int][char]$normalized.ToUpperInvariant()[0]
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) {
            return $code
        }
    }
    throw "Unsupported key: $key"
}

function Send-Key([IntPtr]$hwnd, [string]$key) {
    Assert-NotCancelled "before key chord $key"
    $parts = $key -split "\+"
    $main = $parts[$parts.Length - 1]
    $modifiers = @()
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        switch ($parts[$i].ToLowerInvariant()) {
            "ctrl" { $modifiers += 0x11 }
            "control" { $modifiers += 0x11 }
            "shift" { $modifiers += 0x10 }
            "alt" { $modifiers += 0x12 }
            "super" { $modifiers += 0x5B }
            "win" { $modifiers += 0x5B }
            "cmd" { $modifiers += 0x5B }
        }
    }
    $postedModifiers = @()
    $mainDown = $false
    $vk = Get-VirtualKey $main
    try {
        foreach ($modifier in $modifiers) {
            Send-PostedMessage $hwnd $WM_KEYDOWN ([IntPtr]$modifier) ([IntPtr]::Zero)
            $postedModifiers += $modifier
        }
        Send-PostedMessage $hwnd $WM_KEYDOWN ([IntPtr]$vk) ([IntPtr]::Zero)
        $mainDown = $true
        Start-Sleep -Milliseconds 25
    } finally {
        $releaseError = $null
        if ($mainDown) {
            try { Send-PostedMessage $hwnd $WM_KEYUP ([IntPtr]$vk) ([IntPtr]::Zero) }
            catch { $releaseError = $_ }
        }
        [array]::Reverse($postedModifiers)
        foreach ($modifier in $postedModifiers) {
            try { Send-PostedMessage $hwnd $WM_KEYUP ([IntPtr]$modifier) ([IntPtr]::Zero) }
            catch { if ($null -eq $releaseError) { $releaseError = $_ } }
        }
        if ($null -ne $releaseError) { throw $releaseError }
    }
}

# One EnumWindows pass over every top-level handle, grouped by owning pid 鈥?# not just MainWindowHandle, which is a single heuristic value and misses
# secondary documents, palettes, and borderless windows.
function Get-WindowProcessMap {
    $map = @{}
    $callback = [VarinWin32+EnumWindowsProc]{
        param($callbackHwnd, $lParam)
        $procId = 0
        [void][VarinWin32]::GetWindowThreadProcessId($callbackHwnd, [ref]$procId)
        if ($procId -ne 0) {
            $titleLength = [VarinWin32]::GetWindowTextLength($callbackHwnd)
            $builder = New-Object System.Text.StringBuilder ([math]::Max(1, $titleLength + 1))
            [void][VarinWin32]::GetWindowText($callbackHwnd, $builder, $builder.Capacity)
            if (-not $map.ContainsKey([int]$procId)) {
                $map[[int]$procId] = New-Object System.Collections.Generic.List[object]
            }
            $map[[int]$procId].Add([pscustomobject]@{
                handle = [int64]$callbackHwnd
                title = $builder.ToString()
                bounds = (Get-WindowRectFrame $callbackHwnd)
                visible = [bool][VarinWin32]::IsWindowVisible($callbackHwnd)
                minimized = [bool][VarinWin32]::IsIconic($callbackHwnd)
            })
        }
        return $true
    }
    [void][VarinWin32]::EnumWindows($callback, [IntPtr]::Zero)
    return $map
}

function Get-ProcessWindows([int]$processId) {
    $map = Get-WindowProcessMap
    if ($map.ContainsKey($processId)) { return ConvertTo-ObjectArray $map[$processId] }
    return @()
}

function Get-WindowDpiScale([IntPtr]$hwnd) {
    try {
        $dpi = [VarinWin32]::GetDpiForWindow($hwnd)
        if ($dpi -gt 0) { return [double]$dpi / 96.0 }
    } catch {
    }
    return $null
}

function Resolve-App([string]$query) {
    $normalized = $query.Trim()
    $processQuery = $normalized
    if ($processQuery.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $processQuery = $processQuery.Substring(0, $processQuery.Length - 4)
    }
    # A process has UI when it owns any top-level window 鈥?the processes list
    # is no longer filtered by MainWindowHandle alone.
    $script:ProcessWindows = Get-WindowProcessMap
    $processes = @(Get-Process | Where-Object { $script:ProcessWindows.ContainsKey([int]$_.Id) })
    $pidValue = 0
    if ([int]::TryParse($normalized, [ref]$pidValue)) {
        $match = $processes | Where-Object { $_.Id -eq $pidValue } | Select-Object -First 1
        if ($null -ne $match) {
            return $match
        }
    }

    $match = $processes | Where-Object {
        $candidate = $_
        $_.ProcessName -ieq $processQuery -or
        "$($_.ProcessName).exe" -ieq $normalized -or
        $_.MainWindowTitle -ieq $normalized -or
        $_.MainWindowTitle -ilike "*$normalized*" -or
        (@($script:ProcessWindows[[int]$candidate.Id] | Where-Object { $_.title -ieq $normalized -or $_.title -ilike "*$normalized*" }).Count) -gt 0
    } | Select-Object -First 1
    if ($null -ne $match) {
        return $match
    }

    if (Test-EnvFlagEnabled "VARIN_COMPUTER_ALLOW_APP_LAUNCH") {
        try {
            $started = Start-Process -FilePath $normalized -PassThru
            for ($i = 0; $i -lt 20; $i++) {
                Assert-NotCancelled "waiting for $normalized to open a window"
                Start-Sleep -Milliseconds 250
                $candidate = Get-Process -Id $started.Id -ErrorAction SilentlyContinue
                if ($null -ne $candidate -and $candidate.MainWindowHandle -ne 0) {
                    return $candidate
                }
            }
        } catch [System.OperationCanceledException] {
            throw
        } catch {
        }
    }

    throw "appNotFound(`"$query`")"
}

# Resolve which of the process's top-level windows an operation targets:
# a hwnd number, a window title (exact then contains), or absent = the main
# window when it exists, else the first visible window.
function Resolve-AppWindow($process, $selector) {
    $windows = ConvertTo-ObjectArray $script:ProcessWindows[[int]$process.Id]
    if ($windows.Count -eq 0) { $windows = ConvertTo-ObjectArray (Get-ProcessWindows ([int]$process.Id)) }
    $handle = [int64]0
    if ($null -ne $selector -and "$selector" -ne "") {
        if ([int64]::TryParse("$selector", [ref]$handle)) {
            $match = $windows | Where-Object { $_.handle -eq $handle } | Select-Object -First 1
            if ($null -eq $match) { throw "window handle $handle does not belong to $($process.ProcessName); observe again" }
            return [IntPtr]$match.handle
        }
        $title = "$selector"
        $match = $windows | Where-Object { $_.title -ieq $title } | Select-Object -First 1
        if ($null -eq $match) { $match = $windows | Where-Object { $_.title -ilike "*$title*" } | Select-Object -First 1 }
        if ($null -eq $match) { throw "no window of $($process.ProcessName) matches title `"$title`"" }
        return [IntPtr]$match.handle
    }
    if ($process.MainWindowHandle -ne 0) { return [IntPtr]$process.MainWindowHandle }
    $visible = $windows | Where-Object { $_.visible -and -not $_.minimized } | Select-Object -First 1
    if ($null -ne $visible) { return [IntPtr]$visible.handle }
    if ($windows.Count -gt 0) { return [IntPtr]$windows[0].handle }
    return [IntPtr]::Zero
}

function Get-MainElement($process, [IntPtr]$hwnd = [IntPtr]::Zero) {
    if ($hwnd -ne [IntPtr]::Zero -and [VarinWin32]::IsWindow($hwnd)) {
        return [Windows.Automation.AutomationElement]::FromHandle($hwnd)
    }
    if ($process.MainWindowHandle -ne 0) {
        return [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$process.MainWindowHandle)
    }
    $condition = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::ProcessIdProperty), $process.Id
    $children = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
    if ($children.Count -gt 0) {
        return $children.Item(0)
    }
    throw "No top-level UI Automation window is available for $($process.ProcessName). Run the Windows driver in the signed-in desktop session."
}

function Get-WindowBounds($process, $element, [IntPtr]$hwnd = [IntPtr]::Zero) {
    if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [IntPtr]$process.MainWindowHandle }
    if ($hwnd -ne [IntPtr]::Zero) {
        $fromWin32 = Get-WindowRectFrame $hwnd
        if ($null -ne $fromWin32) {
            return $fromWin32
        }
    }
    try {
        $rect = $element.Current.BoundingRectangle
        if (-not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
            return New-Frame $rect.X $rect.Y $rect.Width $rect.Height
        }
    } catch {
    }
    return $null
}

function Get-PatternNames($element) {
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($pattern in $element.GetSupportedPatterns()) {
        $programmatic = $pattern.ProgrammaticName
        if ($programmatic -like "InvokePatternIdentifiers.Pattern") { $names.Add("Invoke") }
        elseif ($programmatic -like "TogglePatternIdentifiers.Pattern") { $names.Add("Toggle") }
        elseif ($programmatic -like "SelectionItemPatternIdentifiers.Pattern") { $names.Add("Select") }
        elseif ($programmatic -like "ExpandCollapsePatternIdentifiers.Pattern") {
            try {
                $state = $element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState
                if ($state -eq [Windows.Automation.ExpandCollapseState]::Collapsed) { $names.Add("Expand") }
                elseif ($state -eq [Windows.Automation.ExpandCollapseState]::Expanded) { $names.Add("Collapse") }
            } catch {
                $names.Add("Expand")
                $names.Add("Collapse")
            }
        }
        elseif ($programmatic -like "ScrollItemPatternIdentifiers.Pattern") { $names.Add("ScrollIntoView") }
        elseif ($programmatic -like "ScrollPatternIdentifiers.Pattern") { $names.Add("Scroll") }
        elseif ($programmatic -like "ValuePatternIdentifiers.Pattern") { $names.Add("SetValue") }
    }
    if ($names.Count -gt 0) {
        return @($names | Select-Object -Unique)
    }
    return @()
}

function Get-ElementString($element, [string]$propertyName) {
    try {
        $value = $element.Current.$propertyName
        if ($null -eq $value) {
            return ""
        }
        return [string]$value
    } catch {
        return ""
    }
}

function Get-ElementInt64($element, [string]$propertyName) {
    try {
        return [int64]$element.Current.$propertyName
    } catch {
        return 0
    }
}

function Get-ElementControlTypeName($element) {
    try {
        $controlType = $element.Current.ControlType
        if ($null -eq $controlType) {
            return ""
        }
        return [string]$controlType.ProgrammaticName
    } catch {
        return ""
    }
}

function Resolve-TextLimit($Value) {
    if ($null -eq $Value) {
        return $script:DefaultTextLimit
    }
    if ($Value -is [string] -and $Value.Trim().ToLowerInvariant() -eq "max") {
        return $null
    }
    if ($Value -is [bool]) {
        return $script:DefaultTextLimit
    }
    try {
        $integer = [int]$Value
        if ($integer -gt 0) {
            return $integer
        }
    } catch {
    }
    return $script:DefaultTextLimit
}

function Limit-Text([string]$Text, $TextLimit = $script:DefaultTextLimit) {
    if ($null -eq $Text) {
        return ""
    }
    if ($null -eq $TextLimit) {
        return $Text
    }
    $effectiveTextLimit = [int]$TextLimit
    if ($Text.Length -gt $effectiveTextLimit) {
        return $Text.Substring(0, $effectiveTextLimit) + "..."
    }
    return $Text
}

function Get-ElementValue($element, $TextLimit = $script:DefaultTextLimit) {
    try {
        $valuePattern = $element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        $value = $valuePattern.Current.Value
        if ($null -eq $value) {
            return ""
        }
        $text = [string]$value
        return Limit-Text $text $TextLimit
    } catch {
        return ""
    }
}

function Get-ElementRecord($element, [int]$index, $windowBounds, $TextLimit = $script:DefaultTextLimit) {
    $frame = Get-ElementFrame $element $windowBounds
    $runtimeId = @()
    try { $runtimeId = @($element.GetRuntimeId()) } catch {}
    [pscustomobject]@{
        index = $index
        runtimeId = $runtimeId
        automationId = Get-ElementString $element "AutomationId"
        name = Limit-Text (Get-ElementString $element "Name") $TextLimit
        controlType = Get-ElementControlTypeName $element
        localizedControlType = Get-ElementString $element "LocalizedControlType"
        className = Get-ElementString $element "ClassName"
        value = Get-ElementValue $element $TextLimit
        nativeWindowHandle = Get-ElementInt64 $element "NativeWindowHandle"
        frame = $frame
        actions = @(Get-PatternNames $element)
    }
}

function Get-ElementTitle($record) {
    if (-not [string]::IsNullOrWhiteSpace($record.name)) {
        return $record.name
    }
    if (-not [string]::IsNullOrWhiteSpace($record.automationId)) {
        return "ID: $($record.automationId)"
    }
    return ""
}

function Render-Tree($element, $windowBounds, $TextLimit = $script:DefaultTextLimit, [int]$MaxTreeNodes = $script:AccessibilityTreeMaxNodeCount, [int]$MaxTreeDepth = $script:AccessibilityTreeMaxDepth) {
    $records = New-Object System.Collections.Generic.List[object]
    $lines = New-Object System.Collections.Generic.List[string]
    $visited = New-Object System.Collections.Generic.HashSet[string]
    $nextIndex = 0
    $effectiveMaxTreeNodes = if ($MaxTreeNodes -gt 0) { $MaxTreeNodes } else { $script:AccessibilityTreeMaxNodeCount }
    $effectiveMaxTreeDepth = if ($MaxTreeDepth -gt 0) { $MaxTreeDepth } else { $script:AccessibilityTreeMaxDepth }

    function Visit($node, [int]$depth) {
        Assert-NotCancelled ("walked $($script:nextIndex) of up to $($script:MaxTreeNodes) tree nodes")
        if ($script:nextIndex -ge $script:MaxTreeNodes -or $depth -gt $script:MaxTreeDepth) {
            return
        }
        $runtime = ""
        try { $runtime = (@($node.GetRuntimeId()) -join ".") } catch { $runtime = [guid]::NewGuid().ToString() }
        if (-not $script:visited.Add($runtime)) {
            return
        }

        $index = $script:nextIndex
        $script:nextIndex++
        $record = Get-ElementRecord $node $index $script:windowBounds $TextLimit
        $script:records.Add($record)

        $role = $record.localizedControlType
        if ([string]::IsNullOrWhiteSpace($role)) {
            $role = $record.controlType
        }
        $title = Get-ElementTitle $record
        $actionsSegment = ""
        if ($record.actions.Count -gt 0) {
            $actionsSegment = " Secondary Actions: " + ($record.actions -join ", ")
        }
        $valueSegment = ""
        if (-not [string]::IsNullOrWhiteSpace($record.value) -and $record.value -ne $title) {
            $safeValue = (($record.value -replace "`r", "\\r") -replace "`n", "\\n")
            $valueSegment = " Value: $safeValue"
        }
        $frameSegment = ""
        if ($null -ne $record.frame) {
            $frameSegment = " Frame: {{x: {0}, y: {1}, width: {2}, height: {3}}}" -f [int][math]::Round($record.frame.x), [int][math]::Round($record.frame.y), [int][math]::Round($record.frame.width), [int][math]::Round($record.frame.height)
        }
        $script:lines.Add(("`t" * ($depth + 1)) + "$index $role $title$valueSegment$actionsSegment$frameSegment")

        try {
            $children = $node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) {
                Visit $children.Item($i) ($depth + 1)
            }
        } catch {
        }
    }

    $script:records = $records
    $script:lines = $lines
    $script:visited = $visited
    $script:nextIndex = $nextIndex
    $script:windowBounds = $windowBounds
    $script:MaxTreeNodes = $effectiveMaxTreeNodes
    $script:MaxTreeDepth = $effectiveMaxTreeDepth
    Visit $element 0

    [pscustomobject]@{
        records = $records.ToArray()
        lines = $lines.ToArray()
    }
}

function Test-BitmapBlank($bitmap) {
    # A uniform-black capture usually means PrintWindow could not render the
    # window (e.g. GPU-composited content) and the screen-copy fallback is
    # required.
    try {
        $sample = @(
            $bitmap.GetPixel(0, 0),
            $bitmap.GetPixel([math]::Min(5, $bitmap.Width - 1), [math]::Min(5, $bitmap.Height - 1)),
            $bitmap.GetPixel([math]::Max(0, $bitmap.Width - 6), [math]::Max(0, $bitmap.Height - 6))
        )
        foreach ($pixel in $sample) {
            if ($pixel.R -gt 12 -or $pixel.G -gt 12 -or $pixel.B -gt 12) {
                return $false
            }
        }
        return $true
    } catch {
        return $true
    }
}

function Capture-WindowPngBase64([IntPtr]$hwnd, $bounds) {
    if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) {
        return $null
    }
    $width = [int][math]::Round($bounds.width)
    $height = [int][math]::Round($bounds.height)

    # PrintWindow renders the window's own surface, so a covered window still
    # produces its real content instead of the occluding windows' pixels.
    if ($hwnd -ne [IntPtr]::Zero) {
        try {
            $bitmap = New-Object System.Drawing.Bitmap $width, $height
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $hdc = $graphics.GetHdc()
            try {
                [void][VarinWin32]::PrintWindow($hwnd, $hdc, [VarinWin32]::PW_RENDERFULLCONTENT)
            } finally {
                $graphics.ReleaseHdc($hdc)
            }
            if (-not (Test-BitmapBlank $bitmap)) {
                $stream = New-Object System.IO.MemoryStream
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                $graphics.Dispose()
                $bitmap.Dispose()
                $bytes = $stream.ToArray()
                $stream.Dispose()
                return [Convert]::ToBase64String($bytes)
            }
            $graphics.Dispose()
            $bitmap.Dispose()
        } catch {
        }
    }

    try {
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen([int][math]::Round($bounds.x), [int][math]::Round($bounds.y), 0, 0, $bitmap.Size)
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
        $bytes = $stream.ToArray()
        $stream.Dispose()
        return [Convert]::ToBase64String($bytes)
    } catch {
        return $null
    }
}

function Capture-DesktopFrame([double]$Quality = 65) {
    # The viewer contract (BC5) needs the whole desktop, not one window: the
    # union of every screen at physical-pixel scale. JPEG keeps a 4fps stream
    # small enough for a local SSE channel.
    $left = 0; $top = 0; $right = 0; $bottom = 0
    foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
        $left = [math]::Min($left, $screen.Bounds.Left)
        $top = [math]::Min($top, $screen.Bounds.Top)
        $right = [math]::Max($right, $screen.Bounds.Right)
        $bottom = [math]::Max($bottom, $screen.Bounds.Bottom)
    }
    $width = $right - $left
    $height = $bottom - $top
    if ($width -le 0 -or $height -le 0) { return $null }
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
        $jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" } | Select-Object -First 1
        $stream = New-Object System.IO.MemoryStream
        if ($null -ne $jpeg) {
            $params = New-Object System.Drawing.Imaging.EncoderParameters 1
            $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, ([int64][math]::Round($Quality)))
            $bitmap.Save($stream, $jpeg, $params)
            $params.Dispose()
            $mime = "image/jpeg"
        } else {
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            $mime = "image/png"
        }
        $bytes = $stream.ToArray()
        $stream.Dispose()
        return [pscustomobject]@{
            mime = $mime
            base64 = [Convert]::ToBase64String($bytes)
            bounds = (New-Frame $left $top $width $height)
            capturedAt = (Get-Date).ToUniversalTime().ToString("o")
        }
    } catch {
        return $null
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Invoke-HumanInput($operation) {
    # Human-control input (BC5): absolute screen coordinates straight to the
    # desktop session — no app/window binding, no observation needed. The
    # control owner check is the Host's job; the driver just emits input.
    $kind = [string]$operation.kind
    switch ($kind) {
        "click" { Send-GlobalMouseClick ([int]$operation.x) ([int]$operation.y) ([string]$operation.button) ([int]$operation.count) }
        "down"  {
            $flag = [VarinWin32]::MOUSEEVENTF_LEFTDOWN
            if ($operation.button -eq "right") { $flag = [VarinWin32]::MOUSEEVENTF_RIGHTDOWN }
            elseif ($operation.button -eq "middle") { $flag = [VarinWin32]::MOUSEEVENTF_MIDDLEDOWN }
            Send-GlobalMouseInput ([int]$operation.x) ([int]$operation.y) @($flag)
        }
        "up"    {
            $flag = [VarinWin32]::MOUSEEVENTF_LEFTUP
            if ($operation.button -eq "right") { $flag = [VarinWin32]::MOUSEEVENTF_RIGHTUP }
            elseif ($operation.button -eq "middle") { $flag = [VarinWin32]::MOUSEEVENTF_MIDDLEUP }
            Send-GlobalMouseInput ([int]$operation.x) ([int]$operation.y) @($flag)
        }
        "move"  { [void][VarinWin32]::SetCursorPos([int]$operation.x, [int]$operation.y) }
        "scroll" { Send-GlobalScroll ([int]$operation.x) ([int]$operation.y) ([string]$operation.direction) ([double]$operation.pages) }
        "key"   { Send-GlobalKey ([string]$operation.key) }
        "text"  { Send-GlobalText ([string]$operation.text) }
        default { throw "unsupportedHumanInput(`"$kind`")" }
    }
}

function Get-FocusedSummary($processId, $TextLimit = $script:DefaultTextLimit) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused -and $focused.Current.ProcessId -eq $processId) {
            $role = $focused.Current.LocalizedControlType
            $name = Limit-Text $focused.Current.Name $TextLimit
            if ([string]::IsNullOrWhiteSpace($name)) {
                return $role
            }
            return "$role $name"
        }
    } catch {
    }
    return $null
}

function Get-SelectedText($processId, $TextLimit = $script:DefaultTextLimit) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $focused -or $focused.Current.ProcessId -ne $processId) {
            return $null
        }
        $textPattern = $focused.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)
        $selection = $textPattern.GetSelection()
        if ($selection.Count -gt 0) {
            $maxLength = if ($null -eq $TextLimit) { -1 } else { [int]$TextLimit + 1 }
            return Limit-Text ($selection.Item(0).GetText($maxLength)) $TextLimit
        }
    } catch {
    }
    return $null
}

function Build-Snapshot([string]$query, $TextLimit = $script:DefaultTextLimit, [int]$MaxTreeNodes = $script:AccessibilityTreeMaxNodeCount, [int]$MaxTreeDepth = $script:AccessibilityTreeMaxDepth, [bool]$Screenshot = $true, $WindowSelector = $null) {
    $process = Resolve-App $query
    $hwnd = Resolve-AppWindow $process $WindowSelector
    $element = Get-MainElement $process $hwnd
    $bounds = Get-WindowBounds $process $element $hwnd
    Assert-NotCancelled "resolved the target window"
    $rendered = Render-Tree $element $bounds $TextLimit $MaxTreeNodes $MaxTreeDepth
    Assert-NotCancelled "rendered the accessibility tree"
    $windows = ConvertTo-ObjectArray $script:ProcessWindows[[int]$process.Id]
    $selectedTitle = ""
    foreach ($window in $windows) {
        $window | Add-Member -NotePropertyName "main" -NotePropertyValue ($window.handle -eq [int64]$process.MainWindowHandle) -Force
        if ($window.handle -eq [int64]$hwnd) { $selectedTitle = $window.title }
    }
    [pscustomobject]@{
        app = [pscustomobject]@{
            name = $process.ProcessName
            bundleIdentifier = $process.ProcessName
            pid = [int]$process.Id
        }
        windowTitle = $(if ([string]::IsNullOrWhiteSpace($selectedTitle)) { Limit-Text $process.MainWindowTitle $TextLimit } else { Limit-Text $selectedTitle $TextLimit })
        windowHandle = [int64]$hwnd
        windowBounds = $bounds
        dpiScale = Get-WindowDpiScale $hwnd
        windows = @($windows)
        screenshotPngBase64 = $(if ($Screenshot) { Capture-WindowPngBase64 $hwnd $bounds } else { $null })
        treeLines = @($rendered.lines)
        focusedSummary = Get-FocusedSummary $process.Id $TextLimit
        selectedText = Get-SelectedText $process.Id $TextLimit
        elements = @($rendered.records)
    }
}

function List-Apps {
    $lines = New-Object System.Collections.Generic.List[string]
    $apps = New-Object System.Collections.Generic.List[object]
    $map = Get-WindowProcessMap
    foreach ($process in (Get-Process | Where-Object { $map.ContainsKey([int]$_.Id) } | Sort-Object ProcessName, Id)) {
        $windows = ConvertTo-ObjectArray $map[[int]$process.Id]
        $title = $process.MainWindowTitle
        if ([string]::IsNullOrWhiteSpace($title)) {
            $visible = $windows | Where-Object { $_.visible -and -not [string]::IsNullOrWhiteSpace($_.title) } | Select-Object -First 1
            $title = if ($null -ne $visible) { $visible.title } else { "untitled" }
        }
        foreach ($window in $windows) {
            $window | Add-Member -NotePropertyName "main" -NotePropertyValue ($window.handle -eq [int64]$process.MainWindowHandle) -Force
        }
        $lines.Add(("{0} -- {1} [running, pid={2}, window={3}]" -f $process.ProcessName, $process.ProcessName, $process.Id, $title))
        $apps.Add([pscustomobject]@{ name = $process.ProcessName; pid = [int]$process.Id; windowTitle = $title; windows = @($windows) })
    }
    return [pscustomobject]@{ text = ($lines -join "`n"); apps = $apps.ToArray() }
}

function Get-DriverCapabilities {
    $displays = New-Object System.Collections.Generic.List[object]
    try {
        foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
            $displays.Add([pscustomobject]@{
                x = [double]$screen.Bounds.X
                y = [double]$screen.Bounds.Y
                width = [double]$screen.Bounds.Width
                height = [double]$screen.Bounds.Height
                primary = [bool]$screen.Primary
            })
        }
    } catch {
    }
    [pscustomobject]@{
        platform = "windows"
        driver = "windows-uia"
        driverVersion = $script:VarinComputerDriverVersion
        observeTree = $true
        screenshot = $true
        elementAction = $true
        coordinateInput = $true
        textInput = $true
        drag = $true
        dpiAware = $true
        displays = $displays.ToArray()
        # The driver enumerates every top-level window per process, binds
        # observation/input to a chosen hwnd, and renders occluded windows
        # through PrintWindow before falling back to the screen grid.
        multiWindow = $true
        occludedCapture = $true
        # Long operations poll the cancel side-channel at their internal
        # checkpoints; a cancel lands mid-operation, not after it.
        interruptibleInput = $true
        sessionType = "windows-console"
        status = "ready"
    }
}

function Same-RuntimeId($left, $right) {
    if ($null -eq $left -or $null -eq $right -or $left.Count -ne $right.Count) {
        return $false
    }
    for ($i = 0; $i -lt $left.Count; $i++) {
        if ([int]$left[$i] -ne [int]$right[$i]) {
            return $false
        }
    }
    return $true
}

function Get-AllElements($root) {
    $items = New-Object System.Collections.Generic.List[object]
    $items.Add($root)
    try {
        $descendants = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        for ($i = 0; $i -lt $descendants.Count; $i++) {
            $items.Add($descendants.Item($i))
        }
    } catch {
    }
    return $items.ToArray()
}

function Find-Element($process, $record, $rootOverride = $null) {
    if ($null -eq $record) {
        return $null
    }
    $root = if ($null -ne $rootOverride) { $rootOverride } else { Get-MainElement $process }
    foreach ($element in (Get-AllElements $root)) {
        Assert-NotCancelled "matching the observed element in the live tree"
        try {
            if (Same-RuntimeId @($element.GetRuntimeId()) @($record.runtimeId)) {
                return $element
            }
        } catch {
        }
    }
    foreach ($element in (Get-AllElements $root)) {
        try {
            $sameAutomationId = -not [string]::IsNullOrWhiteSpace($record.automationId) -and $element.Current.AutomationId -eq $record.automationId
            $sameName = -not [string]::IsNullOrWhiteSpace($record.name) -and $element.Current.Name -eq $record.name
            $sameType = $element.Current.ControlType.ProgrammaticName -eq $record.controlType
            if (($sameAutomationId -or $sameName) -and $sameType) {
                return $element
            }
        } catch {
        }
    }
    return $null
}

function Get-CurrentPatternOrNull($element, $pattern) {
    try {
        return $element.GetCurrentPattern($pattern)
    } catch {
        return $null
    }
}

function Invoke-PreferredClick($element) {
    $invoke = Get-CurrentPatternOrNull $element ([Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $invoke) {
        $invoke.Invoke()
        return $true
    }
    $selection = Get-CurrentPatternOrNull $element ([Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -ne $selection) {
        $selection.Select()
        return $true
    }
    $toggle = Get-CurrentPatternOrNull $element ([Windows.Automation.TogglePattern]::Pattern)
    if ($null -ne $toggle) {
        $toggle.Toggle()
        return $true
    }
    return $false
}

function Invoke-SecondaryAction($element, [string]$action) {
    switch ($action.ToLowerInvariant()) {
        "invoke" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.InvokePattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Invoke(); return }
        }
        "toggle" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.TogglePattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Toggle(); return }
        }
        "select" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Select(); return }
        }
        "expand" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Expand(); return }
        }
        "collapse" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Collapse(); return }
        }
        "scrollintoview" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ScrollItemPattern]::Pattern)
            if ($null -ne $pattern) { $pattern.ScrollIntoView(); return }
        }
        "setfocus" {
            if (-not (Test-EnvFlagEnabled "VARIN_COMPUTER_ALLOW_FOCUS_ACTIONS")) {
                throw "SetFocus is disabled by default to avoid stealing user focus; set VARIN_COMPUTER_ALLOW_FOCUS_ACTIONS=1 to enable it."
            }
            $element.SetFocus()
            return
        }
    }
    throw "$action is not a valid secondary action"
}

function Invoke-Scroll($element, [string]$direction, [double]$pages) {
    $scroll = Get-CurrentPatternOrNull $element ([Windows.Automation.ScrollPattern]::Pattern)
    if ($null -eq $scroll) {
        return $false
    }
    $horizontal = [Windows.Automation.ScrollAmount]::NoAmount
    $vertical = [Windows.Automation.ScrollAmount]::NoAmount
    if ($direction -eq "up") { $vertical = [Windows.Automation.ScrollAmount]::LargeDecrement }
    elseif ($direction -eq "down") { $vertical = [Windows.Automation.ScrollAmount]::LargeIncrement }
    elseif ($direction -eq "left") { $horizontal = [Windows.Automation.ScrollAmount]::LargeDecrement }
    elseif ($direction -eq "right") { $horizontal = [Windows.Automation.ScrollAmount]::LargeIncrement }
    $repeat = [math]::Max(1, [int][math]::Ceiling($pages))
    for ($i = 0; $i -lt $repeat; $i++) {
        Assert-NotCancelled ("scrolled $i of $repeat steps")
        $scroll.Scroll($horizontal, $vertical)
        Start-Sleep -Milliseconds 40
    }
    return $true
}

function Find-TextEntryElement($process) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused -and $focused.Current.ProcessId -eq $process.Id) {
            $focusedValue = Get-CurrentPatternOrNull $focused ([Windows.Automation.ValuePattern]::Pattern)
            if ($null -ne $focusedValue -and -not $focusedValue.Current.IsReadOnly) {
                return $focused
            }
        }
    } catch {
    }

    $root = Get-MainElement $process
    foreach ($element in (Get-AllElements $root)) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -eq $valuePattern -or $valuePattern.Current.IsReadOnly) {
            continue
        }
        $controlType = Get-ElementControlTypeName $element
        if ($controlType -like "*Edit*" -or $controlType -like "*Document*") {
            return $element
        }
    }

    foreach ($element in (Get-AllElements $root)) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
            return $element
        }
    }

    return $null
}

function Get-NativeWindowHandle($element) {
    $handle = Get-ElementInt64 $element "NativeWindowHandle"
    if ($handle -le 0) {
        return [IntPtr]::Zero
    }
    return [IntPtr]$handle
}

function Test-TextWindowHandleCandidate($process, $element) {
    if ($null -eq $element) {
        return $false
    }
    $handle = Get-NativeWindowHandle $element
    if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr]$process.MainWindowHandle) {
        return $false
    }
    $controlType = Get-ElementControlTypeName $element
    $className = Get-ElementString $element "ClassName"
    return (
        $controlType -like "*Edit*" -or
        $controlType -like "*Document*" -or
        $className -like "*Edit*" -or
        $className -like "*Rich*" -or
        $className -like "*Text*"
    )
}

function Find-TextEntryWindowHandle($process, $preferredElement) {
    if (Test-TextWindowHandleCandidate $process $preferredElement) {
        return Get-NativeWindowHandle $preferredElement
    }

    $root = Get-MainElement $process
    foreach ($element in (Get-AllElements $root)) {
        if (-not (Test-TextWindowHandleCandidate $process $element)) {
            continue
        }
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
            return Get-NativeWindowHandle $element
        }
    }

    foreach ($element in (Get-AllElements $root)) {
        if (Test-TextWindowHandleCandidate $process $element) {
            return Get-NativeWindowHandle $element
        }
    }

    return [IntPtr]::Zero
}

function Invoke-TypeText($process, [string]$text) {
    $element = Find-TextEntryElement $process
    $targetHwnd = Find-TextEntryWindowHandle $process $element
    if ($targetHwnd -ne [IntPtr]::Zero -and (Send-TextToEditHandle $targetHwnd $text $element)) {
        return $true
    }

    if ($null -ne $element) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
            if (-not (Test-EnvFlagEnabled "VARIN_COMPUTER_ALLOW_UIA_TEXT_FALLBACK")) {
                throw "UIA ValuePattern text fallback is disabled by default because it may bring the target app to the foreground; set VARIN_COMPUTER_ALLOW_UIA_TEXT_FALLBACK=1 to enable it."
            }
            $current = ""
            try { $current = [string]$valuePattern.Current.Value } catch {}
            $valuePattern.SetValue($current + $text)
            return $true
        }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Operation dispatcher 鈥?one JSON op in, one response object out. The host
# loop keeps this resident, so observations and actions never restart the
# interpreter.
# ---------------------------------------------------------------------------

function Invoke-ComputerOperation($operation) {
    $tool = [string]$operation.tool

    if ($tool -eq "ping") {
        return [pscustomobject]@{ ok = $true }
    }
    if ($tool -eq "capabilities") {
        return [pscustomobject]@{ ok = $true; capabilities = (Get-DriverCapabilities) }
    }
    if ($tool -eq "release_input") {
        Send-ReleaseInput
        return [pscustomobject]@{ ok = $true }
    }
    if ($tool -eq "list_apps") {
        $listed = List-Apps
        return [pscustomobject]@{ ok = $true; text = $listed.text; apps = $listed.apps }
    }
    if ($tool -eq "capture_frame") {
        $quality = 65
        if ($null -ne $operation.quality) { $quality = [double]$operation.quality }
        $frame = Capture-DesktopFrame $quality
        if ($null -eq $frame) { return [pscustomobject]@{ ok = $false; error = "desktop capture produced no frame" } }
        return [pscustomobject]@{ ok = $true; frame = $frame }
    }
    if ($tool -eq "inject_input") {
        try { Invoke-HumanInput $operation }
        catch { Send-ReleaseInput; throw }
        return [pscustomobject]@{ ok = $true }
    }
    if ($tool -eq "get_app_state") {
        $includeScreenshot = $true
        if ($null -ne $operation.screenshot) {
            $includeScreenshot = [bool]$operation.screenshot
        }
        return [pscustomobject]@{ ok = $true; snapshot = (Build-Snapshot $operation.app (Resolve-TextLimit $operation.text_limit) ([int]$operation.max_tree_nodes) ([int]$operation.max_tree_depth) $includeScreenshot $operation.window) }
    }

    $process = Resolve-App $operation.app
    # The window a caller selected (hwnd or title); absent = the main window
    # or the process's first visible top-level window.
    $hwnd = Resolve-AppWindow $process $operation.window
    $rootElement = Get-MainElement $process $hwnd
    $windowBounds = Get-WindowBounds $process $rootElement $hwnd
    $element = Find-Element $process $operation.element $rootElement
    if ($null -ne $operation.element -and $null -eq $element) { throw "Observed element no longer exists; observe again" }
    if ($null -ne $element) { $operation.element.frame = Get-ElementFrame $element $windowBounds }
    # PostMessage paths target the element's own HWND when the UIA record
    # carries one 鈥?child-window controls receive their own messages.
    $postHwnd = $hwnd
    if ($null -ne $element) {
        $elementHwnd = Get-NativeWindowHandle $element
        if ($elementHwnd -ne [IntPtr]::Zero) { $postHwnd = $elementHwnd }
    }
    $inputPath = [string]$operation.input
    if ([string]::IsNullOrWhiteSpace($inputPath)) { $inputPath = "auto" }
    if ($inputPath -eq "global" -or $operation.click_method -eq "global") {
        if ([VarinWin32]::GetForegroundWindow() -ne $hwnd) { [void][VarinWin32]::SetForegroundWindow($hwnd) }
        if ([VarinWin32]::GetForegroundWindow() -ne $hwnd) { throw "Windows could not activate the target window for global input" }
        $script:InputWindow = $hwnd
    }

    try {
    switch ($tool) {
        "click" {
            $clickMethod = [string]$operation.click_method
            if ([string]::IsNullOrWhiteSpace($clickMethod)) { $clickMethod = "auto" }

            if ($clickMethod -eq "accessibility") {
                if ($null -eq $element) { throw "click_method 'accessibility' requires element_index" }
                if ($operation.mouse_button -eq "right" -or $operation.mouse_button -eq "middle") {
                    throw "click_method 'accessibility' does not support mouse_button '$($operation.mouse_button)'"
                }
                if (-not (Invoke-PreferredClick $element)) {
                    throw "click_method 'accessibility' could not click the requested element"
                }
            } elseif ($clickMethod -eq "global") {
                if ($null -ne $operation.element -and $null -ne $operation.element.frame) {
                    $point = Get-ScreenPoint $operation.element.frame $windowBounds
                } else {
                    $point = [pscustomobject]@{
                        x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                        y = [int][math]::Round($windowBounds.y + [double]$operation.y)
                    }
                }
                Send-GlobalMouseClick $point.x $point.y $operation.mouse_button ([int]$operation.click_count)
            } elseif ($clickMethod -eq "app_post" -or $clickMethod -eq "auto") {
                $handled = $false
                if ($clickMethod -eq "auto" -and $null -ne $element -and $operation.mouse_button -ne "right" -and $operation.mouse_button -ne "middle") {
                    $handled = Invoke-PreferredClick $element
                }
                if (-not $handled) {
                    if ($null -ne $operation.element -and $null -ne $operation.element.frame) {
                        $point = Get-ScreenPoint $operation.element.frame $windowBounds
                    } else {
                        $point = [pscustomobject]@{
                            x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                            y = [int][math]::Round($windowBounds.y + [double]$operation.y)
                        }
                    }
                    Send-MouseClick $postHwnd $point.x $point.y $operation.mouse_button ([int]$operation.click_count)
                }
            } else {
                throw "Invalid click_method '$clickMethod'"
            }
        }
        "perform_secondary_action" {
            if ($null -eq $element) { throw "unknown element_index '$($operation.element.index)'" }
            Invoke-SecondaryAction $element $operation.action
        }
        "scroll" {
            $handled = $false
            if ($null -ne $element) {
                $handled = Invoke-Scroll $element $operation.direction ([double]$operation.pages)
            }
            if (-not $handled) {
                if ($inputPath -eq "global") {
                    $point = Get-ScreenPoint $operation.element.frame $windowBounds
                    if ($null -eq $point) {
                        $point = [pscustomobject]@{
                            x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                            y = [int][math]::Round($windowBounds.y + [double]$operation.y)
                        }
                    }
                    Send-GlobalScroll $point.x $point.y $operation.direction ([double]$operation.pages)
                } else {
                    $point = Get-ScreenPoint $operation.element.frame $windowBounds
                    if ($null -eq $point) {
                        $point = [pscustomobject]@{
                            x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                            y = [int][math]::Round($windowBounds.y + [double]$operation.y)
                        }
                    }
                    Send-Scroll $postHwnd $point.x $point.y $operation.direction ([double]$operation.pages)
                }
            }
        }
        "drag" {
            $fromX = [int][math]::Round($windowBounds.x + [double]$operation.from_x)
            $fromY = [int][math]::Round($windowBounds.y + [double]$operation.from_y)
            $toX = [int][math]::Round($windowBounds.x + [double]$operation.to_x)
            $toY = [int][math]::Round($windowBounds.y + [double]$operation.to_y)
            if ($inputPath -eq "global") {
                Send-GlobalDrag $fromX $fromY $toX $toY
            } else {
                Send-Drag $postHwnd $fromX $fromY $toX $toY
            }
        }
        "type_text" {
            if ($inputPath -eq "global") {
                Send-GlobalText $operation.text
            } elseif (-not (Invoke-TypeText $process $operation.text)) {
                Send-Text $postHwnd $operation.text
            }
        }
        "press_key" {
            if ($inputPath -eq "global") {
                Send-GlobalKey $operation.key
            } else {
                Send-Key $postHwnd $operation.key
            }
        }
        "set_value" {
            if ($null -eq $element) { throw "unknown element_index '$($operation.element.index)'" }
            $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
            if ($null -eq $valuePattern) {
                throw "Cannot set a value for an element that is not settable"
            }
            $valuePattern.SetValue($operation.value)
        }
        default {
            throw "unsupportedTool(`"$tool`")"
        }
    }
    } catch [System.OperationCanceledException] {
        # The cancel side-channel fired mid-operation. The finally below still
        # releases any input this driver had pressed; the message carries how
        # much of the action already reached the desktop.
        return [pscustomobject]@{ ok = $false; cancelled = $true; error = $_.Exception.Message }
    } finally {
        Send-ReleaseInput
        $script:InputWindow = [IntPtr]::Zero
    }

    Start-Sleep -Milliseconds 120
    try {
        return [pscustomobject]@{ ok = $true; snapshot = (Build-Snapshot $operation.app (Resolve-TextLimit $null) 0 0 $true $operation.window) }
    } catch {
        return [pscustomobject]@{ ok = $true; text = "Input was dispatched; post-action observation failed. Observe again before deciding another action." }
    }
}
