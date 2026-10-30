# Phone editing and Huawei app identity bindings

## Goal

Enable profile/admin phone editing and inspect Huawei app bindings grouped by trusted subject and UnionID

## Requirements

- Profile and admin user management offer phone editing and unbinding with country code support.
- Changed numbers become unverified; unchanged numbers retain verification. Self-service cannot assert verification. Enforce format and uniqueness server-side.
- A new admin page groups actual external app bindings by local user and shows app/provider, Huawei client ID, OpenID, UnionID, explicit subject group, and binding timestamps, with search and user-detail links.
- Huawei apps with an explicitly configured common subject group and the same trusted UnionID resolve to one local user while retaining each app's OpenID. Different subjects, missing UnionIDs and conflicting existing bindings must not silently merge users.
- Preserve existing defaults and bindings. No SMS integration, historic account merging or unrelated UI redesign.

## Acceptance Criteria

- [x] Save, reload, change, unbind and invalid/duplicate phone requests work through both write routes.
- [x] Ordinary users cannot edit others or access admin binding data.
- [x] Same-group apps with distinct OpenIDs and the same UnionID create one user and two app bindings.
- [x] Different groups and OpenID-only identities remain separate; conflicting mappings fail clearly.
- [x] Admin navigation reaches the new page; safe projections expose no secrets or raw profiles.
- [x] Existing checks, focused regressions and desktop/mobile browser checks pass.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
