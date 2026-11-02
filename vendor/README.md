# Moderation SDK

`azurekiln-moderation-client-0.1.0.tgz` is the official dependency-free
`@azurekiln/moderation-client@0.1.0` package from `azurekiln-moderation/packages/client`.
It was created with `npm pack --workspace packages/client --ignore-scripts`.
The README contract was established at commit `e95e7ff`; the SDK source is from
commit `457bfa9` (`feat(moderation): add review, image, reports, SDK and deployment`).
The source checkout was clean, and hashes were unchanged before and after packing.

Tarball SHA-256:
`e63df6cf97b73fb67dcf33d41b0a5b1c42ea20f1c1908374ef3a337c9fcaaab5`

`package.json` and `package-lock.json` reference the repository-local tarball.
Include `vendor/` before running `npm ci` in a build context. To upgrade, pack the
official client again, replace the tarball, install it locally, and update the
lockfile and this record. Do not depend on a sibling checkout or an unpublished
registry package. The upstream package license is `UNLICENSED`.
