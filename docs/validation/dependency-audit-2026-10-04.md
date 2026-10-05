# Dependency audit — 2026-10-04

## Resolution in MusicScope

Both affected dependency chains have now been removed from the project. This is
not an upstream patched-release claim: node-forge 1.4.0 and braces 3.0.3
were affected at the initial check. All three local npm audits (web including development packages,
NetEase service, desktop shell) now report **zero known vulnerabilities**.

- **RSA verification advisory:** the pinned NetEase client only uses forge to
  encrypt a short protocol secret. A small, original
  [encryption-only adapter](../../services/netease-api/compat/netease-rsa/README.md)
  delegates this operation to Node's native crypto implementation. No forge code,
  vulnerable signature parser, or signature verification API is included. The
  upstream import name resolves through an explicit npm override to
  `@musicscope/netease-rsa`; it is not a renamed copy of the vulnerable library.
- **Brace recursion advisory:** Next's ESLint plugin only uses
  `fast-glob.globSync(pattern, {onlyDirectories:true})` for root directories.
  A [small directory-glob adapter](../../apps/web/compat/next-root-glob/README.md)
  uses `tinyglobby@0.2.17`, removing fast-glob's micromatch/braces dependency chain
  while retaining Next's existing lint rules. Absolute patterns are evaluated
  from their own filesystem root to preserve Windows cross-drive paths;
  integration tests verify that Next still resolves directories and reports
  invalid links. A direct tinyglobby alias initially failed this Windows test;
  the adapter corrects the path handling rather than dropping the test.

Verification includes the original deterministic weapi encryption fixture,
1024/2048-bit private-key round trips, unsupported-scheme/input rejection,
an upstream usage-contract check, Unicode/space directory globs, 10,000 nested
brace pairs, and actual Next rule enforcement. The source provider remains
pinned at 4.40.1; changes to its crypto usage require another adapter review.

`install-links=true` makes the RSA adapter a physical dependency directory.
Windows packaging copies the adapter source and npm configuration before its
production install. Both Linux and Windows CI now run the dependency regression
tests and full web/service audits; no advisory allowlist or relaxed severity
threshold is used.

## Final CI verification (reviewed 2026-10-05)

[Run 37207233930](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/37207233930)
passed both Linux and Windows at source commit
`a4f04ea3d3db885181d92cd73704a33be1cc4f3b`. Windows completed on
2026-10-04 at 14:19:29 UTC (22:19:29 Asia/Shanghai).

- Full web and sidecar audit gates reported zero known vulnerabilities on both
  platforms; the Windows desktop dependency install also reported zero.
- Windows passed 77 API tests, 18 worker tests, 25 UI tests, seven sidecar tests,
  and three dependency-adapter tests, plus lint, type checking and production build.
- The relocated ZIP passed the native RSA adapter loading/encryption check using
  its bundled Node with developer tools removed from PATH.
- Packaged startup, key/database preservation, real CPU six-stem separation,
  offline packaged playback and a new offline six-stem job all passed.

The two dependency findings no longer block this candidate. The exact artifact,
original reports and remaining manual release checks are recorded in
[Windows acceptance](windows-desktop-2026-10-05.md). This CI success does not
publish a release or replace those remaining checks.

The subsequent web-notice packaging fix at `582bc24` passed Linux and Windows
[run 37276579470](https://github.com/sevenlemoon/MusicScope-V2/actions/runs/37276579470)
on 2026-10-05. All three npm dependency trees again reported zero known
vulnerabilities; relocated RSA loading and packaged offline acceptance passed.
See [the latest Windows evidence](windows-notices-2026-10-05.md).

## Initial finding (before the changes above)

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

Two root advisories had no published fixes at the time of this check:

- [node-forge GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv):
  affects versions through 1.4.0. The sidecar's pinned upstream API imports
  node-forge for public-key encryption; the advisory concerns RSA signature
  verification. The package remains installed, so the existing sidecar audit
  continues to fail (two affected package entries including the parent).
- [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm):
  affects versions through 3.0.3. This tree is a development dependency of
  eslint-config-next through fast-glob/micromatch (five affected entries).

No advisory was suppressed, no audit threshold was raised, and no forced major
downgrade was applied. These findings initially blocked release readiness. The earlier Linux CI run
37171901408 failed at its sidecar audit; its code tests passed.
