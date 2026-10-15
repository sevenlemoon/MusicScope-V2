import path from 'node:path';
import { globSync as tinyGlobSync } from 'tinyglobby';

// Scoped to the pinned Next ESLint caller, not the complete fast-glob API.
export function globSync(pattern, options) {
  if (typeof pattern !== 'string' || options?.onlyDirectories !== true ||
      Object.keys(options).some((key) => key !== 'onlyDirectories')) {
    throw new TypeError('Unsupported Next root-directory glob contract');
  }
  // tinyglobby's relative formatting uses path.posix.relative. Across Windows
  // drives this would yield paths like ../../C:/Users/... relative to D:.
  // For absolute patterns, match from the pattern's own filesystem root and
  // return absolute results. Relative patterns retain their original cwd.
  const absolute = path.isAbsolute(pattern);
  return tinyGlobSync(pattern, {
    onlyDirectories: true,
    ...(absolute ? { cwd: path.parse(pattern).root, absolute: true } : {}),
  });
}
