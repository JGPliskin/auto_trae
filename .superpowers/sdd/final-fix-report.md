# Final Whole-Branch Hardening Fix Report

Date: 2026-07-20
Branch: `codex/trae-auto-continue-design`
Starting head: `79d5471ee3c7`
Scope: all Critical and Important findings in `final-review-findings.md`, plus both practical Minor items.

## Outcome

The hardening pass implements every mandatory safety outcome without launching
Trae, connecting to a real CDP endpoint, or executing the PowerShell launcher.
All regressions use pure analysis or fake CDP/WebSocket dependencies. The
observer-to-watcher verification regressions call the production `observe()`
path rather than constructing impossible session-bound `none` observations.

## Implemented fixes

1. **Re-render blocking:** watcher verification no longer treats changed prompt
   or button backend IDs as disappearance. Any visible safe candidate in the
   same session remains blocked. Only an explicit observer-produced,
   target/session-bound disappearance proof can clear the in-flight block; a
   genuinely later card must then pass a fresh two-scan gate.
2. **Document identity:** DOM traversal now assigns a document identity and
   starts a new ancestry boundary at every `contentDocument`. Prompt/button
   pairs from different documents are rejected before LCA or distance proof.
3. **Exact region cardinality:** after finding a possible common region,
   candidate analysis counts all qualifying prompt and permitted visible,
   enabled button descendants in that region, including nodes deeper than the
   pair-distance threshold. The region must contain exactly one of each.
4. **Production disappearance proof:** during in-flight verification, CLI
   passes the expected session to `observe()`. If AX has no signature, the
   observer validates the expected target, retrieves the pierced DOM, finds one
   matching chat-session node, proves it has a visible box, and returns a
   structured `disappearanceProof`. Ordinary sessionless `none` remains
   non-proof, and a hand-built sessionful `none` without proof is rejected.
5. **Shared structural validation:** `candidate.mjs` now owns candidate
   validation. It verifies exact kind/reason, target/session-shaped
   `sessionKey`, recomputed `candidateKey`, backend IDs, prompt/button
   role/name/proof fields, visibility/enabled state, region ID, and distance
   `0..MAX_REGION_DISTANCE`. Watcher dry-run, stability, verification, and
   action paths all use it.
6. **CDP click result validation:** click rejects a missing/empty resolved
   `objectId` before Runtime invocation and rejects any
   `Runtime.callFunctionOn` response containing `exceptionDetails`. Rejected
   invocation does not increment the click ledger or emit `click_invoked`.
7. **Bounded WebSocket attachment:** `waitUntilOpen()` has a finite default
   five-second attachment timeout and accepts an abort signal. Its temporary
   open/error/close/abort listeners and timeout are cleaned on every terminal
   path. CLI passes its foreground abort signal into attachment.
8. **Post-click timing:** the 30-second verification deadline is assigned only
   after the click invocation returns successfully.
9. **Launcher coverage:** static tests now assert exact executable-path
   refusal, loopback debugger arguments, and absence of kill/restart commands.
   The launcher is parsed as source only and is never executed.

## TDD RED evidence

### Baseline

Before adding regressions, the requested focused suites passed `59/59`.

### RED cycle 1: candidate, observer, watcher, click accounting, deadline

Command:

```powershell
node --test test/candidate.test.mjs test/observer.test.mjs test/watcher.test.mjs
```

Result: exit `1`; `28` passed and `14` failed for the expected missing safety
behaviors. The failures demonstrated:

- cross-document prompt/button pairing returned `candidate_proven`;
- a deep extra button returned `candidate_proven`;
- the shared validator did not exist;
- verification mode made no DOM request and returned sessionless `none`;
- a mismatched target was not rejected;
- a stale candidate key with a changed button ID invoked a click;
- the deadline was `30000` instead of `40000` after a simulated slow click;
- Runtime `exceptionDetails` was counted as `click_invoked`;
- production disappearance could not complete verification;
- a hand-constructed sessionful `none` incorrectly verified;
- a backend-ID re-render incorrectly returned `verification_succeeded`.

After the minimal implementation, the first GREEN run exposed one stale test
fixture identity in the Session B cap test (`41/42`). Correcting the fixture to
use its actual prompt ID produced `42/42` GREEN.

### RED cycle 2: attachment, missing object ID, CLI wiring

Command:

```powershell
node --test test/cdp-client.test.mjs test/cli.test.mjs test/launcher-script.test.mjs
```

Result: exit `1`; `27` passed and `5` failed. Four failures represented the
intended production gaps:

- a never-opening socket reached the test harness timeout;
- abort did not settle attachment;
- missing `objectId` fell through to a five-second Runtime request timeout;
- CLI passed `undefined` instead of the in-flight session on the third scan.

The fifth failure was a typo in the new static launcher test (`$.ExecutablePath`
instead of `$_.ExecutablePath`); the production launcher already met that
contract, so the assertion was corrected without changing the script.

After the minimal implementation, this suite was `32/32` GREEN.

### RED cycle 3: target/session key structure

Command:

```powershell
node --test --test-name-pattern "shared candidate validation" test/candidate.test.mjs
```

Result: exit `1`; the validator accepted a self-consistent but targetless
`session-only` key. Requiring non-empty target and session components made the
focused regression `1/1` GREEN.

## Final GREEN evidence

Requested focused suites:

```powershell
node --test test/candidate.test.mjs test/observer.test.mjs test/cdp-client.test.mjs test/watcher.test.mjs test/cli.test.mjs test/launcher-script.test.mjs
```

Result: exit `0`; `74/74` passed, `0` failed, `0` cancelled, `0` skipped,
`0` todo; no warnings or hangs.

Full suite:

```powershell
node --test
```

Result: exit `0`; `85/85` passed, `0` failed, `0` cancelled, `0` skipped,
`0` todo; no warnings or hangs.

## Changed files

Production:

- `src/candidate.mjs`
- `src/observer.mjs`
- `src/watcher.mjs`
- `src/cdp-client.mjs`
- `src/cli.mjs`

Tests and fake fixtures:

- `test/candidate.test.mjs`
- `test/observer.test.mjs`
- `test/watcher.test.mjs`
- `test/cdp-client.test.mjs`
- `test/cli.test.mjs`
- `test/launcher-script.test.mjs`
- `test/fixtures/observations.mjs`

Report:

- `.superpowers/sdd/final-fix-report.md`

The PowerShell launcher required no source change. No user-owned
docs/research/context/design/plan file is part of this hardening change.

## Self-review

- Re-read all nine review findings against the final diff; each has a direct
  implementation and regression listed above.
- Confirmed backend-ID mutation cannot succeed verification or remove a manual
  block while a continuation signature remains visible.
- Confirmed only structured observer proof can verify disappearance; sessionless
  and unproven sessionful `none` observations do not clear state.
- Confirmed candidate validation is shared at the watcher boundary and
  recomputes identity before stability/action.
- Confirmed content-document roots have no host-parent ancestry and pair
  document identities must match.
- Confirmed all permitted descendants of the selected region participate in
  cardinality checks, even when too deep to form a distance-qualified pair.
- Confirmed CDP failures remain invocation failures: no budget increment and no
  `click_invoked` event.
- Confirmed attachment timeout/abort paths settle and clean temporary resources.
- Confirmed the deadline begins after successful invocation.
- Confirmed all tests are fake-only and no command launches Trae, calls a real
  CDP endpoint, or executes `Start-Process`.
- Confirmed the scoped diff excludes all pre-existing user-owned documentation
  changes and untracked research/context/plan files.

## Unresolved concerns

No blocking design contradiction or known unresolved code defect remains.
Per the explicit safety constraint, this pass did not perform a real Trae/CDP
integration test; behavior is validated entirely through deterministic fake
protocol, observer, watcher, CLI, and static launcher tests. The five-second
attachment bound is configurable at the CDP client factory boundary but is not
exposed as a public CLI option, because no public configurability was required.
