# R19 import browser timeout diagnostic

## Scope

Read-only investigation of two browser timeouts during root's username-input verification. No import product code or permanent test was changed, no timeout was enlarged, and no live data was used.

## Observed failures

- `.artifacts/username-input/check-browser-before-ime-order.log`: the full aggregate passed its first five browser groups, then the import group completed desktop mixed import, a real 2501-row import and complete reimport. It timed out after 30 seconds in `locator.setInputFiles` for the deliberately oversized 10MiB+1 file (`tests/user-import-upload-browser.cjs:534`, helper at line 217).
- `.artifacts/username-input/import-browser-isolated.log`: an unchanged isolated rerun again completed desktop mixed/bulk/reimport, then timed out after 30 seconds reading `#importResult` for the pasted-import success assertion (`tests/user-import-upload-browser.cjs:526`).

These two failure positions differ. The saved logs alone do not establish navigation, session expiry or a product regression as the cause.

## Diagnostic evidence

An inspection-only copy of the existing test adds main-frame navigation, HTTP-error and console logging plus failure DOM/screenshot capture. Its scenarios and original timeout values are unchanged. It passed the complete desktop and mobile import flow, including 97KiB bytes, missing-email groups/login, 2501-row import/reimport, pasted JSON, both oversized local preflights and failed-request source preservation. Command exit: 0.

- Script: `.artifacts/username-input/import-diagnostic.cjs`.
- Log: `.artifacts/username-input/import-diagnostic.log`.
- Screenshots: `.artifacts/username-input/import-diagnostic/`.

During that successful run, the only observed HTTP 401 responses were the existing unauthenticated profile probes at initial authorization; HTTP 500 responses were the test's deliberate import-failure fixture. Main-frame navigation followed the scripted login/users-page transitions. No unexpected session-expiry or background-navigation evidence was captured in this run.

A lower-output diagnostic repeat was started to capture a possible recurrence, then interrupted at the coordinator's request so the final original aggregate could run with less concurrent browser work. Its partial log is retained as `import-diagnostic-silent.log`; it is not passing evidence. No further browser run was started by this reviewer.

## Conclusion and handoff

The concrete cause remains unconfirmed. The diagnostic pass does not turn either original failure into a passing aggregate or justify a product fix. Root owns the final unchanged full browser rerun. Preserve both failure logs and avoid a timeout increase or speculative import change unless a recurrence supplies concrete evidence.
