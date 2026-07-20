param(
  [string]$NodePath = 'D:\Program Files\nodejs\node.exe',
  [string]$RepoPath = '',
  [ValidateRange(1, 65535)]
  [int]$Port = 39240,
  [int]$PollMs = 30000,
  [int]$MaxContinueClicks = 7
)

$ErrorActionPreference = 'Stop'

if ($PollMs -lt 1) {
  Write-Error 'PollMs must be a positive integer'
  exit 1
}
if ($MaxContinueClicks -lt 1) {
  Write-Error 'MaxContinueClicks must be a positive integer'
  exit 1
}

if ([string]::IsNullOrWhiteSpace($RepoPath)) {
  $resolvedRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
} else {
  $resolvedRepo = (Resolve-Path -LiteralPath $RepoPath).Path
}

$resolvedNode = (Resolve-Path -LiteralPath $NodePath).Path
$supervisorPath = Join-Path $resolvedRepo 'src\supervisor.mjs'
if (-not (Test-Path -LiteralPath $supervisorPath -PathType Leaf)) {
  Write-Error "Watcher supervisor not found: $supervisorPath"
  exit 1
}

$supervisorPattern = 'src[\\/]+supervisor\.mjs'
$portPattern = "--port\s+$Port(?:\s|$)"
$existingSupervisor = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and
  $_.CommandLine -match $supervisorPattern -and
  $_.CommandLine -match $portPattern
}

if ($existingSupervisor) {
  Write-Error "A watcher supervisor is already running for port $Port. No new process was started."
  exit 1
}

$argumentList = @(
  "`"$supervisorPath`"",
  '--enable',
  '--port', "$Port",
  '--poll-ms', "$PollMs",
  '--max-continue-clicks', "$MaxContinueClicks"
)

$process = Start-Process -FilePath $resolvedNode `
  -ArgumentList $argumentList `
  -WorkingDirectory $resolvedRepo `
  -WindowStyle Hidden `
  -PassThru

Write-Output "Started watcher supervisor PID $($process.Id) for port $Port"
