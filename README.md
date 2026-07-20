# Trae auto-continue watcher

This watcher observes a CDP-enabled Trae Work session for a narrowly verified
continuation prompt. It is a local, user-run tool: it never launches Trae and
does not type `继续` into the composer.

## Start Trae with CDP

Save your work and close any normally launched Trae manually. Then start a
CDP-enabled session with:

```powershell
.\scripts\start-trae-cdp.ps1
```

The documented default executable is `D:\Program Files\TRAE SOLO CN\TRAE SOLO
CN.exe`. If Trae is installed elsewhere, supply that installation explicitly:

```powershell
.\scripts\start-trae-cdp.ps1 -TraePath 'C:\path\to\Trae.exe'
```

The launcher refuses to touch an existing Trae process; close it manually and
run the launcher again. CDP binds only to `127.0.0.1`, which keeps it off the
network, but the debugging endpoint remains accessible to other local
processes.

## Operate conservatively

Start with one read-only observation:

```powershell
node src/cli.mjs --once
```

Then run the ordinary dry-run and inspect the redacted log at
`logs/trae-auto-continue.jsonl`:

```powershell
node src/cli.mjs
```

Detection does not need `--enable`. `--enable` is the only switch that permits
a live DOM click. The watcher caps live invocations at three for the current
rendered session during this watcher process; it is not a permanent
three-click cap for every window. If the matching button is missing or unsafe,
manual intervention is required. The watcher will never type `继续`.

Press Ctrl+C to end the foreground watcher. It leaves Trae running.
