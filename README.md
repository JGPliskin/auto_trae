# Trae auto-continue watcher

This watcher observes a CDP-enabled Trae Work session for a narrowly verified
continuation prompt. It is a local, user-run tool: it never launches Trae and
does not type `继续` into the composer.

## How Codex and GPT-5.6 were used

This project was built with Codex and GPT-5.6. Codex helped turn the original
problem into a small, testable design, implement the CDP observer and watcher,
write the safety and regression tests, and validate the behavior against a real
Trae session. GPT-5.6 was used through Codex to reason about the safety model,
including strict localhost CDP validation, accessibility-tree and DOM proof,
two-scan candidate confirmation, session-bound verification, click limits, and
fail-closed manual intervention.

The runtime does not call GPT-5.6 or another LLM to guess what to click. After
development, the watcher uses deterministic local CDP observations and logs
only redacted identifiers and events. This keeps the tool predictable while
making Trae's more accessible GLM workflow easier to continue unattended.

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
