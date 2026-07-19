# Task 3 Report — AX/DOM Observation Pipeline

## Status

Implemented and verified Task 3 on `codex/trae-auto-continue-design`, based on
accepted Task 2 commit `a8c3d6a`. The implementation uses only the existing
`getFullAXTree()`, `getDocument()`, and `getBoxModel()` CDP client methods and
does not connect to a real endpoint or Trae.

## RED evidence

### Pure candidate analysis

After adding the redacted fixtures and pure-analysis tests, before creating
the production module, I ran:

```powershell
node --test test/candidate.test.mjs
```

The run failed as expected with `ERR_MODULE_NOT_FOUND` for
`src/candidate.mjs`. This established that the candidate tests exercised the
missing production boundary rather than pre-existing behavior.

### Staged observer

After candidate analysis was green, I added the staged observer tests before
creating the observer module and ran:

```powershell
node --test test/observer.test.mjs
```

The run failed as expected with `ERR_MODULE_NOT_FOUND` for
`src/observer.mjs`. The tests use the existing fake WebSocket with the real
CDP client API and therefore cover actual helper calls and request ordering.

## GREEN evidence

The pure candidate suite passed after the minimal implementation:

```text
tests 9
pass 9
fail 0
```

The staged observer suite passed after the minimal implementation:

```text
tests 3
pass 3
fail 0
```

Fresh final focused verification passed:

```powershell
node --test test/candidate.test.mjs test/observer.test.mjs
```

```text
tests 12
pass 12
fail 0
```

Fresh full-suite verification also passed:

```powershell
node --test
```

```text
tests 26
pass 26
fail 0
```

`git diff --check` completed without whitespace errors.

## Files changed

- `src/candidate.mjs`: defensive AX role/name/disabled parsing, approved
  continuation-signature matching, recursive DOM indexing, box visibility,
  lowest-common-ancestor distance proof, preferred session identity, stable
  observations, and opaque structural key composition.
- `src/observer.mjs`: AX-first staged observation, pre-geometry filtering,
  concurrent pierced-document/relevant-box requests, and fail-closed
  conversion of protocol failures.
- `test/fixtures/observations.mjs`: structurally minimal AX, DOM, box, session,
  distance, shadow-root, and content-document builders without chat text.
- `test/candidate.test.mjs`: all nine pure-analysis requirement groups,
  including the exact `MAX_REGION_DISTANCE = 8` boundary and rationale.
- `test/observer.test.mjs`: AX short-circuit, request scope/concurrency, and
  DOM/box failure tests through the existing fake CDP transport.

## Self-review

- The signature predicate is equivalent to the required expression and the
  only complete prompt strings are the two explicitly approved signature test
  inputs. Reusable fixtures contain no raw conversation text.
- AX values are read defensively. Only nested boolean `disabled === true`
  disables an action; absent disabled data remains eligible only if every
  other safety proof succeeds.
- DOM traversal covers children, shadow roots, and recursively nested
  `contentDocument` trees. Attributes are indexed as maps without mutating the
  protocol snapshot.
- Candidate proof fails closed for missing IDs, unavailable or zero-area box
  models, missing DOM nodes, excessive ancestry distance, extra qualifying
  pairs, unmatched visible signatures, and missing/ambiguous session identity.
- `MAX_REGION_DISTANCE` is exactly eight, with the required code comment that
  live evidence was six hops and the extra two levels are wrapper tolerance.
- Session identity is derived only from an ancestor with both `ai-chat` and
  `chat-session` class tokens and a proven `data-session-id`. The target ID is
  kept separate until `sessionKey` construction.
- The observer always awaits the full AX tree first. No-signature scans issue
  no DOM calls; qualifying AX nodes trigger one pierced document request and
  only their deduplicated box requests, concurrently.
- Diagnostics contain stable reason codes and structural identifiers only.
  Neither production module logs or mutates state.
- `src/cdp-client.mjs` was inspected and used through its public methods but
  was not modified.
- Pre-existing user-owned modified and untracked research/design files were
  not edited or staged.

## Concerns

None blocking. Node's full test discovery reports fixture/helper `.mjs` files
as successful no-op test modules; they perform no network or Trae access.

## Important review fixes

### Issues fixed

1. AX role matching now performs only outer-whitespace trimming and case
   normalization before exact comparison. It no longer deletes internal
   spaces, hyphens, or underscores, so malformed near-matches such as
   `static text` and `but-ton` fail closed while the fixture roles
   `StaticText` and `button` remain accepted.
2. Raw AX and DOM protocol nodes no longer escape the candidate module.
   Private selectors/indexes retain raw snapshots only while proving a
   candidate. Exported AX descriptors contain backend IDs and derived stable
   booleans; exported DOM descriptors contain backend IDs and structural
   parent relationships, never `name.value`, `nodeValue`, or original node
   identity. The observer now consumes the sanitized backend-ID descriptors.

### RED evidence

The two focused regressions were added before the fix and run with:

```powershell
node --test test/candidate.test.mjs
```

The expected RED run reported:

```text
tests 11
pass 8
fail 3
```

The failures showed that `static text` incorrectly produced
`candidate_proven`, AX selection returned original nodes containing
`name.value`, and the DOM index returned original protocol nodes.

### GREEN and final verification

After the minimal fix, the candidate suite passed 11/11. Fresh required
focused verification passed:

```powershell
node --test test/candidate.test.mjs test/observer.test.mjs
```

```text
tests 14
pass 14
fail 0
```

Fresh full-suite verification passed:

```powershell
node --test
```

```text
tests 28
pass 28
fail 0
```

Both test runs completed without warnings or diagnostic leakage.
`git diff --check` also completed without errors.

### Fix files

- `src/candidate.mjs`: exact fail-closed role normalization, private raw AX
  selection/DOM indexing, and sanitized exported descriptors.
- `src/observer.mjs`: consumes sanitized `backendNodeId` descriptors.
- `test/candidate.test.mjs`: malformed-role and raw-protocol-escape
  regressions, plus downstream descriptor assertions.
- `.superpowers/sdd/task-3-report.md`: this review-fix record.

### Fix concerns

None. No real endpoint or Trae process was contacted, and no user-owned
research/design file was modified or staged.
