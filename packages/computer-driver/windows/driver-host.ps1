# Varin Computer Use — persistent Windows driver host.
#
# Runs resident inside the interactive desktop session and speaks a
# line-delimited JSON protocol on stdin/stdout:
#   in : {"id":"<request>","tool":"<op>", ...params}
#   out: {"id":"<request>","ok":true|false, ...}
#
# One line in, one line out; the UIA assemblies and Win32 bindings are loaded
# once, so actions never pay interpreter startup. Managed by the Varin Host
# computer service — do not run interactively.

$ErrorActionPreference = "Stop"
$DriverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $DriverDir "runtime.ps1")

# Report coordinates in physical pixels so Host-side frame math matches the
# display grid regardless of the user's DPI scale.
try { [void][VarinWin32]::SetProcessDPIAware() } catch {}

$writeResponse = {
    param($id, $response)
    $payload = [pscustomobject]@{ id = $id }
    foreach ($property in $response.PSObject.Properties) {
        $payload | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force
    }
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Depth 60 -Compress))
    [Console]::Out.Flush()
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }

    $requestId = $null
    try {
        $operation = $line | ConvertFrom-Json
        $requestId = [string]$operation.id
        $response = Invoke-ComputerOperation $operation
        & $writeResponse $requestId $response
    } catch {
        $message = $_.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
            $message = "$message at $($_.ScriptStackTrace)"
        }
        & $writeResponse $requestId ([pscustomobject]@{ ok = $false; error = $message })
    }
}
