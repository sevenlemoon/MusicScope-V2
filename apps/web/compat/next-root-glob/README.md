# Next ESLint root-directory glob adapter

The pinned `@next/eslint-plugin-next@16.3.8` uses only
`fast-glob.globSync(string, {onlyDirectories: true})`. This small adapter calls
`tinyglobby@0.2.17` for that interface and rejects unsupported options. Neither
micromatch nor the vulnerable braces implementation is included.

Absolute patterns are evaluated from their own filesystem root and return
absolute results. This preserves Windows cross-drive roots: evaluating `C:/...`
from a repository on `D:` must not produce `D:/C:/...`. Relative patterns keep
the current working directory. Tests invoke the real Next rule with directory
globs, including Unicode/space names, and assert that invalid links are reported.

This is not a complete fast-glob replacement. Review the caller and tests when
updating Next. Bump the local package version and refresh the lockfile when
changing the adapter so startup dependency caches are invalidated. `npm ci`
and Docker builds must have this directory available; it is a development-only
dependency and is not used by the production Next server.
