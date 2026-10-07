# Varin Computer Use — persistent Windows driver host.
#
# Runs resident inside the interactive desktop session and speaks a
# line-delimited JSON protocol on stdin/stdout:
#   in : {"id":"<request>","tool":"<op>", ...params}
#   out: {"id":"<request>","ok":true|false, ...}
#
# One request in, a final reply plus optional gesture progress out; the UIA assemblies and Win32 bindings are loaded
# once, so actions never pay interpreter startup. Managed by the Varin Host
# computer service — do not run interactively.
#
# Cancellation is out-of-band: while a request executes the Host writes
# "$VARIN_DRIVER_CANCEL_DIR/<requestId>.cancel"; long operations poll it at
# their internal checkpoints and abort with {ok:false, cancelled:true}.

$ErrorActionPreference = "Stop"
$DriverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $DriverDir "runtime.ps1")

# Report coordinates in physical pixels so Host-side frame math matches the
# display grid regardless of the user's DPI scale.
try { [void][VarinWin32]::SetProcessDPIAware() } catch {}

# Release only this helper's tracked input. Another helper's injected state
# cannot be distinguished from a person's held keys after a crash.
try { Send-ReleaseInput } catch {}

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
        $script:ActiveRequestId = $requestId
        $response = Invoke-ComputerOperation $operation
        & $writeResponse $requestId $response
    } catch [System.OperationCanceledException] {
        & $writeResponse $requestId ([pscustomobject]@{ ok = $false; cancelled = $true; error = $_.Exception.Message })
    } catch {
        $message = $_.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
            $message = "$message at $($_.ScriptStackTrace)"
        }
        & $writeResponse $requestId ([pscustomobject]@{ ok = $false; error = $message })
    } finally {
        $script:ActiveRequestId = $null
    }
}
