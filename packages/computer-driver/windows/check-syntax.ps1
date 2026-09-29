$errors = $null
$tokens = $null
[System.Management.Automation.PSParser]::Tokenize([IO.File]::ReadAllText("$PSScriptRoot\runtime.ps1"), [ref]$errors) > $null
Write-Host ("runtime.ps1 errors: " + $errors.Count)
$errors | Select-Object -First 8 | ForEach-Object { Write-Host ("  L" + $_.Token.StartLine + ": " + $_.Message) }
[System.Management.Automation.PSParser]::Tokenize([IO.File]::ReadAllText("$PSScriptRoot\driver-host.ps1"), [ref]$errors) > $null
Write-Host ("driver-host.ps1 errors: " + $errors.Count)
$errors | Select-Object -First 8 | ForEach-Object { Write-Host ("  L" + $_.Token.StartLine + ": " + $_.Message) }
