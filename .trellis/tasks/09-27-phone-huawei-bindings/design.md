# Design

## Phone
Reuse services/phone.js and User.update. Both write routes validate phone input and enforce uniqueness. Profile changes require recent authentication or current password, following email-change conventions. Forms send changed phone fields only. Unbinding clears verification and timestamps; unchanged numbers retain verification. Reuse existing markup and translations.

## Huawei identities
Keep per-provider identity rows. Add optional huaweiUnionScope to provider configuration using existing migration and admin form patterns. Nonempty scope explicitly asserts a shared Huawei subject. Cross-provider matching is limited to Huawei quick-login providers with exactly that scope and trusted returned UnionID. Preserve per-app OpenIDs in separate identity rows. Reject conflicting mappings; OpenID-only identities never match across providers. Validate primary and secondary matches agree. Snapshot app client ID and scope in sanitized identity profiles for inspection.

## Admin view
Reuse admin navigation/layout. Add admin-only bindings endpoint and page, grouped by local user with search and detail links. Return sanitized projections, never provider secrets or raw identity profiles. Existing rows remain visible with honest missing metadata. Empty scope retains per-provider behavior. No bulk merges.
