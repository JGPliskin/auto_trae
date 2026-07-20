# Trae auto-continue watcher

This is a local Windows watcher for one CDP-enabled Trae Work session. It
clicks only a narrowly verified continuation control. It does not type
`继续`, guess what to click, or use an LLM at runtime.

The foreground CLI is safe by default: it observes and logs candidates without
clicking. `--enable` is required before a live click is allowed. For unattended
use, run the CLI through the supervisor so the watcher is restarted if it
exits or stops sending health heartbeats.

## Requirements

- Windows PowerShell
- Node.js
- Trae Solo CN installed locally

The default paths and port are:

| Setting | Default |
| --- | --- |
| Trae executable | `D:\Program Files\TRAE SOLO CN\TRAE SOLO CN.exe` |
| Node executable | `D:\Program Files\nodejs\node.exe` |
| CDP address | `127.0.0.1` |
| CDP port | `39240` |
| Poll interval | `30000` ms (30 seconds) |
| Maximum live clicks per session | `7` |
| Log file | `logs/trae-auto-continue.jsonl` |

## Install and test

From the repository root:

```powershell
Set-Location 'E:\project\auto_trae'
npm test
```

The test suite is fully local and does not require Trae to be running.

## Start Trae and the supervised watcher

After a reboot, the recommended startup sequence is:

```powershell
Set-Location 'E:\project\auto_trae'

.\scripts\start-trae-cdp.ps1 `
  -TraePath 'D:\Program Files\TRAE SOLO CN\TRAE SOLO CN.exe' `
  -Port 39240

Start-Sleep -Seconds 2

.\scripts\start-watcher-supervisor.ps1 `
  -NodePath 'D:\Program Files\nodejs\node.exe' `
  -RepoPath 'E:\project\auto_trae' `
  -Port 39240
```

The supervisor launcher starts a hidden `src/supervisor.mjs` process. The
supervisor starts the live CLI and restarts that child after an unexpected exit
or a sustained loss of health heartbeats. It does not start, stop, or restart
Trae. The launcher also refuses to create a duplicate supervisor for the same
port.

If Trae or Node.js is installed elsewhere, override the corresponding paths:

```powershell
.\scripts\start-trae-cdp.ps1 -TraePath 'C:\Path\To\Trae.exe' -Port 39240

.\scripts\start-watcher-supervisor.ps1 `
  -NodePath 'C:\Program Files\nodejs\node.exe' `
  -RepoPath 'E:\project\auto_trae' `
  -Port 39240
```

`start-trae-cdp.ps1` refuses to touch an existing Trae process. Close that
process manually before running the launcher again. CDP is bound to loopback,
so it is not exposed to the network, although other local processes can still
access it.

## Configure the watcher

Both the CLI and supervisor accept positive integer values without the old
three-click cap:

```powershell
node src/cli.mjs --help

node src/supervisor.mjs `
  --enable `
  --port 39240 `
  --poll-ms 30000 `
  --max-continue-clicks 7
```

Useful options:

- `--enable` permits live DOM clicks. Without it, the CLI is dry-run.
- `--once` performs one read-only observation and exits.
- `--port <1..65535>` selects the loopback CDP port; default: `39240`.
- `--poll-ms <positive integer>` controls the scan interval; default: `30000`.
- `--max-continue-clicks <positive integer>` sets the per-session live click
  budget; default: `7`.
- `--log-file <path>` changes the JSONL log location.

For continuous operation, prefer `start-watcher-supervisor.ps1`. If you run
`src/cli.mjs` directly, Ctrl+C ends the foreground watcher and leaves Trae
running.

## Verify that monitoring is active

Check the supervisor, its CLI child, Trae, and the CDP listener:

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'src[\\/]supervisor\.mjs.*--enable.*--port\s+39240' -or
    $_.CommandLine -match 'src[\\/]cli\.mjs.*--enable.*--port\s+39240'
  } |
  Select-Object ProcessId, ParentProcessId, CommandLine

Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 39240 -State Listen

Get-Content '.\logs\trae-auto-continue.jsonl' -Tail 20
```

The CLI child should list the supervisor PID as its `ParentProcessId`. The
listener should belong to the Trae root process, not the watcher.

## Logs and troubleshooting

The JSONL log contains timestamps, event codes, redacted identifiers, and
counts. It never records raw accessibility names, prompt text, session IDs, or
surrounding chat content. Relevant events include connection state changes,
candidate observations, click invocations, manual intervention requests,
target/discovery failures, and request timeouts.

Interpret failures by checking the process chain first:

1. If the supervisor is missing, the watcher guard layer is down.
2. If the supervisor exists but the CLI child is missing, wait briefly to see
   whether it is automatically restarted.
3. If both processes and port `39240` are healthy but the log reports
   `request_timeout`, `target_unavailable`, or `discovery_failed`, the issue is
   in Trae CDP/accessibility state rather than watcher liveness.

The watcher fails closed when the accessibility or DOM evidence is ambiguous.
In that case it records `manual_intervention_required` instead of clicking.

## Safety model

- CDP discovery accepts only the literal loopback host `127.0.0.1`.
- A candidate must pass accessibility, DOM, geometry, session, and stability
  checks before a click is considered.
- A re-render, transport failure, ambiguous target, or failed verification
  resets the proof and prevents mutation.
- The supervisor only manages its watcher child; it never manages Trae.
