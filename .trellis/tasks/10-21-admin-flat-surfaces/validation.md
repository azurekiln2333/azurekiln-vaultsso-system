# Admin surface acceptance

Date: 2026-10-21. Branch: `fix/admin-mfa-polish`. Code and independent visual review: PASS. Commit/archive pending parent Phase 3.4 review.

## Acceptance

- [x] Shell, embedded overview/users, clients form/table, settings and direct admin pages use neutral flat surfaces with matching iframe paint.
- [x] White 12px panels, restrained borders, shadow removal and consistent 24px desktop / 16px mobile insets follow the local New API reference. Phone statistic cards stay in two columns; timestamps no longer fragment between digits.
- [x] Chinese and English plus representative Traditional Chinese pass; navigation, actions and full metadata remain accessible. Wide tables scroll inside their container; no document overflow at 320px.
- [x] Admin smoke/navigation checks and the parent's final six-suite integrated browser check pass.

## Evidence

- Worker delivery and geometry: `implementation-result.md`.
- Independent rendered review: `../10-21-admin-mfa-polish/review.md`.
- Before/after captures: ignored `.artifacts/admin-mfa-polish/{baseline,after}/`.
- Final admin evidence: 50 PNGs, 87 measurements; shell/iframe body and iframe element are `rgb(248, 249, 251)` with `background-image: none`. Zero page errors or viewport overflow in the captured matrix.
- Main visually inspected the final desktop shell/users and mobile clients screenshots after both CSS follow-ups.
- `npm run check:syntax`: PASS, 97 files. `node tests/browser-smoke.cjs`: PASS. Parent `npm run check:browser`: final PASS, exit 0. `git diff --check`: PASS.

## Scope and limits

Only two admin stylesheets and eight admin templates change. Shared base/public backgrounds, admin JavaScript, backend, routes and administrative actions are unchanged. A one-row long-value fixture cannot establish large-data table density. The reviewer separately found an existing shell-language-switch account-label issue in unchanged JavaScript; it is not fixed here. Parent validation also records the unrelated intermittent account-bindings test timeout seen before the successful final run.
