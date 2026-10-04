# Dependency audit — 2026-10-04

The Mac startup verification exposed newly reported advisories in the existing
dependency locks. Patched dependencies were updated without disabling audit gates:

- Next.js and eslint-config-next: 16.3.4 → 16.3.8.
- Transitive brace-expansion: refreshed to compatible patched versions.
- NetEase sidecar basic-ftp: pinned override 6.2.1, because the parent dependency
  otherwise retains the affected major version.

After these changes, `npm --prefix apps/web audit --omit=dev` reports zero
vulnerabilities. Frontend lint, TypeScript, 25 tests, production build, and the
four sidecar tests passed locally. This does not mean the complete dependency
tree is free of advisories.

Two root advisories remain without published fixes at the time of this check:

- [node-forge GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv):
  affects versions through 1.4.0. The sidecar's pinned upstream API imports
  node-forge for public-key encryption; the advisory concerns RSA signature
  verification. The package remains installed, so the existing sidecar audit
  continues to fail (two affected package entries including the parent).
- [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm):
  affects versions through 3.0.3. This tree is a development dependency of
  eslint-config-next through fast-glob/micromatch (five affected entries).

No advisory was suppressed, no audit threshold was raised, and no forced major
downgrade was applied. Release readiness remains blocked until the remaining
dependency risks are resolved or explicitly reviewed. The earlier Linux CI run
37171901408 failed at its sidecar audit; its code tests passed.
