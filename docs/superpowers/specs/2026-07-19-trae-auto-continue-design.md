# Trae Work Auto-Continue Design

## Status

Approved direction: a local, passive CDP watcher for TRAE Work (installed as
`TRAE SOLO CN`). The watcher never starts, stops, restarts, focuses, or sends
keystrokes to Trae.

## Problem

TRAE Work can stop an active task with either of these visible prompts:

- `模型思考次数已达上限，请输入「继续」以获取更多内容。`
- `输出过长，请输入「继续」以获取更多内容。`

The user wants a local, low-overhead way to resume only these cases without
using visual-model Computer Use. Resuming consumes Trae's own quota, so the
automation must be deliberately bounded and fail closed.

## Confirmed Runtime Evidence

On the user's installed TRAE Work 1.107.1 instance, CDP exposed both the
second prompt and an enabled accessibility button named `继续`. The button was
a real `BUTTON` element. A basic DOM text query did not find the rendered
card, while the CDP accessibility tree did; the watcher therefore uses the
accessibility tree as its detection surface.

## Scope

### Included

- A user-run launcher that starts Trae with a loopback-only CDP port.
- A separate Node.js watcher that attaches only to an already running,
  CDP-enabled Trae instance.
- Detection of the two exact Chinese prompts above.
- Direct activation of the one visible, enabled `继续` or `Continue` button.
- Dry-run, explicit live mode, bounded actions, verification, logging, and
  foreground cancellation.

### Excluded

- Starting, closing, restarting, or focusing Trae from the watcher.
- Sending `继续` through the composer in the first release.
- Handling timeouts, network failures, generic retry messages, approvals,
  terminal commands, deletions, or any prompt outside the two exact strings.
- UI Automation, image matching, Computer Use, MCP hosting, or modifications
  to Trae's installed files.

## Alternatives Considered

1. **Standalone CDP watcher — selected.** Node 24 already provides the HTTP
   and WebSocket primitives needed for a small CDP client. It directly targets
   the runtime surface verified on this machine and keeps the action set tiny.
2. **OpenCLI extension — not selected for the first release.** Its
   `trae-cn` adapter is useful prior art for composer send-and-verify logic,
   but the current `trae-solo` adapter intentionally does not expose message
   actions. Adapting it would still require custom detection, safety logic,
   and compatibility maintenance for Work.
3. **Trae Ralph fork — not selected.** It contains broader auto-actions that
   are inappropriate here, has no published package, and would require more
   auditing than the narrow watcher.

## Architecture

```text
User-run CDP launcher ──starts──> TRAE Work on 127.0.0.1:39240
                                         │
                                         │ Chrome DevTools Protocol
                                         ▼
Foreground watcher ──logs──> local JSONL event log
```

The launcher is separate from the watcher. It is the only component that
starts Trae, and it is run deliberately by the user at the start of a
monitorable session. If a normally started Trae process already exists, the
launcher refuses with an explanation; it never terminates or restarts it.

The watcher repeatedly reads the CDP accessibility tree. It does not use
screenshots, mouse movement, keyboard input, or an LLM.

## Detection and Action Rules

1. Connect only to `http://127.0.0.1:39240`; reject non-loopback endpoints.
2. Select the TRAE Work page target and read its accessibility tree.
3. Match only a static-text node whose accessible name exactly equals one of
   the two approved prompts, then require a non-zero CDP box model for its DOM
   node.
4. In the same observation, require exactly one enabled `继续` or `Continue`
   button with a non-zero box model, and prove through DOM ancestry that it is
   in the same rendered prompt region as the matched text.
5. If the prompt or button is ambiguous, disabled, hidden, unrelated, or
   absent, record the condition and take no action.
6. In dry-run mode, record `would_continue` and take no action.
7. In live mode, resolve the fresh CDP backend node for that button and invoke
   its native DOM `click()` once.
8. Verify within a bounded interval that the prompt/button disappears or that
   observable task output changes. Otherwise stop the watcher rather than
   retrying.

The first release intentionally uses the stricter cap of **three successful
continue actions per watcher run**, not an inferred cross-session task ID.
This is safer until a durable Trae Work task identity has been independently
verified. The watcher also de-duplicates a prompt/button identity for its
entire run.

## User Interface and Controls

- Default invocation is dry-run and prints each candidate to the console.
- `--enable` is required for live clicks.
- `--max-actions N` accepts `1` through `3` and defaults to `3`.
- `Ctrl+C` ends the foreground watcher immediately.
- The log records timestamp, target identity, approved prompt kind, decision,
  action count, and verification result. It never records conversation text
  beyond the approved prompt label.

## Failure Behavior

- No CDP endpoint or no Trae target: report unavailable and keep waiting;
  never launch Trae.
- CDP disconnect: return to the waiting state with a clear log entry.
- Multiple candidates, stale node, disabled button, action limit reached, or
  verification timeout: stop safely and explain why.
- Any unexpected CDP error: no fallback to message sending, UIA, image
  matching, or keystrokes.

## Testing Strategy

- Unit-test prompt classification, candidate ambiguity, de-duplication, cap
  enforcement, and state transitions with recorded CDP-shaped fixtures.
- Unit-test the CDP abstraction against a local fake WebSocket endpoint;
  tests must not connect to Trae.
- Run an end-to-end dry-run against a CDP-enabled Trae instance and confirm it
  recognizes the exact prompt and button without writing to the application.
- A live click is a separate, explicit user-authorized manual acceptance test;
  it is never part of automated test execution.

## OpenCLI Boundary

OpenCLI remains optional diagnostic/reference material. Its `trae-cn` adapter
contains useful composer send validation, but no OpenCLI package or adapter is
required by this runtime. If a future release needs a composer fallback, that
path is a separate design and test cycle rather than an implicit fallback.
