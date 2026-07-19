param(
  [string]$TraePath = 'D:\Program Files\TRAE SOLO CN\TRAE SOLO CN.exe',
  [ValidateRange(1, 65535)]
  [int]$Port = 39240
)

$ErrorActionPreference = 'Stop'
$resolvedPath = (Resolve-Path -LiteralPath $TraePath).Path
$existingProcess = Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and [string]::Equals(
    $_.ExecutablePath,
    $resolvedPath,
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

if ($existingProcess) {
  Write-Error 'Trae is already running from this executable path. Close it manually, then run this launcher again to start a CDP-enabled session.'
  exit 1
}

Write-Warning "CDP will bind to 127.0.0.1:$Port. It is off the network, but other local processes can still use this debugging endpoint."
Start-Process -FilePath $resolvedPath -ArgumentList @(
  '--remote-debugging-address=127.0.0.1',
  "--remote-debugging-port=$Port"
)
Write-Output "Started Trae with loopback CDP at http://127.0.0.1:$Port"
