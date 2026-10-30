# account-bindings-browser.cjs:65 — review (cause unresolved)

Scope of this review: the single integrated failure reported by `npm run check:browser`
(`tests/account-bindings-browser.cjs:65`, timeout waiting for `#applicationsStatus` to show the
text of a held-stale `401` from `/api/account/applications`).

**Outcome: the cause is unresolved. No product fix and no test fix is retained.**
The only change I made during diagnosis (extra preconditions in this test file) did not
establish a synchronization fix and is being reverted by main; the original regression
assertion stands unchanged.

## 1. Observed facts

### 1.1 The integrated failure (reported by main)

```
page.waitForFunction: Timeout 30000ms exceeded.
    at main (D:\MyNewWebProjects\azurekiln-oauth2\tests\account-bindings-browser.cjs:65:16)
```

`npm run check:browser` passed `browser-smoke` and then timed out here, after the held stale
`/api/account/applications` request was fulfilled with `401`.

### 1.2 Isolated reproduction is intermittent

Running `node tests/account-bindings-browser.cjs` alone:

| Runs | Result |
| --- | --- |
| run 1 | pass (7 s) |
| run 2 | pass (6 s) |
| run 3 | **fail** at line 65 (33 s ≈ 30 s timeout + setup) |
| 4 further runs | pass |
| 1 further run | **fail** at line 65 |

So the same command alternates between a clean pass in ~6-7 s and a failure that is exactly the
reported line and exactly the 30 s wait budget. The failure is real and reproducible, but not
deterministic. No other line in the suite has been observed to fail.

### 1.3 Bounded probes of the product path (all passed)

Two instrumented probes, run once each, both produced the intended rendering:

- Single-flow probe: hold the init request → run the phone-modal flow → fulfill `401`.
  Result: `#applicationsStatus` changed from `加载中...` to `应用记录请求已失效`, URL stayed
  `/profile`, and exactly **1** `/api/account/applications` request was made.
- Six-iteration probe on one fixture (fresh login per iteration, same held-then-fulfilled
  sequence): `ok=true` on all 6 iterations, `appsRequests=1` every time.

These probes show the happy path works and that this flow issues a single applications request.
They do **not** reproduce the failing run, so they cannot by themselves identify its cause.

## 2. Source facts (established, not hypotheses)

From `public/js/pages/account/profile.js`:

- `loadApplications()` (line 222) takes `const requestVersion = ++applicationsRequestVersion`
  (line 224); the success path (232), the failure path (238), and the `finally` (241) all bail
  out when `requestVersion !== applicationsRequestVersion`. A superseded response is
  **intentionally discarded and renders nothing**.
- `renderApplications()` (line 211) is the only writer of `#applicationsStatus` text, and sets
  `profile-list-error` when `applicationsError` is set.
- `loadApplications()` is called at init (619), from the refresh button (249), and after an
  identity unbind (347, which pre-increments the version at 343).
- The phone-save path (`#phoneEditForm` submit, line 463 → `saveProfile`, ~425) **never calls
  `loadApplications()`**.
- `saveProfile` navigates to `/oauth2/authorize` when the `/api/profile` PUT returns `401`.

These facts constrain any explanation: a single init request stays current through the phone
save, so its `401` should render; and a superseded response is silent by design. They do not
tell us which of the possible deviations actually happened in the failing run.

## 3. Hypotheses considered — all UNPROVEN

Recorded so they are not mistaken for findings. None is supported by evidence from a failing
run; none should be treated as the cause.

1. **Second `loadApplications()` bumped the version, so the stale `401` was discarded.**
   *Weakened by evidence:* the six-iteration probe showed exactly 1 applications request per
   flow, and a superseded response would have rendered the *newer* request's outcome rather than
   nothing. Never observed in a failing run.
2. **The document navigated during the renewed save** (e.g. a `401` from the real
   `/api/profile` PUT triggering `window.location.href = '/oauth2/authorize'`), leaving the
   fulfilled route with no live handler, so line 65 polled a page that was no longer `/profile`.
   *Not observed:* no failing run was captured with navigation logging in place.
3. **The held route was aborted/evicted while held across unrelated UI round-trips**, so
   `fulfill` reached a dead request.
   *Not observed:* no `requestfailed` or `route.fulfill` error was captured in a failing run.
4. **A plain environment-timing effect** (loaded machine, 30 s budget consumed before the
   response could be handled).
   *Not observed:* the failing runs took ~33 s total, so the 30 s wait began near the start of
   the block; nothing measured points to slow response handling specifically.

The earlier revision of this document presented hypothesis 2 as the cause. That was wrong: no
evidence from a failing run established navigation, and the added assertions were merely
diagnostic preconditions. They did not fix anything, and they are not retained.

## 4. What was and was not changed

- **Product code: not changed.** No file under `public/js/pages/account/`, `views/account/`, or
  any backend route/service/model was modified for this diagnosis.
- **Test code: no retained change.** During diagnosis I added two preconditions and an optional
  chain to `tests/account-bindings-browser.cjs` around line 65. These are diagnostic only, do not
  constitute a synchronization fix, and main is removing that diff so the original regression
  assertion (`waitForFunction` on the stale `401` message plus
  `assert.ok(page.url().endsWith('/profile'), 'An old background request cannot redirect a renewed phone-edit session')`)
  is restored exactly as it was.
- **No git, branch, stage, commit, or task-lifecycle operations** were performed by this review.
  No new agents or worktrees were created.

## 5. Cleanup status (confirmed)

- All diagnostic scripts I created lived in `$env:TEMP` (`acct-bind-diag*.cjs`,
  `mfa-*diag*.cjs`) and have been deleted. None was ever written into the repository.
- No fixture, browser, or node process started by my probes is left running.
- The only file I own and leave behind is this document.

## 6. Recommended next step (for main, if the failure recurs)

Because the cause is unresolved, treat the next occurrence as a fresh, instrumented
investigation rather than applying a timing workaround. The single most informative capture,
on a failing run only, is: the number of `/api/account/applications` requests, whether
`route.fulfill` threw, any `requestfailed` for that URL, `framenavigated` events after the phone
save, and the `#applicationsStatus` text and `page.url()` at the moment of the timeout.
Those five signals discriminate cleanly between the hypotheses in §3; none of them has yet been
observed in a failing run.
