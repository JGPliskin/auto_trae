# Task 5 Report — Foreground CLI and Reconnect Behavior

## Status

Implemented and verified Task 5 on `codex/trae-auto-continue-design`, based on
accepted Tasks 1–4 commit `68428a1`. The foreground CLI parses configuration
before CDP work, keeps one watcher across transport replacement, remains
read-only by default and under `--once`, uses deterministic injected time
boundaries, and shuts down its current client on AbortSignal/Ctrl+C.

Tests use only injected discovery, client, observer, sleep/clock, logger, and
output fakes. Process-level tests exercise only `--help` and invalid arguments,
which return before discovery. No test contacted a CDP endpoint or Trae, and no
code launches, focuses, or types into Trae.

## Necessary prior-task interface correction

Task 2's `createCdpClient()` returned while its WebSocket was still
`CONNECTING`, but `request()` immediately rejects unless the socket is already
open. Task 5 therefore had no supported way to attach before its first
observation; a real run could enter reconnect backoff solely because the
socket's asynchronous `open` event had not fired yet.

The minimal correction adds `client.waitUntilOpen()`. It resolves on `open`,
rejects on pre-open `error`/`close`, cleans up its temporary listeners, and is
awaited by the CLI before logging `connected` or observing. This required the
only scope expansion beyond Task 5-owned files: `src/cdp-client.mjs` and one
regression in `test/cdp-client.test.mjs`. No existing CDP behavior changed.

## RED evidence

The CDP readiness regression first failed with:

```text
TypeError: client.waitUntilOpen is not a function
tests 1; pass 0; fail 1
```

The first Task 5 test was written before `src/cli.mjs` and failed with
`ERR_MODULE_NOT_FOUND`. Subsequent vertical slices produced these expected
failures before their minimal implementations:

- Default dry-run scheduled no poll (`actual []`, expected `[1500]`).
- A discovery exception escaped instead of entering reconnect backoff.
- Socket closure logged `connection_failed` instead of `socket_closed`.
- AbortSignal left the attached client open while observation was pending
  (`0 !== 1`).
- The process entry ignored invalid configuration and exited `0` rather than
  `1`.
- Observer-level `ax_unavailable` retained the old transport
  (`discoveries 1 !== 2`).
- A transport interruption incorrectly preserved first-scan stability and
  clicked after observation 3 rather than requiring observation 4.

Each RED command exited normally; none hung. After the user interruption, a
process inventory found no `node --test` process for this repository.

## GREEN evidence

The CDP readiness suite passed:

```powershell
node --test test/cdp-client.test.mjs
```

```text
tests 9
pass 9
fail 0
duration_ms 800.1219
```

Fresh required focused verification passed:

```powershell
node --test test/cli.test.mjs
```

```text
tests 10
pass 10
fail 0
duration_ms 2319.593
```

Fresh full-suite verification passed:

```powershell
node --test
```

```text
tests 63
pass 63
fail 0
duration_ms 6516.0339
```

Both required final runs exited normally with no failures, cancellations,
skips, warnings, diagnostics, timeout symptoms, or hanging handles.

## Files changed

- `src/cli.mjs`: process-level help/main entry, dependency-injected foreground
  lifecycle, forced read-only `--once`, dry-run/live watcher wiring, bounded
  reconnect, redacted output, connection-state deduplication, and abort cleanup.
- `test/cli.test.mjs`: ten fake-only tests covering the Task 5 lifecycle,
  exact backoff, logging transitions, reconnect state, help, and cleanup.
- `src/cdp-client.mjs`: minimal awaitable WebSocket attachment boundary needed
  before the CLI's first CDP observation.
- `test/cdp-client.test.mjs`: readiness regression using the explicit fake
  socket `open()` transition.
- `.superpowers/sdd/task-5-report.md`: this report.

## Self-review

### Standards axis

- Existing Node ESM and `node:test` style is preserved; no dependency or
  unrelated abstraction was added.
- External boundaries only are injected. Tests observe the public `runCli`
  lifecycle and process entry rather than private loop internals.
- The retry table names the exact required delays. Connection error mapping
  emits allowlisted stable codes and never serializes exception messages.
- Foreground sleep keeps the process alive and removes its abort listener on
  either completion or cancellation. Client close is idempotent at the CLI
  ownership boundary, including abort during a pending observation.
- Transport failure resets only consecutive-scan proof. The same watcher and
  its session ledger remain alive, demonstrated by click counts continuing
  from one to two after reconnect.
- Manual review found no blocking Fowler smell. `runCli` is the one lifecycle
  coordinator required by this task; extracting speculative classes would add
  indirection without another consumer.

### Specification axis

- `--help` prints the exact exported `usage` string and returns before
  `runCli`, fetch, or WebSocket creation. Invalid configuration also exits
  before discovery.
- `--once --enable` is deliberately forced to dry-run, performs one
  observation, closes, and schedules neither a poll nor reconnect.
- Default mode logs `candidate_observed`/`would_continue` and never calls the
  client's click helper.
- Discovery failures use `1500, 3000, 6000, 15000, 15000` ms. Connected
  transport errors restart at 1500 ms, close the old client, and rediscover.
- Repeated identical unavailable states produce one logger/output event; the
  transition to connected produces another.
- `ax_unavailable`, which is how the accepted observer redacts first-request
  transport failures, also replaces the client rather than polling a dead
  transport.
- SIGINT aborts the same signal tested through the injected AbortSignal path.
  A pending attached client closes immediately, and no post-abort observation
  can invoke a click.
- Console rendering uses only event, connection-state, and reason codes. No
  observation text or raw target/session/candidate identity is rendered.

## Concerns

None blocking. The necessary CDP readiness extension is intentionally small
and reported above. User-owned modified/untracked research, design, context,
and plan files were not edited or staged. No real endpoint or Trae process was
contacted.

## Review fix — abort boundaries, process redaction, and attachment coverage

### Issues fixed

1. Discovery was awaited directly. Abort closed only an existing client, so a
   slow discovery could return a target after abort and still create a
   WebSocket. The CLI now races discovery, attachment, connected logging, and
   observation against AbortSignal through one listener-cleaning boundary. It
   checks the signal before every later CDP step, returns while a slow injected
   operation is still pending, and consumes a delayed rejection without an
   unhandled promise rejection.
2. Process main previously printed arbitrary `error.message`. It now validates
   arguments in a parser-only catch where controlled Usage details are allowed;
   every unexpected runtime failure renders exactly
   `Foreground watcher failed (runtime_failure)`.
3. `waitUntilOpen()` already rejected and cleaned up correctly on pre-open
   error/close, but only its open path was covered. Tracking fake-WebSocket
   regressions now prove rejection, temporary-listener cleanup, and that later
   events cannot change the settled result.

### RED evidence

The two abort regressions were written before the abort-aware boundary and run
with:

```powershell
node --test --test-name-pattern="abort during slow discovery|abort from connected logging" test/cli.test.mjs
```

```text
tests 2
pass 0
fail 2
duration_ms 948.0592
```

The failures showed both defects directly: `runCli` had not settled before
discovery completed (`false !== true`), and connected logging followed by
abort still made one observation (`1 !== 0`).

The unexpected-error test was then added before the rendering helper. Its RED
run failed module instantiation with:

```text
SyntaxError: The requested module '../src/cli.mjs' does not provide an export named 'renderProcessError'
tests 1
pass 0
fail 1
duration_ms 757.9387
```

The waitUntilOpen review item was a coverage-only gap: both new
characterization tests passed on their first run, so no production CDP change
was warranted or made. Their first result was `tests 2; pass 2; fail 0`.

### GREEN evidence

Fresh combined focused verification passed:

```powershell
node --test test/cli.test.mjs test/cdp-client.test.mjs
```

```text
tests 25
pass 25
fail 0
duration_ms 3113.1447
```

Fresh full-suite verification passed:

```powershell
node --test
```

```text
tests 69
pass 69
fail 0
duration_ms 6762.555
```

Both final commands exited normally with no warnings, failures,
cancellations, skips, diagnostics, timeout symptoms, or hanging handles.

### Files and self-review

- `src/cli.mjs`: abort-aware race boundary, post-await abort checks, controlled
  Usage handling, and fixed unexpected-runtime rendering.
- `test/cli.test.mjs`: slow-discovery abort, delayed-rejection handling,
  connected-to-observe abort, and fixed error-rendering regressions.
- `test/cdp-client.test.mjs`: pre-open error/close and listener cleanup tests.
- `.superpowers/sdd/task-5-report.md`: this appended review-fix record.

The race helper attaches both fulfillment and rejection handlers to the
underlying operation before yielding; an abort settles only the wrapper while
late operation rejection remains handled. Every wrapper removes its abort
listener on either outcome. The current client is still closed immediately by
the outer abort handler, and aborted observation results never reach the
watcher or click boundary. No raw runtime error reaches stderr. User-owned
research/design/context/plan files remain untouched and unstaged.

### Review-fix concerns

None blocking. No real endpoint or Trae process was contacted.
