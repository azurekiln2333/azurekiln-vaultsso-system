# Login account chooser and administrator phone verification

## Goal
Replace the single signed-in notice on the login page with a usable browser account list and an Add account action. Also allow administrators to edit Phone verified beside the existing Email verified checkbox.

## Authorization and scope
The user approved creating a Trellis task and explicitly instructed the coordinator to immediately finish planning and dispatch implementation to four existing Pi agents in Herdr. This supersedes the skill's additional planning-approval pause. The user then clarified the additional phone request as an administrator checkbox analogous to Email verified, not SMS delivery.

## Confirmed facts
- Login UI currently fetches /api/profile and renders only one current account (public/js/pages/auth/login.js, hydrateSessionBanner).
- Database supports multiple sessions; browser authentication reads only one session cookie (server.js, getAuthenticatedUser).
- Complete login issues cookies through setSessionCookie and applyIssuedLogin. MFA pending stages must not count as completed logins.
- Backend has phone_verified and phone_verified_at; admin user form currently submits emailVerified but no phoneVerified (views/admin/user.html, public/js/pages/admin/user.js, PUT /api/users/:id).

## Requirements
- R1: Show distinct valid accounts signed in within this browser, showing display name/username and current status. Do not list all system users.
- R2: Add account opens the existing sign-in/register flow without logging out previous accounts. Cancel/back returns to the list; incomplete/failed authentication preserves the active account.
- R3: Selecting a stored account validates its existing session and continues to profile (or existing OAuth continuation). Preserve original session deadline, revocation, bans and all verification requirements.
- R4: Each account has a logout/remove action that revokes its saved browser session and removes its list entry without logging out unrelated accounts. Preserve the existing logout route's current-account behavior.
- R5: Support existing single-session browsers, empty lists, reloads, keyboard access, mobile layout and all three existing languages. Keep a bounded list of five accounts, most recently used first; adding beyond the bound forgets the oldest list entry without revoking another device.
- R6: Administrator user edit adds Phone verified, loads the actual saved value and persists checking and unchecking. An absent/invalid phone cannot be marked verified. Changing/clearing the number resets the displayed checkbox so the old verification does not silently carry over; an explicit admin check may verify a new valid number.
- R7: Only the existing administrator-protected update endpoint accepts phoneVerified. Unchanged verified numbers retain their verification timestamp; marking a different/newly verified number sets a new timestamp; unchecking/unbinding clears it. Preserve phone uniqueness, normalization and credential-revocation rules.

## Acceptance criteria
- AC1 (R1-R5): Sign in A, add B, reopen login, see both, select A and confirm /api/profile is A without extending A's expiry.
- AC2 (R2-R4): Failed or pending MFA for B preserves A; removing B leaves A usable; expired/revoked/banned/forged entries cannot authenticate or appear as usable accounts.
- AC3 (R5): A browser with only the old session cookie is listed; empty browser can sign in normally; desktop/mobile and zh-CN/zh-TW/en-US show usable controls without overflow.
- AC4 (R6-R7): Administrator checks/unchecks phone verification, saves/reloads and observes persisted state and timestamps; empty-phone true fails readably; ordinary profile edits cannot self-verify; changing/unbinding clears verification unless an administrator explicitly checks the valid new phone.
- AC5: Existing session-duration, phone, MFA, OAuth, account-first login and i18n checks pass.

## Out of scope
SMS sending, SMS login, system-wide user enumeration on login, cross-device account lists, new OAuth prompt support, production deployment and authentication redesign.

## Risks and limits
The browser remembers up to five valid sessions. HTTP-only signed metadata must stay within cookie size limits and never reach browser storage/API output as credentials. Existing OAuth automatic SSO behavior is retained.
