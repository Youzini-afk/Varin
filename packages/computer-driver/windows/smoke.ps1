# BC5 smoke: capture_frame + inject_input through the resident driver host.
$requests = @(
    @{ id = "cap"; tool = "capture_frame"; quality = 60 },
    @{ id = "mv"; tool = "inject_input"; kind = "move"; x = 100; y = 100 },
    @{ id = "rel"; tool = "release_input" }
)
$requests | ForEach-Object { ($_ | ConvertTo-Json -Compress -Depth 8) } | Set-Content (Join-Path $PSScriptRoot "in.txt") -Encoding Ascii

$hostScript = Join-Path $PSScriptRoot "driver-host.ps1"
$inFile = Join-Path $PSScriptRoot "in.txt"
$outFile = Join-Path $PSScriptRoot "out.txt"
$errFile = Join-Path $PSScriptRoot "err.txt"
$driver = Start-Process powershell.exe -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $hostScript
) -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -NoNewWindow
Start-Sleep -Seconds 8
$driver | Stop-Process -Force -ErrorAction SilentlyContinue

Get-Content $outFile | ForEach-Object {
    $line = $_
    try {
        $parsed = $line | ConvertFrom-Json
        if ($parsed.frame) {
            Write-Host ("frame: " + $parsed.frame.mime + " " + [int]$parsed.frame.bounds.width + "x" + [int]$parsed.frame.bounds.height + " base64=" + $parsed.frame.base64.Length + "B ok=" + $parsed.ok)
        } else {
            Write-Host $line.Substring(0, [Math]::Min(300, $line.Length))
        }
    } catch {
        Write-Host $line.Substring(0, [Math]::Min(300, $line.Length))
    }
}
Get-Content $errFile -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object { Write-Host ("ERR: " + $_) }
Remove-Item $inFile, $outFile, $errFile -ErrorAction SilentlyContinue
