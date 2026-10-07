# Execute the production targeting/dispatch functions against fake controls and
# fake input functions. This test never loads user32 or touches the desktop.
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "runtime.ps1"), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw $parseErrors[0].Message }
foreach ($name in @("Same-RuntimeId", "Find-Element", "Send-ComputerGesture", "Invoke-ComputerOperation", "Find-TextEntryElement", "Find-TextEntryWindowHandle", "Test-TextWindowHandleCandidate", "Invoke-TypeText")) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if ($null -eq $definition) { throw "Missing production function $name" }
    Invoke-Expression $definition.Extent.Text
}
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
public static class VarinWin32 {
    public struct POINT { public int X; public int Y; }
    public static List<POINT> Points = new List<POINT>();
    public static IntPtr Owner = new IntPtr(73);
    public static IntPtr WindowFromPoint(POINT point) { Points.Add(point); return Owner; }
    public static bool IsChild(IntPtr parent, IntPtr child) { return false; }
}
namespace Windows.Automation {
    public static class ValuePattern { public static object Pattern = new object(); }
    public static class AutomationElement { public static object FocusedElement; }
}
"@
function Assert-NotCancelled { }
function Get-AllElements($root) { if ($null -ne $root.Controls) { return $root.Controls }; return $script:Controls }
function Resolve-App { return [pscustomobject]@{ Id = 42; MainWindowHandle = 73 } }
function Resolve-AppWindow { return [IntPtr]73 }
function Get-MainElement { return $script:Root }
function Get-WindowBounds { return $script:Bounds }
function Get-WindowDpiScale { return 1.5 }
function Send-Key { $script:Inputs += 1 }
function Send-MouseClick { $script:Inputs += 1 }
function Send-Drag { $script:Inputs += 1 }
function Send-ReleaseInput { }
function Resolve-TextLimit { return 500 }
function Get-NativeWindowHandle($element) { return [IntPtr]$element.Current.NativeWindowHandle }
function Get-ElementControlTypeName($element) { return $element.Current.ControlType.ProgrammaticName }
function Get-ElementString { return "Edit" }
function Get-CurrentPatternOrNull { return [pscustomobject]@{ Current = [pscustomobject]@{ IsReadOnly = $false } } }
function Send-TextToEditHandle($hwnd, $text, $element) { $script:TypedHandle = $hwnd; $script:Inputs += 1; return $true }
function Build-Snapshot($query, $limit, $nodes, $depth, $screenshot, $window) {
    $script:Reads += 1
    return [pscustomobject]@{ screenshot = $screenshot; treeLines = @("Window") }
}
function New-Control($id, $name, $runtimeId) {
    $control = [pscustomobject]@{ Runtime = $runtimeId; Current = [pscustomobject]@{ AutomationId = $id; Name = $name; ControlType = [pscustomobject]@{ ProgrammaticName = "ControlType.Button" } } }
    $control | Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value { return @($this.Runtime) }
    return $control
}
$script:Controls = @((New-Control "primary" "Save" 1), (New-Control "other" "Save" 2))
$script:Root = [pscustomobject]@{ Name = "Root" }
$record = [pscustomobject]@{ runtimeId = @(90); automationId = "primary"; name = "Save"; controlType = "ControlType.Button" }
$found = Find-Element ([pscustomobject]@{}) $record ([pscustomobject]@{})
if ($found.Current.AutomationId -ne "primary") { throw "Unique AutomationId did not take precedence over duplicate names" }
$record.automationId = ""
$ambiguous = $false
try { Find-Element ([pscustomobject]@{}) $record ([pscustomobject]@{}) | Out-Null } catch { $ambiguous = $_.Exception.Message -like "*multiple matching*" }
if (-not $ambiguous) { throw "Duplicate name was selected instead of rejected" }
$record.runtimeId = @(2)
$found = Find-Element ([pscustomobject]@{}) $record ([pscustomobject]@{})
if ($found.Current.AutomationId -ne "other") { throw "Runtime identity did not preserve the original control" }

$script:Bounds = [pscustomobject]@{ x = 10; y = 20; width = 800; height = 600 }
$script:Inputs = 0
$script:Reads = 0
$script:LastInputTimes = @{}
$operation = [pscustomobject]@{ tool = "click"; app = "42"; x = 120; y = 80; expected_bounds = $script:Bounds; expected_dpi = 1.5; capture_source = "screen" }
$response = Invoke-ComputerOperation $operation
if (-not $response.ok -or $script:Inputs -ne 1 -or $script:Reads -ne 0) { throw "Default action captured instead of returning dispatch acceptance" }
if ([VarinWin32]::Points.Count -ne 1 -or [VarinWin32]::Points[0].X -ne 130 -or [VarinWin32]::Points[0].Y -ne 100) { throw "Single screenshot point did not map to the screen point" }
$response = Invoke-ComputerOperation ([pscustomobject]@{ tool = "drag"; app = "42"; from_x = 120; from_y = 80; to_x = 240; to_y = 160; expected_bounds = $script:Bounds; expected_dpi = 1.5; capture_source = "screen" })
if (-not $response.ok -or [VarinWin32]::Points.Count -ne 3 -or [VarinWin32]::Points[2].X -ne 250 -or [VarinWin32]::Points[2].Y -ne 180) { throw "Drag preflight did not validate both endpoints" }
$before = $script:Inputs
[VarinWin32]::Owner = [IntPtr]99
$response = Invoke-ComputerOperation $operation
if ($response.ok -or -not $response.rejected -or $script:Inputs -ne $before) { throw "Occluded point reached input dispatch" }
[VarinWin32]::Owner = [IntPtr]73
$script:Bounds = [pscustomobject]@{ x = 11; y = 20; width = 800; height = 600 }
$response = Invoke-ComputerOperation $operation
if ($response.ok -or -not $response.rejected -or $script:Inputs -ne $before) { throw "Changed geometry reached input dispatch" }
$script:Bounds = $operation.expected_bounds
$operation.expected_dpi = 2
$response = Invoke-ComputerOperation $operation
if ($response.ok -or -not $response.rejected -or $script:Inputs -ne $before) { throw "Changed DPI reached input dispatch" }
$response = Invoke-ComputerOperation ([pscustomobject]@{ tool = "press_key"; app = "42"; key = "enter"; return_state = "tree" })
if (-not $response.ok -or $script:Reads -ne 1 -or $response.snapshot.screenshot) { throw "Explicit tree read did not honor the capture mode" }
$boundInput = New-Control "bound" "Bound editor" 11
$otherInput = New-Control "other-window" "Other editor" 12
foreach ($element in @($boundInput, $otherInput)) {
    $element.Current.ControlType.ProgrammaticName = "ControlType.Edit"
    $element.Current | Add-Member -NotePropertyName ProcessId -NotePropertyValue 42
}
$boundInput.Current | Add-Member -NotePropertyName NativeWindowHandle -NotePropertyValue 74
$otherInput.Current | Add-Member -NotePropertyName NativeWindowHandle -NotePropertyValue 99
$script:Root = [pscustomobject]@{ Name = "Bound window"; Controls = @($boundInput) }
[Windows.Automation.AutomationElement]::FocusedElement = $otherInput
$response = Invoke-ComputerOperation ([pscustomobject]@{ tool = "type_text"; app = "42"; window = 73; text = "hello" })
if (-not $response.ok -or $script:TypedHandle -ne [IntPtr]74) { throw "Text input escaped the bound window to the same app's focused/main window" }
$capture = New-Object System.IO.StringWriter
$output = [Console]::Out
try {
    [Console]::SetOut($capture)
    $response = Invoke-ComputerOperation ([pscustomobject]@{ id = "visual"; visual_feedback = $true; tool = "type_text"; app = "42"; window = 73; text = "private input" })
} finally { [Console]::SetOut($output) }
$events = @($capture.ToString().Trim() -split "`n" | ForEach-Object { $_ | ConvertFrom-Json })
if (-not $response.ok -or $events.Count -ne 2 -or $events[0].phase -ne "target" -or $events[0].target.x -ne $script:Bounds.x -or $events[1].phase -ne "dispatched") { throw "Native gesture feedback did not carry the relocated target and dispatch" }
if ($capture.ToString() -like "*private input*") { throw "Gesture feedback leaked typed text" }
Write-Output "Windows targeting checks passed (fake controls/input; no desktop access)."
