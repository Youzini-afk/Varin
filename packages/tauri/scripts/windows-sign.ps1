# Existing release certificate only. Never creates/imports a persistent key.
param([Parameter(Mandatory=$true)][string]$File, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
try {
  if (-not $VerifyOnly) {
    $source = $env:WINDOWS_CSC_LINK
    if (-not $source) { $source = $env:WIN_CSC_LINK }
    if (-not $source) { $source = $env:CSC_LINK }
    if (-not $source) { throw 'Missing configured release certificate' }
    $password = $env:WINDOWS_CSC_KEY_PASSWORD
    if (-not $password) { $password = $env:WIN_CSC_KEY_PASSWORD }
    if (-not $password) { $password = $env:CSC_KEY_PASSWORD }
    if (Test-Path -LiteralPath $source -PathType Leaf) { $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $source)) }
    else { $bytes = [Convert]::FromBase64String($source) }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes, $password, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    try {
      if (-not $certificate.HasPrivateKey) { throw 'Configured certificate has no private key' }
      $result = Set-AuthenticodeSignature -LiteralPath $File -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
      if ($result.Status -ne 'Valid') { throw 'Authenticode signing did not validate' }
    } finally { $certificate.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length) }
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $File
  if ($signature.Status -ne 'Valid') { throw 'Authenticode verification failed' }
  if ($env:VARIN_WINDOWS_PUBLISHER_THUMBPRINT -and $signature.SignerCertificate.Thumbprint -ne $env:VARIN_WINDOWS_PUBLISHER_THUMBPRINT) { throw 'Unexpected code signing certificate' }
  Write-Output 'verified'
} catch {
  # Avoid emitting exception arguments/certificate/password data into CI logs.
  [Console]::Error.WriteLine('Windows release signing or verification failed.')
  exit 1
}
