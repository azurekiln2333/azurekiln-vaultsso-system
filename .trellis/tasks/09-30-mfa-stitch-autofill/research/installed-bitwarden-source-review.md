# Installed Bitwarden Inline TOTP Source Review

Date: 2026-10-01

## Scope

Read-only inspection of the installed Chrome extension, version `2026.5.1`:

`D:/AppData/Local/Google/Chrome/User Data/Default/Extensions/nngceckbapebfimnlniiiahkandclblb/2026.5.1_0`

No extension storage, vault data, profile credentials, or product files were modified or read as data. The parent agent owns full-extension browser reproduction. The findings below establish code paths, not the user's actual extension settings or the confirmed cause of their report.

The user subsequently clarified that **Firefox fails and Chrome works normally**. The installed package examined here is the Chrome package, not the failing Firefox add-on. The original timing hypotheses below remain source background and are not the leading explanation after that clarification.

## Positive Field Qualification

All line numbers in this section refer to `content/bootstrap-autofill-overlay.js`.

- `23982`: `isTotpField` rejects recovery-code keywords first; `autocomplete="one-time-code"` then returns true directly. A six-slot presentation does not need six real inputs.
- `24018`: the constructor starts an asynchronous `getUserPremiumStatus` message and assigns `premiumEnabled` when its response arrives.
- `24030`: `isFieldForLoginForm` accepts a non-password TOTP field only while `premiumEnabled` is true. Username/password qualification proceeds independently of that flag.
- `9838`: `isIgnoredField` uses `isFieldForLoginForm`; qualifying fields receive login fill type and TOTP account-creation field type.
- `10341`, `10357`, `10397`: visibility checks use element geometry, viewport position, opacity, display, visibility, clip-path, and occlusion. Text color and caret color are not checked. The current full-size overlay input's transparent text is therefore not itself a rejection condition.
- `9396`: qualified fields receive input, focus, blur, keyup, and click listeners. Our native input/change handling does not stop propagation.
- `9689`: clicking a bound, enabled field calls the focused action if the inline menu is not already visible.

## Initial Disabled State And Cached Collection

- `9255`: `setupOverlayListeners` returns before listener setup when either the DOM field or collected metadata says readonly/disabled.
- `2236` and `25600`: the mutation observer's attribute filter includes `disabled`; observation covers the document subtree.
- `24694`: attribute-only batches call `applyAttributeMutation`. A child-list batch instead calls `requirePageDetailsUpdate`.
- `25632`: `applyAttributeMutation` updates cached metadata, but does not mark `domRecentlyMutated`, call overlay setup, or request collection.
- `25794`: updating the disabled property in cached field data only sets `dataTarget.disabled`.
- `24845`: a later `getPageDetails` call with unchanged DOM and an existing field cache updates visibility and returns cached details without running `setupOverlayListeners`.
- `25663`: `requirePageDetailsUpdate` marks the DOM dirty. The following full collection runs overlay setup at `24858`.
- `9990`: listener setup on an already-focused qualified field invokes the focused action when `document.hasFocus()` is true. Auto-focus before binding is supported when a subsequent collection actually rebinds.

This is a concrete extension lifecycle weakness: a field first collected disabled and later enabled by an attribute-only change can remain without inline listeners. The website's current challenge rendering also assigns instructions, label, and toggle text using `textContent`, producing child-list mutations before enabling the field. That mitigates the attribute-only path for this exact page, so the source alone does not show that removing initial `disabled` would solve the reported issue.

## Premium Response Timing

The `getUserPremiumStatus` completion at `24018` only assigns the boolean. It does not request a collection or retry setup for previously rejected TOTP fields. If initial collection precedes that response, and no subsequent child-list rebuild occurs after it, a stable TOTP-only page can remain unbound. Other sites' password fields qualify without this flag, which makes this timing hypothesis consistent with the user reporting inline menus elsewhere.

The parent browser probe should delay the Premium response until after the last challenge-render mutation, then compare listener binding before and after a real child-list mutation. A passing probe with an immediate stubbed Premium response does not cover this race.

## Site And URI Rules

`background.js` is minified on line 2. Offsets below are JavaScript string character offsets, useful for locating the named methods with `indexOf`.

- `getTargetingRulesForUrl`, offset `2040254`: FillAssist targeting requires its feature flag, enabled FillAssist, and an unlocked account. Rules are matched by host and optional pathname. A matching blocked host or pathname returns `[]`; absent rules normally return `null`.
- Collector `24832`: an empty targeting-rule list returns zero fields and skips all heuristics. This can suppress a specific MFA path independently of field markup.
- Script injector `inject`, offset `3129386`: injection checks `blockedInteractionsUris$` and skips a matching blocked URL. It also handles host-access permission failures. Neither state was inspected in this research.
- `getCipherViews`, offset `2932310`: inline candidate logins come from `getAllDecryptedForUrl(tab.url, account)`.
- `filterCiphersForUrl`, near offset `2518207`: candidate matching uses per-item URI settings and the default URI strategy. An item configured to match the sign-in URL exactly can fail to match `/oauth2/mfa`.
- `buildCipherData`, offset `2936288`: an actual TOTP seed on a matching login is used to generate the inline code. A missing matching login can explain missing TOTP choices, but does not establish why no inline button is shown.
- `openInlineMenu`, offset `2957060`: an empty input opens both button and list only when the extension's inline visibility value is `2`; otherwise it opens the button. Clicking the extension button explicitly opens the full list.

## Injection And CSP

- Manifest content scripts inject a small trigger at `document_start`; host permissions cover HTTP and HTTPS.
- Background `injectAutofillScripts`, offset `3030853`, chooses the overlay bundle from the inline-menu/notification settings.
- Background `executeScriptInTab`, offset `2859149`, injects files through `chrome.scripting.executeScript` in `ExecutionWorld.ISOLATED`.
- Overlay `5916`: the inline frame source is `BrowserApi.getRuntimeURL("overlay/menu.html")` and is appended inside the extension-owned shadow root.
- Manifest exposes `overlay/menu.html` with `use_dynamic_url: true`.
- The website's `frame-src` permits self and Cloudflare. Installed source does not establish whether the browser blocks extension-created frames under that policy. Actual extension frame load/error events are necessary before changing CSP. Page-script stubs are not equivalent to the isolated extension world.

## Chrome Source Hypotheses Before Browser Clarification

1. **Initial collection before the asynchronous Premium response.** A missed retry is explicit in source and can explain TOTP-only pages failing while ordinary login fields work. Actual response timing remains unverified.
2. **First collection while disabled, followed by no effective dirty collection after enabling.** The attribute-only flaw is explicit, but current challenge text rendering should produce a rebuild, lowering confidence for this exact page.
3. **A site/path targeting rule or interaction block.** Concrete source paths can suppress all fields or injection. The user's extension settings were not read.
4. **URI mismatch for the saved TOTP item.** Concrete matching code can remove TOTP candidates on the new MFA path. This best explains a visible menu lacking entries, rather than a completely absent menu.
5. **An extension-frame load/CSP issue.** Frame insertion is confirmed; an actual browser refusal has not been observed by this research. No CSP change is currently justified.

If the full-extension probe confirms the disabled-only cause, a minimal site change is to mount an enabled input after challenge data is ready, while continuing to guard submit before a valid challenge and after terminal errors. Merely renaming the field is not supported by the qualification evidence. A Premium timing miss requires a verified re-collection strategy or an extension-side retry; arbitrary timeout or unrelated repeated DOM mutations should not be added as an assumed fix.

## Firefox-Specific Follow-Up

- The user reports the same site works in Chrome. That lowers confidence that generic input naming, transparent text, or the initial disabled state is the confirmed cause.
- The Chrome bundle contains shared Firefox branches. At `6384`, Gecko/Firefox user-agent detection enables these branches. At `6826` and `6850`, menu button/list hosts are ordinary `div[popover="manual"]` elements; Chrome uses random custom elements. Both paths construct the same extension iframe through `5916`.
- Website MFA selectors do not generally restyle every div. The broad `.mfa-page *` selector applies only box sizing, while the extension host sets `all: initial` through inline styles. Source inspection did not reveal a specific conflicting MFA style.
- The existing `.artifacts/bitwarden-csp-issues.json` contains https://github.com/bitwarden/clients/issues/18867, reporting Firefox 128.10 ESR with Bitwarden 2025.12.1. Its reproduction explicitly says login suggestions appear and then CSP violations are logged. The issue body therefore establishes Firefox CSP-report noise, not a blocked iframe or absent menu.
- Live-read comments confirm the distinction: https://github.com/bitwarden/clients/issues/18867#issuecomment-4097112803 attributes the reports to inline reset styles on the ordinary div host, and explicitly says it does not seem to affect popup display because interaction/styling occurs inside the iframe. The site's current `style-src 'self' 'unsafe-inline'` already permits this styling. This report does not justify changing `frame-src`.
- Other issues in that saved search concern web-vault email-alias API requests, passkey UUID exposure, installation failures, or unrelated pull requests. They do not establish this MFA failure's cause.
- The decisive check is Firefox with the actual add-on: whether listeners exist, whether the menu iframe is inserted, and which resource or operation a browser error actually blocks. Any site-side CSP change should target an observed blocked resource/directive. Chrome's isolated-world behavior and passing field-source probes do not replace this check.
