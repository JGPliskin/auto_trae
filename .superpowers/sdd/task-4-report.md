# Task 4 Report — Redacted Logs and Watcher State Machine

## Status

Implemented and verified Task 4 on `codex/trae-auto-continue-design`, based on
accepted Tasks 1–3 commit `c2c31d6`. The change is limited to the four Task 4
owned source/test files plus this required report. It uses injected observers,
clock values, loggers, and click functions only; it never connects to or
mutates Trae.

An interruption-time process inventory found no `node --test` process whose
command line referenced this repository and no task-owned timer or handle left
running. Both required verification commands subsequently exited normally.

## RED evidence

### Redacted JSONL logger

The logger tests were created before `src/logger.mjs`. The first focused run:

```powershell
node --test test/logger.test.mjs
```

failed as expected with `ERR_MODULE_NOT_FOUND` for `src/logger.mjs`. This
proved that the tests exercised the missing logger boundary.

After the first logger implementation was green, self-review identified that
a merely code-shaped but unapproved reason token could still reach disk. A
regression test was added first and the focused run failed with:

```text
tests 5
pass 4
fail 1
AssertionError: Missing expected rejection
```

The minimal fix replaced pattern-based acceptance with fixed reason and
connection-state allowlists.

### Watcher state machine

All required watcher behavior tests were created before `src/watcher.mjs`.
The first focused run:

```powershell
node --test test/watcher.test.mjs
```

failed as expected with `ERR_MODULE_NOT_FOUND` for `src/watcher.mjs`. The
suite drives complete sanitized observations one at a time through an injected
clock, event collector, and click function; no protocol or application process
is involved.

## GREEN evidence

The hardened logger suite passed:

```text
tests 5
pass 5
fail 0
```

The watcher suite passed, including nested reset/failure cases:

```text
tests 15
pass 15
fail 0
```

Fresh required focused verification passed and exited normally:

```powershell
node --test test/logger.test.mjs test/watcher.test.mjs
```

```text
tests 20
pass 20
fail 0
duration_ms 1500.5445
```

Fresh full-suite verification passed and exited normally:

```powershell
node --test
```

```text
tests 48
pass 48
fail 0
duration_ms 6002.7736
```

Both final runs were pristine: no failures, cancellations, skips, warnings,
diagnostics, timeout symptoms, or leaked sensitive text.

## Files changed

- `src/logger.mjs`: directory-safe serialized JSONL appends, fixed event and
  code allowlists, SHA-256 opaque identifiers, explicit field selection,
  generic continuation signature, counts, timestamps, modes, and state-only
  deduplication.
- `src/watcher.mjs`: explicit five-part state model, dry-run deduplication,
  two-scan live stability, exact-key invocation protection, generic
  per-session continuation blocking, per-session click caps, deferred click
  accounting, and 30-second disappearance-only verification.
- `test/logger.test.mjs`: fixed schema, hashing, directory creation,
  redaction, deduplication/action emission, and event/code allowlist tests.
- `test/watcher.test.mjs`: deterministic coverage of every required dry-run,
  live stability, reset, invocation ordering, re-render blocking, per-session
  cap, verification, one-shot manual reporting, and cross-session behavior.
- `.superpowers/sdd/task-4-report.md`: this implementation and verification
  record.

## Self-review

### Standards axis

- No repository-specific `AGENTS.md`, `CONTRIBUTING*`,
  `CODING_STANDARDS*`, or `.editorconfig` file exists. Review against existing
  Node ESM/test style and the standard code-smell baseline found no blocking
  issue or unrelated abstraction.
- Production files have one responsibility each. Tests use complete sanitized
  observation shapes and assert watcher behavior rather than test-double
  implementation details.
- The mutation boundary receives only the current second-scan candidate key
  and backend node ID. A deferred fake proves the block and `inFlight` state
  exist before mutation, while `continueClicks` and `click_invoked` change only
  after the injected invocation returns.

### Specification axis

- `state` contains exactly the required `sessionLedgers`, `stableCandidate`,
  `invokedCandidateKeys`, `inFlight`, and `blockedContinuation` structures.
- Dry-run stores no ledger, invocation key, block, or in-flight action. It
  emits the first `would_continue` and remains quiet for identical scans.
- Live mutation requires two equal consecutive safe candidate keys. Unsafe,
  `none`, and different-candidate observations reset stability.
- Exact invoked keys remain permanently protected. A changed backend ID cannot
  bypass the generic per-session continuation block while a signature remains
  visible.
- Click counts are invocation counts, incremented after return. They are not
  labelled successful. Caps are ledger-local, report once, and do not stop
  another rendered session.
- Verification accepts only a fresh `none`/`no_signature` observation before
  `deadlineMs`. Output-only changes and visible re-renders are ignored as
  proof. At 30,000 ms, unsafe evidence, or loss of session confirmation, one
  manual event is emitted and the continuation remains blocked until a fresh
  no-signature observation clears it.
- JSONL serialization selects fields explicitly. Target, session, and
  candidate inputs are hashed; arbitrary payload fields are dropped; event,
  reason, and connection-state codes are allowlisted; prompt/chat/AX text and
  raw `data-session-id` values have no output path.
- No correction to `src/candidate.mjs`, `src/observer.mjs`, or any accepted
  prior-task interface was needed.

## Concerns

None blocking. The logger's connection-state allowlist is present for Task 5's
documented event code but no reconnect behavior is implemented here. Existing
user-owned modified and untracked research/design files remain untouched and
will not be staged. No Trae process or endpoint was contacted.

## Important review fix — prompt replacement and session-owned clearing

This section supersedes the earlier statement that verification accepts only a
fresh `none` observation. A fresh safe same-session candidate whose prompt
backend ID differs from `originalPromptBackendId` also proves that the original
prompt disappeared before the deadline.

### Issues fixed

1. `originalPromptBackendId` is now compared during in-flight verification. A
   different prompt ID in the same rendered session records
   `verification_succeeded` without clicking the replacement. That replacement
   must then pass a new two-equal-scan gate before any later invocation.
2. A sessionless `none` no longer clears every continuation block. The watcher
   tracks the last safely observed rendered session and deletes only that
   session's block. A `none` associated with Session B therefore cannot clear a
   manual block retained for Session A, while a disappearance associated with
   the in-flight session remains valid proof.

No candidate, observer, logger, or CLI interface changed.

### RED evidence

The two regression tests were added before the implementation change and run
with:

```powershell
node --test test/watcher.test.mjs
```

The run failed for the two expected behavioral reasons:

```text
tests 17
pass 15
fail 2
duration_ms 823.6811
```

- Prompt replacement returned `waiting` instead of
  `verification_succeeded`.
- Session B's `none` removed Session A's block (`false !== true`).

### GREEN evidence

After the minimal watcher fix, the focused watcher suite passed:

```text
tests 17
pass 17
fail 0
duration_ms 878.2456
```

Fresh required logger/watcher verification then passed:

```powershell
node --test test/logger.test.mjs test/watcher.test.mjs
```

```text
tests 22
pass 22
fail 0
duration_ms 1617.7806
```

Fresh full-suite verification also passed:

```powershell
node --test
```

```text
tests 50
pass 50
fail 0
duration_ms 5976.8554
```

Both required final commands exited normally with no warnings, diagnostics,
cancelled/skipped tests, timeout symptoms, or hanging handles.

### Fix files and self-review

- `src/watcher.mjs`: internal rendered-session context, prompt-ID replacement
  proof, shared verification-success transition, and session-specific block
  deletion.
- `test/watcher.test.mjs`: replacement proof/fresh-gate regression,
  cross-session `none` isolation regression, and corrected same-prompt
  re-render fixture.
- `.superpowers/sdd/task-4-report.md`: this review-fix record and correction.

The implementation continues to fail closed: unsafe or cross-session evidence
cannot verify an in-flight action; exact invoked candidate keys remain blocked;
same-prompt re-renders remain non-proof; replacement success does not seed the
stability gate; and Session A state cannot be erased by Session B observations.
No real endpoint or Trae process was contacted. User-owned modified/untracked
research and design files were not edited.

### Fix concerns

None blocking.

## Important re-review fix — blocked/invoked precedence over cap reporting

### Issue fixed

After a third invocation, a verification failure correctly emitted one
`manual_intervention_required` event and retained the session continuation
block. A later safe re-render nevertheless reached the cap branch before the
existing block check, producing a second manual event with the incorrect
`click_cap_exhausted` reason.

`processLive` now checks the session's existing continuation block before cap
reporting. At the cap, an exact already-invoked candidate key also returns
`blocked` before any cap event. The cap event is therefore reserved for a
genuinely unblocked, uninvoked next candidate.

### RED evidence

The regression was added before the implementation change and run with:

```powershell
node --test test/watcher.test.mjs
```

The expected RED run reported:

```text
tests 18
pass 17
fail 1
duration_ms 839.3037
```

The failing assertion showed the duplicate and mislabel directly:

```text
actual:   ['verification_unsafe', 'click_cap_exhausted']
expected: ['verification_unsafe']
```

### GREEN evidence

After the minimal precedence fix, the watcher suite passed:

```text
tests 18
pass 18
fail 0
duration_ms 740.5897
```

Fresh required focused verification passed:

```powershell
node --test test/logger.test.mjs test/watcher.test.mjs
```

```text
tests 23
pass 23
fail 0
duration_ms 1656.308
```

Fresh full-suite verification passed:

```powershell
node --test
```

```text
tests 51
pass 51
fail 0
duration_ms 6102.0224
```

Both required final runs exited normally with no warnings, diagnostics,
cancelled/skipped tests, timeout symptoms, or hanging handles.

### Self-review and reusable lesson

- The regression reaches the real third-invocation ledger state, fails its
  verification, then uses a changed candidate key with the original prompt ID
  to model the blocked continuation's safe re-render.
- The re-render performs no fourth click, emits no cap event, leaves
  `exhaustedReported` false, and preserves the original one-shot
  `verification_unsafe` manual event.
- A genuinely new fourth candidate still follows the existing cap test and
  reports `click_cap_exhausted` once. Session-local budgets remain unchanged.
- No public interface, logger schema, verification rule, or prior-task file
  changed.

Reusable state-machine rule: terminal identity/block guards must precede
aggregate budget reporting. Otherwise a repeated terminal entity can be
misclassified as a new budget-consuming entity and produce duplicate events.

### Re-review fix concerns

None blocking. No Trae process or endpoint was contacted. User-owned modified
and untracked design/research files were not edited and will not be staged.
