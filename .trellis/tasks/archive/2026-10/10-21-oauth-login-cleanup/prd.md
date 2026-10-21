# Simplify OAuth2 login information

## Goal

Make the OAuth2 login page simpler by removing the authorization details the user explicitly asked to delete: the callback URI, scope chips, and the sentence explaining that sign-in returns the user to the target application with the authorization result.

## Background

- `views/auth/login.html:41` contains a dedicated authorization details card. Its client name repeats the application already identified by the page heading.
- `public/js/pages/auth/login.js:264` populates that card, including the callback URI and requested scopes. Removing its markup also requires removing these DOM references.
- `public/css/vaultsso-authorize.css:179` styles the card, and `public/js/shared/i18n.js:51` contains its Chinese and English copy. Repository search confirms these card-specific selectors and translation keys have no other consumers.
- The user approved creating a Trellis task on October 21, 2026, then approved proceeding after the final planning summary by directing implementation to the four existing Pi agents in the same Herdr workspace.

## Requirements

1. Remove the complete authorization details card, including its repeated client name, authorization description, scope chips, callback label, and callback URI. Leave no empty panel or spacing behind.
2. Keep the existing page heading identifying the destination application and the login, registration, and recovery forms usable.
3. Remove rendering code, styles, and translations that belong exclusively to the deleted card. Refresh changed asset references so cached JavaScript cannot access deleted elements.
4. Preserve OAuth request parameters and hidden form fields, including redirect URI, scope, state, nonce, response type, and PKCE. Password authentication, MFA continuation, and the final authorization callback retain their existing behavior.
5. Apply the presentation change consistently across supported languages and desktop/mobile layouts.

## Acceptance Criteria

- [x] OAuth2 login displays none of the deleted authorization details and has no empty replacement panel.
- [x] Direct login and OAuth2 login initialize without browser JavaScript errors, including after changing language.
- [x] Login and registration forms still carry the original OAuth request parameters as hidden fields.
- [x] Existing browser checks pass for password login and OAuth2 continuation, including state, nonce, and PKCE through MFA.
- [x] Desktop and mobile checks confirm the compact page has no horizontal overflow.
- [x] Project syntax and browser script reference checks pass.

## Out of Scope

- Backend authorization, scope validation, callback validation, or API changes.
- Client administration and success-page callback information.
- Rewriting the page heading, form copy, authentication feedback, or other page layouts.

## Artifact Status

This is a lightweight presentation-only task. The PRD and curated implementation/check context manifests are sufficient; separate design and implementation documents are unnecessary.
